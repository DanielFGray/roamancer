/**
 * Reconcile releases the head of an app's `main` (docs/design/continuous-deployment.md). The
 * `reconcile` job reads `main` in the app's repository on the control host, decides, and either records why it
 * waits or builds and deploys the tree the way `ops release` does, without the prompt: a push
 * to `main` is the approval. A queue job runs it, so it takes turns with deploys.
 */
import { Cause, Console, Effect, FileSystem, Option, Schema as S } from "effect";
import { defaultBuildMemoryMB } from "./BuildLimits.ts";
import { runBuild, type BuildSite } from "./BuildJob.ts";
import * as Cartridge from "./Cartridge.ts";
import * as Exec from "./Exec.ts";
import * as Git from "./Git.ts";
import { repositoryOf } from "./queue/Paths.ts";
import * as Repositories from "./Repositories.ts";
import { JobCommandError } from "./queue/Run.ts";
import type { Reconcile as ReconcileState } from "./queue/Store.ts";
import { Store as StoreService } from "./queue/Store.ts";
import { pinCartridgeText, repositoriesOf } from "./ReleaseImage.ts";
import { deployRef } from "./Signoff.ts";

/** What reconcile does with the tree at the head of `main`. */
export type Verdict =
  /** Reconcile already released or tried this tree; the next push tries again. */
  | "tried"
  /** No signoff for this tree. Not a try: the signoff arriving releases it. */
  | "signoff"
  /** No valid token. Not a try: `ops login` lets the next run release it. */
  | "login"
  | "release";

/**
 * Decide from what reconcile can see, with no I/O. It compares `main`'s tree with the last
 * tree it tried and never with what runs live, so a rollback stays until `main` changes.
 */
export const decide = (input: {
  readonly tree: string;
  readonly triedTree: string | null;
  readonly signedOff: boolean;
  readonly tokenValid: boolean;
}): Verdict => {
  if (input.tree === input.triedTree) return "tried";
  if (!input.signedOff) return "signoff";
  if (!input.tokenValid) return "login";
  return "release";
};

/**
 * The commit and tree at the head of `main` in the bare repository `repository`, or none when
 * it has no such branch. Fails when the repository cannot be read. The operator owns the
 * repository and the runner reads it; the host's git config lists the folder in
 * `safe.directory`, without which git refuses a repository another user owns.
 */
export const readHead = Effect.fn("Reconcile.readHead")(function* (repository: string) {
  const git = (...args: ReadonlyArray<string>) =>
    Exec.output("git", ["-C", repository, ...args]).pipe(Effect.map((text) => text.trim()));
  // A for-each-ref pattern also matches refs below it, such as refs/heads/main/x, so the
  // listing is filtered to the exact name.
  const listing = yield* git("for-each-ref", "--format=%(refname) %(objectname)", deployRef);
  const commit = listing
    .split("\n")
    .map((line) => line.split(" "))
    .find(([ref]) => ref === deployRef)?.[1];
  if (commit === undefined) return Option.none<{ commit: string; tree: string }>();
  return Option.some({ commit, tree: yield* git("rev-parse", `${commit}^{tree}`) });
});

/** `ops release`'s plan or deploy step failed; `message` is the reason its error gave. */
export class ReleaseFailed extends S.TaggedError<ReleaseFailed>()("ReleaseFailed", {
  message: S.String,
}) {}

/** What a reconcile job needs besides the store and the build services. */
export interface ReconcileDeps {
  /** The queue job that runs this reconcile; it names the release's build. */
  readonly jobId: number;
  /** The folder of the apps' bare repositories (queue/Paths.ts `repositoryOf`). */
  readonly repositories: string;
  readonly site: BuildSite;
  /** Whether the job holds a token OpenBao accepts. */
  readonly tokenValid: Effect.Effect<boolean>;
  /** Plan or deploy `app` as `ops release` does, with `env` added: the pinned cartridge and the commit. */
  readonly stage: (
    command: "plan" | "deploy",
    app: string,
    env: Record<string, string>,
  ) => Effect.Effect<void, ReleaseFailed>;
}

type Saved = Omit<ReconcileState, "checkedAt">;

/**
 * Reconcile one app: record what it found, and release when {@link decide} says so. Fails the
 * job, after recording the try, when the build or the deploy fails.
 */
export const reconcileApp = Effect.fn("Reconcile.reconcileApp")(function* (
  app: string,
  deps: ReconcileDeps,
) {
  const store = yield* StoreService;
  if (!(yield* Repositories.has(deps.repositories, app))) {
    return yield* new JobCommandError({
      message: `'${app}' has no repository on the control host; run \`ops repo create\` in its checkout`,
    });
  }
  const before: Saved = Option.getOrElse(yield* store.getReconcile(app), () => ({
    app,
    seenCommit: null,
    seenTree: null,
    triedTree: null,
    triedCommit: null,
    triedResult: null,
    triedJob: null,
    status: "no-main" as const,
    detail: "",
  }));
  // A repository that cannot be read is an outcome on show in `ops dash`, not a failed job:
  // the timer would add one every minute.
  yield* readHead(repositoryOf(deps.repositories, app)).pipe(
    Effect.matchEffect({
      onFailure: (error) => note(app, before, "unreachable", describeFailure(error)),
      onSuccess: (seen) => actOn(app, seen, before, deps),
    }),
  );
});

/** Save and print the outcome; returns the saved state for the next step. */
const note = Effect.fn("Reconcile.note")(function* (
  app: string,
  state: Saved,
  status: ReconcileState["status"],
  detail: string,
  patch: Partial<ReconcileState> = {},
) {
  const next: Saved = { ...state, ...patch, status, detail };
  yield* (yield* StoreService).saveReconcile(next);
  yield* Console.log(`${app}: ${status}: ${detail}`);
  return next;
});

/** Decide for the head of `main` and carry out the verdict. */
const actOn = Effect.fn("Reconcile.actOn")(function* (
  app: string,
  main: Option.Option<{ readonly commit: string; readonly tree: string }>,
  before: Saved,
  deps: ReconcileDeps,
) {
  const store = yield* StoreService;
  if (Option.isNone(main)) {
    yield* note(app, before, "no-main", `${app}'s repository has no ${deployRef}`);
    return;
  }
  const seen = main.value;
  const state: Saved = { ...before, seenCommit: seen.commit, seenTree: seen.tree };
  const signoff = Option.fromNullishOr(
    (yield* store.listSignoffs(app)).find((row) => row.tree === seen.tree),
  );
  const verdict = decide({
    tree: seen.tree,
    triedTree: state.triedTree,
    signedOff: Option.isSome(signoff),
    tokenValid: Option.isSome(signoff) && (yield* deps.tokenValid),
  });
  const what = `commit ${short(seen.commit)} (tree ${short(seen.tree)})`;
  const waitForSignoff = () =>
    note(
      app,
      state,
      "waiting-signoff",
      `${what} has no signoff; run \`ops signoff ${short(seen.commit)}\``,
    );

  switch (verdict) {
    case "tried":
      // Keep the last outcome on show; only the time it was looked at moves.
      yield* store.saveReconcile(state);
      return;
    case "signoff":
      yield* waitForSignoff();
      return;
    case "login":
      yield* note(
        app,
        state,
        "waiting-login",
        `${what} is signed off; run \`ops login\` to release it`,
      );
      return;
    case "release": {
      // decide releases only a signed-off tree, so none here means the signoff went away.
      if (Option.isNone(signoff)) {
        yield* waitForSignoff();
        return;
      }
      const tried = { triedTree: seen.tree, triedCommit: seen.commit, triedJob: deps.jobId };
      yield* releaseTree(app, seen, signoff.value.id, deps).pipe(
        Effect.scoped,
        Effect.matchCauseEffect({
          onSuccess: (pinned) =>
            note(app, state, "released", `${what} released as ${pinned}`, {
              ...tried,
              triedResult: "released",
            }),
          onFailure: (cause) => {
            const message = Option.match(Cause.findErrorOption(cause), {
              onSome: describeFailure,
              onNone: () => Cause.pretty(cause),
            });
            return note(app, state, "failed", `${what}: ${message}`, {
              ...tried,
              triedResult: "failed",
            }).pipe(Effect.andThen(new JobCommandError({ message })));
          },
        }),
      );
    }
  }
});

/**
 * Export the tree, find or build its image, and plan then deploy the cartridge pinned to it.
 * Returns the pinned image reference.
 */
const releaseTree = Effect.fn("Reconcile.releaseTree")(function* (
  app: string,
  head: { readonly commit: string; readonly tree: string },
  signoffId: number,
  deps: ReconcileDeps,
) {
  const fs = yield* FileSystem.FileSystem;
  const store = yield* StoreService;
  const source = repositoryOf(deps.repositories, app);
  const work = yield* fs.makeTempDirectoryScoped();
  const tarFile = `${work}/tree.tar`;
  yield* Git.archiveOf(source, head.commit, tarFile);
  const exported = `${work}/tree`;
  yield* Git.unpack(tarFile, exported);

  const cartridgeFile = `${exported}/cartridge.json`;
  const cartridge = yield* Cartridge.decodeFile(cartridgeFile, Cartridge.AppCartridge);
  if (cartridge.name !== app) {
    return yield* new JobCommandError({
      message: `the repository's cartridge is '${cartridge.name}', not '${app}'`,
    });
  }
  const repositories = repositoriesOf(cartridge);
  if (repositories.length !== 1) {
    return yield* new JobCommandError({
      message: `cartridge.json must name one image to release; it names ${repositories.join(", ")}`,
    });
  }
  const repository = repositories[0];

  const find = store.findImage({ repository, key: head.tree });
  const digest = yield* Option.match(yield* find, {
    onSome: (known) => Effect.succeed(Option.some(known)),
    onNone: () =>
      runBuild(
        {
          repository,
          key: head.tree,
          jobId: deps.jobId,
          tarFile,
          memoryMaxMB: cartridge.build?.memoryMB ?? defaultBuildMemoryMB,
        },
        deps.site,
      ).pipe(Effect.andThen(find)),
  });
  if (Option.isNone(digest)) {
    return yield* new JobCommandError({ message: `the build recorded no image for ${repository}` });
  }
  const pinned = `${repository}@${digest.value}`;

  const pinnedFile = `${work}/cartridge.pinned.json`;
  yield* fs.writeFileString(
    pinnedFile,
    pinCartridgeText(yield* fs.readFileString(cartridgeFile), cartridge, pinned),
  );
  // The repository's root commit names it whatever its remotes are called (release.ts).
  const roots = yield* Exec.output("git", [
    "-C",
    source,
    "rev-list",
    "--max-parents=0",
    head.commit,
  ]);
  const env = {
    CARTRIDGE_FILE: pinnedFile,
    ORIGIN: roots.trim().split("\n").sort()[0],
    REVISION: head.commit,
    SIGNOFF: String(signoffId),
  };
  // A push to main is the approval, but the plan still checks the cartridge and its secrets
  // before anything deploys, as `ops release` does.
  yield* deps.stage("plan", app, env);
  yield* deps.stage("deploy", app, env);
  return pinned;
});

const short = (hash: string) => hash.slice(0, 12);

/** One line for a failure: its message when it has one, else its exit code or its tag. */
export const describeFailure = (error: {
  readonly _tag: string;
  readonly message?: string;
  readonly code?: number;
}): string => {
  if (error.message !== undefined && error.message !== "") return error.message;
  return error.code === undefined ? error._tag : `${error._tag} exited ${error.code}`;
};
