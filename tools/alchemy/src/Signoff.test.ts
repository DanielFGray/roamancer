import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
import { commands as signoffCommands, deployPushes, summarizeLog } from "./Signoff.ts";
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

describe("deployPushes", () => {
  const zero = "0".repeat(40);
  const a = "a".repeat(40);
  const b = "b".repeat(40);
  const cases: Array<{ name: string; stdin: string; want: ReadonlyArray<string> }> = [
    { name: "a push to main", stdin: `refs/heads/main ${a} refs/heads/main ${b}\n`, want: [a] },
    {
      name: "another branch to main",
      stdin: `refs/heads/fix ${a} refs/heads/main ${zero}\n`,
      want: [a],
    },
    {
      name: "a push to another branch",
      stdin: `refs/heads/main ${a} refs/heads/dev ${b}\n`,
      want: [],
    },
    { name: "a deletion of main", stdin: `(delete) ${zero} refs/heads/main ${b}\n`, want: [] },
    {
      name: "the same commit pushed twice",
      stdin: `refs/heads/main ${a} refs/heads/main ${b}\nrefs/heads/x ${a} refs/heads/main ${b}\n`,
      want: [a],
    },
    { name: "nothing pushed", stdin: "", want: [] },
  ];
  for (const { name, stdin, want } of cases) {
    it(name, () => {
      assert.deepEqual(deployPushes(stdin), want);
    });
  }
});

describe("ops signoff", () => {
  const signoff = signoffCommands[0]!;
  const run = (...args: Array<string>) => Command.runWith(signoff, { version: "test" })(args);
  const sent = (log: ReadonlyArray<string>) =>
    log.some((line) => line.endsWith("alchemy-runner signoff"));

  it("verifies the committed tree, not the working tree, and records it without the revision check", async () => {
    const repo = gitFixture('#!/bin/sh\ngrep -qx ok status.txt && echo "12 pass"\n');
    try {
      writeFileSync(join(repo, "status.txt"), "edited\n");
      const { error, log, inputs } = await execute(run(repo));
      assert.equal(error, undefined);
      assert.ok(!log.some((line) => line.endsWith("alchemy-runner version")));
      const record = JSON.parse(inputs.at(-1)!);
      assert.equal(record.app, "signoff-probe");
      assert.equal(record.tree, git(repo, "rev-parse", "HEAD^{tree}").trim());
      assert.equal(record.commit, git(repo, "rev-parse", "HEAD").trim());
      assert.equal(record.summary.trim(), "12 pass");
    } finally {
      rmSync(join(repo, ".."), { recursive: true, force: true });
    }
  });

  it("records nothing when scripts/verify fails", async () => {
    const repo = gitFixture("#!/bin/sh\necho 1 fail\nexit 1\n");
    try {
      const { error, log } = await execute(run(repo));
      assert.ok(error instanceof OpsError);
      assert.match(error.message, /scripts\/verify exited 1/);
      assert.ok(!sent(log));
    } finally {
      rmSync(join(repo, ".."), { recursive: true, force: true });
    }
  });

  it("refuses an app without scripts/verify", async () => {
    const repo = gitFixture(undefined);
    try {
      const { error, log } = await execute(run(repo));
      assert.ok(error instanceof OpsError);
      assert.match(error.message, /no scripts\/verify/);
      assert.ok(!sent(log));
    } finally {
      rmSync(join(repo, ".."), { recursive: true, force: true });
    }
  });

  it("install writes its hook, and refuses to replace another", async () => {
    const repo = gitFixture(undefined);
    try {
      const path = join(repo, ".git/hooks/pre-push");
      assert.equal((await execute(run("install", repo))).error, undefined);
      assert.match(readFileSync(path, "utf8"), /exec ops signoff pre-push/);
      assert.equal(statSync(path).mode & 0o111, 0o111);
      assert.equal((await execute(run("install", repo))).error, undefined);
      writeFileSync(path, "#!/bin/sh\nexit 0\n");
      const { error } = await execute(run("install", repo));
      assert.ok(error instanceof OpsError);
      assert.match(error.message, /another pre-push hook/);
      assert.equal(readFileSync(path, "utf8"), "#!/bin/sh\nexit 0\n");
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

/**
 * A real git repo with one commit: the cartridge, status.txt = "ok", and `verify` as an
 * executable scripts/verify when given. The caller removes its parent folder.
 */
const gitFixture = (verify: string | undefined): string => {
  const root = mkdtempSync(join(tmpdir(), "ops-signoff-"));
  const repo = join(root, "app");
  mkdirSync(join(repo, "scripts"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "cartridge.json"), `${cartridgeJson}\n`);
  writeFileSync(join(repo, "status.txt"), "ok\n");
  if (verify !== undefined) writeFileSync(join(repo, "scripts/verify"), verify, { mode: 0o755 });
  git(repo, "add", ".");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
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
 * Run a program with a recording spawner and a site whose server is `ctl`. ssh to the host
 * is faked (a signoff answers id 1); every other program, git and the app's scripts, runs.
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

const handle = (code: number, stdout: string, all = stdout) =>
  Spawner.makeHandle({
    pid: Spawner.ProcessId(1),
    exitCode: Effect.succeed(Spawner.ExitCode(code)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    stdout: Stream.make(new TextEncoder().encode(stdout)),
    stderr: Stream.empty,
    all: Stream.make(new TextEncoder().encode(all)),
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
        const result = spawnSync(command.command, [...command.args], {
          cwd: command.options.cwd,
          encoding: "utf8",
        });
        return handle(
          result.status ?? 1,
          result.stdout ?? "",
          `${result.stdout ?? ""}${result.stderr ?? ""}`,
        );
      }),
    ),
  );
