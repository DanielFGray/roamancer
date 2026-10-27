/**
 * Commands that run on the control host, the machine with the Nomad server, OpenBao and the
 * Alchemy state. Each call first pushes this repository's HEAD to the host, so the host runs
 * the committed platform cartridges and code, then runs `src/cli.ts` over ssh after
 * `bun install`. The host's checkout is ~/server-ansible, and ~/alchemy links to its
 * tools/alchemy, so Alchemy's state, which git ignores, stays at ~/alchemy/.alchemy through
 * every push.
 */
import { Clock, Context, Effect, Layer, Random, Stdio } from "effect";
import * as Exec from "./Exec.ts";
import * as Git from "./Git.ts";
import { Site } from "./Site.ts";

/** What the host receives besides the command line. */
export interface Sent {
  /** A cartridge file to copy to the host; the command reads it instead of the recorded one. */
  readonly cartridge?: string | undefined;
  /** The root commit of the repository the cartridge came from. */
  readonly origin?: string | undefined;
  /** The released commit. */
  readonly revision?: string | undefined;
  /** The pushed image a staged deploy runs. */
  readonly stagedImage?: string | undefined;
}

/** The commands the host runs; `ops` forwards their arguments unread. */
export const hostCommands = [
  { name: "plan", description: "Preview an Alchemy deploy of a stage" },
  { name: "deploy", description: "Run Alchemy's deploy of a stage, for example --stage giglist" },
  { name: "destroy", description: "Destroy a stage's resources" },
  { name: "drift", description: "Report drift between the state and the running resources" },
  { name: "state", description: "Read Alchemy's state store" },
  { name: "rollback", description: "Deploy a recorded deployment again: <name> <id>" },
  { name: "deployment", description: "The recorded deployments of an app: list <name>" },
  { name: "dash", description: "Every job's health and each node's load, once" },
  { name: "status", description: "A cartridge's Nomad allocation status" },
  { name: "logs", description: "A job's logs, or why it is not running" },
  { name: "place-queued", description: "Ask Nomad to place queued jobs again" },
  { name: "stage-image", description: "The image a staged deploy runs" },
  {
    name: "login",
    description: "Mint a 2-hour OpenBao token from the root token, typed or piped on stdin",
  },
  { name: "check-login", description: "Fail unless the OpenBao token is valid" },
] as const;

/**
 * The command line `ssh` hands to the host's shell: install dependencies in ~/alchemy, then
 * run src/cli.ts with each argument as one word. Variables Remote already sends are applied
 * to that process only, so `bun install` does not see them.
 */
export const remoteCommand = (
  args: ReadonlyArray<string>,
  environment: ReadonlyArray<readonly [string, string]>,
) => {
  const cli = ["bun", "src/cli.ts", ...args.map(Exec.quote)].join(" ");
  const run =
    environment.length === 0
      ? cli
      : `env ${environment.map(([name, value]) => Exec.quote(`${name}=${value}`)).join(" ")} ${cli}`;
  return `cd alchemy && bun install --frozen-lockfile --silent && exec ${run}`;
};

// Runs in the push's ssh call. ~/alchemy is a link into the checkout, dangling until the push lands. A real folder there is the earlier layout, which
// held Alchemy's state: it must be moved into the checkout by hand, never replaced.
const linkAlchemy = `if [ -d alchemy ] && [ ! -L alchemy ]; then
  echo "~/alchemy is a folder from the rsync layout. Move its .alchemy and node_modules to ~/${Git.checkout}/tools/alchemy, remove it, and run this again." >&2
  exit 1
fi
ln -sfn ${Git.checkout}/tools/alchemy alchemy`;

export class Remote extends Context.Service<Remote>()("ops/Remote", {
  make: Effect.gen(function* () {
    const site = yield* Site;
    const stdio = yield* Stdio.Stdio;

    // The folder under .alchemy, which a push leaves alone; named per run.
    const sendCartridge = Effect.fn("Remote.sendCartridge")(function* (host: string, file: string) {
      const name = `.alchemy/input/cartridge-${yield* Clock.currentTimeMillis}-${yield* Random.nextIntBetween(0, 1_000_000_000)}.json`;
      yield* Exec.run("ssh", ["-n", host, "mkdir -p alchemy/.alchemy/input"]);
      yield* Exec.run("scp", ["-q", file, `${host}:alchemy/${name}`]);
      return name;
    });

    const prepare = Effect.fn("Remote.prepare")(function* (
      args: ReadonlyArray<string>,
      sent: Sent,
    ) {
      const host = yield* site.host;
      yield* Git.push(host, Git.repository, Git.checkout, linkAlchemy);
      const cartridgeFile =
        sent.cartridge === undefined ? undefined : yield* sendCartridge(host, sent.cartridge);
      const variables: ReadonlyArray<readonly [string, string | undefined]> = [
        ["CARTRIDGE_FILE", cartridgeFile],
        ["ORIGIN", sent.origin],
        ["REVISION", sent.revision],
        ["STAGED_IMAGE", sent.stagedImage],
      ];
      const environment = variables.flatMap(([name, value]) =>
        value === undefined ? [] : [[name, value] as const],
      );
      return { host, command: remoteCommand(args, environment) };
    });

    /** Run a host command on this terminal. */
    const run = Effect.fn("Remote.run")(function* (args: ReadonlyArray<string>, sent: Sent = {}) {
      const { host, command } = yield* prepare(args, sent);
      // The remote shell starts in the home folder. A terminal is requested only when this
      // one has one. Piped input is not a terminal: it reaches the host command over ssh's
      // stdin, which the setup calls above never read (see `-n` in Git.push).
      const terminal = yield* stdio.stdinIsTerminal;
      yield* Exec.run("ssh", (terminal ? ["-t"] : []).concat(host, command));
    });

    /** Run a host command and return what it prints. */
    const output = Effect.fn("Remote.output")(function* (
      args: ReadonlyArray<string>,
      sent: Sent = {},
    ) {
      const { host, command } = yield* prepare(args, sent);
      return yield* Exec.output("ssh", [host, command]);
    });

    return { run, output };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}
