import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as BunServices from "@effect/platform-bun/BunServices";
import { ConfigProvider, Effect, FileSystem, Layer, Option, Redacted, Sink, Stream } from "effect";
import { ChildProcess } from "effect/process";
import * as Spawner from "effect/process/ChildProcessSpawner";
import {
  AlchemyFailed,
  loadHostEnvironment,
  parseEnvFile,
  planOrDeploy,
  stageFlag,
} from "./cli.ts";
import * as Deployments from "./Deployments.ts";
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

describe("stageFlag", () => {
  it("reads --stage and --stage=", () => {
    assert.deepEqual(stageFlag(["--stage", "giglist"]), Option.some("giglist"));
    assert.deepEqual(stageFlag(["--yes", "--stage=giglist"]), Option.some("giglist"));
    assert.deepEqual(stageFlag(["--yes"]), Option.none());
  });
});

describe("loadHostEnvironment", () => {
  it("fails when the controller env file is unreadable", async () => {
    const error = await Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      return yield* loadHostEnvironment(`${dir}/missing.env`).pipe(
        Effect.as(Option.none()),
        Effect.catch((failure) => Effect.succeed(Option.some(failure))),
      );
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.runPromise);
    assert.ok(Option.isSome(error));
    assert.match(error.value.message, /cannot read .*missing\.env/);
  });

  it("fails when XDG_RUNTIME_DIR is unset", async () => {
    const error = await Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const path = `${dir}/controller.env`;
      yield* fs.writeFileString(path, "NOMAD_TOKEN=abc\n");
      return yield* loadHostEnvironment(path).pipe(
        Effect.as(Option.none()),
        Effect.catch((failure) => Effect.succeed(Option.some(failure))),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({}))),
      );
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.runPromise);
    assert.ok(Option.isSome(error));
    assert.match(error.value.message, /XDG_RUNTIME_DIR is not set/);
  });

  it("loads controller keys and the OpenBao token file", async () => {
    const values = await Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const controller = `${dir}/controller.env`;
      yield* fs.writeFileString(controller, "NOMAD_TOKEN=secret-token\n");
      yield* fs.writeFileString(`${dir}/openbao.token`, "bao-token\n");
      return yield* loadHostEnvironment(controller).pipe(
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromEnvRecord({ XDG_RUNTIME_DIR: dir })),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.runPromise);
    assert.equal(values.NOMAD_TOKEN, "secret-token");
    assert.equal(values.OPENBAO_TOKEN, "bao-token");
    assert.equal(values.NOMAD_ADDR, "http://127.0.0.1:4646");
    assert.equal(values.OPENBAO_ADDR, "http://127.0.0.1:8200");
    assert.ok(values.OPENBAO_TOKEN_FILE.endsWith("/openbao.token"));
  });
});

describe("planOrDeploy", () => {
  it("runs checkToken then alchemy when ORIGIN is unset", async () => {
    const { log } = await record({
      program: (env) => planOrDeploy("plan", ["--stage", "tiny"], env),
      env: {},
      cartridge: tinyCartridge,
    });
    assert.deepEqual(log, ["checkToken", "bunx alchemy plan --stage tiny"]);
  });

  it("checks, checkToken, alchemy, and records a deploy when ORIGIN is set", async () => {
    const { log } = await record({
      program: (env) => planOrDeploy("deploy", ["--stage", "tiny"], env),
      env: { ORIGIN: "abc", REVISION: "def" },
      cartridge: tinyCartridge,
    });
    assert.deepEqual(log, [
      "deployment check tiny",
      "checkToken",
      "bunx alchemy deploy --stage tiny",
      "deployment record tiny",
    ]);
  });

  it("does not record after a plan that was checked", async () => {
    const { log } = await record({
      program: (env) => planOrDeploy("plan", ["--stage", "tiny"], env),
      env: { ORIGIN: "abc", REVISION: "def" },
      cartridge: tinyCartridge,
    });
    assert.deepEqual(log, [
      "deployment check tiny",
      "checkToken",
      "bunx alchemy plan --stage tiny",
    ]);
  });

  it("does not record when Alchemy exits non-zero", async () => {
    const { log, error } = await record({
      program: (env) => planOrDeploy("deploy", ["--stage", "tiny"], env),
      env: { ORIGIN: "abc", REVISION: "def" },
      cartridge: tinyCartridge,
      alchemyExit: 2,
    });
    assert.ok(error instanceof AlchemyFailed);
    assert.equal(error.code, 2);
    assert.deepEqual(log, [
      "deployment check tiny",
      "checkToken",
      "bunx alchemy deploy --stage tiny",
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
        const line = ChildProcess.isStandardCommand(command)
          ? [command.command, ...command.args].join(" ")
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
        createToken: () => Effect.succeed(Redacted.make("x")),
        readKv: unused,
        readValkeyCredentials: unused,
        writeValkeyCredentials: unused,
        readAdminCredential: unused,
        writeAdminCredential: unused,
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
