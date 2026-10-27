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
import { ChildProcess } from "effect/process";
import { Prompt } from "effect/cli";
import * as Spawner from "effect/process/ChildProcessSpawner";
import { OpsError } from "./Exec.ts";
import { flakeHosts, HostName, install, rebuild } from "./Nixos.ts";
import { Remote, remoteCommand } from "./Remote.ts";
import { route } from "./ops.ts";
import { Site } from "./Site.ts";

const alchemyContents = new URL("..", import.meta.url).pathname;
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
  it("syncs this checkout and runs the host command", async () => {
    const { log } = await execute(Effect.flatMap(Remote, (remote) => remote.run(["dash"])));
    assert.deepEqual(log, [syncAlchemy, "ssh ctl alchemy/scripts/ops-on-host.sh 'dash'"]);
  });

  it("asks for a terminal only when stdin is one", async () => {
    const { log } = await execute(
      Effect.flatMap(Remote, (remote) => remote.run(["login"])),
      {
        terminal: true,
      },
    );
    assert.equal(log.at(-1), "ssh -t ctl alchemy/scripts/ops-on-host.sh 'login'");
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
    assert.equal(log[0], syncAlchemy);
    assert.equal(log[1], "ssh ctl mkdir -p alchemy/.alchemy/input");
    assert.match(
      log[2],
      /^scp -q \/tmp\/c\.json ctl:alchemy\/\.alchemy\/input\/cartridge-\d+-\d+\.json$/,
    );
    assert.match(
      log[3],
      /^ssh ctl env 'CARTRIDGE_FILE=\.alchemy\/input\/cartridge-\d+-\d+\.json' 'ORIGIN=abc' 'REVISION=def' alchemy\/scripts\/ops-on-host\.sh 'deploy' '--stage' 'giglist'$/,
    );
  });

  it("uses OPS_HOST in place of the site's server", async () => {
    const { log } = await execute(
      Effect.flatMap(Remote, (remote) => remote.run(["dash"])),
      {
        env: { OPS_HOST: "other" },
      },
    );
    assert.equal(log.at(-1), "ssh other alchemy/scripts/ops-on-host.sh 'dash'");
  });
});

describe("rebuild", () => {
  it("copies nixos with the site folder and switches the named host", async () => {
    const { log, site } = await execute(rebuild(Option.some("cynic"), Option.some("root@z")));
    assert.deepEqual(log, [
      "ssh root@z test -w /etc/nixos",
      "ssh root@z rsync -a --delete /etc/nixos/ /var/tmp/nixos-before-rebuild/",
      `rsync -a --delete --exclude result --exclude /site ${nixosFolder}/ root@z:/etc/nixos/`,
      `rsync -a --delete --exclude .git ${site}/ root@z:/etc/nixos/site/`,
      "ssh -t root@z sudo nixos-rebuild switch --flake 'path:/etc/nixos#cynic'",
      syncAlchemy,
      "ssh ctl alchemy/scripts/ops-on-host.sh 'place-queued'",
    ]);
  });

  it("creates /etc/nixos on a host that has none", async () => {
    const { log } = await execute(rebuild(Option.some("cynic"), Option.none()), {
      reply: (line) => (line === "ssh cynic test -w /etc/nixos" ? 1 : 0),
    });
    assert.equal(log[1], `ssh -t cynic sudo install -d -o "$(id -un)" -g root -m 0755 /etc/nixos`);
  });

  it("rebuilds every host the flake declares, one at a time", async () => {
    const { log } = await execute(rebuild(Option.none(), Option.none()));
    const switches = log.filter((line) => line.includes("nixos-rebuild switch"));
    assert.deepEqual(
      switches.length,
      flakeHosts(readFileSync(`${nixosFolder}/flake.nix`, "utf8")).length,
    );
  });

  it("stops at the first failure", async () => {
    const { log, error } = await execute(rebuild(Option.none(), Option.none()), {
      reply: (line) => (line.includes("nixos-before-rebuild") ? 1 : 0),
    });
    assert.ok(error instanceof OpsError);
    assert.equal(log.filter((line) => line.includes("nixos-rebuild switch")).length, 0);
    assert.equal(log.filter((line) => line.includes("nixos-before-rebuild")).length, 1);
  });
});

describe("install", () => {
  const options = { host: "cynic", target: "root@z", yes: true, anywhere: ["--debug"] };

  it("builds in the container from a copy with the site folder", async () => {
    const { log, site, home } = await execute(install(options));
    const [volume, copyNixos, copySite, docker] = log;
    assert.equal(volume, "docker volume inspect server-ansible-nix");
    assert.match(
      copyNixos,
      new RegExp(`^rsync -a --delete --exclude result --exclude /site ${nixosFolder}/ `),
    );
    assert.match(copySite, new RegExp(`^rsync -a --delete --exclude \\.git ${site}/ `));
    const tree = / (\S+)\/$/.exec(copyNixos)?.[1];
    assert.ok(tree !== undefined);
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

const syncAlchemy = `rsync -a --delete --exclude node_modules --exclude .alchemy --exclude logs ${alchemyContents} ctl:alchemy/`;

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
        return Effect.succeed(handle(options.reply?.(line) ?? 0));
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
    return { log, site, home, error: Option.getOrUndefined(error) };
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
