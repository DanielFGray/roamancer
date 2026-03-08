import { Effect } from "effect"
import { randomBytes } from "node:crypto"

// ---------------------------------------------------------------------------
// Service — crypto.randomBytes, base64 encoded
// ---------------------------------------------------------------------------

export class PasswordGenerator extends Effect.Service<PasswordGenerator>()(
  "infra/PasswordGenerator",
  {
    succeed: {
      generate: (length = 24) =>
        Effect.sync(() => randomBytes(length).toString("base64")),
    },
  },
) {}
