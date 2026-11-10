/**
 * The control host's job queue, seen from the workstation. Every Alchemy and Nomad command
 * that needs the host's state or tokens is a job: `ops` sends one JSON request to
 * `alchemy-runner submit` over ssh, then follows the job with `alchemy-runner wait`. The host
 * runs only the runner its last `ops rebuild` installed. That runner refuses a request with a
 * key it does not know (queue/Protocol.ts), so a checkout newer than the runner cannot send a
 * request it would misread; before the first job, `ops` only notes that runner code here is
 * not live. A job answers with its exit code: its output is for the operator to read, because
 * the journal holds the job's stdout and stderr as one stream.
 */
import { Console, Context, Effect, Layer, Option, Schema as S, Stdio, type Stream } from "effect";
import type { PlatformError } from "effect/PlatformError";
import * as Exec from "./Exec.ts";
import * as Git from "./Git.ts";
import { production, repositoryOf } from "./queue/Paths.ts";
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
    const noteRevision = yield* Effect.cached(
      Effect.gen(function* () {
        yield* noteRunnerRevision(yield* site.host);
      }),
    );

    /** Queue `job` on the host and return its id. */
    const submit = Effect.fn("Remote.submit")(function* (job: JobSubmit) {
      yield* noteRevision;
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
     * Queue a build: `request` is one build request line and then the tar it counts (see
     * `Builder`). Returns the build job's id.
     */
    const build = Effect.fn("Remote.build")(function* (
      request: Stream.Stream<Uint8Array, PlatformError>,
    ) {
      yield* noteRevision;
      const printed = yield* Exec.output("ssh", [yield* site.host, `${runner} build`], request);
      return yield* S.decodeUnknownEffect(S.NumberFromString)(printed.trim()).pipe(
        Effect.mapError(
          () => new Exec.OpsError({ message: `build printed no job id: ${printed}` }),
        ),
      );
    });

    /** Record a signoff on the host (not a job) and return its id. */
    const signoff = Effect.fn("Remote.signoff")(function* (record: SignoffSend) {
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
     * Make `app`'s bare repository on the host unless it has one, as the operator over ssh,
     * and return the URL to push to.
     */
    const createRepository = Effect.fn("Remote.createRepository")(function* (app: string) {
      const host = yield* site.host;
      const printed = yield* Exec.output("ssh", [host, `${runner} repository ${Exec.quote(app)}`]);
      return {
        created: printed.trim() === "created",
        url: `${host}:${repositoryOf(production.repositories, app)}`,
      };
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

    /** The digest the host recorded for `image.key`, or none. */
    const findImage = Effect.fn("Remote.findImage")(function* (image: {
      readonly repository: string;
      readonly key: string;
    }) {
      yield* noteRevision;
      const printed = (yield* Exec.output("ssh", [
        yield* site.host,
        [runner, "image", "find", image.repository, image.key].map(Exec.quote).join(" "),
      ])).trim();
      if (printed === "") return Option.none<string>();
      if (!S.is(ImageDigest)(printed)) {
        return yield* new Exec.OpsError({
          message: `the runner printed no digest for ${image.repository} ${image.key}: ${printed}`,
        });
      }
      return Option.some(printed);
    });

    /**
     * Queue a retry reconcile job for `stage`, which deploys its branch's tree even when
     * reconcile already tried it, and stream its output.
     */
    const reconcile = Effect.fn("Remote.reconcile")(function* (stage: string) {
      return yield* run({ command: "reconcile", stage, retry: true });
    });

    return {
      submit,
      build,
      signoff,
      listSignoffs,
      createRepository,
      run,
      direct,
      findImage,
      reconcile,
    };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}

/**
 * Tell the operator, on stderr, when the host's runner was not built from tools/alchemy here
 * (uncommitted changes included, tests and docs left out): jobs run the runner's code, so a
 * change here to code the runner runs is not live until `ops rebuild`. It never fails, even
 * when the runner has no revision to print: the runner refuses a request it cannot read.
 */
const noteRunnerRevision = Effect.fn("Remote.noteRunnerRevision")(
  function* (host: string) {
    const revision = (yield* Exec.output("ssh", [host, `${runner} version`])).trim();
    const short = revision.slice(0, 12);
    const known = yield* Exec.succeeds("git", [
      "-C",
      Git.repository,
      "cat-file",
      "-e",
      `${revision}^{commit}`,
    ]);
    if (!known) {
      return yield* Console.error(
        `Note: ${host} runs server-ansible ${short}, which this checkout does not have.`,
      );
    }
    const same = yield* Exec.succeeds("git", [
      "-C",
      Git.repository,
      "diff",
      "--quiet",
      revision,
      "--",
      "tools/alchemy",
      ":!*.test.ts",
      ":!*.md",
    ]);
    if (!same) {
      yield* Console.error(
        `Note: ${host} runs server-ansible ${short}, and tools/alchemy here differs from it. A change to code the runner runs is not live until \`ops rebuild\`.`,
      );
    }
  },
  (effect, host) =>
    Effect.catch(effect, (error) =>
      Console.error(`Note: could not read the runner's revision on ${host}: ${error.message}`),
    ),
);
