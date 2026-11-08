/**
 * Bodies of the stageless jobs (Schema.ts says why they are jobs). Each prints into the
 * unit journal, which `alchemy-runner wait` streams to the operator.
 */
import { Array as Arr, Console, Effect, Option } from "effect";
import * as Cartridge from "../Cartridge.ts";
import * as Deployments from "../Deployments.ts";
import * as FleetStatus from "../FleetStatus.ts";
import { Nomad } from "../Nomad.ts";
import * as Package from "../Package.ts";
import { sameImageDigest } from "../ReleaseImage.ts";
import * as TaskLog from "../TaskLog.ts";
import { JobCommandError } from "./Run.ts";

/** Recorded deployments of one app, newest first. */
export const listDeployments = Effect.fn("queue.listDeployments")(function* (name: string) {
  const deployments = yield* Deployments.Deployments;
  const all = yield* deployments.list(name);
  if (all.length === 0) return yield* Console.log(`No recorded deployment of '${name}'.`);
  yield* Effect.forEach(all, (deployment) =>
    Console.log(
      `${deployment.id}\t${deployment.deployedAt}\t${deployment.revision}\t${images(deployment.cartridge).join(" ")}`,
    ),
  );
});

/** Each service's three newest allocations and their task states. */
export const status = Effect.fn("queue.status")(function* (name: string) {
  const cartridge = yield* Cartridge.resolve(Package.root, name);
  const nomad = yield* Nomad;
  yield* Effect.forEach(cartridge.services, (service) =>
    nomad.allocations(service.name).pipe(
      Effect.flatMap((allocations) =>
        Console.log(
          [
            service.name,
            ...(allocations.length === 0 ? ["  no allocations"] : []),
            ...Arr.sort(allocations, TaskLog.newestFirst)
              .slice(0, 3)
              .map((allocation) => {
                const tasks = Object.entries(allocation.TaskStates ?? {})
                  .map(
                    ([task, state]) =>
                      `${task}=${state.State}${state.Failed ? " (failed)" : ""}` +
                      (state.Restarts > 0 ? ` restarts=${state.Restarts}` : ""),
                  )
                  .join(" ");
                return `  ${allocation.ID.slice(0, 8)} v${allocation.JobVersion} ${allocation.ClientStatus} ${tasks}`;
              }),
          ].join("\n"),
        ),
      ),
    ),
  );
});

/**
 * Print the one image a staged instance runs. With `stable`, fail unless every staged
 * job's current version deployed successfully.
 */
export const stageImage = Effect.fn("queue.stageImage")(function* (
  name: string,
  stable: boolean,
  expect: string | null,
) {
  const cartridge = yield* Cartridge.resolve(Package.root, name);
  const nomad = yield* Nomad;
  // Only application services run the candidate image; a server keeps its own.
  const jobs = cartridge.services.map((service) => `${service.name}${Cartridge.stagedSuffix}`);
  // A staged deploy can stop after registering some jobs, so the jobs Nomad has are enough.
  const snapshots = (yield* Effect.forEach(jobs, (job) => nomad.job(job))).flatMap(Option.toArray);
  if (snapshots.length === 0) {
    return yield* new JobCommandError({
      message: `Nomad has no staged job of '${name}'.`,
    });
  }
  const unstable = snapshots.filter((snapshot) => !snapshot.Stable).map((snapshot) => snapshot.ID);
  const missing = jobs.filter((job) => !snapshots.some((snapshot) => snapshot.ID === job));
  if (stable && (missing.length > 0 || unstable.length > 0)) {
    return yield* new JobCommandError({
      message: `the staged instance of '${name}' is not fully deployed (${[...unstable, ...missing].join(", ")}); fix or discard it first`,
    });
  }
  const unique = [
    ...new Set(
      snapshots.flatMap((snapshot) =>
        snapshot.TaskGroups.flatMap((group) =>
          group.Tasks.flatMap((task) => Option.toArray(Option.fromNullishOr(task.Config.image))),
        ),
      ),
    ),
  ];
  if (unique.length !== 1) {
    return yield* new JobCommandError({
      message: `the staged jobs of '${name}' run ${unique.length} images; expected one`,
    });
  }
  const image = unique[0];
  if (expect !== null && !sameImageDigest(expect, image)) {
    return yield* new JobCommandError({
      message: `the staged instance of '${name}' runs ${image}, not ${expect}`,
    });
  }
  yield* Console.log(image);
});

/**
 * Nomad does not retry a queued allocation when a node gains a host volume or memory,
 * so a rebuild that adds either leaves jobs queued until something asks again.
 */
export const placeQueued = Effect.fn("queue.placeQueued")(function* () {
  const nomad = yield* Nomad;
  const queued = (yield* nomad.jobs()).filter((job) => FleetStatus.queued(job) > 0);
  yield* Effect.forEach(queued, (job) =>
    nomad.evaluate(job.ID).pipe(Effect.andThen(Console.log(`asked Nomad to place ${job.ID}`))),
  );
});

/** The images a recorded cartridge's services run; the record is valid JSON by construction. */
const images = (cartridge: string): ReadonlyArray<string> => [
  ...new Set(
    (JSON.parse(cartridge) as { services: ReadonlyArray<{ image: string }> }).services.map(
      (service) => service.image.replace(/^.*@sha256:(.{12}).*$/, "sha256:$1"),
    ),
  ),
];
