import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunServices from "@effect/platform-bun/BunServices";
import { ConfigProvider, Context, Effect, FileSystem, Layer, Option, Sink, Stream } from "effect";
import { TestConsole } from "effect/testing";
import { ChildProcess } from "effect/process";
import * as Spawner from "effect/process/ChildProcessSpawner";
import { Builder } from "./Builder.ts";
import { OpsError } from "./Exec.ts";
import { Site } from "./Site.ts";

type SiteService = Context.Service.Shape<typeof Site>;

const digest = `sha256:${"a".repeat(64)}`;
const repository = "registry.cluster:5000/probe";
const commit = "abc1234";
const tagged = `${repository}:${commit}`;
const tree = "/exported-tree";
const image = { repository, commit };

describe("Site.buildNode", () => {
  it("is none when site.toml has no [build] table", async () => {
    const node = await withSite(
      '[cluster]\nserver = "ctl"\nlanAddress = "10.0.0.2"\n',
      (site) => site.buildNode,
    );
    assert.deepEqual(node, Option.none());
  });

  it("is some(host) when [build] node is set", async () => {
    const node = await withSite(
      '[cluster]\nserver = "ctl"\nlanAddress = "10.0.0.2"\n\n[build]\nnode = "atheist"\n',
      (site) => site.buildNode,
    );
    assert.deepEqual(node, Option.some("atheist"));
  });

  it("names a bad [build] table instead of blaming cluster.server", async () => {
    const error = await withSite(
      '[cluster]\nserver = "ctl"\nlanAddress = "10.0.0.2"\n\n[build]\nnode = 1\n',
      (site) => site.buildNode,
    ).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    assert.ok(error instanceof OpsError);
    assert.match(error.message, /\[build\]/);
    assert.doesNotMatch(error.message, /^cluster\.server is not set/);
  });
});

describe("Builder.layer", () => {
  it("pipes a tar of the tree into one ssh call and returns tagged@digest", async () => {
    const { log, result } = await execute(
      Effect.flatMap(Builder, (builder) => builder.build(tree, image)),
      {
        siteToml:
          '[cluster]\nserver = "ctl"\nlanAddress = "10.0.0.2"\n\n[build]\nnode = "atheist"\n',
      },
    );
    assert.equal(log.length, 1);
    assert.equal(
      log[0],
      `tar -C ${tree} -cf - . | ssh atheist tmp=$(mktemp) && trap 'rm -f "$tmp"' EXIT && podman build -t '${tagged}' - >&2 && podman push --digestfile "$tmp" '${tagged}' >&2 && cat "$tmp"`,
    );
    assert.equal(result, `${tagged}@${digest}`);
  });

  // The remote script runs in a real sh against a podman that, like the real one, prints its
  // build steps and the image ID on stdout.
  it("returns only the digest when podman build writes to stdout", async () => {
    const bin = mkdtempSync(join(tmpdir(), "fake-podman-"));
    writeFileSync(
      join(bin, "podman"),
      `#!/bin/sh
case "$1" in
  build) echo "STEP 1/2: FROM scratch"; echo "${"b".repeat(64)}" ;;
  push) echo "Writing manifest"; printf '%s' "${digest}" > "$3" ;;
esac
`,
      { mode: 0o755 },
    );
    const { result } = await execute(
      Effect.flatMap(Builder, (builder) => builder.build(tree, image)),
      {
        siteToml:
          '[cluster]\nserver = "ctl"\nlanAddress = "10.0.0.2"\n\n[build]\nnode = "atheist"\n',
        output: (line) =>
          spawnSync(
            "sh",
            ["-c", line.slice(line.indexOf("ssh atheist ") + "ssh atheist ".length)],
            {
              encoding: "utf8",
              env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
            },
          ).stdout,
      },
    );
    rmSync(bin, { recursive: true });
    assert.equal(result, `${tagged}@${digest}`);
  });

  it("fails when ssh exits non-zero", async () => {
    const { error } = await execute(
      Effect.flatMap(Builder, (builder) => builder.build(tree, image)),
      {
        siteToml:
          '[cluster]\nserver = "ctl"\nlanAddress = "10.0.0.2"\n\n[build]\nnode = "atheist"\n',
        reply: () => 1,
      },
    );
    assert.ok(error instanceof OpsError);
    assert.match(error.message, /tar \| ssh atheist exited 1/);
  });

  it("uses Local docker commands when [build] node is absent", async () => {
    const { log, result } = await execute(
      Effect.flatMap(Builder, (builder) => builder.build(tree, image)),
      {
        siteToml: '[cluster]\nserver = "ctl"\nlanAddress = "10.0.0.2"\n',
        output: (line) => (line.startsWith("docker inspect") ? `${repository}@${digest}\n` : ""),
      },
    );
    assert.ok(log.some((line) => line.startsWith(`docker build -t ${tagged} ${tree}`)));
    assert.ok(log.some((line) => line.startsWith(`docker push ${tagged}`)));
    assert.ok(log.some((line) => line.startsWith("docker inspect ")));
    assert.equal(log.filter((line) => line.includes(" ssh ")).length, 0);
    assert.equal(result, `${tagged}@${digest}`);
  });

  it("uses the Node path when [build] node is set", async () => {
    const { log, result } = await execute(
      Effect.flatMap(Builder, (builder) => builder.build(tree, image)),
      {
        siteToml:
          '[cluster]\nserver = "ctl"\nlanAddress = "10.0.0.2"\n\n[build]\nnode = "atheist"\n',
      },
    );
    assert.ok(log[0]?.startsWith(`tar -C ${tree} -cf - . | ssh atheist `));
    assert.equal(log.filter((line) => line.startsWith("docker ")).length, 0);
    assert.equal(result, `${tagged}@${digest}`);
  });
});

/** Read a value from Site against a temporary site.toml. */
const withSite = <A>(toml: string, read: (site: SiteService) => Effect.Effect<A, OpsError>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();
    yield* fs.writeFileString(`${dir}/site.toml`, toml);
    return yield* Effect.gen(function* () {
      return yield* read(yield* Site);
    }).pipe(
      Effect.provide(Site.layer),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ OPS_SITE: dir }))),
    );
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.runPromise);

/**
 * Run a Builder program with a spawner that records each command line, a site folder, and
 * default digest output for ssh / docker inspect.
 */
const execute = <A, E>(
  program: Effect.Effect<
    A,
    E,
    Builder | Site | Spawner.ChildProcessSpawner | FileSystem.FileSystem
  >,
  options: {
    readonly reply?: (line: string) => number;
    readonly output?: (line: string) => string;
    readonly siteToml?: string;
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const site = yield* fs.makeTempDirectoryScoped();
    yield* fs.writeFileString(
      `${site}/site.toml`,
      options.siteToml ?? '[cluster]\nserver = "ctl"\nlanAddress = "10.0.0.2"\n',
    );
    const log: Array<string> = [];
    const spawner = Layer.succeed(
      Spawner.ChildProcessSpawner,
      Spawner.make((command) => {
        const line = lineOf(command);
        log.push(line);
        return Effect.succeed(
          handle(options.reply?.(line) ?? 0, options.output?.(line) ?? `${digest}\n`),
        );
      }),
    );
    const environment = Layer.mergeAll(
      spawner,
      ConfigProvider.layer(ConfigProvider.fromEnvRecord({ OPS_SITE: site })),
    );
    const outcome = yield* program.pipe(
      Effect.map((value) => ({ result: Option.some(value), error: Option.none<E>() })),
      Effect.catch((failure) =>
        Effect.succeed({ result: Option.none<A>(), error: Option.some(failure) }),
      ),
      Effect.provide(
        Builder.layer.pipe(Layer.provideMerge(Site.layer), Layer.provideMerge(environment)),
      ),
    );
    return {
      log,
      result: Option.getOrUndefined(outcome.result),
      error: Option.getOrUndefined(outcome.error),
    };
  }).pipe(
    Effect.scoped,
    Effect.provide(TestConsole.layer),
    Effect.provide(BunServices.layer),
    Effect.runPromise,
  );

const lineOf = (command: ChildProcess.Command): string =>
  ChildProcess.isStandardCommand(command)
    ? [command.command, ...command.args].join(" ")
    : `${lineOf(command.left)} | ${lineOf(command.right)}`;

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
