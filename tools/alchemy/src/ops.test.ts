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
import { OpsError } from "./Exec.ts";
import * as Git from "./Git.ts";
import { flakeHosts, HostName, install, rebuild } from "./Nixos.ts";
import { Remote, remoteCommand } from "./Remote.ts";
import { route } from "./ops.ts";
import { Site } from "./Site.ts";

const nixosFolder = new URL("../../../nixos", import.meta.url).pathname;

describe("route", () => {
  it("puts -- after a host command so its flags reach the host", () => {
    assert.deepEqual(route(["deploy", "--stage", "giglist"]), [
      "deploy",
      "--",
      "--stage",
      "giglist",
    ]);
    assert.deepEqual(route(["logs", "--", "x"]), ["logs", "--", "x"]);
  });

  it("leaves the commands that run here alone", () => {
    assert.deepEqual(route(["install", "--yes", "cynic", "root@x"]), [
      "install",
      "--yes",
      "cynic",
      "root@x",
    ]);
    assert.deepEqual(route(["--help"]), ["--help"]);
    assert.deepEqual(route([]), []);
  });
});

describe("remoteCommand", () => {
  it("quotes every argument and variable as one word", () => {
    assert.equal(remoteCommand(["dash"], []), "alchemy/scripts/ops-on-host.sh 'dash'");
    assert.equal(
      remoteCommand(["logs", "it's"], [["ORIGIN", "a b"]]),
      "env 'ORIGIN=a b' alchemy/scripts/ops-on-host.sh 'logs' 'it'\\''s'",
    );
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

describe("Remote", () => {
  it("pushes HEAD to the host and runs the host command", async () => {
    const { log } = await execute(Effect.flatMap(Remote, (remote) => remote.run(["dash"])));
    assert.equal(log.length, 6);
    assert.match(log[3], /^ssh -n ctl git init .*\nif \[ -d alchemy \] && \[ ! -L alchemy \]/s);
    assert.match(log[3], /ln -sfn server-ansible\/tools\/alchemy alchemy$/);
    assert.deepEqual(log.slice(5), ["ssh ctl alchemy/scripts/ops-on-host.sh 'dash'"]);
  });

  it("asks for a terminal only when stdin is one", async () => {
    const { log } = await execute(
      Effect.flatMap(Remote, (remote) => remote.run(["login"])),
      { terminal: true },
    );
    assert.equal(log[log.length - 1], "ssh -t ctl alchemy/scripts/ops-on-host.sh 'login'");
  });

  it("leaves stdin to the host command alone: setup ssh calls never read it", async () => {
    const { log } = await execute(Effect.flatMap(Remote, (remote) => remote.run(["login"])));
    const setup = log.filter((line) => line.startsWith("ssh ") && !line.includes("ops-on-host"));
    assert.ok(setup.length > 0);
    assert.ok(setup.every((line) => line.startsWith("ssh -n ")));
    assert.equal(log[log.length - 1], "ssh ctl alchemy/scripts/ops-on-host.sh 'login'");
  });

  it("sends a cartridge and what the release records", async () => {
    const { log } = await execute(
      Effect.flatMap(Remote, (remote) =>
        remote.run(["deploy", "--stage", "giglist"], {
          cartridge: "/tmp/c.json",
          origin: "abc",
          revision: "def",
        }),
      ),
    );
    assert.equal(log[5], "ssh -n ctl mkdir -p alchemy/.alchemy/input");
    assert.match(
      log[6],
      /^scp -q \/tmp\/c\.json ctl:alchemy\/\.alchemy\/input\/cartridge-\d+-\d+\.json$/,
    );
    assert.match(
      log[7],
      /^ssh ctl env 'CARTRIDGE_FILE=\.alchemy\/input\/cartridge-\d+-\d+\.json' 'ORIGIN=abc' 'REVISION=def' alchemy\/scripts\/ops-on-host\.sh 'deploy' '--stage' 'giglist'$/,
    );
  });

  it("uses OPS_HOST in place of the site's server", async () => {
    const { log } = await execute(
      Effect.flatMap(Remote, (remote) => remote.run(["dash"])),
      { env: { OPS_HOST: "other" } },
    );
    assert.deepEqual(
      log.slice(0, 5).filter((line) => !line.startsWith("ssh -n other git init")),
      sent("other", Git.repository, Git.checkout).filter(
        (line) => !line.startsWith("ssh -n other git init"),
      ),
    );
    assert.equal(log[log.length - 1], "ssh other alchemy/scripts/ops-on-host.sh 'dash'");
  });

  it("names the uncommitted changes that stay behind", async () => {
    const { messages } = await execute(
      Effect.flatMap(Remote, (remote) => remote.run(["dash"])),
      {
        output: (line) =>
          line.endsWith("--show-prefix")
            ? ""
            : line.endsWith("status --porcelain")
              ? " M a.ts\n?? b.ts\n"
              : "abc1234\n",
      },
    );
    assert.match(messages[0], /abc1234 to ctl:server-ansible \(2 uncommitted changes stay here\)/);
  });

  it("does not push when the directory is not a repository", async () => {
    const { log, error } = await execute(
      Effect.flatMap(Remote, (remote) => remote.run(["dash"])),
      { reply: (line) => (line.includes("rev-parse") ? 128 : 0) },
    );
    assert.ok(error instanceof OpsError);
    assert.match(error.message, /not a git repository/);
    assert.equal(log.filter((line) => line.includes("push")).length, 0);
  });
});

describe("rebuild", () => {
  it("pushes both repositories and switches the named host", async () => {
    const { log, site } = await execute(rebuild(Option.some("cynic"), Option.some("root@z")));
    assert.deepEqual(log.slice(0, 10), [
      ...sent("root@z", Git.repository, Git.checkout),
      ...sent("root@z", site, "site"),
    ]);
    assert.equal(
      log[10],
      `ssh -t root@z rm -rf "$HOME/site-tree" && mkdir "$HOME/site-tree" && git -C "$HOME/site" archive HEAD | tar -x -C "$HOME/site-tree" && sudo nixos-rebuild switch --flake "path:$HOME/server-ansible/nixos#cynic" --override-input site "path:$HOME/site-tree"`,
    );
    assert.equal(log[log.length - 1], "ssh ctl alchemy/scripts/ops-on-host.sh 'place-queued'");
  });

  it("rebuilds every host the flake declares, one at a time", async () => {
    const { log } = await execute(rebuild(Option.none(), Option.none()));
    const switches = log.filter((line) => line.includes("nixos-rebuild switch"));
    assert.equal(
      switches.length,
      flakeHosts(readFileSync(`${nixosFolder}/flake.nix`, "utf8")).length,
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
      new RegExp(`^git -C ${Git.repository} archive --format=tar -o \\S+ HEAD:nixos$`),
    );
    assert.match(archives[1], new RegExp(`^git -C ${site} archive --format=tar -o \\S+ HEAD$`));
    const extractions = log.filter((line) => line.startsWith("tar -xf "));
    const tree = / -C (\S+)$/.exec(extractions[0])?.[1];
    assert.ok(tree !== undefined);
    assert.ok(extractions[1].endsWith(` -C ${tree}/site`));
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
  `ssh -n ${target} git init -q -b deploy '${remote}' && git -C '${remote}' config receive.denyCurrentBranch updateInstead`,
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
    const spawner = Layer.succeed(
      Spawner.ChildProcessSpawner,
      Spawner.make((command) => {
        const line = ChildProcess.isStandardCommand(command)
          ? [command.command, ...command.args].join(" ")
          : "(piped command)";
        log.push(line);
        return Effect.succeed(handle(options.reply?.(line) ?? 0, options.output?.(line) ?? ""));
      }),
    );
    const environment = Layer.mergeAll(
      spawner,
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
    return { log, messages, site, home, error: Option.getOrUndefined(error) };
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
