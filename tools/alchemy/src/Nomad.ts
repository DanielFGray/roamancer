import { Context, Effect, Layer, Option, Redacted, Schema as S } from "effect";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { Job, toJobSpec } from "./Job.ts";
import type { ReleaseJobSpec } from "./ReleaseJob.ts";
import * as NomadConfig from "./NomadConfig.ts";

export class NomadError extends S.TaggedError<NomadError>()("NomadError", {
  op: S.String,
  cause: S.Defect(),
}) {}

export type PlanType = "None" | "Added" | "Edited" | "Deleted";

const NomadMeta = S.Struct({
  "alchemy.owner": S.optionalKey(S.String),
  "alchemy.provider": S.optionalKey(S.String),
  "alchemy.release": S.optionalKey(S.String),
});

const JobSnapshot = S.Struct({
  ID: S.String,
  Version: S.Number,
  JobModifyIndex: S.Number,
  Meta: S.NullOr(NomadMeta),
});
export type JobSnapshot = typeof JobSnapshot.Type;

export const JobListItemSchema = S.Struct({
  ID: S.String,
  JobModifyIndex: S.Number,
  // `/v1/jobs?meta=true` omits the key for a job that has no metadata, such
  // as one an operator ran by hand.
  Meta: S.optionalKey(S.NullOr(NomadMeta)),
});
export type JobListItem = typeof JobListItemSchema.Type;

const Deployment = S.Struct({
  ID: S.String,
  JobVersion: S.Number,
  JobModifyIndex: S.Number,
  Status: S.Literals(["running", "successful", "failed", "cancelled"]),
  StatusDescription: S.String,
});
export type Deployment = typeof Deployment.Type;

const PlanResponse = S.Struct({
  Diff: S.Struct({ Type: S.Literals(["None", "Added", "Edited", "Deleted"]) }),
  JobModifyIndex: S.Number,
});

const Registration = S.Struct({ EvalID: S.String, JobModifyIndex: S.Number });
export type Registration = typeof Registration.Type;

export const ServiceLocationSchema = S.Struct({
  ServiceName: S.String,
  AllocID: S.String,
  Address: S.String,
  Port: S.Number,
});
export type ServiceLocation = typeof ServiceLocationSchema.Type;

export const AllocationSnapshotSchema = S.Struct({
  ID: S.String,
  JobID: S.String,
  DesiredStatus: S.String,
  ClientStatus: S.String,
  DeploymentStatus: S.optionalKey(S.NullOr(S.Struct({ Healthy: S.Boolean }))),
  Job: S.Struct({
    ID: S.String,
    Version: S.Number,
    JobModifyIndex: S.Number,
  }),
});

export type AllocationSnapshot = typeof AllocationSnapshotSchema.Type;

const AllocationCheck = S.Struct({
  Mode: S.String,
  Service: S.String,
  Status: S.String,
});
export const AllocationChecksSchema = S.Record(S.String, AllocationCheck);
export type AllocationChecks = typeof AllocationChecksSchema.Type;

const AllocationEvent = S.Struct({
  Type: S.String,
  FilterKeys: S.OptionFromNullOr(S.Array(S.String)),
});

const AllocationEventBatch = S.Struct({
  Events: S.Array(AllocationEvent),
});

type JobRequest = {
  readonly Job: ReturnType<typeof toJobSpec> | ReleaseJobSpec;
  readonly Diff?: boolean;
  readonly EnforceIndex?: boolean;
  readonly JobModifyIndex?: number;
};

export class Nomad extends Context.Service<
  Nomad,
  {
    readonly jobs: () => Effect.Effect<ReadonlyArray<JobListItem>, NomadError>;
    readonly job: (name: string) => Effect.Effect<Option.Option<JobSnapshot>, NomadError>;
    readonly plan: (job: Job, owner: string) => Effect.Effect<typeof PlanResponse.Type, NomadError>;
    readonly planRelease: (
      name: string,
      job: ReleaseJobSpec,
    ) => Effect.Effect<typeof PlanResponse.Type, NomadError>;
    readonly register: (
      job: Job,
      owner: string,
      expectedModifyIndex: number,
    ) => Effect.Effect<Registration, NomadError>;
    readonly registerRelease: (
      name: string,
      job: ReleaseJobSpec,
      expectedModifyIndex: number,
    ) => Effect.Effect<Registration, NomadError>;
    readonly deployment: (name: string) => Effect.Effect<Option.Option<Deployment>, NomadError>;
    readonly service: (name: string) => Effect.Effect<ReadonlyArray<ServiceLocation>, NomadError>;
    readonly allocation: (
      id: string,
    ) => Effect.Effect<Option.Option<AllocationSnapshot>, NomadError>;
    readonly allocationChecks: (
      id: string,
    ) => Effect.Effect<Option.Option<AllocationChecks>, NomadError>;
    readonly allocationChanges: Stream.Stream<ReadonlyArray<string>, NomadError>;
    readonly stop: (name: string) => Effect.Effect<void, NomadError>;
  }
>()("alchemy/Nomad") {}

/** Alchemy provider layers cannot expose typed startup failures to the CLI. */
export const layer = () =>
  Layer.effect(
    Nomad,
    Effect.gen(function* () {
      const target = yield* NomadConfig.target();
      const http = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest(HttpClientRequest.prependUrl(target.address)),
        HttpClient.mapRequest((request) =>
          Option.match(target.token, {
            onNone: () => request,
            onSome: (token) =>
              HttpClientRequest.setHeader("X-Nomad-Token", Redacted.value(token))(request),
          }),
        ),
      );
      const call = (
        op: string,
        req: Effect.Effect<HttpClientRequest.HttpClientRequest, NomadError>,
      ) =>
        req.pipe(
          Effect.flatMap(http.execute),
          Effect.mapError((cause) => new NomadError({ op, cause })),
        );
      const requestJson = (
        op: string,
        method: "POST" | "GET" | "DELETE",
        url: string,
        body?: JobRequest,
      ) =>
        call(
          op,
          body === undefined
            ? Effect.succeed(HttpClientRequest.make(method)(url))
            : HttpClientRequest.make(method)(url).pipe(
                HttpClientRequest.bodyJson(body),
                Effect.mapError((cause) => new NomadError({ op, cause })),
              ),
        ).pipe(
          Effect.flatMap((response) =>
            HttpClientResponse.filterStatusOk(response).pipe(
              Effect.mapError((cause) => new NomadError({ op, cause })),
            ),
          ),
        );
      const decode = <A, I, R>(
        op: string,
        response: HttpClientResponse.HttpClientResponse,
        schema: S.Codec<A, I, R>,
      ) =>
        HttpClientResponse.schemaBodyJson(schema)(response).pipe(
          Effect.mapError((cause) => new NomadError({ op, cause })),
        );
      const lookup = <A, I, R>(op: string, url: string, schema: S.Codec<A, I, R>) =>
        call(op, Effect.succeed(HttpClientRequest.get(url))).pipe(
          Effect.flatMap((response) =>
            response.status === 404
              ? Effect.succeed(Option.none<A>())
              : HttpClientResponse.filterStatusOk(response).pipe(
                  Effect.mapError((cause) => new NomadError({ op, cause })),
                  Effect.flatMap((ok) => decode(op, ok, S.NullOr(schema))),
                  Effect.map(Option.fromNullishOr),
                ),
          ),
        );

      return Nomad.of({
        jobs: () =>
          requestJson("jobs", "GET", "/v1/jobs?meta=true").pipe(
            Effect.flatMap((response) => decode("jobs", response, S.Array(JobListItemSchema))),
          ),
        job: (name) => lookup("job", `/v1/job/${encodeURIComponent(name)}`, JobSnapshot),
        plan: (job, owner) =>
          requestJson("plan", "POST", `/v1/job/${encodeURIComponent(job.name)}/plan`, {
            Job: toJobSpec(job, owner),
            Diff: true,
          }).pipe(Effect.flatMap((response) => decode("plan", response, PlanResponse))),
        planRelease: (name, job) =>
          requestJson("planRelease", "POST", `/v1/job/${encodeURIComponent(name)}/plan`, {
            Job: job,
            Diff: true,
          }).pipe(Effect.flatMap((response) => decode("planRelease", response, PlanResponse))),
        register: (job, owner, expectedModifyIndex) =>
          requestJson("register", "POST", "/v1/jobs", {
            Job: toJobSpec(job, owner),
            EnforceIndex: true,
            JobModifyIndex: expectedModifyIndex,
          }).pipe(Effect.flatMap((response) => decode("register", response, Registration))),
        registerRelease: (name, job, expectedModifyIndex) =>
          requestJson("registerRelease", "POST", "/v1/jobs", {
            Job: job,
            EnforceIndex: true,
            JobModifyIndex: expectedModifyIndex,
          }).pipe(Effect.flatMap((response) => decode("registerRelease", response, Registration))),
        deployment: (name) =>
          lookup("deployment", `/v1/job/${encodeURIComponent(name)}/deployment`, Deployment),
        service: (name) =>
          call(
            "service",
            Effect.succeed(HttpClientRequest.get(`/v1/service/${encodeURIComponent(name)}`)),
          ).pipe(
            Effect.flatMap((response) =>
              decode("service", response, S.Array(ServiceLocationSchema)),
            ),
          ),
        allocation: (id) =>
          lookup(
            "allocation",
            `/v1/allocation/${encodeURIComponent(id)}`,
            AllocationSnapshotSchema,
          ),
        allocationChecks: (id) =>
          lookup(
            "allocation checks",
            `/v1/client/allocation/${encodeURIComponent(id)}/checks`,
            AllocationChecksSchema,
          ),
        allocationChanges: Stream.unwrap(
          call(
            "allocation changes",
            Effect.succeed(
              HttpClientRequest.get("/v1/event/stream").pipe(
                HttpClientRequest.setUrlParam("topic", "Allocation"),
              ),
            ),
          ).pipe(
            Effect.flatMap((response) =>
              HttpClientResponse.filterStatusOk(response).pipe(
                Effect.mapError((cause) => new NomadError({ op: "allocation changes", cause })),
                Effect.map((ok) => ok.stream),
              ),
            ),
          ),
        ).pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.filter((line) => line.length > 0 && line !== "{}"),
          Stream.mapEffect((line) =>
            S.decodeUnknownEffect(S.fromJsonString(AllocationEventBatch))(line).pipe(
              Effect.mapError((cause) => new NomadError({ op: "allocation changes", cause })),
            ),
          ),
          Stream.map((batch) =>
            batch.Events.filter(
              (event) =>
                event.Type === "AllocationCreated" ||
                event.Type === "AllocationUpdated" ||
                event.Type === "AllocationUpdateDesiredStatus",
            ).flatMap((event) => Option.getOrElse(event.FilterKeys, () => [])),
          ),
          Stream.mapError((cause) => new NomadError({ op: "allocation changes", cause })),
        ),
        stop: (name) =>
          requestJson("stop", "DELETE", `/v1/job/${encodeURIComponent(name)}?purge=true`).pipe(
            Effect.asVoid,
          ),
      });
    }).pipe(Effect.orDie),
  );
