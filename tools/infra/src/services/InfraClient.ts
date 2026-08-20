import { Effect, Schema as S } from "effect";
import * as HttpClient from "@effect/platform/HttpClient";
import * as HttpClientRequest from "@effect/platform/HttpClientRequest";
import { INFRA_SERVER_URL, API_TOKEN } from "../lib/config.ts";

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
  autoPromote: S.optional(S.String),
});

const PromoteResult = S.Struct({
  name: S.String,
  stage: S.String,
  domain: S.String,
});

const RollbackResult = S.Struct({
  name: S.String,
  stage: S.String,
});

const TeardownResult = S.Struct({
  name: S.String,
  stage: S.String,
});

const ProjectInfo = S.Struct({
  name: S.String,
  stageCount: S.Number,
  promoted: S.NullOr(S.String),
});

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
});

const StageListResult = S.Struct({
  name: S.String,
  stages: S.Array(StageDetail),
  production: S.NullOr(S.String),
});

const StubResponse = S.Struct({
  status: S.String,
  message: S.String,
});

const BackupJobStatus = S.Struct({
  lastRun: S.NullOr(S.String),
  lastResult: S.Union(S.Literal("success"), S.Literal("failure")),
  lastError: S.NullOr(S.String),
  lastFile: S.NullOr(S.String),
});

const BackupStatusResponse = S.Struct({
  postgres: BackupJobStatus,
  vault: BackupJobStatus,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const request = <A, I>(
  client: HttpClient.HttpClient,
  method: "GET" | "POST",
  path: string,
  schema: S.Schema<A, I>,
  body?: unknown,
): Effect.Effect<A, ClientError> =>
  Effect.gen(function* () {
    const baseRequest =
      method === "GET"
        ? HttpClientRequest.get(`${INFRA_SERVER_URL}${path}`)
        : HttpClientRequest.post(`${INFRA_SERVER_URL}${path}`);
    const request =
      body === undefined
        ? baseRequest
        : yield* HttpClientRequest.bodyJson(body)(baseRequest).pipe(
            Effect.mapError(
              (error) => new ClientError({ message: `failed to encode request: ${String(error)}` }),
            ),
          );
    const authenticatedRequest = API_TOKEN
      ? HttpClientRequest.setHeader(request, "Authorization", `Bearer ${API_TOKEN}`)
      : request;
    return yield* client
      .execute(authenticatedRequest)
      .pipe(
        Effect.mapError((err) => new ClientError({ message: `request failed: ${err.message}` })),
      );
  }).pipe(
    Effect.flatMap((res) => {
      if (res.status < 200 || res.status >= 300) {
        return res.text.pipe(
          Effect.mapError(
            () => new ClientError({ message: `HTTP ${res.status}`, status: res.status }),
          ),
          Effect.flatMap((text) =>
            Effect.fail(
              new ClientError({
                message: `HTTP ${res.status}: ${text}`,
                status: res.status,
              }),
            ),
          ),
        );
      }

      return res.json.pipe(
        Effect.mapError(() => new ClientError({ message: "failed to parse response JSON" })),
      );
    }),
    Effect.flatMap((json) =>
      S.decodeUnknown(schema)(json).pipe(
        Effect.mapError((e) => new ClientError({ message: `invalid response: ${e.message}` })),
      ),
    ),
  );

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

const make = (client: HttpClient.HttpClient) => ({
  deploy: (name: string, ref?: string, as?: string, repo?: string) =>
    request(client, "POST", "/deploy", DeployResult, {
      name,
      ...(ref !== undefined ? { ref } : {}),
      ...(as !== undefined ? { as } : {}),
      ...(repo !== undefined ? { repo } : {}),
    }),

  promote: (name: string, stage: string) =>
    request(client, "POST", "/promote", PromoteResult, { name, stage }),

  rollback: (name: string) => request(client, "POST", "/rollback", RollbackResult, { name }),

  teardown: (name: string, stage: string) =>
    request(client, "POST", "/teardown", TeardownResult, { name, stage }),

  listProjects: () => request(client, "GET", "/projects", S.Array(ProjectInfo)),

  getProject: (name: string) =>
    request(client, "GET", `/projects/${encodeURIComponent(name)}`, StageListResult),

  getStages: (name: string) =>
    request(client, "GET", `/projects/${encodeURIComponent(name)}/stages`, StageListResult),

  status: () => request(client, "GET", "/status", StubResponse),

  backups: () => request(client, "GET", "/backups", BackupStatusResponse),

  routes: () =>
    request(client, "GET", "/routes", S.Array(S.Record({ key: S.String, value: S.Unknown }))),

  syncRoutes: () => request(client, "POST", "/sync", StubResponse),
});

export class InfraClient extends Effect.Service<InfraClient>()("infra/InfraClient", {
  effect: Effect.gen(function* () {
    return make(yield* HttpClient.HttpClient);
  }),
}) {}
