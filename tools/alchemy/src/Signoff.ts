/**
 * Workstation `ops signoff`: refuse a dirty or unpushed tree, summarize the test log, and
 * record the signoff on the control host. Listing is `ops signoff list <app>`.
 */
import { createHash } from "node:crypto";
import { Console, Effect, FileSystem } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import * as Cartridge from "./Cartridge.ts";
import { OpsError, output, succeeds } from "./Exec.ts";
import { Remote } from "./Remote.ts";

const folder = Argument.String("folder").pipe(
  Argument.withDescription(
    "The app's git repository with cartridge.json; its committed HEAD is signed off",
  ),
  Argument.withDefault("."),
);

const logFlag = Flag.String("log").pipe(
  Flag.withDescription("The test log whose last lines become the stored summary"),
);

/** CSI / OSC ANSI sequences; stripped before the summary is truncated. */
const esc = String.fromCharCode(0x1b);
const bel = String.fromCharCode(0x07);
const ansi = new RegExp(
  `${esc}(?:\\[[0-9;?]*[ -/]*[@-~]|\\][^${bel}${esc}]*(?:${bel}|${esc}\\\\))`,
  "g",
);

/**
 * Last 20 lines of `text`, ANSI removed, at most 4096 bytes (the end of that slice when longer).
 */
export const summarizeLog = (text: string): string => {
  const cleaned = text.replace(ansi, "");
  const lines = cleaned.split(/\r?\n/);
  const last = lines.slice(-20).join("\n");
  const bytes = Buffer.from(last, "utf8");
  if (bytes.length <= 4096) return last;
  // Prefer the end of the last-20 block: that is where test failures usually sit.
  return bytes.subarray(bytes.length - 4096).toString("utf8");
};

const signoffList = Command.make(
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
).pipe(Command.withDescription("List an app's signoffs on the control host, newest first"));

const signoff = Command.make(
  "signoff",
  { folder, log: logFlag },
  Effect.fn(function* ({ folder, log: logPath }) {
    yield* refuseDirty(folder);
    yield* refuseUnpushed(folder);
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(logPath);
    if (!exists) {
      return yield* new OpsError({
        message: `log file ${logPath} is missing; run the tests and pass --log <file>`,
      });
    }
    const logText = yield* fs.readFileString(logPath);
    if (logText.length === 0) {
      return yield* new OpsError({
        message: `log file ${logPath} is empty; run the tests and pass a non-empty --log`,
      });
    }
    const cartridge = yield* Cartridge.decodeFile(
      `${folder}/cartridge.json`,
      Cartridge.AppCartridge,
    );
    const tree = (yield* output("git", ["-C", folder, "rev-parse", "HEAD^{tree}"])).trim();
    const commit = (yield* output("git", ["-C", folder, "rev-parse", "HEAD"])).trim();
    const summary = summarizeLog(logText);
    const logSha256 = createHash("sha256").update(logText, "utf8").digest("hex");
    const id = yield* (yield* Remote).signoff({
      app: cartridge.name,
      tree,
      commit,
      summary,
      logSha256,
    });
    yield* Console.log(`Signed off ${cartridge.name} tree ${tree.slice(0, 12)} (signoff ${id})`);
  }),
).pipe(
  Command.withDescription(
    "Record that this repository's HEAD passed its tests; refuses a dirty or unpushed tree",
  ),
  Command.withSubcommands([signoffList]),
);

/** The signoff commands, registered under `ops` with the release commands. */
export const commands = [signoff];

/** Refuse when tracked files differ from HEAD; untracked files (the log) are allowed. */
const refuseDirty = Effect.fn("Signoff.refuseDirty")(function* (folder: string) {
  const clean = yield* succeeds("git", ["-C", folder, "diff", "--quiet", "HEAD"]);
  if (!clean) {
    return yield* new OpsError({
      message: "tracked files differ from HEAD; commit or stash them before signing off",
    });
  }
});

/**
 * Fetch the push remote once, then refuse unless HEAD is an ancestor of @{push}. No @{push}
 * is a refusal: the commit must already be on the remote the developer pushes to.
 */
const refuseUnpushed = Effect.fn("Signoff.refuseUnpushed")(function* (folder: string) {
  const hasPush = yield* succeeds("git", [
    "-C",
    folder,
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{push}",
  ]);
  if (!hasPush) {
    return yield* new OpsError({
      message:
        "HEAD has no @{push} upstream; set the branch's push remote and push before signing off",
    });
  }
  const pushRef = (yield* output("git", [
    "-C",
    folder,
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{push}",
  ])).trim();
  const remote = pushRef.split("/")[0];
  if (remote === undefined || remote === "") {
    return yield* new OpsError({
      message: `could not read the push remote from @{push} (${pushRef})`,
    });
  }
  yield* output("git", ["-C", folder, "fetch", "--quiet", remote]);
  const onRemote = yield* succeeds("git", [
    "-C",
    folder,
    "merge-base",
    "--is-ancestor",
    "HEAD",
    "@{push}",
  ]);
  if (!onRemote) {
    return yield* new OpsError({
      message: "HEAD is not on the push remote; push this commit before signing off",
    });
  }
});
