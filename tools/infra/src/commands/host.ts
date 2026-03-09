import { Args, Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { SshClient } from "../services/SshClient.ts"

// ---------------------------------------------------------------------------
// Known hosts
// ---------------------------------------------------------------------------

const knownHosts: Record<string, string> = {
  cynic: "cynic.dlab",
  atheist: "atheist.dlab",
}

const resolveHost = (name: string) => knownHosts[name] ?? name

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

const hostArg = Options.text("on").pipe(
  Options.withDefault("cynic"),
  Options.withDescription("Host name or alias (cynic, atheist)"),
)

const unitArg = Args.text({ name: "unit" }).pipe(
  Args.withDescription("Systemd unit name"),
)

const hostRestart = Command.make("restart", { unit: unitArg, on: hostArg }).pipe(
  Command.withHandler(({ unit, on }) =>
    Effect.gen(function* () {
      const ssh = yield* SshClient
      const host = resolveHost(on)
      yield* Console.log(`Restarting ${unit} on ${host}...`)
      yield* ssh.execInteractive(host, `sudo systemctl restart ${unit}`)
      const output = yield* ssh.exec(host, `systemctl is-active ${unit}`)
      yield* Console.log(`${unit}: ${output.trim()}`)
    }),
  ),
  Command.withDescription("Restart a systemd unit on a remote host"),
)

const hostStop = Command.make("stop", { unit: unitArg, on: hostArg }).pipe(
  Command.withHandler(({ unit, on }) =>
    Effect.gen(function* () {
      const ssh = yield* SshClient
      const host = resolveHost(on)
      yield* Console.log(`Stopping ${unit} on ${host}...`)
      yield* ssh.execInteractive(host, `sudo systemctl stop ${unit}`)
      yield* Console.log(`${unit} stopped`)
    }),
  ),
  Command.withDescription("Stop a systemd unit on a remote host"),
)

const hostStatus = Command.make("status", { unit: unitArg, on: hostArg }).pipe(
  Command.withHandler(({ unit, on }) =>
    Effect.gen(function* () {
      const ssh = yield* SshClient
      const host = resolveHost(on)
      const output = yield* ssh.exec(host, `systemctl status ${unit} --no-pager -l`)
      yield* Console.log(output.trim())
    }),
  ),
  Command.withDescription("Show status of a systemd unit on a remote host"),
)

const hostLogs = Command.make("logs", {
  unit: unitArg,
  on: hostArg,
  lines: Options.integer("lines").pipe(
    Options.withAlias("n"),
    Options.withDefault(50),
    Options.withDescription("Number of lines to show"),
  ),
}).pipe(
  Command.withHandler(({ unit, on, lines }) =>
    Effect.gen(function* () {
      const ssh = yield* SshClient
      const host = resolveHost(on)
      const output = yield* ssh.exec(host, `journalctl -u ${unit} -n ${lines} --no-pager`)
      yield* Console.log(output.trim())
    }),
  ),
  Command.withDescription("Show logs for a systemd unit on a remote host"),
)

// ---------------------------------------------------------------------------
// Group command
// ---------------------------------------------------------------------------

export const hostCommand = Command.make("host").pipe(
  Command.withHandler(() => Effect.void),
  Command.withSubcommands([hostRestart, hostStop, hostStatus, hostLogs]),
  Command.withDescription("Manage systemd units on remote hosts"),
)
