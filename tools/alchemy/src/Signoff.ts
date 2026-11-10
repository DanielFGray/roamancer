/**
 * Workstation `ops signoff`: run an app's `scripts/verify` on one commit's exported tree, and
 * record on the control host that the tree passed. Reconcile deploys `main` and `develop` only
 * when their tree has a signoff (docs/design/continuous-deployment.md).
 *
 * What verify checks is the project's own choice; the platform only needs it to exit 0.
 *
 * `ops signoff install` writes a git pre-push hook that runs `ops signoff pre-push`. Before a
 * push of `main` or `develop` to any remote, it runs verify on each pushed tree that has no
 * signoff yet and records it, so a tree whose verify fails never leaves the machine on those
 * branches. A tree that already has a signoff is not verified again.
 */
import { createHash } from "node:crypto";
import { Console, Effect, FileSystem, Option, Stdio, Stream } from "effect";
import { Argument, Command } from "effect/cli";
import { ChildProcess } from "effect/process";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import * as Cartridge from "./Cartridge.ts";
import { OpsError, output } from "./Exec.ts";
import * as Git from "./Git.ts";
import { Remote, type SignoffSend } from "./Remote.ts";

/** The branch reconcile releases live. */
export const liveRef = "refs/heads/main";
/** The branch reconcile deploys to the app's staged copy. */
export const stagedRef = "refs/heads/develop";
/** The branches whose pushes deploy, so a push to either needs a signoff. */
export const deployRefs: ReadonlyArray<string> = [liveRef, stagedRef];

const folder = Argument.String("folder").pipe(
  Argument.withDescription("The app's git repository, with cartridge.json and scripts/verify"),
  Argument.withDefault("."),
);

const signoff = Command.make(
  "signoff",
  {
    folder,
    commit: Argument.String("commit").pipe(
      Argument.withDescription("The commit to verify and sign off"),
      Argument.withDefault("HEAD"),
    ),
  },
  Effect.fn(function* ({ folder, commit }) {
    yield* send(yield* verify(folder, commit));
  }),
).pipe(
  Command.withDescription(
    "Run scripts/verify on a commit's exported tree, and record on the control host that it passed",
  ),
  Command.withSubcommands([
    Command.make(
      "list",
      {
        app: Argument.String("app").pipe(Argument.withDescription("The cartridge name to list")),
      },
      Effect.fn(function* ({ app }) {
        const rows = yield* (yield* Remote).listSignoffs(app);
        for (const row of rows) {
          const firstLine = row.summary.split(/\r?\n/, 1)[0] ?? "";
          yield* Console.log(
            `${row.createdAt} ${row.tree.slice(0, 12)} ${row.commit.slice(0, 12)} ${firstLine}`,
          );
        }
      }),
    ).pipe(Command.withDescription("List an app's signoffs on the control host, newest first")),
    Command.make(
      "install",
      { folder },
      Effect.fn(function* ({ folder }) {
        const refused = yield* installHook(folder);
        if (Option.isSome(refused)) return yield* new OpsError({ message: refused.value });
      }),
    ).pipe(
      Command.withDescription(
        "Write a pre-push hook in this repository that verifies and signs off each pushed main or develop tree",
      ),
    ),
    Command.make(
      "pre-push",
      {
        // Git passes a pre-push hook the remote's name and URL. Every remote gets the same
        // check, so neither is read; the hook passes them so its text never has to change.
        remote: Argument.String("remote").pipe(
          Argument.withDescription("The remote's name, which git passes to a pre-push hook"),
        ),
        url: Argument.String("url").pipe(
          Argument.withDescription("The URL the push goes to, which git passes to a pre-push hook"),
        ),
        folder,
      },
      Effect.fn(function* ({ folder }) {
        const stdin = yield* Stdio.Stdio;
        const lines = yield* Stream.mkString(Stream.decodeText(stdin.stdin)).pipe(
          Effect.mapError(
            (error) => new OpsError({ message: `read the hook's stdin: ${error.message}` }),
          ),
        );
        for (const commit of deployPushes(lines)) yield* ensureSignoff(folder, commit);
      }),
    ).pipe(
      Command.withDescription(
        "The pre-push hook's body: verify and sign off each pushed main or develop tree that has no signoff",
      ),
    ),
  ]),
);

/** The signoff commands, registered under `ops` with the release commands. */
export const commands = [signoff];

/**
 * The commits a push sends to `main` or `develop`, from the lines git gives a pre-push hook on stdin
 * (`<local ref> <local sha> <remote ref> <remote sha>`). A deletion sends no commit.
 */
export const deployPushes = (stdin: string): ReadonlyArray<string> => {
  const commits = stdin
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter(
      ([, local, remote]) =>
        remote !== undefined &&
        deployRefs.includes(remote) &&
        local !== undefined &&
        !/^0+$/.test(local),
    )
    .map(([, local]) => local!);
  return [...new Set(commits)];
};

/** Last 20 lines of `text`, ANSI removed, at most 4096 bytes (the end of that slice when longer). */
export const summarizeLog = (text: string): string => {
  const cleaned = text.replace(ansi, "");
  const lines = cleaned.split(/\r?\n/);
  const last = lines.slice(-20).join("\n");
  const bytes = Buffer.from(last, "utf8");
  if (bytes.length <= 4096) return last;
  // Prefer the end of the last-20 block: that is where test failures usually sit.
  return bytes.subarray(bytes.length - 4096).toString("utf8");
};

/**
 * Export `commit`'s tree, run its `scripts/worktree-setup` (when present) and `scripts/verify`
 * there, and return the signoff record to send. The export holds only committed files, so uncommitted edits,
 * ignored files such as `.env`, and the checkout's `node_modules` cannot change the result:
 * the record says exactly which tree passed. The export has no `.git`.
 */
const verify = Effect.fn("Signoff.verify")(function* (folder: string, commit: string) {
  const fs = yield* FileSystem.FileSystem;
  const sha = (yield* output("git", [
    "-C",
    folder,
    "rev-parse",
    "--verify",
    `${commit}^{commit}`,
  ])).trim();
  const tree = (yield* output("git", ["-C", folder, "rev-parse", `${sha}^{tree}`])).trim();
  const exported = yield* fs.makeTempDirectoryScoped();
  yield* Git.exportTree(folder, sha, exported, "to verify");
  const cartridge = yield* Cartridge.decodeFile(
    `${exported}/cartridge.json`,
    Cartridge.AppCartridge,
  );
  if (!(yield* fs.exists(`${exported}/scripts/verify`))) {
    return yield* new OpsError({
      message: `${cartridge.name} has no scripts/verify at ${sha.slice(0, 12)}; commit an executable script that runs its checks`,
    });
  }
  if (yield* fs.exists(`${exported}/scripts/worktree-setup`)) {
    yield* script(exported, "scripts/worktree-setup");
  }
  const log = yield* script(exported, "scripts/verify");
  return {
    app: cartridge.name,
    tree,
    commit: sha,
    summary: summarizeLog(log),
    logSha256: createHash("sha256").update(log, "utf8").digest("hex"),
  };
}, Effect.scoped);

/** Store `record` on the control host. */
const send = Effect.fn("Signoff.send")(function* (record: SignoffSend) {
  const id = yield* (yield* Remote).signoff(record);
  yield* Console.error(`Signed off ${record.app} tree ${record.tree.slice(0, 12)} (signoff ${id})`);
});

/**
 * Run `./<path>` in `directory`, show its output on standard error as it runs, and return
 * that output. Standard output stays free for what `ops` prints, and git shows a hook's
 * standard error to the person pushing.
 */
const script = Effect.fn("Signoff.script")(function* (directory: string, path: string) {
  const spawner = yield* ChildProcessSpawner;
  const failed = (error: { readonly message: string }) =>
    new OpsError({ message: `${path} could not run: ${error.message}` });
  const handle = yield* spawner
    .spawn(ChildProcess.make(`./${path}`, [], { cwd: directory, stdin: "ignore" }))
    .pipe(Effect.mapError(failed));
  const text = yield* handle.all.pipe(
    Stream.decodeText,
    Stream.tap((chunk) => Effect.sync(() => process.stderr.write(chunk))),
    Stream.mkString,
    Effect.mapError(failed),
  );
  const code = yield* handle.exitCode.pipe(Effect.mapError(failed));
  if (code !== 0) {
    return yield* new OpsError({ message: `${path} exited ${code}; nothing was signed off` });
  }
  return text;
}, Effect.scoped);

/**
 * Give `commit`'s tree a signoff unless the control host has one: run verify on it and
 * record the result, so a failing verify refuses the push. Commits with the same tree are
 * verified once, because the second finds the first's record. A host that does not answer
 * only warns and lets the push through: afterwards reconcile still waits for a signoff.
 */
const ensureSignoff = Effect.fn("Signoff.ensureSignoff")(function* (
  folder: string,
  commit: string,
) {
  const cartridge = yield* Cartridge.decodeText(
    yield* output("git", ["-C", folder, "show", `${commit}:cartridge.json`]),
    Cartridge.AppCartridge,
  );
  const tree = (yield* output("git", ["-C", folder, "rev-parse", `${commit}^{tree}`])).trim();
  const signoffs = yield* (yield* Remote).listSignoffs(cartridge.name).pipe(
    Effect.map(Option.some),
    Effect.catchTag("OpsError", (error) =>
      Console.error(
        `ops signoff: ${error.message}\nThe push continues: the control host did not answer, so tree ${tree.slice(0, 12)} was not checked. Reconcile deploys it only after a signoff.`,
      ).pipe(Effect.as(Option.none<ReadonlyArray<{ readonly tree: string }>>())),
    ),
  );
  if (Option.isNone(signoffs) || signoffs.value.some((row) => row.tree === tree)) return;
  yield* Console.error(
    `${cartridge.name} tree ${tree.slice(0, 12)} has no signoff; running scripts/verify before the push`,
  );
  yield* send(yield* verify(folder, commit));
});

/** The hook `install` writes; the marker line lets `install` replace its own hook only. */
const hookMarker = "# Written by `ops signoff install`.";
const hook = `#!/bin/sh
${hookMarker} Before a push of main or develop, it runs
# scripts/verify on each pushed tree with no signoff on the control host and records the
# signoff, so a failing verify refuses the push. It passes git's arguments (remote name and
# URL) on unchanged, so the check can change without a new hook. \`git push --no-verify\`
# skips it, and reconcile still waits for a signoff.
exec ops signoff pre-push "$@"
`;

/**
 * Write the pre-push hook where git looks for it: `--git-path` follows `core.hooksPath`, and
 * linked worktrees share the main checkout's hooks. Another tool's hook, such as a hook
 * manager's, is left as it is, because that tool rewrites it: the result is then the line to
 * add to that tool's configuration. None means the hook was written.
 */
export const installHook = Effect.fn("Signoff.installHook")(function* (folder: string) {
  const fs = yield* FileSystem.FileSystem;
  const relative = (yield* output("git", [
    "-C",
    folder,
    "rev-parse",
    "--git-path",
    "hooks/pre-push",
  ])).trim();
  const path = relative.startsWith("/") ? relative : `${folder}/${relative}`;
  if (yield* fs.exists(path)) {
    const existing = yield* fs.readFileString(path);
    if (!existing.includes(hookMarker)) {
      return Option.some(
        `${path} is another tool's pre-push hook; add \`ops signoff pre-push\` to that tool's pre-push commands`,
      );
    }
  }
  yield* fs.makeDirectory(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  yield* fs.writeFileString(path, hook);
  yield* fs.chmod(path, 0o755);
  yield* Console.error(`Wrote ${path}`);
  return Option.none<string>();
});

/** CSI / OSC ANSI sequences; stripped before the summary is truncated. */
const esc = String.fromCharCode(0x1b);
const bel = String.fromCharCode(0x07);
const ansi = new RegExp(
  `${esc}(?:\\[[0-9;?]*[ -/]*[@-~]|\\][^${bel}${esc}]*(?:${bel}|${esc}\\\\))`,
  "g",
);
