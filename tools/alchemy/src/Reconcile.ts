/**
 * Reconcile releases the head of an app's `main` (docs/design/continuous-deployment.md). The
 * `reconcile` job reads `main` with the app's deploy key, decides, and either records why it
 * waits or builds and deploys the tree the way `ops release` does, without the prompt: a push
 * to `main` is the approval. A queue job runs it, so it takes turns with deploys.
 */
import { Cause, Console, Effect, FileSystem, Option, Schema as S } from "effect";
import { defaultBuildMemoryMB } from "./BuildLimits.ts";
import { runBuild, type BuildSite } from "./BuildJob.ts";
import * as Cartridge from "./Cartridge.ts";
import * as Exec from "./Exec.ts";
import * as Git from "./Git.ts";
import { apps, type Deploy, type Policy } from "./Policy.ts";
import { JobCommandError } from "./queue/Run.ts";
import type { Reconcile as ReconcileState } from "./queue/Store.ts";
import { Store as StoreService } from "./queue/Store.ts";
import { pinCartridgeText, repositoriesOf } from "./ReleaseImage.ts";
import { deployRef } from "./Signoff.ts";

/** What reconcile does with the tree at the head of `main`. */
export type Verdict =
  /** The policy says `manual`: only `ops release` releases this app. */
  | "manual"
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
  readonly deploy: Deploy;
  readonly tree: string;
  readonly triedTree: string | null;
  readonly signedOff: boolean;
  readonly tokenValid: boolean;
}): Verdict => {
  if (input.deploy === "manual") return "manual";
  if (input.tree === input.triedTree) return "tried";
  if (!input.signedOff) return "signoff";
  if (!input.tokenValid) return "login";
  return "release";
};

/** The environment git needs to read a repository with the deploy key in `keyFile`. */
export const sshEnvironment = (keyFile: string): Record<string, string> => ({
  GIT_SSH_COMMAND: `ssh -i ${keyFile} -o IdentitiesOnly=yes -o BatchMode=yes`,
  GIT_TERMINAL_PROMPT: "0",
});

/** The deploy key of `app` inside the keys folder. */
export const keyFile = (keysDir: string, app: string) => `${keysDir}/${app}`;

/** The commit at the head of `main` in `url`, or none when the repository has no such branch. */
export const remoteHead = Effect.fn("Reconcile.remoteHead")(function* (
  url: string,
  env: Record<string, string>,
) {
  const listing = yield* Exec.output("git", ["ls-remote", "--", url, deployRef], undefined, env);
  const [commit, ref] = listing.trim().split("\n")[0]?.split(/\s+/) ?? [];
  return commit !== undefined && ref === deployRef && /^[0-9a-f]{40,64}$/.test(commit)
    ? Option.some(commit)
    : Option.none<string>();
});

/**
 * Fetch `main` of `url` into the bare repository `cache` (made on the first fetch) and return
 * its commit and tree. The fetch brings the whole history, not one commit: the release
 * records the repository's root commit as the app's origin (release.ts), and a shallow
 * clone's oldest commit is not the root. Later fetches bring only what is new.
 */
export const fetchHead = Effect.fn("Reconcile.fetchHead")(function* (
  cache: string,
  url: string,
  env: Record<string, string>,
) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(cache))) {
    yield* fs.makeDirectory(cache, { recursive: true });
    yield* Exec.run("git", ["init", "--bare", "--quiet", cache]);
  }
  yield* Exec.run(
    "git",
    [
      "-C",
      cache,
      "fetch",
      "--quiet",
      "--no-tags",
      "--force",
      "--",
      url,
      `${deployRef}:refs/reconcile/main`,
    ],
    env,
  );
  const git = (...args: ReadonlyArray<string>) =>
    Exec.output("git", ["-C", cache, ...args]).pipe(Effect.map((text) => text.trim()));
  const commit = yield* git("rev-parse", "refs/reconcile/main");
  const tree = yield* git("rev-parse", `${commit}^{tree}`);
  return { commit, tree };
});

/** `ops release`'s plan or deploy step failed; `message` is the reason its error gave. */
export class ReleaseFailed extends S.TaggedError<ReleaseFailed>()("ReleaseFailed", {
  message: S.String,
}) {}

/** What a reconcile job needs besides the store and the build services. */
export interface ReconcileDeps {
  readonly policy: Policy;
  /** The queue job that runs this reconcile; it names the release's build. */
  readonly jobId: number;
  /** The folder of bare repositories, one per app. */
  readonly cacheDir: string;
  readonly site: BuildSite;
  /** The environment for git when it reads `app`'s repository. */
  readonly gitEnvironment: (app: string) => Record<string, string>;
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
  const entry = apps(deps.policy).find((candidate) => candidate.app === app);
  if (entry === undefined) {
    return yield* new JobCommandError({
      message: `'${app}' is not in the site policy (policy.toml). Add it and run \`ops rebuild\`.`,
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
  if (entry.deploy === "manual") {
    yield* note(
      app,
      before,
      "manual",
      "the site policy sets deploy = manual; release it with `ops release`",
    );
    return;
  }

  // A repository that cannot be read (no deploy key on GitHub yet, no network) is an outcome
  // on show in `ops dash`, not a failed job: the timer would add one every minute.
  yield* readMain(
    entry.repository,
    `${deps.cacheDir}/${app}.git`,
    deps.gitEnvironment(app),
    before,
  ).pipe(
    Effect.matchEffect({
      onFailure: (error) => note(app, before, "unreachable", describeFailure(error)),
      onSuccess: (seen) => actOn(app, entry.deploy, seen, before, deps),
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
  deploy: Deploy,
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
    deploy,
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
    case "manual":
      return;
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
 * The commit and tree at the head of `main`, or none. Reconcile fetches only when the head
 * differs from the one it saw last, so a quiet minute costs one `git ls-remote`.
 */
const readMain = Effect.fn("Reconcile.readMain")(function* (
  url: string,
  cache: string,
  env: Record<string, string>,
  seen: { readonly seenCommit: string | null; readonly seenTree: string | null },
) {
  const head = yield* remoteHead(url, env);
  if (Option.isNone(head)) return Option.none<{ commit: string; tree: string }>();
  if (seen.seenCommit === head.value && seen.seenTree !== null) {
    return Option.some({ commit: head.value, tree: seen.seenTree });
  }
  return Option.some(yield* fetchHead(cache, url, env));
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
  const cache = `${deps.cacheDir}/${app}.git`;
  const work = yield* fs.makeTempDirectoryScoped();
  const tarFile = `${work}/tree.tar`;
  yield* Git.archiveOf(cache, head.commit, tarFile);
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
    cache,
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
