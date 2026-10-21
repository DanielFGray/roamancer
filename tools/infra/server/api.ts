import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
  HttpApiSecurity,
} from "@effect/platform";
import { Context, Schema as S } from "effect";
import { OperationalReportSchema } from "../src/services/OperationalReport.ts";

// ---------------------------------------------------------------------------
// Webhook error schemas
// ---------------------------------------------------------------------------

export class WebhookForbidden extends S.TaggedError<WebhookForbidden>()(
  "WebhookForbidden",
  { message: S.String },
  HttpApiSchema.annotations({ status: 403 }),
) {}

export class WebhookError extends S.TaggedError<WebhookError>()(
  "WebhookError",
  { message: S.String },
  HttpApiSchema.annotations({ status: 500 }),
) {}

// ---------------------------------------------------------------------------
// Error schemas
// ---------------------------------------------------------------------------

export class DeployError extends S.TaggedError<DeployError>()(
  "DeployError",
  { message: S.String },
  HttpApiSchema.annotations({ status: 500 }),
) {}

export class NotFoundError extends S.TaggedError<NotFoundError>()(
  "NotFoundError",
  { message: S.String },
  HttpApiSchema.annotations({ status: 404 }),
) {}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** Alphanumeric + hyphens/underscores/dots, 1-64 chars. No consecutive dots (prevents path traversal). */
const SafeName = S.String.pipe(
  S.pattern(/^[a-zA-Z0-9](?:[a-zA-Z0-9_.-]*[a-zA-Z0-9])?$/),
  S.maxLength(64),
  S.filter((s) => !s.includes(".."), { message: () => "name must not contain '..'" }),
);

export const StubResponse = S.Struct({
  status: S.String,
  message: S.String,
});

/** Git ref: branches, tags, SHAs. Allows alphanumeric, dots, slashes, hyphens, underscores, tildes. */
const SafeRef = S.String.pipe(S.pattern(/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/));

/** Git remote URL: git@host:path, https://host/path, or ssh://host/path */
const SafeRepoUrl = S.String.pipe(S.pattern(/^(https?:\/\/|git@|ssh:\/\/)[a-zA-Z0-9._/-]+$/));

const DeployBody = S.Struct({
  name: SafeName,
  ref: S.optional(SafeRef),
  as: S.optional(SafeName),
  repo: S.optional(SafeRepoUrl),
});

const PromoteBody = S.Struct({
  name: SafeName,
  stage: SafeName,
  force: S.optional(S.Boolean),
});

const RollbackBody = S.Struct({
  name: SafeName,
});

const TeardownBody = S.Struct({
  name: SafeName,
  stage: SafeName,
});

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

export const DeployResultSchema = S.Struct({
  name: S.String,
  stage: S.String,
  hash: S.String,
  type: S.String,
  previewUrl: S.String,
  autoPromote: S.optional(S.String),
});

export const PromoteResultSchema = S.Struct({
  name: S.String,
  stage: S.String,
  domain: S.String,
});

export const RollbackResultSchema = S.Struct({
  name: S.String,
  stage: S.String,
});

export const TeardownResultSchema = S.Struct({
  name: S.String,
  stage: S.String,
});

export const ProjectInfoSchema = S.Struct({
  name: S.String,
  stageCount: S.Number,
  promoted: S.NullOr(S.String),
});

const StageDetailSchema = S.Struct({
  stage: S.String,
  promoted: S.Boolean,
  type: S.String,
  port: S.NullOr(S.Number),
  domain: S.String,
  ref: S.String,
  hash: S.String,
  deployed_at: S.String,
  previewUrl: S.String,
});

export const StageListResultSchema = S.Struct({
  name: S.String,
  stages: S.Array(StageDetailSchema),
  production: S.NullOr(S.String),
});

const nameParam = HttpApiSchema.param("name", SafeName);

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

export class Unauthorized extends S.TaggedError<Unauthorized>()(
  "Unauthorized",
  { message: S.String },
  HttpApiSchema.annotations({ status: 401 }),
) {}

export class CurrentUser extends Context.Tag("CurrentUser")<
  CurrentUser,
  { readonly token: string }
>() {}

export class Authorization extends HttpApiMiddleware.Tag<Authorization>()("Authorization", {
  failure: Unauthorized,
  provides: CurrentUser,
  security: { bearer: HttpApiSecurity.bearer },
}) {}

// ---------------------------------------------------------------------------
// API groups
// ---------------------------------------------------------------------------

const projectsGroup = HttpApiGroup.make("projects")
  .add(HttpApiEndpoint.get("listProjects", "/projects").addSuccess(S.Array(ProjectInfoSchema)))
  .add(
    HttpApiEndpoint.get("getProject")`/projects/${nameParam}`
      .addSuccess(StageListResultSchema)
      .addError(NotFoundError),
  )
  .add(
    HttpApiEndpoint.get("listStages")`/projects/${nameParam}/stages`
      .addSuccess(StageListResultSchema)
      .addError(NotFoundError),
  )
  .middleware(Authorization);

const BackupJobStatusSchema = S.Struct({
  lastRun: S.NullOr(S.String),
  lastResult: S.Union(S.Literal("success"), S.Literal("failure")),
  lastError: S.NullOr(S.String),
  lastFile: S.NullOr(S.String),
});

const BackupStatusResponse = S.Struct({
  postgres: BackupJobStatusSchema,
  vault: BackupJobStatusSchema,
  clickhouse: BackupJobStatusSchema,
  valkey: BackupJobStatusSchema,
  zookeeper: BackupJobStatusSchema,
  signoz: BackupJobStatusSchema,
});

const CaddyRouteSchema = S.Record({ key: S.String, value: S.Unknown });

const statusGroup = HttpApiGroup.make("status")
  .add(HttpApiEndpoint.get("getStatus", "/status").addSuccess(OperationalReportSchema))
  .add(HttpApiEndpoint.get("getBackups", "/backups").addSuccess(BackupStatusResponse))
  .add(HttpApiEndpoint.get("getRoutes", "/routes").addSuccess(S.Array(CaddyRouteSchema)))
  .add(HttpApiEndpoint.post("syncRoutes", "/sync").addSuccess(StubResponse))
  .middleware(Authorization);

const actionsGroup = HttpApiGroup.make("actions")
  .add(
    HttpApiEndpoint.post("deploy", "/deploy")
      .setPayload(DeployBody)
      .addSuccess(DeployResultSchema)
      .addError(DeployError),
  )
  .add(
    HttpApiEndpoint.post("promote", "/promote")
      .setPayload(PromoteBody)
      .addSuccess(PromoteResultSchema)
      .addError(NotFoundError),
  )
  .add(
    HttpApiEndpoint.post("rollback", "/rollback")
      .setPayload(RollbackBody)
      .addSuccess(RollbackResultSchema)
      .addError(NotFoundError),
  )
  .add(
    HttpApiEndpoint.post("teardown", "/teardown")
      .setPayload(TeardownBody)
      .addSuccess(TeardownResultSchema)
      .addError(NotFoundError),
  )
  .middleware(Authorization);

// ---------------------------------------------------------------------------
// Webhooks group (no bearer auth — uses HMAC instead)
// ---------------------------------------------------------------------------

const webhooksGroup = HttpApiGroup.make("webhooks")
  .add(
    HttpApiEndpoint.post("forgejoWebhook", "/webhook/forgejo")
      .addSuccess(StubResponse)
      .addError(WebhookForbidden)
      .addError(WebhookError),
  )
  .add(
    HttpApiEndpoint.post("githubWebhook", "/webhook/github")
      .addSuccess(StubResponse)
      .addError(WebhookForbidden)
      .addError(WebhookError),
  );

// ---------------------------------------------------------------------------
// Top-level API
// ---------------------------------------------------------------------------

export const InfraApi = HttpApi.make("InfraApi")
  .add(projectsGroup)
  .add(statusGroup)
  .add(actionsGroup)
  .add(webhooksGroup);
