import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunServices from "@effect/platform-bun/BunServices";
import { ConfigProvider, Effect, Layer, Option, Sink, Stdio, Stream } from "effect";
import { Command } from "effect/cli";
import { ChildProcess } from "effect/process";
import * as Spawner from "effect/process/ChildProcessSpawner";
import { TestConsole } from "effect/testing";
import { Builder, type BuildImage } from "./Builder.ts";
import { OpsError } from "./Exec.ts";
import * as Git from "./Git.ts";
import { commands } from "./release.ts";
import { Remote } from "./Remote.ts";
import { Site } from "./Site.ts";

const digest = `sha256:${"d".repeat(64)}`;
const giglist = new URL("../examples/apps/giglist/cartridge.json", import.meta.url).pathname;
/** The one image repository the giglist example names. */
const repositoryName = (
  JSON.parse(readFileSync(giglist, "utf8")) as { services: Array<{ image: string }> }
).services[0].image
  .replace(/@.*$/, "")
  .replace(/:[^/:]+$/, "");

describe("release commands and the image key", () => {
  it("stage reuses the image the host recorded for HEAD's tree, by digest alone", async () => {
    const { builds, lookups, records, submitted, tree } = await runOps("stage", {
      recorded: Option.some(digest),
    });
    assert.deepEqual(builds, []);
    assert.deepEqual(records, []);
    assert.deepEqual(lookups, [tree]);
    const images = submitted.map((job) => job.stagedImage);
    assert.ok(images.length > 0);
    assert.deepEqual(new Set(images), new Set([`${repositoryName}@${digest}`]));
  });

  it("stage builds when the host recorded no image for the tree, and sends no record: the runner records after its registry check", async () => {
    const { builds, records, tree } = await runOps("stage", { recorded: Option.none() });
    assert.deepEqual(builds, [{ repository: repositoryName, key: tree }]);
    assert.deepEqual(records, []);
  });

  it("promote refuses and builds nothing when no image has HEAD's tree", async () => {
    const { builds, submitted, error } = await runOps("promote", { recorded: Option.none() });
    assert.ok(error instanceof OpsError);
    assert.match(error.message, /Run `ops stage` first/);
    assert.deepEqual(builds, []);
    assert.deepEqual(submitted, []);
  });
});

/** The git tree hash of HEAD in `repository`. */
const treeOf = (repository: string) =>
  execFileSync("git", ["-C", repository, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();

/** A committed app repository holding the giglist example cartridge. */
const appRepository = () => {
  const dir = mkdtempSync(join(tmpdir(), "release-app-"));
  copyFileSync(giglist, join(dir, "cartridge.json"));
  writeFileSync(join(dir, "Dockerfile"), "FROM scratch\n");
  const git = (...args: Array<string>) => execFileSync("git", ["-C", dir, ...args]);
  git("init", "-q");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "app");
  return dir;
};

/**
 * Run `ops <command> --yes <app repository>` with a fake Builder and a fake control host.
 * git against the app repository and tar run for real, because the commands export and read
 * the committed tree; ssh and git against the platform checkout (the runner revision check)
 * are recorded and answered.
 */
const runOps = (command: string, options: { readonly recorded: Option.Option<string> }) => {
  const repository = appRepository();
  const tree = treeOf(repository);
  const site = mkdtempSync(join(tmpdir(), "release-site-"));
  writeFileSync(join(site, "site.toml"), '[cluster]\nserver = "ctl"\nlanAddress = "10.0.0.2"\n');
  const builds: Array<BuildImage> = [];
  const lookups: Array<string> = [];
  const inputs: Array<string> = [];
  const builder = Layer.succeed(Builder, {
    build: (_tree: string, image: BuildImage) =>
      Effect.sync(() => {
        builds.push(image);
        return `${image.repository}:${image.key}@${digest}`;
      }),
  });
  const program = Effect.gen(function* () {
    const real = yield* Spawner.ChildProcessSpawner;
    const spawner = Spawner.make((spawned) => {
      if (ChildProcess.isStandardCommand(spawned) && runsForReal(spawned)) {
        return real.spawn(spawned);
      }
      return Effect.gen(function* () {
        const line = ChildProcess.isStandardCommand(spawned)
          ? [spawned.command, ...spawned.args].join(" ")
          : "(piped)";
        const stdin = ChildProcess.isStandardCommand(spawned) ? spawned.options.stdin : undefined;
        if (Stream.isStream(stdin)) inputs.push(yield* Stream.mkString(Stream.decodeText(stdin)));
        const find = line.match(/'image' 'find' '[^']+' '([0-9a-f]+)'$/);
        if (find !== null) {
          lookups.push(find[1]);
          return handle(Option.getOrElse(options.recorded, () => ""));
        }
        return handle(line.endsWith("version") ? "abc123\n" : line.endsWith("submit") ? "4\n" : "");
      });
    });
    const ops = Command.make("ops").pipe(Command.withSubcommands(commands));
    return yield* Command.runWith(ops, { version: "1" })([command, "--yes", repository]).pipe(
      Effect.as(undefined),
      Effect.catch((failure) => Effect.succeed(failure)),
      Effect.provide(
        Layer.mergeAll(builder, Remote.layer).pipe(
          Layer.provideMerge(Site.layer),
          Layer.provideMerge(
            Layer.mergeAll(
              Layer.succeed(Spawner.ChildProcessSpawner, spawner),
              Stdio.layerTest({ stdinIsTerminal: Effect.succeed(false) }),
              ConfigProvider.layer(ConfigProvider.fromEnvRecord({ OPS_SITE: site })),
            ),
          ),
        ),
      ),
    );
  });
  return program.pipe(
    Effect.scoped,
    Effect.provide(TestConsole.layer),
    Effect.provide(BunServices.layer),
    Effect.ensuring(
      Effect.sync(() => {
        rmSync(repository, { recursive: true, force: true });
        rmSync(site, { recursive: true, force: true });
      }),
    ),
    Effect.runPromise,
    (outcome) =>
      outcome.then((error) => ({
        builds,
        lookups,
        tree,
        error,
        records: inputs
          .map((input) => JSON.parse(input) as { _tag: string })
          .filter((request) => request._tag === "recordImage"),
        submitted: inputs
          .map((input) => JSON.parse(input) as { stagedImage?: string | null })
          .filter((job) => "stagedImage" in job),
      })),
  );
};

/** git outside the platform checkout, and tar, which unpacks the exported tree. */
const runsForReal = (command: ChildProcess.StandardCommand) =>
  command.command === "tar" ||
  (command.command === "git" && !(command.args[0] === "-C" && command.args[1] === Git.repository));

const handle = (stdout: string) =>
  Spawner.makeHandle({
    pid: Spawner.ProcessId(1),
    exitCode: Effect.succeed(Spawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    stdout: Stream.make(new TextEncoder().encode(stdout)),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
