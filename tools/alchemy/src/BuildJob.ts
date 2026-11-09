/**
 * The runner's image build (docs/design/continuous-deployment.md, "Build"). The runner uploads
 * an app's exported tree to the `builds` bucket, runs a Nomad batch job on a worker node that
 * builds it with Buildah in the builder user's Podman and pushes `<repository>:<key>`, and
 * reads the digest the job prints. That output comes from code anyone who can push to the app
 * may write, so the runner records a digest only after the registry answers for
 * `<repository>@<digest>`, and only under the repository and key it chose for this job.
 */
import { Console, Effect, Option, Schedule, Schema as S } from "effect";
import { BuildStore } from "./BuildStore.ts";
import type { Evaluation } from "./Nomad.ts";
import { Nomad } from "./Nomad.ts";
import { ImageDigest, ImageKey } from "./queue/Protocol.ts";
import { Registry } from "./Registry.ts";
import { Store } from "./queue/Store.ts";

/**
 * The Buildah platform image (`ops image buildah-image`, built from nixos/cynic/buildah-image.nix).
 * Platform images that are services are pinned in platform/*\/cartridge.json; this one is no
 * service, so the runner's build job pins it here, where it is used.
 */
export const buildahImage =
  "registry.cluster:5000/platform-buildah@sha256:abb4ea28e9b36a3a75cdb4e93db286f62450a6a5dabdbb0d1ea72807b3bfea45";

/** What the scheduler reserves for the job; `memory_max` is the cap above it. */
export const reservedBuildMemoryMB = 256;

/** How long the tree's URL works: long enough to wait for placement and image pull, no longer. */
const artifactSeconds = 600;
/** A job nothing placed within this time fails, so a blocked build cannot stall the queue. */
const placementLimit = "5 minutes";
const buildLimit = "30 minutes";

export class BuildFailed extends S.TaggedError<BuildFailed>()("BuildFailed", {
  message: S.String,
}) {}

export interface BuildRequest {
  /** `registry/name`, which the runner checks against its registry before it builds. */
  readonly repository: string;
  readonly key: string;
  /** The queue job that runs this build; it names the Nomad job and the uploaded object. */
  readonly jobId: number;
  /** The exported tree as a tar. */
  readonly tarFile: string;
  readonly memoryMaxMB: number;
}

/** Where the runner's registry and its CA folder are, as site.toml sets them. */
export interface BuildSite {
  /** `name:port`, as the registry is addressed. */
  readonly registry: string;
  /** The folder on each worker node that holds the registry CA (`ca.crt`). */
  readonly registryCaDir: string;
}

/** The Nomad batch job that builds one tree. */
export const buildJobSpec = (input: {
  readonly nomadJob: string;
  readonly repository: string;
  readonly key: string;
  readonly artifactUrl: string;
  readonly memoryMaxMB: number;
  readonly registryCaDir: string;
}) => {
  const tagged = `${input.repository}:${input.key}`;
  // buildah writes its progress to stdout; stderr carries it so stdout holds only the digest.
  const script = [
    `buildah bud --isolation chroot --storage-driver vfs --cert-dir /run/registry-ca -f /local/tree/Dockerfile -t ${tagged} /local/tree >&2`,
    `buildah push --storage-driver vfs --cert-dir /run/registry-ca --digestfile /tmp/digest ${tagged} >&2`,
    "cat /tmp/digest",
  ].join(" && ");
  return {
    ID: input.nomadJob,
    Name: input.nomadJob,
    Type: "batch",
    Datacenters: ["dc1"],
    Constraints: [{ LTarget: "${meta.builder}", Operand: "=", RTarget: "true" }],
    TaskGroups: [
      {
        Name: "build",
        Count: 1,
        // A failed build is final: the next push tries again.
        RestartPolicy: { Attempts: 0, Mode: "fail" },
        ReschedulePolicy: { Attempts: 0, Unlimited: false },
        Tasks: [
          {
            Name: "buildah",
            Driver: "podman",
            Config: {
              image: buildahImage,
              socket: "builder",
              // A volumes string cannot hold the colon of certs.d/<registry>:<port>, so the
              // folder goes to a fixed path that --cert-dir names.
              volumes: [`${input.registryCaDir}:/run/registry-ca:ro`],
              command: "/bin/sh",
              args: ["-ec", script],
            },
            Resources: {
              CPU: 500,
              MemoryMB: reservedBuildMemoryMB,
              MemoryMaxMB: input.memoryMaxMB,
            },
            // The Nomad client fetches the tree, so the task holds no credential. No Identity
            // block: the task gets no workload identity file or variable.
            Artifacts: [{ GetterSource: input.artifactUrl, RelativeDest: "local/tree" }],
          },
        ],
      },
    ],
  };
};

/**
 * Build `request.key` of `request.repository` and record its digest. Fails, naming why, when the
 * build job fails, cannot be placed, prints no digest, or prints one the registry lacks.
 * The tree in the bucket and the Nomad job are removed whatever the outcome.
 */
export const runBuild = Effect.fn("runBuild")(function* (request: BuildRequest, site: BuildSite) {
  yield* checkRequest(request, site);
  const store = yield* BuildStore;
  const nomad = yield* Nomad;
  const object = `${request.jobId}-${request.key}.tar`;
  const nomadJob = `build-${request.jobId}`;

  yield* store.put(object, request.tarFile);
  const digest = yield* Effect.gen(function* () {
    const artifactUrl = yield* store.getUrl(object, artifactSeconds);
    yield* nomad.registerBatch(
      buildJobSpec({
        nomadJob,
        repository: request.repository,
        key: request.key,
        artifactUrl,
        memoryMaxMB: request.memoryMaxMB,
        registryCaDir: site.registryCaDir,
      }),
    );
    yield* Console.log(`Submitted Nomad job ${nomadJob}`);
    return yield* waitForDigest(nomadJob);
  }).pipe(
    Effect.ensuring(
      Effect.all([nomad.stop(nomadJob), store.remove(object)], { discard: true }).pipe(
        Effect.catch((error) => Console.error(`cleanup failed: ${error.message}`)),
      ),
    ),
  );

  yield* acceptDigest(request, digest);
});

/**
 * The refusals that need no Nomad: an image key that is not a tree hash, a repository outside
 * the cluster registry (the runner calls the registry with it), or a name that would reach the
 * build script as anything but a path.
 */
const checkRequest = (request: BuildRequest, site: BuildSite) =>
  Effect.gen(function* () {
    if (!S.is(ImageKey)(request.key)) {
      return yield* new BuildFailed({ message: `'${request.key}' is not a git tree hash` });
    }
    const name = request.repository.slice(site.registry.length + 1);
    if (
      !request.repository.startsWith(`${site.registry}/`) ||
      !/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/.test(name)
    ) {
      return yield* new BuildFailed({
        message: `'${request.repository}' is not a repository of ${site.registry}`,
      });
    }
  });

/**
 * Wait for the job's allocation to end, and return the digest it printed. Fails when no
 * allocation is placed in time, naming Nomad's placement failure.
 */
const waitForDigest = Effect.fn("waitForDigest")(function* (nomadJob: string) {
  const nomad = yield* Nomad;
  const newest = nomad
    .allocations(nomadJob)
    .pipe(Effect.map((all) => Option.fromNullishOr(all[0])));
  const untilSome = <A, E, R>(effect: Effect.Effect<Option.Option<A>, E, R>) =>
    effect.pipe(Effect.repeat({ schedule: Schedule.spaced("3 seconds"), until: Option.isSome }));

  const placed = yield* untilSome(newest).pipe(Effect.timeoutOption(placementLimit));
  if (Option.isNone(placed) || Option.isNone(placed.value)) {
    const why = placementFailure(yield* nomad.evaluations(nomadJob));
    return yield* new BuildFailed({
      message: `${nomadJob} was not placed within ${placementLimit}${why === "" ? "" : `: ${why}`}`,
    });
  }
  const ended = yield* untilSome(
    newest.pipe(
      Effect.map(
        Option.filter(
          (allocation) =>
            allocation.ClientStatus !== "pending" && allocation.ClientStatus !== "running",
        ),
      ),
    ),
  ).pipe(Effect.timeoutOption(buildLimit));
  if (Option.isNone(ended) || Option.isNone(ended.value)) {
    return yield* new BuildFailed({ message: `${nomadJob} did not end within ${buildLimit}` });
  }
  const allocation = ended.value.value;
  if (allocation.ClientStatus !== "complete") {
    const stderr = yield* nomad.logs(allocation.ID, "buildah", "stderr", 4000);
    yield* Console.error(stderr);
    return yield* new BuildFailed({
      message: `${nomadJob} ended ${allocation.ClientStatus}; its stderr is above`,
    });
  }
  const stdout = yield* nomad.logs(allocation.ID, "buildah", "stdout", 4000);
  const last = stdout.trim().split("\n").at(-1)?.trim() ?? "";
  if (!S.is(ImageDigest)(last)) {
    return yield* new BuildFailed({ message: `${nomadJob} printed no image digest` });
  }
  return last;
});

/** Record `digest` only when the registry holds it under the repository this job pushed to. */
const acceptDigest = Effect.fn("acceptDigest")(function* (request: BuildRequest, digest: string) {
  const registry = yield* Registry;
  if (!(yield* registry.has(request.repository, digest))) {
    return yield* new BuildFailed({
      message: `the registry has no ${request.repository}@${digest}; the digest is not recorded`,
    });
  }
  yield* (yield* Store).recordImage({
    repository: request.repository,
    key: request.key,
    digest,
  });
  yield* Console.log(`Recorded ${request.repository}@${digest} for tree ${request.key}`);
});

/**
 * Why the scheduler left a job unplaced, from its newest evaluation, for the operator who
 * reads the job's output; empty when Nomad names no failure.
 */
export const placementFailure = (evaluations: ReadonlyArray<Evaluation>): string => {
  const failed = evaluations.find((evaluation) => evaluation.FailedTGAllocs !== null);
  if (failed?.FailedTGAllocs == null) return "";
  return Object.entries(failed.FailedTGAllocs)
    .flatMap(([group, placement]) => [
      ...Object.entries(placement.ConstraintFiltered ?? {}).map(
        ([reason, nodes]) => `${group}: ${reason} (${nodes} nodes)`,
      ),
      ...Object.entries(placement.DimensionExhausted ?? {}).map(
        ([dimension, nodes]) => `${group}: ${dimension} exhausted (${nodes} nodes)`,
      ),
    ])
    .join("; ");
};
