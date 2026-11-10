/**
 * Reconcile deploys the heads of an app's deploying branches (docs/design/continuous-deployment.md):
 * `main` releases the app live, and `develop` deploys its tailnet-only staged copy. The
 * `reconcile` job reads each branch in the app's repository on the control host, decides, and
 * either records why it waits or builds and deploys the tree with no prompt: a push is the
 * approval. A queue job runs it, so it takes turns with deploys.
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
import { liveRef, stagedRef } from "./Signoff.ts";

/** A branch reconcile watches, and the stage its head deploys to. */
export interface Target {
  readonly ref: string;
  /** The app's own name for the live release; `<app>-staged` for the staged copy. */
  readonly stage: string;
  readonly live: boolean;
}

/**
 * The app's targets, `main` first: the timer queues one reconcile job per target in this
 * order, and the queue runs jobs one at a time.
 */
export const targets = (app: string): readonly [live: Target, staged: Target] => [
  { ref: liveRef, stage: app, live: true },
  { ref: stagedRef, stage: `${app}${Cartridge.stagedSuffix}`, live: false },
];

/** What reconcile does with the tree at the head of a target's branch. */
export type Verdict =
  /** Reconcile already deployed or tried this tree; the next push or a retry tries again. */
  | "tried"
  /** No signoff for this tree. Not a try: the signoff arriving deploys it. */
  | "signoff"
  /** No valid token. Not a try: `ops login` lets the next run deploy it. */
  | "login"
  | "deploy";

/**
 * Decide from what reconcile can see, with no I/O. It compares the branch's tree with the last
 * tree it tried and never with what runs, so a rollback stays until `main` changes or
 * the operator retries. A retry deploys a tried tree again, as when a release failed for a
 * cause outside the tree; it still needs the signoff and the token.
 */
export const decide = (input: {
  readonly tree: string;
  readonly triedTree: string | null;
  readonly retry: boolean;
  readonly signedOff: boolean;
  readonly tokenValid: boolean;
}): Verdict => {
  if (input.tree === input.triedTree && !input.retry) return "tried";
  if (!input.signedOff) return "signoff";
  if (!input.tokenValid) return "login";
  return "deploy";
};

/**
 * The commit and tree at the head of `ref` in the bare repository `repository`, or none when
 * it has no such branch. Fails when the repository cannot be read. The operator owns the
 * repository and the runner reads it; the host's git config lists the folder in
 * `safe.directory`, without which git refuses a repository another user owns.
 */
export const readHead = Effect.fn("Reconcile.readHead")(function* (
  repository: string,
  ref: string,
) {
  const git = (...args: ReadonlyArray<string>) =>
    Exec.output("git", ["-C", repository, ...args]).pipe(Effect.map((text) => text.trim()));
  // A for-each-ref pattern also matches refs below it, such as refs/heads/main/x, so the
  // listing is filtered to the exact name.
  const listing = yield* git("for-each-ref", "--format=%(refname) %(objectname)", ref);
  const commit = listing
    .split("\n")
    .map((line) => line.split(" "))
    .find(([name]) => name === ref)?.[1];
  if (commit === undefined) return Option.none<{ commit: string; tree: string }>();
  return Option.some({ commit, tree: yield* git("rev-parse", `${commit}^{tree}`) });
});

/** The plan or deploy step failed; `message` is the reason its error gave. */
export class DeployFailed extends S.TaggedError<DeployFailed>()("DeployFailed", {
  message: S.String,
}) {}

/** What a reconcile job needs besides the store and the build services. */
export interface ReconcileDeps {
  /** The queue job that runs this reconcile; it names the build. */
  readonly jobId: number;
  /** Deploy each branch's tree even when reconcile already tried it (ReconcileSubmit `retry`). */
  readonly retry: boolean;
  /** The folder of the apps' bare repositories (queue/Paths.ts `repositoryOf`). */
  readonly repositories: string;
  readonly site: BuildSite;
  /** Whether the job holds a token OpenBao accepts. */
  readonly tokenValid: Effect.Effect<boolean>;
  /** Plan or deploy `stage` with `env` added: the cartridge file, the commit, and more. */
  readonly stage: (
    command: "plan" | "deploy",
    stage: string,
    env: Record<string, string>,
  ) => Effect.Effect<void, DeployFailed>;
}

type Saved = Omit<ReconcileState, "checkedAt">;
type Head = { readonly commit: string; readonly tree: string };

/**
 * Reconcile one stage of an app: record what its branch's head is, and deploy it when
 * {@link decide} says so. Fails the job, after recording the try, when a build or a deploy
 * fails.
 */
export const reconcileStage = Effect.fn("Reconcile.reconcileStage")(function* (
  stage: string,
  deps: ReconcileDeps,
) {
  const base = Cartridge.baseName(stage);
  const app = Option.getOrElse(base, () => stage);
  if (!(yield* Repositories.has(deps.repositories, app))) {
    return yield* new JobCommandError({
      message: `'${app}' has no repository on the control host; run \`ops repo create\` in its checkout`,
    });
  }
  const [live, staged] = targets(app);
  yield* reconcileTarget(app, Option.isSome(base) ? staged : live, deps);
});

const reconcileTarget = Effect.fn("Reconcile.reconcileTarget")(function* (
  app: string,
  target: Target,
  deps: ReconcileDeps,
) {
  const store = yield* StoreService;
  const before: Saved = Option.getOrElse(yield* store.getReconcile(target.stage), () => ({
    stage: target.stage,
    seenCommit: null,
    seenTree: null,
    triedTree: null,
    triedCommit: null,
    triedJob: null,
    status: "no-branch" as const,
    detail: "",
  }));
  // A repository that cannot be read is an outcome on show in `ops dash`, not a failed job:
  // the timer would add one every minute.
  yield* readHead(repositoryOf(deps.repositories, app), target.ref).pipe(
    Effect.matchEffect({
      onFailure: (error) => note(before, "unreachable", describeFailure(error)),
      onSuccess: (seen) => actOn(app, target, seen, before, deps),
    }),
  );
});

/** Save and print the outcome; returns the saved state for the next step. */
const note = Effect.fn("Reconcile.note")(function* (
  state: Saved,
  status: ReconcileState["status"],
  detail: string,
  patch: Partial<ReconcileState> = {},
) {
  const next: Saved = { ...state, ...patch, status, detail };
  yield* (yield* StoreService).saveReconcile(next);
  yield* Console.log(`${next.stage}: ${status}: ${detail}`);
  return next;
});

/** Decide for the head of the target's branch and carry out the verdict. */
const actOn = Effect.fn("Reconcile.actOn")(function* (
  app: string,
  target: Target,
  head: Option.Option<Head>,
  before: Saved,
  deps: ReconcileDeps,
) {
  const store = yield* StoreService;
  if (Option.isNone(head)) {
    yield* note(before, "no-branch", `${app}'s repository has no ${target.ref}`);
    return;
  }
  const seen = head.value;
  const state: Saved = { ...before, seenCommit: seen.commit, seenTree: seen.tree };
  const signoff = Option.fromNullishOr(
    (yield* store.listSignoffs(app)).find((row) => row.tree === seen.tree),
  );
  const verdict = decide({
    tree: seen.tree,
    triedTree: state.triedTree,
    retry: deps.retry,
    signedOff: Option.isSome(signoff),
    tokenValid: Option.isSome(signoff) && (yield* deps.tokenValid),
  });
  const what = `commit ${short(seen.commit)} (tree ${short(seen.tree)})`;
  const waitForSignoff = () =>
    note(
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
      yield* note(state, "waiting-login", `${what} is signed off; run \`ops login\` to deploy it`);
      return;
    case "deploy": {
      // decide deploys only a signed-off tree, so none here means the signoff went away.
      if (Option.isNone(signoff)) {
        yield* waitForSignoff();
        return;
      }
      const tried = { triedTree: seen.tree, triedCommit: seen.commit, triedJob: deps.jobId };
      const done = target.live ? "released" : "staged";
      yield* deployTree(app, target, seen, signoff.value.id, deps).pipe(
        Effect.scoped,
        Effect.matchCauseEffect({
          onSuccess: (pinned) => note(state, done, `${what} ${done} as ${pinned}`, tried),
          onFailure: (cause) => {
            const message = Option.match(Cause.findErrorOption(cause), {
              onSome: describeFailure,
              onNone: () => Cause.pretty(cause),
            });
            return note(state, "failed", `${what}: ${message}`, tried).pipe(
              Effect.andThen(new JobCommandError({ message })),
            );
          },
        }),
      );
    }
  }
});

/**
 * Export the tree, find or build its image, and plan then deploy the cartridge pinned to it.
 * The live stage records the release with its repository, commit and signoff; the staged copy
 * runs the image as STAGED_IMAGE and records nothing. Returns the pinned image reference.
 */
const deployTree = Effect.fn("Reconcile.deployTree")(function* (
  app: string,
  target: Target,
  head: Head,
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
  const env: Record<string, string> = target.live
    ? {
        CARTRIDGE_FILE: pinnedFile,
        ORIGIN: yield* rootCommit(source, head.commit),
        REVISION: head.commit,
        SIGNOFF: String(signoffId),
      }
    : { CARTRIDGE_FILE: pinnedFile, REVISION: head.commit, STAGED_IMAGE: pinned };
  // A push is the approval, but the plan still checks the cartridge and its secrets before
  // anything deploys.
  yield* deps.stage("plan", target.stage, env);
  yield* deps.stage("deploy", target.stage, env);
  return pinned;
});

/** The repository's root commit, which names it whatever its remotes are called. */
const rootCommit = (repository: string, commit: string) =>
  Exec.output("git", ["-C", repository, "rev-list", "--max-parents=0", commit]).pipe(
    Effect.map((roots) => roots.trim().split("\n").sort()[0]),
  );

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
