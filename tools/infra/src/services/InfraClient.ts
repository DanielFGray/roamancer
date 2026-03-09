import { Effect, Schema as S } from "effect"
import { INFRA_SERVER_URL, API_TOKEN } from "../lib/config.ts"

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class ClientError extends S.TaggedError<ClientError>()("ClientError", {
  message: S.String,
  status: S.optional(S.Number),
}) {}

// ---------------------------------------------------------------------------
// Response schemas (must match server api.ts)
// ---------------------------------------------------------------------------

const DeployResult = S.Struct({
  name: S.String,
  stage: S.String,
  hash: S.String,
  type: S.String,
  previewUrl: S.String,
})

const PromoteResult = S.Struct({
  name: S.String,
  stage: S.String,
  domain: S.String,
})

const RollbackResult = S.Struct({
  name: S.String,
  stage: S.String,
})

const TeardownResult = S.Struct({
  name: S.String,
  stage: S.String,
})

const ProjectInfo = S.Struct({
  name: S.String,
  stageCount: S.Number,
  promoted: S.NullOr(S.String),
})

const StageDetail = S.Struct({
  stage: S.String,
  promoted: S.Boolean,
  type: S.String,
  port: S.NullOr(S.Number),
  domain: S.String,
  ref: S.String,
  hash: S.String,
  deployed_at: S.String,
  previewUrl: S.String,
})

const StageListResult = S.Struct({
  name: S.String,
  stages: S.Array(StageDetail),
  production: S.NullOr(S.String),
})

const StubResponse = S.Struct({
  status: S.String,
  message: S.String,
})

const BackupJobStatus = S.Struct({
  lastRun: S.NullOr(S.String),
  lastResult: S.Union(S.Literal("success"), S.Literal("failure")),
  lastError: S.NullOr(S.String),
  lastFile: S.NullOr(S.String),
})

const BackupStatusResponse = S.Struct({
  postgres: BackupJobStatus,
  vault: BackupJobStatus,
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const headers = (): Record<string, string> => {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
  }
  if (API_TOKEN) {
    h["Authorization"] = `Bearer ${API_TOKEN}`
  }
  return h
}

const request = <A, I>(
  method: "GET" | "POST",
  path: string,
  schema: S.Schema<A, I>,
  body?: unknown,
): Effect.Effect<A, ClientError> =>
  Effect.tryPromise({
    try: () =>
      fetch(`${INFRA_SERVER_URL}${path}`, {
        method,
        headers: headers(),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
    catch: (err) =>
      new ClientError({
        message: `fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      }),
  }).pipe(
    Effect.flatMap((res) => {
      if (!res.ok) {
        return Effect.tryPromise({
          try: () => res.text(),
          catch: () =>
            new ClientError({
              message: `HTTP ${res.status}`,
              status: res.status,
            }),
        }).pipe(
          Effect.flatMap((text) =>
            Effect.fail(
              new ClientError({
                message: `HTTP ${res.status}: ${text}`,
                status: res.status,
              }),
            ),
          ),
        )
      }

      return Effect.tryPromise({
        try: () => res.json() as Promise<unknown>,
        catch: () =>
          new ClientError({ message: "failed to parse response JSON" }),
      })
    }),
    Effect.flatMap((json) =>
      S.decodeUnknown(schema)(json).pipe(
        Effect.mapError(
          (e) => new ClientError({ message: `invalid response: ${e.message}` }),
        ),
      ),
    ),
  )

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

const make = {
  deploy: (
    name: string,
    ref?: string,
    as?: string,
    repo?: string,
  ) =>
    request("POST", "/deploy", DeployResult, {
      name,
      ...(ref !== undefined ? { ref } : {}),
      ...(as !== undefined ? { as } : {}),
      ...(repo !== undefined ? { repo } : {}),
    }),

  promote: (name: string, stage: string) =>
    request("POST", "/promote", PromoteResult, { name, stage }),

  rollback: (name: string) =>
    request("POST", "/rollback", RollbackResult, { name }),

  teardown: (name: string, stage: string) =>
    request("POST", "/teardown", TeardownResult, { name, stage }),

  listProjects: () =>
    request("GET", "/projects", S.Array(ProjectInfo)),

  getProject: (name: string) =>
    request("GET", `/projects/${encodeURIComponent(name)}`, StageListResult),

  getStages: (name: string) =>
    request(
      "GET",
      `/projects/${encodeURIComponent(name)}/stages`,
      StageListResult,
    ),

  status: () =>
    request("GET", "/status", StubResponse),

  backups: () =>
    request("GET", "/backups", BackupStatusResponse),

  routes: () =>
    request(
      "GET",
      "/routes",
      S.Array(S.Record({ key: S.String, value: S.Unknown })),
    ),

  syncRoutes: () =>
    request("POST", "/sync", StubResponse),
}

export class InfraClient extends Effect.Service<InfraClient>()(
  "infra/InfraClient",
  { succeed: make },
) {}
