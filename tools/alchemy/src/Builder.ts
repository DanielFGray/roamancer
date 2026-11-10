/**
 * Build a commit's tree through the runner. The tree goes to the runner as git's archive over
 * ssh; the runner uploads it, builds it as a Nomad job on a worker node, checks the digest the
 * job prints against the registry, and records it. Every image, from `ops stage` or from a
 * push, comes from that one build path with one set of limits. This returns the pinned
 * reference `repository:key@digest`; the tag only names the tree for people, and a deploy pins
 * the digest.
 */
import { Context, Effect, FileSystem, Layer, Option, Stream } from "effect";
import { OpsError } from "./Exec.ts";
import { Remote } from "./Remote.ts";

export interface BuildImage {
  readonly repository: string;
  /**
   * The image key: the git tree hash of the commit built (`git rev-parse <commit>^{tree}`).
   * Two commits with the same files share it, as after a squash merge.
   */
  readonly key: string;
}

export class Builder extends Context.Service<Builder>()("ops/Builder", {
  make: Effect.gen(function* () {
    const remote = yield* Remote;
    const fs = yield* FileSystem.FileSystem;

    /**
     * Send `archive`, the commit's tree as `Git.exportArchive` writes it, and wait for the build
     * job. The Nomad client unpacks it as root, and the builder user reads it through the
     * permission bits that git sets on each entry. `memoryMaxMB` is the most memory the build
     * may use, which the app's cartridge sets.
     */
    const build = Effect.fn("Builder.build")(function* (
      archive: string,
      image: BuildImage,
      memoryMaxMB: number,
    ) {
      const { size } = yield* fs.stat(archive);
      // One request line, then the tar it counts: the runner's front end stores the tar and
      // queues the build.
      const request = JSON.stringify({
        _tag: "build",
        repository: image.repository,
        key: image.key,
        memoryMaxMB,
        size: Number(size),
      });
      const id = yield* remote.build(
        Stream.concat(Stream.make(new TextEncoder().encode(`${request}\n`)), fs.stream(archive)),
      );
      yield* remote.direct(["wait", `${id}`]);
      const digest = yield* remote.findImage(image);
      return yield* Option.match(digest, {
        onNone: () =>
          Effect.fail(
            new OpsError({
              message: `build job ${id} ended without recording an image for ${image.repository}:${image.key}`,
            }),
          ),
        onSome: (value) => Effect.succeed(`${image.repository}:${image.key}@${value}`),
      });
    });

    return { build };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}
