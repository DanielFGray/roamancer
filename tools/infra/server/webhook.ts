import { HttpApiBuilder, HttpServerRequest } from "@effect/platform";
import { Effect, Schema as S } from "effect";
import { createHmac, timingSafeEqual } from "node:crypto";

import { InfraApi, WebhookForbidden, WebhookError } from "./api.ts";
import { AgentSecrets } from "./secrets.ts";
import { DeployRunner } from "../src/services/DeployRunner.ts";
import { WEBHOOK_AUTO_PROMOTE } from "../src/lib/config.ts";

// ---------------------------------------------------------------------------
// Shared validation
// ---------------------------------------------------------------------------

/** Matches SafeName in api.ts — allows dots for repos like dfg.rocks */
const REPO_NAME_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9_.-]*[a-zA-Z0-9])?$/;
const MAX_BODY_BYTES = 1024 * 1024;
const readBody = Effect.fnUntraced(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest;
  return yield* req.text.pipe(
    Effect.mapError((e) => new WebhookError({ message: `failed to read body: ${e.message}` })),
    Effect.filterOrFail(
      (body) => Buffer.byteLength(body) <= MAX_BODY_BYTES,
      () => new WebhookError({ message: `request body exceeds ${MAX_BODY_BYTES} bytes` }),
    ),
  );
});

const validateHmac = Effect.fnUntraced(function* (secret: string, body: string, signature: string) {
  const expected = createHmac("sha256", secret).update(body).digest("hex");

  const expectedBuf = Buffer.from(expected, "hex");
  const signatureBuf = Buffer.from(signature, "hex");

  if (expectedBuf.length !== signatureBuf.length || !timingSafeEqual(expectedBuf, signatureBuf)) {
    return yield* new WebhookForbidden({ message: "invalid HMAC signature" });
  }
});

const PushPayload = S.Struct({
  ref: S.optional(S.String),
  repository: S.optional(S.Struct({ name: S.optional(S.String) })),
});

const parsePushPayload = Effect.fnUntraced(function* (rawBody: string) {
  const json = yield* S.decodeUnknown(S.parseJson(PushPayload))(rawBody).pipe(
    Effect.mapError(() => new WebhookError({ message: "invalid JSON in webhook body" })),
  );

  const fullRef = json.ref ?? "refs/heads/unknown";
  const branch = fullRef.replace(/^refs\/heads\//, "");
  const repoName = json.repository?.name ?? "unknown";

  if (!REPO_NAME_RE.test(repoName)) {
    return yield* new WebhookError({
      message: `invalid repository name: ${repoName}`,
    });
  }

  return { branch, repoName };
});

// ---------------------------------------------------------------------------
// Deploy trigger with auto-promote
// ---------------------------------------------------------------------------

const triggerDeploy = (name: string, ref: string) =>
  Effect.gen(function* () {
    yield* Effect.log(`Webhook deploy triggered: ${name}@${ref}`);
    const runner = yield* DeployRunner;
    const result = yield* runner.deploy({ name, ref });
    yield* Effect.log(`Webhook deploy complete: ${result.name}@${result.hash} -> ${result.stage}`);

    // Auto-promote is opt-in and disabled by default.
    if (result.autoPromote && result.autoPromote === ref) {
      if (!WEBHOOK_AUTO_PROMOTE) {
        yield* Effect.logWarning(
          `Skipping auto-promote for ${name}/${result.stage}; set INFRA_WEBHOOK_AUTO_PROMOTE=true to enable`,
        );
      } else {
        yield* Effect.log(
          `Auto-promoting ${name}/${result.stage} (branch ${ref} matches autoPromote)`,
        );
        yield* runner.promote({ name, stage: result.stage });
        yield* Effect.log(`Auto-promote complete: ${name} -> production`);
      }
    }
  }).pipe(
    Effect.catchAllCause((cause) => Effect.log(`Webhook deploy failed: ${name}@${ref}: ${cause}`)),
  );

// ---------------------------------------------------------------------------
// Webhook group handler
// ---------------------------------------------------------------------------

export const WebhooksGroupLive = HttpApiBuilder.group(InfraApi, "webhooks", (handlers) =>
  handlers
    .handle(
      "forgejoWebhook",
      Effect.fnUntraced(function* () {
        const rawBody = yield* readBody();
        const req = yield* HttpServerRequest.HttpServerRequest;
        const { webhookSecret } = yield* AgentSecrets;
        if (!webhookSecret) {
          return yield* new WebhookError({ message: "WEBHOOK_SECRET not configured" });
        }
        const signature = req.headers["x-gitea-signature"] ?? "";
        yield* validateHmac(webhookSecret, rawBody, signature);

        const { branch, repoName } = yield* parsePushPayload(rawBody);
        yield* Effect.forkDaemon(triggerDeploy(repoName, branch));

        return { status: "accepted" as const, message: "deploy queued" };
      }),
    )
    .handle(
      "githubWebhook",
      Effect.fnUntraced(function* () {
        const rawBody = yield* readBody();
        const req = yield* HttpServerRequest.HttpServerRequest;
        const { webhookSecret } = yield* AgentSecrets;
        if (!webhookSecret) {
          return yield* new WebhookError({ message: "WEBHOOK_SECRET not configured" });
        }

        // GitHub prefixes signature with "sha256="
        const sigHeader = req.headers["x-hub-signature-256"] ?? "";
        if (!sigHeader.startsWith("sha256=")) {
          return yield* new WebhookForbidden({ message: "invalid signature format" });
        }
        yield* validateHmac(webhookSecret, rawBody, sigHeader.slice("sha256=".length));

        const { branch, repoName } = yield* parsePushPayload(rawBody);
        yield* Effect.forkDaemon(triggerDeploy(repoName, branch));

        return { status: "accepted" as const, message: "deploy queued" };
      }),
    ),
);
