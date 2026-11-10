/**
 * The control host's job queue, seen from the workstation. Every Alchemy and Nomad command
 * that needs the host's state or tokens is a job: `ops` sends one JSON request to
 * `alchemy-runner submit` over ssh, then follows the job with `alchemy-runner wait`. The host
 * runs only the runner its last `ops rebuild` installed, so before the first job `ops`
 * refuses when this checkout's tools/alchemy differs from the runner's revision. A job
 * answers with its exit code: its output is for the operator to read, because the journal
 * holds the job's stdout and stderr as one stream.
 */
import { Context, Effect, Layer, Option, Schema as S, Stdio, type Stream } from "effect";
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
    const sameRevision = yield* Effect.cached(
      Effect.gen(function* () {
        yield* checkRevision(yield* site.host);
      }),
    );

    /**
     * Queue `job` on the host and return its id. A job whose request holds no file or
     * cartridge from this checkout may pass `sameRevision: false`: the runner reads only what
     * it was built to read, so a platform commit here need not stop it.
     */
    const submit = Effect.fn("Remote.submit")(function* (
      job: JobSubmit,
      options: { readonly sameRevision: boolean } = { sameRevision: true },
    ) {
      if (options.sameRevision) yield* sameRevision;
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
     * `Builder`). Returns the build job's id. Like submit, it needs the runner's revision.
     */
    const build = Effect.fn("Remote.build")(function* (
      request: Stream.Stream<Uint8Array, PlatformError>,
    ) {
      yield* sameRevision;
      const printed = yield* Exec.output("ssh", [yield* site.host, `${runner} build`], request);
      return yield* S.decodeUnknownEffect(S.NumberFromString)(printed.trim()).pipe(
        Effect.mapError(
          () => new Exec.OpsError({ message: `build printed no job id: ${printed}` }),
        ),
      );
    });

    /**
     * Record a signoff on the host (not a job) and return its id. It skips the runner revision
     * check that submit makes: the runner executes a job's plan, but only stores a signoff, and
     * its protocol schema refuses a record it cannot read. With the check, a platform commit
     * here would stop every app's push to main until the next rebuild.
     */
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

    /** The app's signoffs on the host, newest first. Like signoff, it skips the revision check. */
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
     * and return the URL to push to. Like signoff, it skips the revision check: the host only
     * runs git init in its repositories folder.
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
      yield* sameRevision;
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
     * reconcile already tried it, and stream its output. Reconcile receives nothing from this checkout
     * (it reads the app's repository on the host), so it skips the revision check, as the
     * timer's jobs do.
     */
    const reconcile = Effect.fn("Remote.reconcile")(function* (stage: string) {
      const id = yield* submit(
        { command: "reconcile", stage, retry: true },
        { sameRevision: false },
      );
      yield* direct(["wait", `${id}`]);
      return id;
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
