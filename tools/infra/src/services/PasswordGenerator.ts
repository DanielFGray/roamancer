import { Effect } from "effect"
import { spawn } from "bun"

// ---------------------------------------------------------------------------
// Service — openssl rand, base64url encoded
// ---------------------------------------------------------------------------

export class PasswordGenerator extends Effect.Service<PasswordGenerator>()(
  "infra/PasswordGenerator",
  {
    succeed: {
      generate: (bytes = 32) =>
        Effect.gen(function* () {
          const proc = spawn({
            cmd: ["openssl", "rand", "-base64", String(bytes)],
            stdout: "pipe",
            stderr: "pipe",
          })
          const exitCode = yield* Effect.promise(() => proc.exited)
          if (exitCode !== 0) {
            return yield* Effect.die("openssl rand failed")
          }
          const raw = yield* Effect.promise(() => proc.stdout.text())
          return raw.trim().replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
        }),
    },
  },
) {}
