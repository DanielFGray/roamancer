import { Effect } from "effect"
import { PasswordGenerator } from "./PasswordGenerator.ts"
import type { EnvField } from "../lib/env-parser.ts"
import { resolveComposed } from "../lib/env-parser.ts"

// ---------------------------------------------------------------------------
// Service
//
// Two-phase resolution:
//   1. Static -> use existing or schema value; Generated -> new password
//   2. Composed -> interpolate from phase-1 values (pure, no effects)
//
// When `existing` is provided (rotation), static fields keep their vault
// value and generated fields get fresh passwords.
// ---------------------------------------------------------------------------

export class SecretResolver extends Effect.Service<SecretResolver>()(
  "infra/SecretResolver",
  {
    effect: Effect.gen(function* () {
      const gen = yield* PasswordGenerator

      return {
        resolve: (
          fields: ReadonlyArray<EnvField>,
          existing?: Record<string, string>,
        ): Effect.Effect<Record<string, string>> =>
          Effect.gen(function* () {
            // Phase 1: Static and Generated
            const phase1 = yield* Effect.reduce(
              fields.filter((f) => f.kind !== "composed"),
              {} as Record<string, string>,
              (acc, field) =>
                field.kind === "static"
                  ? Effect.succeed({ ...acc, [field.key]: existing?.[field.key] ?? field.value })
                  : gen.generate().pipe(Effect.map((pw) => ({ ...acc, [field.key]: pw }))),
            )

            // Phase 2: Composed (pure — fold over phase 1 results)
            return fields
              .filter((f) => f.kind === "composed")
              .reduce(
                (acc, field) => ({ ...acc, [field.key]: resolveComposed(field.value, acc) }),
                phase1,
              )
          }),
      }
    }),
    dependencies: [PasswordGenerator.Default],
  },
) {}
