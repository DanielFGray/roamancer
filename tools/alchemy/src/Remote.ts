/**
 * The control host's job queue, seen from the workstation. Every Alchemy and Nomad command
 * that needs the host's state or tokens is a job: `ops` sends one JSON request to
 * `alchemy-runner submit` over ssh, then follows the job with `alchemy-runner wait`. The host
 * runs only the runner its last `ops rebuild` installed, so before the first job `ops`
 * refuses when this checkout's tools/alchemy differs from the runner's revision. A job
 * answers with its exit code: its output is for the operator to read, because the journal
 * holds the job's stdout and stderr as one stream.
 */
import { Context, Effect, Layer, Option, Schema as S, Stdio } from "effect";
import * as Exec from "./Exec.ts";
import * as Git from "./Git.ts";
import { ImageDigest, SignoffRecord } from "./queue/Protocol.ts";
import type { JobSubmit } from "./queue/Schema.ts";
import { Site } from "./Site.ts";

const runner = "alchemy-runner";

export type SignoffSend = {
  readonly app: string;
  readonly tree: string;
  readonly commit: string;
  readonly summary: string;
  readonly logSha256: string;
};

export class Remote extends Context.Service<Remote>()("ops/Remote", {
  make: Effect.gen(function* () {
    const site = yield* Site;
    const stdio = yield* Stdio.Stdio;
    const sameRevision = yield* Effect.cached(
      Effect.gen(function* () {
        yield* checkRevision(yield* site.host);
      }),
    );

    /** Queue `job` on the host and return its id. */
    const submit = Effect.fn("Remote.submit")(function* (job: JobSubmit) {
      yield* sameRevision;
      const host = yield* site.host;
      const printed = yield* Exec.output(
        "ssh",
        [host, `${runner} submit`],
        JSON.stringify({ _tag: "submit", ...job }),
      );
      return yield* S.decodeUnknownEffect(S.NumberFromString)(printed.trim()).pipe(
        Effect.mapError(
          () => new Exec.OpsError({ message: `submit printed no job id: ${printed}` }),
        ),
      );
    });

    /**
     * Record a local-test signoff on the host (not a job) and return its id. Keeps the same
     * runner revision check as submit.
     */
    const signoff = Effect.fn("Remote.signoff")(function* (record: SignoffSend) {
      yield* sameRevision;
      const host = yield* site.host;
      const printed = yield* Exec.output(
        "ssh",
        [host, `${runner} signoff`],
        JSON.stringify({ _tag: "signoff", ...record }),
      );
      return yield* S.decodeUnknownEffect(S.NumberFromString)(printed.trim()).pipe(
        Effect.mapError(() => new Exec.OpsError({ message: `signoff printed no id: ${printed}` })),
      );
    });

    /** The app's signoffs on the host, newest first. */
    const listSignoffs = Effect.fn("Remote.listSignoffs")(function* (app: string) {
      yield* sameRevision;
      const host = yield* site.host;
      const printed = yield* Exec.output("ssh", [host, `${runner} signoffs`, app]);
      return yield* S.decodeUnknownEffect(S.fromJsonString(S.Array(SignoffRecord)))(
        printed.trim() === "" ? "[]" : printed.trim(),
      ).pipe(
        Effect.mapError(
          (error) =>
            new Exec.OpsError({ message: `signoffs printed invalid JSON: ${error.message}` }),
        ),
      );
    });

    /**
     * Queue `job` and stream its output on this terminal; fails unless it succeeds, and
     * returns its id. With a terminal, ssh forwards Ctrl-C, which cancels a job that has not
     * started.
     */
    const run = Effect.fn("Remote.run")(function* (job: JobSubmit) {
      const id = yield* submit(job);
      yield* direct(["wait", `${id}`]);
      return id;
    });

    /**
     * Run an `alchemy-runner` command that is not a job (login, logs) on this terminal.
     * Piped input is not a terminal: it reaches the command over ssh's stdin.
     */
    const direct = Effect.fn("Remote.direct")(function* (args: ReadonlyArray<string>) {
      const terminal = yield* stdio.stdinIsTerminal;
      yield* Exec.run(
        "ssh",
        (terminal ? ["-t"] : []).concat(
          yield* site.host,
          [runner, ...args].map(Exec.quote).join(" "),
        ),
      );
    });

    /**
     * Record `digest` on the host as the image of `image.key`. Only an image that `ops`
     * pushed itself is recorded, so a release that reuses a record deploys what it built.
     */
    const recordImage = Effect.fn("Remote.recordImage")(function* (
      image: { readonly repository: string; readonly key: string },
      digest: string,
    ) {
      yield* sameRevision;
      yield* Exec.output(
        "ssh",
        [yield* site.host, `${runner} image record`],
        JSON.stringify({ _tag: "recordImage", ...image, digest }),
      );
    });

    /** The digest the host recorded for `image.key`, or none. */
    const findImage = Effect.fn("Remote.findImage")(function* (image: {
      readonly repository: string;
      readonly key: string;
    }) {
      yield* sameRevision;
      const printed = (
        yield* Exec.output("ssh", [
          yield* site.host,
          [runner, "image", "find", image.repository, image.key].map(Exec.quote).join(" "),
        ])
      ).trim();
      if (printed === "") return Option.none<string>();
      if (!S.is(ImageDigest)(printed)) {
        return yield* new Exec.OpsError({
          message: `the runner printed no digest for ${image.repository} ${image.key}: ${printed}`,
        });
      }
      return Option.some(printed);
    });

    return { submit, signoff, listSignoffs, run, direct, recordImage, findImage };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}

/**
 * Fail unless tools/alchemy in this checkout, uncommitted changes included, is the tree the
 * host's runner was built from. The job requests and the cartridges they name come from
 * this checkout, so a different runner could read them differently.
 */
const checkRevision = Effect.fn("Remote.checkRevision")(function* (host: string) {
  const revision = (yield* Exec.output("ssh", [host, `${runner} version`])).trim();
  const known = yield* Exec.succeeds("git", [
    "-C",
    Git.repository,
    "cat-file",
    "-e",
    `${revision}^{commit}`,
  ]);
  if (!known) {
    return yield* new Exec.OpsError({
      message: `${host} runs server-ansible ${revision.slice(0, 12)}, which this checkout does not have. Fetch it, or run \`ops rebuild\` for that host from here.`,
    });
  }
  const same = yield* Exec.succeeds("git", [
    "-C",
    Git.repository,
    "diff",
    "--quiet",
    revision,
    "--",
    "tools/alchemy",
  ]);
  if (!same) {
    return yield* new Exec.OpsError({
      message: `${host} runs server-ansible ${revision.slice(0, 12)}, and tools/alchemy here differs from it. Commit, then run \`ops rebuild\` for that host.`,
    });
  }
});
