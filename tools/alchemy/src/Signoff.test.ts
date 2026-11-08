import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import * as BunServices from "@effect/platform-bun/BunServices";
import { ConfigProvider, Effect, FileSystem, Layer, Option, Sink, Stdio, Stream } from "effect";
import { TestConsole } from "effect/testing";
import { ChildProcess } from "effect/process";
import { Command } from "effect/cli";
import * as Spawner from "effect/process/ChildProcessSpawner";
import { OpsError } from "./Exec.ts";
import { Remote } from "./Remote.ts";
import { commands as signoffCommands, summarizeLog } from "./Signoff.ts";
import { Site } from "./Site.ts";

describe("summarizeLog", () => {
  const cases: Array<{ name: string; input: string; want: string }> = [
    {
      name: "keeps the last 20 lines",
      input: Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join("\n"),
      want: Array.from({ length: 20 }, (_, i) => `line ${i + 6}`).join("\n"),
    },
    {
      name: "strips ANSI color codes",
      input: "\x1b[32mpass\x1b[0m\n\x1b[31mfail\x1b[0m",
      want: "pass\nfail",
    },
    {
      name: "truncates to the last 4096 bytes of the last 20 lines",
      input: `${"x".repeat(5000)}\n${"y".repeat(5000)}`,
      want: "y".repeat(4096),
    },
  ];

  for (const { name, input, want } of cases) {
    it(name, () => {
      assert.equal(summarizeLog(input), want);
    });
  }
});

describe("ops signoff refusals", () => {
  const signoff = signoffCommands[0]!;
  const run = (repo: string) =>
    Command.runWith(signoff, { version: "test" })(["--log", join(repo, "test.log"), repo]);

  it("refuses when a tracked file differs from HEAD", async () => {
    const repo = gitFixture();
    try {
      writeFileSync(join(repo, "cartridge.json"), `${cartridgeJson.slice(0, -2)} \n`);
      const { error, log } = await execute(run(repo));
      assert.ok(error instanceof OpsError);
      assert.match(error.message, /tracked files differ from HEAD/);
      assert.ok(!log.some((line) => line.includes("alchemy-runner signoff")));
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(join(repo, ".."), { recursive: true, force: true });
    }
  });

  it("refuses when HEAD is not on @{push}", async () => {
    const repo = gitFixture();
    try {
      writeFileSync(join(repo, "extra.txt"), "x\n");
      git(repo, "add", "extra.txt");
      git(repo, "commit", "-m", "local only");
      writeFileSync(join(repo, "test.log"), "ok\n");
      const { error, log } = await execute(run(repo));
      assert.ok(error instanceof OpsError);
      assert.match(error.message, /not on the push remote/);
      assert.ok(!log.some((line) => line.includes("alchemy-runner signoff")));
    } finally {
      rmSync(join(repo, ".."), { recursive: true, force: true });
    }
  });

  it("refuses an empty log file", async () => {
    const repo = gitFixture();
    try {
      writeFileSync(join(repo, "test.log"), "");
      const { error, log } = await execute(run(repo));
      assert.ok(error instanceof OpsError);
      assert.match(error.message, /empty/);
      assert.ok(!log.some((line) => line.includes("alchemy-runner signoff")));
    } finally {
      rmSync(join(repo, ".."), { recursive: true, force: true });
    }
  });
});

const cartridgeJson = JSON.stringify(
  {
    apiVersion: "server-ansible/v2",
    name: "signoff-probe",
    postgres: [],
    services: [
      {
        name: "signoff-probe-api",
        image: "registry.cluster:5000/signoff-probe:dev",
        hostPort: "dynamic",
        containerPort: 3000,
        cpu: 100,
        memoryMB: 128,
        networkMode: "bridge",
        environment: [],
        connections: [],
        routes: [],
        secrets: [],
      },
    ],
  },
  null,
  2,
);

/** A real git repo with a bare push remote and HEAD already on @{push}. */
const gitFixture = (): string => {
  const root = mkdtempSync(join(tmpdir(), "ops-signoff-"));
  const bare = join(root, "remote.git");
  const repo = join(root, "app");
  mkdirSync(repo);
  git(root, "init", "--bare", bare);
  git(repo, "init", "-b", "main");
  writeFileSync(join(repo, "cartridge.json"), `${cartridgeJson}\n`);
  writeFileSync(join(repo, "test.log"), "ok\n");
  git(repo, "add", "cartridge.json");
  git(repo, "commit", "-m", "init");
  git(repo, "remote", "add", "origin", bare);
  git(repo, "push", "-u", "origin", "main");
  return repo;
};

const git = (cwd: string, ...args: Array<string>) => {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
};

/**
 * Run a program with a recording spawner and a site whose server is `ctl`. Signoff refusals
 * must not reach ssh; when they do, the host answers a fake id.
 */
const execute = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const site = yield* fs.makeTempDirectoryScoped();
    yield* fs.writeFileString(
      `${site}/site.toml`,
      '[cluster]\nserver = "ctl"\nlanAddress = "10.0.0.2"\n',
    );
    const log: Array<string> = [];
    const inputs: Array<string> = [];
    const environment = Layer.mergeAll(
      recordingSpawner(log, inputs),
      Stdio.layerTest({ stdinIsTerminal: Effect.succeed(false) }),
      ConfigProvider.layer(ConfigProvider.fromEnvRecord({ OPS_SITE: site })),
    );
    const error = yield* (
      program as Effect.Effect<A, E, Remote | Site | Stdio.Stdio | Spawner.ChildProcessSpawner>
    ).pipe(
      Effect.as(Option.none<E>()),
      Effect.catch((failure) => Effect.succeed(Option.some(failure))),
      Effect.provide(
        Remote.layer.pipe(Layer.provideMerge(Site.layer), Layer.provideMerge(environment)),
      ),
    );
    return { log, inputs, error: Option.getOrUndefined(error) };
  }).pipe(
    Effect.scoped,
    Effect.provide(TestConsole.layer),
    Effect.provide(BunServices.layer),
    Effect.runPromise,
  );

const handle = (code: number, stdout: string) =>
  Spawner.makeHandle({
    pid: Spawner.ProcessId(1),
    exitCode: Effect.succeed(Spawner.ExitCode(code)),
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

const recordingSpawner = (log: Array<string>, inputs: Array<string>) =>
  Layer.succeed(
    Spawner.ChildProcessSpawner,
    Spawner.make(
      Effect.fnUntraced(function* (command) {
        if (!ChildProcess.isStandardCommand(command)) {
          log.push("(piped command)");
          return handle(0, "");
        }
        const line = [command.command, ...command.args].join(" ");
        log.push(line);
        const stdin = command.options.stdin;
        if (Stream.isStream(stdin)) inputs.push(yield* Stream.mkString(Stream.decodeText(stdin)));
        if (line.endsWith("alchemy-runner version")) return handle(0, "abc123\n");
        if (line.endsWith("alchemy-runner signoff")) return handle(0, "1\n");
        // Real git must run: fall through is wrong for a recording spawner. Call the real binary.
        const result = spawnSync(command.command, [...command.args], {
          encoding: "utf8",
          input: undefined,
        });
        return handle(result.status ?? 1, result.stdout ?? "");
      }),
    ),
  );
