import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Effect, FileSystem, Layer, Option, Redacted, Sink, Stream } from "effect";
import { ChildProcess } from "effect/process";
import * as Spawner from "effect/process/ChildProcessSpawner";
import {
  AlchemyFailed,
  alchemyArgv,
  loadNomadEnvironment,
  parseEnvFile,
  planOrDeploy,
} from "./cli.ts";
import * as Deployments from "./Deployments.ts";
import * as Package from "./Package.ts";
import { OpenBao, OpenBaoError } from "./OpenBao.ts";

const tinyCartridge = JSON.stringify({
  apiVersion: "server-ansible/v2",
  name: "tiny",
  services: [
    {
      name: "tiny",
      image:
        "registry.cluster:5000/tiny@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      hostPort: "dynamic",
      containerPort: 8080,
      cpu: 100,
      memoryMB: 128,
      networkMode: "bridge",
      environment: [],
      connections: [],
      secrets: [],
    },
  ],
});

describe("parseEnvFile", () => {
  it("reads KEY=VALUE lines and ignores blanks and comments", () => {
    assert.deepEqual(
      parseEnvFile("NOMAD_TOKEN=abc\n\n# skip\nOPENBAO_ADDR=http://127.0.0.1:8200\n"),
      {
        NOMAD_TOKEN: "abc",
        OPENBAO_ADDR: "http://127.0.0.1:8200",
      },
    );
  });
});

describe("cli --help", () => {
  it("prints host commands with no controller.env or XDG_RUNTIME_DIR", () => {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && key !== "XDG_RUNTIME_DIR") env[key] = value;
    }
    const result = spawnSync(
      process.execPath,
      [new URL("./cli.ts", import.meta.url).pathname, "--help"],
      { env, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /login/);
    assert.doesNotMatch(result.stderr, /cannot read/);
    assert.doesNotMatch(result.stderr, /XDG_RUNTIME_DIR/);
  });
});

describe("alchemyArgv", () => {
  const stage = { stage: "shop", cartridge: null, revision: "", stagedImage: null };
  const app = ["-c", Package.appEntry];

  it("passes --yes to every queued change: the submit was the approval", () => {
    assert.deepEqual(alchemyArgv({ command: "deploy", ...stage, planJobId: 1 }), [
      "deploy",
      "--stage",
      "shop",
      "--yes",
      ...app,
    ]);
    assert.deepEqual(alchemyArgv({ command: "destroy", ...stage }), [
      "destroy",
      "--stage",
      "shop",
      "--yes",
      "-c",
      Package.stateEntry,
    ]);
    assert.deepEqual(alchemyArgv({ command: "rollback", name: "shop", deploymentId: 3 }), [
      "deploy",
      "--stage",
      "shop",
      "--yes",
      ...app,
    ]);
  });

  it("does not pass --yes to a plan or a drift check", () => {
    assert.deepEqual(alchemyArgv({ command: "plan", ...stage }), [
      "plan",
      "--stage",
      "shop",
      ...app,
    ]);
    assert.deepEqual(alchemyArgv({ command: "drift", ...stage }), [
      "drift",
      "--stage",
      "shop",
      ...app,
    ]);
  });
});

describe("loadNomadEnvironment", () => {
  it("names the script that writes an unreadable env file", async () => {
    const error = await Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      return yield* loadNomadEnvironment(`${dir}/operator.env`).pipe(Effect.flip);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.runPromise);
    assert.match(
      error.message,
      /cannot read .*operator\.env\. Run 'sudo nomad-acl-issue-operator'/,
    );
  });

  it("loads the file's keys and the loopback addresses", async () => {
    const values = await Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const file = `${dir}/controller.env`;
      yield* fs.writeFileString(file, "NOMAD_TOKEN=secret-token\n");
      return yield* loadNomadEnvironment(file);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.runPromise);
    assert.equal(values.NOMAD_TOKEN, "secret-token");
    assert.equal(values.NOMAD_ADDR, "http://127.0.0.1:4646");
    assert.equal(values.OPENBAO_ADDR, "http://127.0.0.1:8200");
  });
});

describe("planOrDeploy", () => {
  it("runs alchemy when ORIGIN is unset", async () => {
    const { log } = await record({
      program: (env) => planOrDeploy("plan", "tiny", env),
      env: {},
      cartridge: tinyCartridge,
    });
    assert.deepEqual(log, ["alchemy plan --stage tiny -c alchemy.run.ts"]);
  });

  it("checks, runs alchemy, and records a deploy when ORIGIN is set", async () => {
    const { log } = await record({
      program: (env) => planOrDeploy("deploy", "tiny", env),
      env: { ORIGIN: "abc", REVISION: "def" },
      cartridge: tinyCartridge,
    });
    assert.deepEqual(log, [
      "deployment check tiny",
      "alchemy deploy --stage tiny --yes -c alchemy.run.ts",
      "deployment record tiny",
    ]);
  });

  it("does not record after a plan that was checked", async () => {
    const { log } = await record({
      program: (env) => planOrDeploy("plan", "tiny", env),
      env: { ORIGIN: "abc", REVISION: "def" },
      cartridge: tinyCartridge,
    });
    assert.deepEqual(log, ["deployment check tiny", "alchemy plan --stage tiny -c alchemy.run.ts"]);
  });

  it("does not record when Alchemy exits non-zero", async () => {
    const { log, error } = await record({
      program: (env) => planOrDeploy("deploy", "tiny", env),
      env: { ORIGIN: "abc", REVISION: "def" },
      cartridge: tinyCartridge,
      alchemyExit: 2,
    });
    assert.ok(error instanceof AlchemyFailed);
    assert.equal(error.code, 2);
    assert.deepEqual(log, [
      "deployment check tiny",
      "alchemy deploy --stage tiny --yes -c alchemy.run.ts",
    ]);
  });
});

const record = (options: {
  readonly program: (
    env: Record<string, string>,
  ) => Effect.Effect<
    unknown,
    unknown,
    Spawner.ChildProcessSpawner | Deployments.Deployments | OpenBao | FileSystem.FileSystem
  >;
  readonly env: Record<string, string>;
  readonly cartridge?: string;
  readonly alchemyExit?: number;
}) =>
  Effect.gen(function* () {
    const log: Array<string> = [];
    const fs = yield* FileSystem.FileSystem;
    const env = { ...options.env };
    if (options.cartridge !== undefined) {
      const dir = yield* fs.makeTempDirectoryScoped();
      const path = `${dir}/tiny.json`;
      yield* fs.writeFileString(path, options.cartridge);
      env.CARTRIDGE_FILE = path;
    }
    const unused = () => Effect.fail(new OpenBaoError({ operation: "unused", target: "test" }));
    const spawner = Layer.succeed(
      Spawner.ChildProcessSpawner,
      Spawner.make((command) => {
        // Package paths are absolute; the log names them by file.
        const line = ChildProcess.isStandardCommand(command)
          ? [command.command, ...command.args]
              .join(" ")
              .replace(`${process.execPath} ${Package.alchemyCli}`, "alchemy")
              .replace(Package.appEntry, "alchemy.run.ts")
          : "(piped command)";
        log.push(line);
        return Effect.succeed(handle(options.alchemyExit ?? 0));
      }),
    );
    const deployments = Layer.succeed(
      Deployments.Deployments,
      Deployments.Deployments.of({
        list: () => Effect.succeed([]),
        latest: () => Effect.succeed(Option.none()),
        newest: () => Effect.succeed([]),
        get: () => Effect.succeed(Option.none()),
        checkOrigin: (name) =>
          Effect.sync(() => {
            log.push(`deployment check ${name}`);
          }),
        record: (deployment) =>
          Effect.sync(() => {
            log.push(`deployment record ${deployment.name}`);
            return {
              id: 1,
              deployedAt: "now",
              name: deployment.name,
              origin: deployment.origin,
              signoff: deployment.signoff ?? null,
              revision: deployment.revision,
              cartridge: deployment.cartridge,
            };
          }),
      }),
    );
    const openbao = Layer.succeed(
      OpenBao,
      OpenBao.of({
        checkToken: () =>
          Effect.sync(() => {
            log.push("checkToken");
          }),
        readKvKeys: () => Effect.succeed(Option.some([])),
        writeKvKey: unused,
        readKvData: unused,
        writeKvData: unused,
        createToken: () => Effect.succeed(Redacted.make("x")),
        postgresLogin: unused,
        readKv: unused,
        readValkeyCredentials: unused,
        writeValkeyCredentials: unused,
        readAdminCredential: unused,
        readPostgresConnectionUrl: unused,
        configurePostgres: unused,
        configureWorkloadRole: unused,
      }),
    );
    const error = yield* options.program(env).pipe(
      Effect.as(Option.none()),
      Effect.catch((failure) => Effect.succeed(Option.some(failure))),
      Effect.provide(Layer.mergeAll(spawner, deployments, openbao)),
    );
    return { log, error: Option.getOrUndefined(error) };
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.runPromise);

const handle = (code: number) =>
  Spawner.makeHandle({
    pid: Spawner.ProcessId(1),
    exitCode: Effect.succeed(Spawner.ExitCode(code)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
