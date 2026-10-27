/**
 * Commands that run on the control host, the machine with the Nomad server, OpenBao and the
 * Alchemy state. Each call first syncs this checkout's tools/alchemy to ~/alchemy there, so
 * the host runs the platform cartridges and code in this checkout, then runs
 * scripts/ops-on-host.sh over ssh. The host's Alchemy state and node_modules stay.
 */
import { Clock, Context, Effect, Layer, Random, Stdio } from "effect";
import * as Exec from "./Exec.ts";
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
  { name: "login", description: "Mint a 2-hour OpenBao token from the root token" },
  { name: "check-login", description: "Fail unless the OpenBao token is valid" },
] as const;

/**
 * The command line `ssh` hands to the host's shell: the script, then each argument as one
 * word, after the environment the script reads.
 */
export const remoteCommand = (
  args: ReadonlyArray<string>,
  environment: ReadonlyArray<readonly [string, string]>,
) => {
  const script = ["alchemy/scripts/ops-on-host.sh", ...args.map(Exec.quote)].join(" ");
  return environment.length === 0
    ? script
    : `env ${environment.map(([name, value]) => Exec.quote(`${name}=${value}`)).join(" ")} ${script}`;
};

export class Remote extends Context.Service<Remote>()("ops/Remote", {
  make: Effect.gen(function* () {
    const site = yield* Site;
    const stdio = yield* Stdio.Stdio;
    // With the trailing slash rsync wants, to copy the folder's contents.
    const alchemyContents = new URL("..", import.meta.url).pathname;

    // The folder under .alchemy, which the sync keeps; named per run.
    const sendCartridge = Effect.fn("Remote.sendCartridge")(function* (host: string, file: string) {
      const name = `.alchemy/input/cartridge-${yield* Clock.currentTimeMillis}-${yield* Random.nextIntBetween(0, 1_000_000_000)}.json`;
      yield* Exec.run("ssh", [host, "mkdir -p alchemy/.alchemy/input"]);
      yield* Exec.run("scp", ["-q", file, `${host}:alchemy/${name}`]);
      return name;
    });

    // --delete, so a file removed here cannot linger on the host; the excluded folders hold
    // the host's own state.
    const prepare = Effect.fn("Remote.prepare")(function* (
      args: ReadonlyArray<string>,
      sent: Sent,
    ) {
      const host = yield* site.host;
      yield* Exec.run("rsync", [
        "-a",
        "--delete",
        "--exclude",
        "node_modules",
        "--exclude",
        ".alchemy",
        "--exclude",
        "logs",
        alchemyContents,
        `${host}:alchemy/`,
      ]);
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
      // one has one: prompts such as `ops login` need it, and piped output does not.
      const terminal = yield* stdio.stdinIsTerminal;
      yield* Exec.run("ssh", [...(terminal ? ["-t"] : []), host, command]);
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
