import { Effect, Schema as S } from "effect"
import { spawn } from "bun"

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class SshError extends S.TaggedError<SshError>()("SshError", {
  code: S.NullOr(S.Number),
  signal: S.NullOr(S.String),
  message: S.String,
}) {}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const target = (host: string, user?: string) => user ? `${user}@${host}` : host

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class SshClient extends Effect.Service<SshClient>()("infra/SshClient", {
  succeed: {
    exec: (host: string, command: string, user?: string) =>
      Effect.gen(function* () {
        const dest = target(host, user)
        const proc = spawn({
          cmd: ["ssh", dest, `bash -lc ${JSON.stringify(command)}`],
          stdout: "pipe",
          stderr: "pipe",
        })

        const stdout = yield* Effect.promise(() => proc.stdout.text())
        const exitCode = yield* Effect.promise(() => proc.exited)

        if (exitCode !== 0) {
          const stderr = yield* Effect.promise(() => proc.stderr.text())
          return yield* Effect.fail(
            new SshError({ code: exitCode, signal: null, message: `ssh ${dest}: ${stderr.trim()}` }),
          )
        }

        return stdout
      }),

    /** Write content to a remote file via base64 pipe (immune to heredoc injection) */
    writeFile: (host: string, remotePath: string, content: string, opts?: { mode?: string; user?: string }) =>
      Effect.gen(function* () {
        const b64 = Buffer.from(content).toString("base64")
        const decode = `echo '${b64}' | base64 -d`
        const write = `${decode} > ${remotePath}`
        const chmod = opts?.mode ? ` && chmod ${opts.mode} ${remotePath}` : ""
        const dest = target(host, opts?.user)
        const cmd = `${write}${chmod}`
        const proc = spawn({
          cmd: ["ssh", dest, `bash -lc ${JSON.stringify(cmd)}`],
          stdout: "pipe",
          stderr: "pipe",
        })
        const exitCode = yield* Effect.promise(() => proc.exited)
        if (exitCode !== 0) {
          const stderr = yield* Effect.promise(() => proc.stderr.text())
          return yield* Effect.fail(
            new SshError({ code: exitCode, signal: null, message: `ssh ${dest} writeFile: ${stderr.trim()}` }),
          )
        }
      }),

    /** Run a command interactively with TTY (for sudo, etc.) */
    execInteractive: (host: string, command: string, user?: string) =>
      Effect.gen(function* () {
        const dest = target(host, user)
        const proc = spawn({
          cmd: ["ssh", "-t", dest, `bash -lc ${JSON.stringify(command)}`],
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        })

        const exitCode = yield* Effect.promise(() => proc.exited)

        if (exitCode !== 0) {
          return yield* Effect.fail(
            new SshError({ code: exitCode, signal: null, message: `ssh ${dest}: exited ${exitCode}` }),
          )
        }
      }),

    rsync: (source: string, dest: string, host: string, user?: string) =>
      Effect.gen(function* () {
        const remoteDest = `${target(host, user)}:${dest}`
        const proc = spawn({
          cmd: ["rsync", "-a", "--delete", source, remoteDest],
          stderr: "pipe",
        })

        const exitCode = yield* Effect.promise(() => proc.exited)

        if (exitCode !== 0) {
          const stderr = yield* Effect.promise(() => proc.stderr.text())
          return yield* Effect.fail(
            new SshError({ code: exitCode, signal: null, message: `rsync: ${stderr.trim()}` }),
          )
        }
      }),
  },
}) {}
