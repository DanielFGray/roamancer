import { HttpApiBuilder, HttpServerRequest } from "@effect/platform"
import { Effect } from "effect"
import { createHmac, timingSafeEqual } from "node:crypto"

import { InfraApi, WebhookForbidden, WebhookError } from "./api.ts"
import { DeployRunner } from "../src/services/DeployRunner.ts"
import { WEBHOOK_SECRET } from "../src/lib/config.ts"

// ---------------------------------------------------------------------------
// HMAC validation
// ---------------------------------------------------------------------------

const validateSignature = (
  body: string,
  signature: string,
) =>
  Effect.gen(function* () {
    if (!WEBHOOK_SECRET) {
      return yield* new WebhookError({
        message: "WEBHOOK_SECRET not configured",
      })
    }

    const expected = createHmac("sha256", WEBHOOK_SECRET)
      .update(body)
      .digest("hex")

    const expectedBuf = Buffer.from(expected, "hex")
    const signatureBuf = Buffer.from(signature, "hex")

    if (expectedBuf.length !== signatureBuf.length || !timingSafeEqual(expectedBuf, signatureBuf)) {
      return yield* new WebhookForbidden({
        message: "invalid HMAC signature",
      })
    }
  })

// ---------------------------------------------------------------------------
// Deploy trigger (stub)
// ---------------------------------------------------------------------------

const triggerDeploy = (name: string, ref: string) =>
  Effect.gen(function* () {
    yield* Effect.log(`Webhook deploy triggered: ${name}@${ref}`)
    const runner = yield* DeployRunner
    yield* runner.deploy({ name, ref }).pipe(
      Effect.tap((result) =>
        Effect.log(`Webhook deploy complete: ${result.name}@${result.hash} -> ${result.stage}`),
      ),
      Effect.catchAllCause((cause) =>
        Effect.log(`Webhook deploy failed: ${name}@${ref}: ${cause}`),
      ),
    )
  })

// ---------------------------------------------------------------------------
// Webhook group handler
// ---------------------------------------------------------------------------

export const WebhooksGroupLive = HttpApiBuilder.group(
  InfraApi,
  "webhooks",
  (handlers) =>
    handlers.handle("forgejoWebhook", () =>
      Effect.gen(function* () {
        // need raw body for HMAC — read from request
        const req = yield* HttpServerRequest.HttpServerRequest
        const MAX_BODY_BYTES = 1024 * 1024 // 1 MB
        const rawBody = yield* req.text.pipe(
          Effect.mapError(
            (e) => new WebhookError({ message: `failed to read body: ${e.message}` }),
          ),
          Effect.filterOrFail(
            (body) => Buffer.byteLength(body) <= MAX_BODY_BYTES,
            () => new WebhookError({ message: `request body exceeds ${MAX_BODY_BYTES} bytes` }),
          ),
        )

        const signature =
          req.headers["x-gitea-signature"] ?? ""

        yield* validateSignature(rawBody, signature)

        // parse push payload
        const json = yield* Effect.try({
          try: () =>
            JSON.parse(rawBody) as {
              ref?: string
              repository?: { name?: string }
            },
          catch: () => new WebhookError({ message: "invalid JSON in webhook body" }),
        })

        const fullRef = json.ref ?? "refs/heads/unknown"
        const branch = fullRef.replace(/^refs\/heads\//, "")
        const repoName = json.repository?.name ?? "unknown"

        // Validate repo name before passing to deploy (same rule as API SafeName)
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(repoName)) {
          return yield* new WebhookError({
            message: `invalid repository name: ${repoName}`,
          })
        }

        // fire-and-forget: fork deploy into background fiber
        yield* Effect.fork(triggerDeploy(repoName, branch))

        return {
          status: "accepted" as const,
          message: "deploy queued",
        }
      }),
    ),
)
