import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
  HttpApiSecurity,
} from "@effect/platform"
import { Context, Schema } from "effect"

// ---------------------------------------------------------------------------
// Webhook error schemas
// ---------------------------------------------------------------------------

export class WebhookForbidden extends Schema.TaggedError<WebhookForbidden>()(
  "WebhookForbidden",
  { message: Schema.String },
  HttpApiSchema.annotations({ status: 403 }),
) {}

export class WebhookError extends Schema.TaggedError<WebhookError>()(
  "WebhookError",
  { message: Schema.String },
  HttpApiSchema.annotations({ status: 500 }),
) {}

// ---------------------------------------------------------------------------
// Error schemas
// ---------------------------------------------------------------------------

export class DeployError extends Schema.TaggedError<DeployError>()(
  "DeployError",
  { message: Schema.String },
  HttpApiSchema.annotations({ status: 500 }),
) {}

export class NotFoundError extends Schema.TaggedError<NotFoundError>()(
  "NotFoundError",
  { message: Schema.String },
  HttpApiSchema.annotations({ status: 404 }),
) {}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** Alphanumeric + hyphens/underscores, 1-64 chars. Prevents path traversal and shell injection. */
const SafeName = Schema.String.pipe(
  Schema.pattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/),
)

export const StubResponse = Schema.Struct({
  status: Schema.String,
  message: Schema.String,
})

/** Git ref: branches, tags, SHAs. Allows alphanumeric, dots, slashes, hyphens, underscores, tildes. */
const SafeRef = Schema.String.pipe(
  Schema.pattern(/^[a-zA-Z0-9][a-zA-Z0-9._\/-]{0,127}$/),
)

/** Git remote URL: git@host:path, https://host/path, or ssh://host/path */
const SafeRepoUrl = Schema.String.pipe(
  Schema.pattern(/^(https?:\/\/|git@|ssh:\/\/)[a-zA-Z0-9._\/-]+$/),
)

const DeployBody = Schema.Struct({
  name: SafeName,
  ref: Schema.optional(SafeRef),
  as: Schema.optional(SafeName),
  repo: Schema.optional(SafeRepoUrl),
})

const PromoteBody = Schema.Struct({
  name: SafeName,
  stage: SafeName,
  force: Schema.optional(Schema.Boolean),
})

const RollbackBody = Schema.Struct({
  name: SafeName,
})

const TeardownBody = Schema.Struct({
  name: SafeName,
  stage: SafeName,
})

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

export const DeployResultSchema = Schema.Struct({
  name: Schema.String,
  stage: Schema.String,
  hash: Schema.String,
  type: Schema.String,
  previewUrl: Schema.String,
})

export const PromoteResultSchema = Schema.Struct({
  name: Schema.String,
  stage: Schema.String,
  domain: Schema.String,
})

export const RollbackResultSchema = Schema.Struct({
  name: Schema.String,
  stage: Schema.String,
})

export const TeardownResultSchema = Schema.Struct({
  name: Schema.String,
  stage: Schema.String,
})

export const ProjectInfoSchema = Schema.Struct({
  name: Schema.String,
  stageCount: Schema.Number,
  promoted: Schema.NullOr(Schema.String),
})

const StageDetailSchema = Schema.Struct({
  stage: Schema.String,
  promoted: Schema.Boolean,
  type: Schema.String,
  port: Schema.NullOr(Schema.Number),
  ref: Schema.String,
  hash: Schema.String,
  deployed_at: Schema.String,
})

export const StageListResultSchema = Schema.Struct({
  name: Schema.String,
  stages: Schema.Array(StageDetailSchema),
  production: Schema.NullOr(Schema.String),
})

const nameParam = HttpApiSchema.param("name", SafeName)

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  { message: Schema.String },
  HttpApiSchema.annotations({ status: 401 }),
) {}

export class CurrentUser extends Context.Tag("CurrentUser")<
  CurrentUser,
  { readonly token: string }
>() {}

export class Authorization extends HttpApiMiddleware.Tag<Authorization>()(
  "Authorization",
  {
    failure: Unauthorized,
    provides: CurrentUser,
    security: { bearer: HttpApiSecurity.bearer },
  },
) {}

// ---------------------------------------------------------------------------
// API groups
// ---------------------------------------------------------------------------

const projectsGroup = HttpApiGroup.make("projects")
  .add(
    HttpApiEndpoint.get("listProjects", "/projects")
      .addSuccess(Schema.Array(ProjectInfoSchema)),
  )
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
  .middleware(Authorization)

const BackupJobStatusSchema = Schema.Struct({
  lastRun: Schema.NullOr(Schema.String),
  lastResult: Schema.Union(Schema.Literal("success"), Schema.Literal("failure")),
  lastError: Schema.NullOr(Schema.String),
  lastFile: Schema.NullOr(Schema.String),
})

const BackupStatusResponse = Schema.Struct({
  postgres: BackupJobStatusSchema,
  vault: BackupJobStatusSchema,
})

const statusGroup = HttpApiGroup.make("status")
  .add(
    HttpApiEndpoint.get("getStatus", "/status").addSuccess(StubResponse),
  )
  .add(
    HttpApiEndpoint.get("getBackups", "/backups").addSuccess(BackupStatusResponse),
  )
  .middleware(Authorization)

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
  .middleware(Authorization)

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

// ---------------------------------------------------------------------------
// Top-level API
// ---------------------------------------------------------------------------

export const InfraApi = HttpApi.make("InfraApi")
  .add(projectsGroup)
  .add(statusGroup)
  .add(actionsGroup)
  .add(webhooksGroup)
