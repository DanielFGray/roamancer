/**
 * Host configuration, not apps. `rebuild` copies the repository's nixos folder to a running
 * host and switches it there, so the host's own Nix builds it. `install` erases a machine's
 * disk and installs a host's configuration. Both give the build this installation's site
 * folder in place of the placeholder values shipped in nixos/site.
 */
import { Config, Console, Effect, FileSystem, Option, Path, Schema as S, Stdio } from "effect";
import { Prompt } from "effect/cli";
import * as Exec from "./Exec.ts";
import { Remote } from "./Remote.ts";
import { Site } from "./Site.ts";

/** A `nixosConfigurations` name in nixos/flake.nix, which is also the host's ssh name. */
export const HostName = S.String.check(S.isPattern(/^[a-z0-9-]+$/));

/** The `nixosConfigurations` names a flake declares, in file order. */
export const flakeHosts = (flake: string) =>
  [...flake.matchAll(/^ *nixosConfigurations\.([a-z0-9-]+) *=/gm)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );

/**
 * Sync nixos/ to each host's /etc/nixos and switch it to that configuration; every host the
 * flake declares when none is named. sudo asks for the password on the terminal, so hosts go
 * one at a time and the first failure stops the run. The ssh target defaults to the host
 * name, so ~/.ssh/config supplies the address and user.
 */
export const rebuild = Effect.fn("Nixos.rebuild")(function* (
  named: Option.Option<string>,
  target: Option.Option<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const remote = yield* Remote;
  const hosts = Option.isSome(named)
    ? [named.value]
    : flakeHosts(yield* fs.readFileString(`${nixosFolder}/flake.nix`));
  yield* Effect.forEach(hosts, (host) =>
    Effect.gen(function* () {
      const to = Option.getOrElse(target, () => host);
      yield* Console.error(`== ${host} (${to})`);
      // A freshly installed host has no /etc/nixos until its first rebuild declares one. The
      // test fails for any reason; the install then reports a connection problem itself.
      yield* Exec.run("ssh", [to, "test", "-w", "/etc/nixos"]).pipe(
        Effect.catchTag("OpsError", () =>
          Exec.run("ssh", ["-t", to, 'sudo install -d -o "$(id -un)" -g root -m 0755 /etc/nixos']),
        ),
      );
      // The copy replaces /etc/nixos. A change made by hand on the host is lost by the
      // switch, and a rollback needs the source it was built from, so keep what was there.
      yield* Exec.run("ssh", [to, "rsync -a --delete /etc/nixos/ /var/tmp/nixos-before-rebuild/"]);
      yield* copyNixos(`${to}:/etc/nixos`);
      yield* Exec.run("ssh", [
        "-t",
        to,
        `sudo nixos-rebuild switch --flake ${Exec.quote(`path:/etc/nixos#${host}`)}`,
      ]);
    }),
  );
  // A switch can add the host volume or memory a queued job waits for; Nomad does not retry
  // on its own.
  yield* remote.run(["place-queued"]);
});

/**
 * Erase a machine's disk and install a host's configuration with nixos-anywhere, for a
 * machine that does not run NixOS yet (a running one takes `rebuild`). The workstation has
 * no Nix, so the build runs in the nixos/nix container. Its store lives in a named volume
 * bound to ~/.cache, not Docker's data root, because a system closure fills a small root
 * disk; Docker seeds the empty volume from the image on first use.
 *
 * Files under ~/.local/state/server-ansible/extra-files/<host> (SSH host keys, Tailscale
 * state, and for a cluster node its CA certificates and password hash) are copied onto the
 * new root, so the host keeps its identity across the reinstall. The host's config sets the
 * owners and modes of the files it reads; this sets only those of /etc/ssh and Tailscale.
 * Folder modes are copied too: sshd reads authorized_keys.d as the user, so etc/ssh must be
 * 0755.
 */
export const install = Effect.fn("Nixos.install")(function* (options: {
  readonly host: string;
  readonly target: string;
  readonly yes: boolean;
  /** Further arguments for nixos-anywhere. */
  readonly anywhere: ReadonlyArray<string>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { host, target } = options;
  // Resolve the site folder before asking, so a missing OPS_SITE costs no answer.
  yield* (yield* Site).folder;
  if (!options.yes) yield* confirmErase(host, target);

  const home = yield* Config.String("HOME");
  const key = yield* Config.String("SSH_KEY").pipe(
    Config.withDefault(path.join(home, ".ssh", "id_ed25519")),
  );
  const extra = path.join(home, ".local", "state", "server-ansible", "extra-files", host);
  const hasExtra = yield* fs.exists(extra);

  if (!(yield* Exec.succeeds("docker", ["volume", "inspect", nixVolume]))) {
    const store = path.join(home, ".cache", nixVolume);
    yield* fs.makeDirectory(store, { recursive: true });
    yield* Exec.output("docker", [
      ...["volume", "create", "--opt", "type=none", "--opt", "o=bind"],
      ...["--opt", `device=${store}`, nixVolume],
    ]);
  }

  const tree = yield* fs.makeTempDirectoryScoped();
  yield* copyNixos(tree);
  yield* Exec.run("docker", [
    ...["run", "--rm", "--network", "host"],
    ...["--volume", `${nixVolume}:/nix`],
    ...["--volume", `${tree}:/src:ro`],
    ...["--volume", `${key}:/key:ro`],
    ...(hasExtra ? ["--volume", `${extra}:/extra:ro`] : []),
    ...["--env", "NIX_CONFIG=experimental-features = nix-command flakes"],
    ...["nixos/nix:latest", "sh", "-euc", containerScript],
    // $0, $1 and $2 of the script, then nixos-anywhere's own arguments.
    nixosAnywhere,
    host,
    target,
    ...(hasExtra
      ? [
          "--extra-files",
          "/extra",
          "--chown",
          "/etc/ssh",
          "0:0",
          "--chown",
          "/var/lib/tailscale",
          "0:0",
        ]
      : []),
    ...options.anywhere,
  ]);
}, Effect.scoped);

const nixosFolder = new URL("../../../nixos", import.meta.url).pathname;
const nixVolume = "server-ansible-nix";
const nixosAnywhere = "github:nix-community/nixos-anywhere/1.11.0";

// Runs in the container: $0 is the nixos-anywhere flake, $1 the host, $2 the ssh target, and
// the rest are nixos-anywhere's arguments.
const containerScript = `
install -d -m700 /root/.ssh && install -m600 /key /root/.ssh/id
printf "Host *\\n  IdentityFile /root/.ssh/id\\n  StrictHostKeyChecking accept-new\\n" > /root/.ssh/config
cp -r /src /work
host=$1 target=$2
shift 2
exec nix run "$0" -- --flake "path:/work#$host" --target-host "$target" "$@"
`;

/** Copy the nixos folder to `destination`, a path or host:path, with the site folder as its `site`. */
const copyNixos = Effect.fn("Nixos.copy")(function* (destination: string) {
  const folder = yield* (yield* Site).folder;
  // nixos/site holds placeholder values; the build must see this installation's.
  yield* Exec.run("rsync", [
    ...["-a", "--delete", "--exclude", "result", "--exclude", "/site"],
    `${nixosFolder}/`,
    `${destination}/`,
  ]);
  yield* Exec.run("rsync", [
    ...["-a", "--delete", "--exclude", ".git"],
    `${folder}/`,
    `${destination}/site/`,
  ]);
});

/** Ask for the host name before a disk is erased; a script without a terminal passes --yes. */
const confirmErase = Effect.fn("Nixos.confirmErase")(function* (host: string, target: string) {
  if (!(yield* (yield* Stdio.Stdio).stdinIsTerminal)) {
    return yield* new Exec.OpsError({
      message: `pass --yes to erase ${target} without a terminal`,
    });
  }
  const answer = yield* Prompt.run(
    Prompt.String({ message: `This erases the disk of ${target}. Type ${host} to continue` }),
  ).pipe(Effect.mapError(() => new Exec.OpsError({ message: "not confirmed" })));
  if (answer !== host) return yield* new Exec.OpsError({ message: "not confirmed" });
});
