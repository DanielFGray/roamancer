import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as BunServices from "@effect/platform-bun/BunServices";
import {
  ConfigProvider,
  Effect,
  FileSystem,
  Layer,
  Option,
  Schema as S,
  Sink,
  Stdio,
  Stream,
} from "effect";
import { TestConsole } from "effect/testing";
import { ChildProcess } from "effect/process";
import { Prompt } from "effect/cli";
import * as Spawner from "effect/process/ChildProcessSpawner";
import { OpsError, route } from "./Exec.ts";
import * as Git from "./Git.ts";
import { flakeHosts, HostName, install, rebuild } from "./Nixos.ts";
import { deployStage, forwarded } from "./Jobs.ts";
import { Remote } from "./Remote.ts";
import { Site } from "./Site.ts";

const repositoryRoot = new URL("../../..", import.meta.url).pathname;
const hostRoute = route(forwarded);

describe("route", () => {
  it("puts -- after a forwarding command so its flags reach the host", () => {
    assert.deepEqual(hostRoute(["logs", "--tail", "x"]), ["logs", "--", "--tail", "x"]);
    assert.deepEqual(hostRoute(["logs", "--", "x"]), ["logs", "--", "x"]);
  });

  it("leaves every other command alone", () => {
    assert.deepEqual(hostRoute(["deploy", "--stage", "giglist"]), ["deploy", "--stage", "giglist"]);
    assert.deepEqual(hostRoute(["--help"]), ["--help"]);
    assert.deepEqual(hostRoute([]), []);
  });
});

describe("flakeHosts", () => {
  it("lists the nixosConfigurations in file order", () => {
    const flake = `outputs = {\n  nixosConfigurations.cynic = host ./cynic;\n  nixosConfigurations.atheist = host ./a;\n  # nixosConfigurations.skipped is a comment\n};`;
    assert.deepEqual(flakeHosts(flake), ["cynic", "atheist"]);
  });
});

describe("HostName", () => {
  it("accepts a flake host name and refuses shell syntax", () => {
    assert.equal(S.is(HostName)("cynic-2"), true);
    assert.equal(S.is(HostName)("cynic; rm"), false);
    assert.equal(S.is(HostName)(""), false);
  });
});

/** What the fake control host prints: the runner's revision and each submitted job's id. */
const host = (line: string) =>
  line.endsWith("alchemy-runner version")
    ? "abc123\n"
    : line.endsWith("alchemy-runner submit")
      ? "7\n"
      : "";

describe("Remote", () => {
  it("checks the runner revision once, submits JSON on stdin, then waits", async () => {
    const { log, inputs } = await execute(
      Effect.flatMap(Remote, (remote) =>
        Effect.andThen(remote.run({ command: "dash" }), remote.run({ command: "place-queued" })),
      ),
      { output: host },
    );
    assert.deepEqual(log, [
      "ssh ctl alchemy-runner version",
      `git -C ${Git.repository} cat-file -e abc123^{commit}`,
      `git -C ${Git.repository} diff --quiet abc123 -- tools/alchemy`,
      "ssh ctl alchemy-runner submit",
      "ssh ctl 'alchemy-runner' 'wait' '7'",
      "ssh ctl alchemy-runner submit",
      "ssh ctl 'alchemy-runner' 'wait' '7'",
    ]);
    assert.deepEqual(
      inputs.map((input) => JSON.parse(input)),
      [
        { _tag: "submit", command: "dash" },
        { _tag: "submit", command: "place-queued" },
      ],
    );
  });

  it("refuses every job when tools/alchemy differs from the runner's revision", async () => {
    const { log, error } = await execute(
      Effect.flatMap(Remote, (remote) => remote.run({ command: "dash" })),
      { output: host, reply: (line) => (line.includes(" diff ") ? 1 : 0) },
    );
    assert.ok(error instanceof OpsError);
    assert.match(error.message, /ctl runs server-ansible abc123, .* run `ops rebuild`/);
    assert.ok(!log.some((line) => line.includes("submit")));
  });

  it("names a runner revision this checkout lacks, rather than calling it a difference", async () => {
    const { error } = await execute(
      Effect.flatMap(Remote, (remote) => remote.run({ command: "dash" })),
      { output: host, reply: (line) => (line.includes(" cat-file ") ? 1 : 0) },
    );
    assert.ok(error instanceof OpsError);
    assert.match(error.message, /abc123, which this checkout does not have/);
  });

  it("asks for a terminal only when stdin is one", async () => {
    const { log } = await execute(
      Effect.flatMap(Remote, (remote) => remote.direct(["login"])),
      { terminal: true },
    );
    assert.deepEqual(log, ["ssh -t ctl 'alchemy-runner' 'login'"]);
  });

  it("uses OPS_HOST in place of the site's server", async () => {
    const { log } = await execute(
      Effect.flatMap(Remote, (remote) => remote.direct(["logs", "it's"])),
      { env: { OPS_HOST: "other" } },
    );
    assert.deepEqual(log, ["ssh other 'alchemy-runner' 'logs' 'it'\\''s'"]);
  });
});

describe("deployStage", () => {
  const sent = { cartridge: "{}", origin: "o", revision: "r", stagedImage: null };

  it("deploys the plan it showed, naming that plan's job", async () => {
    const { inputs } = await execute(deployStage("giglist", sent, true), {
      output: (line) =>
        line.endsWith("version") ? "abc123\n" : line.endsWith("submit") ? "4\n" : "",
    });
    assert.deepEqual(
      inputs.map((input) => JSON.parse(input)),
      [
        { _tag: "submit", command: "plan", stage: "giglist", ...sent },
        { _tag: "submit", command: "deploy", stage: "giglist", ...sent, planJobId: 4 },
      ],
    );
  });

  it("plans but does not deploy without --yes or a terminal", async () => {
    const { inputs, error } = await execute(deployStage("giglist", sent, false), {
      output: (line) =>
        line.endsWith("version") ? "abc123\n" : line.endsWith("submit") ? "4\n" : "",
    });
    assert.ok(error instanceof OpsError);
    assert.match(error.message, /pass --yes/);
    assert.deepEqual(
      inputs.map((input) => JSON.parse(input).command),
      ["plan"],
    );
  });
});

describe("rebuild", () => {
  it("pushes both repositories and switches the named host", async () => {
    const { log, site } = await execute(rebuild(Option.some("cynic"), Option.some("root@z")), {
      output: host,
    });
    assert.deepEqual(log.slice(0, 8), [
      ...sent("root@z", Git.repository, Git.checkout),
      ...sent("root@z", site, "site"),
    ]);
    assert.equal(
      log[8],
      `ssh -t root@z rm -rf "$HOME/site-tree" "$HOME/build-info" && mkdir "$HOME/site-tree" "$HOME/build-info" && git -C "$HOME/site" archive HEAD | tar -x -C "$HOME/site-tree" && git -C "$HOME/server-ansible" rev-parse HEAD > "$HOME/build-info/rev" && sudo nixos-rebuild switch --flake "git+file:$HOME/server-ansible#cynic" --override-input site "path:$HOME/site-tree" --override-input build "path:$HOME/build-info"`,
    );
    assert.equal(log[log.length - 1], "ssh ctl 'alchemy-runner' 'wait' '7'");
  });

  it("rebuilds every host the flake declares, one at a time", async () => {
    const { log } = await execute(rebuild(Option.none(), Option.none()));
    const switches = log.filter((line) => line.includes("nixos-rebuild switch"));
    assert.equal(
      switches.length,
      flakeHosts(readFileSync(`${repositoryRoot}/flake.nix`, "utf8")).length,
    );
  });

  it("stops at the first failure", async () => {
    const { log, error } = await execute(rebuild(Option.none(), Option.none()), {
      reply: (line) => (line.includes("nixos-rebuild switch") ? 1 : 0),
    });
    assert.ok(error instanceof OpsError);
    assert.equal(log.filter((line) => line.includes("nixos-rebuild switch")).length, 1);
  });

  it("pushes nothing to a host whose push is refused", async () => {
    const { log, error } = await execute(rebuild(Option.some("cynic"), Option.none()), {
      reply: (line) => (line.includes(" push ") ? 1 : 0),
    });
    assert.ok(error instanceof OpsError);
    assert.equal(log.filter((line) => line.includes("nixos-rebuild switch")).length, 0);
  });
});

describe("install", () => {
  const options = { host: "cynic", target: "root@z", yes: true, anywhere: ["--debug"] };

  it("builds in the container from the committed trees and the site folder", async () => {
    const { log, site, home } = await execute(install(options));
    assert.equal(log[0], "docker volume inspect server-ansible-nix");
    const archives = log.filter((line) => line.includes(" archive "));
    assert.match(
      archives[0],
      new RegExp(`^git -C ${Git.repository} archive --format=tar -o \\S+ HEAD$`),
    );
    assert.match(archives[1], new RegExp(`^git -C ${site} archive --format=tar -o \\S+ HEAD$`));
    const extractions = log.filter((line) => line.startsWith("tar -xf "));
    const tree = / -C (\S+)$/.exec(extractions[0])?.[1];
    assert.ok(tree !== undefined);
    assert.ok(extractions[1].endsWith(` -C ${tree}/nixos/site`));
    const docker = log[log.length - 1];
    assert.ok(docker.startsWith("docker run --rm --network host --volume server-ansible-nix:/nix"));
    assert.ok(docker.includes(`--volume ${tree}:/src:ro`));
    assert.ok(docker.includes(`--volume ${home}/.ssh/id_ed25519:/key:ro`));
    assert.ok(!docker.includes("/extra"));
    assert.ok(docker.endsWith("github:nix-community/nixos-anywhere/1.11.0 cynic root@z --debug"));
  });

  it("copies the host's saved identity onto the new root", async () => {
    const { log } = await execute(install(options), { extraFiles: "cynic" });
    const docker = log[log.length - 1];
    assert.ok(docker.includes("/extra:ro"));
    assert.ok(
      docker.endsWith(
        "cynic root@z --extra-files /extra --chown /etc/ssh 0:0 --chown /var/lib/tailscale 0:0 --debug",
      ),
    );
  });

  it("creates the Nix store volume on first use", async () => {
    const { log } = await execute(install(options), {
      reply: (line) => (line.startsWith("docker volume inspect") ? 1 : 0),
    });
    assert.match(
      log[1],
      /^docker volume create --opt type=none --opt o=bind --opt device=\S+\/\.cache\/server-ansible-nix server-ansible-nix$/,
    );
  });

  it("refuses to erase a disk without --yes and a terminal", async () => {
    const { log, error } = await execute(install({ ...options, yes: false }));
    assert.ok(error instanceof OpsError);
    assert.match(error.message, /pass --yes/);
    assert.deepEqual(log, []);
  });
});

/** The commands that make `remote` on `target` a checkout of `dir`'s HEAD. */
const sent = (target: string, dir: string, remote: string) => [
  `git -C ${dir} rev-parse --show-prefix`,
  `git -C ${dir} rev-parse --short HEAD`,
  `git -C ${dir} status --porcelain`,
  `git -C ${dir} push --quiet --force ${target}:${remote} HEAD:refs/heads/deploy`,
];

/**
 * Run a program with a spawner that records each command line and exits with `reply`'s
 * code, a site folder whose server is `ctl`, and an empty home folder. `error` is the
 * program's failure, if it failed.
 */
const execute = <A, E>(
  program: Effect.Effect<
    A,
    E,
    Remote | Site | Stdio.Stdio | Spawner.ChildProcessSpawner | Prompt.Environment
  >,
  options: {
    readonly reply?: (line: string) => number;
    /** What a program prints; nothing by default. */
    readonly output?: (line: string) => string;
    readonly terminal?: boolean;
    readonly env?: Record<string, string>;
    readonly extraFiles?: string;
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const site = yield* fs.makeTempDirectoryScoped();
    const home = yield* fs.makeTempDirectoryScoped();
    yield* fs.writeFileString(`${site}/site.toml`, '[cluster]\nserver = "ctl"\n');
    if (options.extraFiles !== undefined) {
      yield* fs.makeDirectory(
        `${home}/.local/state/server-ansible/extra-files/${options.extraFiles}`,
        {
          recursive: true,
        },
      );
    }
    const log: Array<string> = [];
    const inputs: Array<string> = [];
    const environment = Layer.mergeAll(
      recordingSpawner(log, inputs, options),
      Stdio.layerTest({ stdinIsTerminal: Effect.succeed(options.terminal ?? false) }),
      ConfigProvider.layer(
        ConfigProvider.fromEnvRecord({ OPS_SITE: site, HOME: home, ...options.env }),
      ),
    );
    const error = yield* program.pipe(
      Effect.as(Option.none<E>()),
      Effect.catch((failure) => Effect.succeed(Option.some(failure))),
      Effect.provide(
        Remote.layer.pipe(Layer.provideMerge(Site.layer), Layer.provideMerge(environment)),
      ),
    );
    const messages = (yield* TestConsole.errorLines).map(String);
    return { log, inputs, messages, site, home, error: Option.getOrUndefined(error) };
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

/** A spawner that records each command line and its stdin, and replies as `options` say. */
const recordingSpawner = (
  log: Array<string>,
  inputs: Array<string>,
  options: {
    readonly reply?: (line: string) => number;
    readonly output?: (line: string) => string;
  },
) =>
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
        return handle(options.reply?.(line) ?? 0, options.output?.(line) ?? "");
      }),
    ),
  );
