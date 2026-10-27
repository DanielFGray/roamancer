/**
 * Build an exported commit tree and push it to the cluster registry. The workstation uses
 * Docker (Local); a node named in site.toml uses rootless Podman over one ssh call that
 * receives the tree as a tar on stdin (Node). Both return the same pinned reference
 * `repository:commit@digest`.
 */
import { Array as Arr, Context, Effect, Layer, Option, Stream } from "effect";
import { ChildProcess } from "effect/process";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import { OpsError, output, quote, run } from "./Exec.ts";
import { Site } from "./Site.ts";

export interface BuildImage {
  readonly repository: string;
  readonly commit: string;
}

/** Docker build and push on this machine from the exported tree. */
const localBuild = (tree: string, image: BuildImage) =>
  Effect.gen(function* () {
    const tagged = `${image.repository}:${image.commit}`;
    yield* run("docker", ["build", "-t", tagged, tree]);
    yield* run("docker", ["push", tagged]);
    const digests = yield* output("docker", [
      "inspect",
      "--format",
      "{{range .RepoDigests}}{{println .}}{{end}}",
      tagged,
    ]);
    const pinned = yield* Arr.findFirst(digests.split("\n"), (digest) =>
      digest.startsWith(`${image.repository}@`),
    ).pipe(
      Option.match({
        onNone: () =>
          Effect.fail(new OpsError({ message: `docker records no digest for ${tagged}` })),
        onSome: Effect.succeed,
      }),
    );
    const digest = pinned.slice(image.repository.length + 1);
    return `${tagged}@${digest}`;
  });

/**
 * Rootless Podman on `host`: one ssh call whose stdin is a tar of the exported tree, which
 * builds, pushes, and prints the digest file.
 */
const nodeBuild = (host: string) => (tree: string, image: BuildImage) =>
  Effect.gen(function* () {
    const tagged = `${image.repository}:${image.commit}`;
    const spawner = yield* ChildProcessSpawner;
    const remote = [
      "tmp=$(mktemp)",
      `trap 'rm -f "$tmp"' EXIT`,
      `podman build -t ${quote(tagged)} -`,
      `podman push --digestfile "$tmp" ${quote(tagged)}`,
      `cat "$tmp"`,
    ].join(" && ");
    const handle = yield* spawner
      .spawn(
        ChildProcess.make("tar", ["-C", tree, "-cf", "-", "."]).pipe(
          ChildProcess.pipeTo(ChildProcess.make("ssh", [host, remote], { stderr: "inherit" })),
        ),
      )
      .pipe(Effect.catchTag("PlatformError", (error) => Effect.fail(opsError(error))));
    const text = yield* Stream.mkString(Stream.decodeText(handle.stdout)).pipe(
      Effect.catchTag("PlatformError", (error) => Effect.fail(opsError(error))),
    );
    const code = yield* handle.exitCode.pipe(
      Effect.catchTag("PlatformError", (error) => Effect.fail(opsError(error))),
    );
    if (code !== 0) {
      return yield* new OpsError({
        message: `tar | ssh ${host} exited ${code}`,
      });
    }
    return `${tagged}@${text.trim()}`;
  }).pipe(Effect.scoped);

const opsError = (error: { readonly message: string }) => new OpsError({ message: error.message });

export class Builder extends Context.Service<Builder>()("ops/Builder", {
  make: Effect.gen(function* () {
    const node = yield* (yield* Site).buildNode;
    return {
      build: Option.match(node, {
        onNone: () => localBuild,
        onSome: (host) => nodeBuild(host),
      }),
    };
  }),
}) {
  /** Local when site.toml has no `[build] node`, otherwise Node on that host. */
  static readonly layer = Layer.effect(this, this.make);
}
