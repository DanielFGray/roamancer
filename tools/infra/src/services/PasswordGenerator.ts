import { Effect, Stream } from "effect";
import * as Command from "@effect/platform/Command";
import { BunContext } from "@effect/platform-bun";

// ---------------------------------------------------------------------------
// Service — openssl rand, base64url encoded
//
// Password generation is treated as an infrastructure precondition, not a
// recoverable failure: if openssl is missing or misbehaves, the environment
// is broken and every caller would just propagate the same problem anyway.
// ---------------------------------------------------------------------------

const generateOnce = (bytes: number) =>
  Effect.gen(function* () {
    const process = yield* Command.start(Command.make("openssl", "rand", "-base64", String(bytes)));
    const stdout = yield* Stream.decodeText(process.stdout).pipe(
      Stream.runFold("", (acc, chunk) => acc + chunk),
    );
    const exitCode = yield* process.exitCode;
    if (exitCode !== 0) return yield* Effect.dieMessage(`openssl rand failed (exit ${exitCode})`);
    return stdout;
  }).pipe(Effect.scoped, Effect.orDie, Effect.provide(BunContext.layer));

export class PasswordGenerator extends Effect.Service<PasswordGenerator>()(
  "infra/PasswordGenerator",
  {
    succeed: {
      generate: (bytes = 32) =>
        generateOnce(bytes).pipe(
          Effect.map((raw) => raw.trim().replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")),
        ),
    },
  },
) {}
