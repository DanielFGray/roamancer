/**
 * Host configuration, not apps. `rebuild` pushes the committed repository and site folder to a
 * running host and switches it there, so the host's own Nix builds them. `install` erases a
 * machine's disk and installs a host's configuration, built from the same two commits. The
 * site folder replaces the placeholder values shipped in nixos/site, so it must be a git
 * repository too. Uncommitted changes in either stay on this machine.
 */
import { Config, Console, Effect, FileSystem, Option, Path, Schema as S, Stdio } from "effect";
import { Prompt } from "effect/cli";
import { dockerPush } from "./Builder.ts";
import * as Exec from "./Exec.ts";
import * as Git from "./Git.ts";
import { Remote } from "./Remote.ts";
import { Site } from "./Site.ts";

/** A `nixosConfigurations` name in the root flake.nix, which is also the host's ssh name. */
export const HostName = S.String.check(S.isPattern(/^[a-z0-9-]+$/));

/** The `nixosConfigurations` names a flake declares, in file order. */
export const flakeHosts = (flake: string) =>
  [...flake.matchAll(/^ *nixosConfigurations\.([a-z0-9-]+) *=/gm)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );

/**
 * Switch each host to its configuration in the pushed commit; every host the flake declares
 * when none is named. sudo asks for the password on the terminal, so hosts go one at a time
 * and the first failure stops the run. The ssh target defaults to the host name, so
 * ~/.ssh/config supplies the address and user. The host builds from its checkouts; the
 * switch records the build as a system generation, which is how to roll back.
 */
export const rebuild = Effect.fn("Nixos.rebuild")(function* (
  named: Option.Option<string>,
  target: Option.Option<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const remote = yield* Remote;
  const site = yield* (yield* Site).folder;
  const hosts = Option.isSome(named)
    ? [named.value]
    : flakeHosts(yield* fs.readFileString(`${repositoryRoot}/flake.nix`));
  yield* Effect.forEach(hosts, (host) =>
    Effect.gen(function* () {
      const to = Option.getOrElse(target, () => host);
      yield* Console.error(`== ${host} (${to})`);
      yield* Git.push(to, Git.repository, Git.checkout);
      yield* Git.push(to, site, "site");
      // $HOME expands in the operator's shell, before sudo. git+file builds only the
      // committed files. The site input stays a path: the committed tree is exported
      // without .git so root need not own the checkout, and a path input would otherwise
      // copy .git into the world-readable store. Overriding site hides self.rev, so the
      // build input carries the commit, for ALCHEMY_RUNNER_REVISION.
      yield* Exec.run("ssh", [
        "-t",
        to,
        `rm -rf "$HOME/site-tree" "$HOME/build-info" && mkdir "$HOME/site-tree" "$HOME/build-info" && git -C "$HOME/site" archive HEAD | tar -x -C "$HOME/site-tree" && git -C "$HOME/${Git.checkout}" rev-parse HEAD > "$HOME/build-info/rev" && sudo nixos-rebuild switch --flake "git+file:$HOME/${Git.checkout}#${host}" --override-input site "path:$HOME/site-tree" --override-input build "path:$HOME/build-info"`,
      ]);
    }),
  );
  // A switch can add the host volume or memory a queued job waits for; Nomad does not retry
  // on its own.
  yield* remote.run({ command: "place-queued" });
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
  const site = yield* (yield* Site).folder;
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

  // The committed trees, with the site folder in place of the placeholder one. The root
  // flake's source includes tools/, so the archive is the repository HEAD, not nixos/ alone.
  const tree = yield* fs.makeTempDirectoryScoped();
  yield* Git.exportTree(Git.repository, "HEAD", tree);
  yield* fs.remove(`${tree}/nixos/site`, { recursive: true, force: true });
  yield* Git.exportTree(site, "HEAD", `${tree}/nixos/site`);
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

/**
 * Build the container image that a flake output such as `garage-image` makes, from the
 * committed repository, and push it to the cluster registry. Prints the reference that a
 * platform cartridge pins, `registry/name@sha256:digest`. Nix runs in the nixos/nix container,
 * as for `install`, and this machine's Docker loads and pushes the result.
 */
export const image = Effect.fn("Nixos.image")(function* (output: string) {
  const fs = yield* FileSystem.FileSystem;
  const registry = yield* (yield* Site).registry;
  const tree = yield* fs.makeTempDirectoryScoped();
  const built = yield* fs.makeTempDirectoryScoped();
  yield* Git.exportTree(Git.repository, "HEAD", tree);
  yield* Exec.run("docker", [
    ...["run", "--rm"],
    ...["--volume", `${tree}:/src:ro`],
    ...["--volume", `${built}:/out`],
    ...["--env", "NIX_CONFIG=experimental-features = nix-command flakes"],
    // $0 of the script is the flake output.
    ...["nixos/nix:latest", "sh", "-euc", imageScript, output],
  ]);
  const loaded = yield* Exec.output("docker", ["load", "--input", `${built}/image.tar.gz`]);
  const name = /^Loaded image: (\S+)$/m.exec(loaded)?.[1];
  if (name === undefined) {
    return yield* new Exec.OpsError({ message: `docker load named no image: ${loaded.trim()}` });
  }
  // dockerTools names the image `name:tag` with no registry.
  const tagged = `${registry}/${name}`;
  const repository = tagged.slice(0, tagged.lastIndexOf(":"));
  yield* Exec.run("docker", ["tag", name, tagged]);
  const pushed = yield* dockerPush(repository, tagged);
  yield* Console.log(`${repository}@${pushed.slice(pushed.lastIndexOf("@") + 1)}`);
}, Effect.scoped);

// Runs in the container: $0 is the flake output. A dockerTools image is one gzipped tar file,
// which is copied out of the container's store.
const imageScript = `
nix build "path:/src#$0" --out-link /tmp/image
cp -L /tmp/image /out/image.tar.gz
`;

const repositoryRoot = new URL("../../..", import.meta.url).pathname;
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
