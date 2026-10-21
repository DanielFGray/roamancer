import { Context, Effect, Layer, Option, Redacted, Schema } from "effect";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { Job, toJobSpec } from "./Job.ts";
import type { ReleaseJobSpec } from "./ReleaseJob.ts";
import * as NomadConfig from "./NomadConfig.ts";

export class NomadError extends Schema.TaggedError<NomadError>()("NomadError", {
  op: Schema.String,
  cause: Schema.Defect(),
}) {}

export type PlanType = "None" | "Added" | "Edited" | "Deleted";

const NomadMeta = Schema.Struct({
  "alchemy.owner": Schema.optionalKey(Schema.String),
  "alchemy.provider": Schema.optionalKey(Schema.String),
  "alchemy.release": Schema.optionalKey(Schema.String),
});

const JobSnapshot = Schema.Struct({
  ID: Schema.String,
  Version: Schema.Number,
  JobModifyIndex: Schema.Number,
  Meta: Schema.NullOr(NomadMeta),
});
export type JobSnapshot = typeof JobSnapshot.Type;

export const JobListItemSchema = Schema.Struct({
  ID: Schema.String,
  JobModifyIndex: Schema.Number,
  Meta: Schema.NullOr(NomadMeta),
});
export type JobListItem = typeof JobListItemSchema.Type;

const Deployment = Schema.Struct({
  ID: Schema.String,
  JobVersion: Schema.Number,
  JobModifyIndex: Schema.Number,
  Status: Schema.Literals(["running", "successful", "failed", "cancelled"]),
  StatusDescription: Schema.String,
});
export type Deployment = typeof Deployment.Type;

const PlanResponse = Schema.Struct({
  Diff: Schema.Struct({ Type: Schema.Literals(["None", "Added", "Edited", "Deleted"]) }),
  JobModifyIndex: Schema.Number,
});

const Registration = Schema.Struct({ EvalID: Schema.String, JobModifyIndex: Schema.Number });
export type Registration = typeof Registration.Type;

export const ServiceLocationSchema = Schema.Struct({
  ServiceName: Schema.String,
  AllocID: Schema.String,
  Address: Schema.String,
  Port: Schema.Number,
});
export type ServiceLocation = typeof ServiceLocationSchema.Type;

export const AllocationSnapshotSchema = Schema.Struct({
  ID: Schema.String,
  JobID: Schema.String,
  DesiredStatus: Schema.String,
  ClientStatus: Schema.String,
  DeploymentStatus: Schema.optionalKey(Schema.NullOr(Schema.Struct({ Healthy: Schema.Boolean }))),
  Job: Schema.Struct({
    ID: Schema.String,
    Version: Schema.Number,
    JobModifyIndex: Schema.Number,
  }),
});

export type AllocationSnapshot = typeof AllocationSnapshotSchema.Type;

const AllocationCheck = Schema.Struct({
  Mode: Schema.String,
  Service: Schema.String,
  Status: Schema.String,
});
export const AllocationChecksSchema = Schema.Record(Schema.String, AllocationCheck);
export type AllocationChecks = typeof AllocationChecksSchema.Type;

const AllocationEvent = Schema.Struct({
  Type: Schema.String,
  FilterKeys: Schema.OptionFromNullOr(Schema.Array(Schema.String)),
});

const AllocationEventBatch = Schema.Struct({
  Events: Schema.Array(AllocationEvent),
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
        schema: Schema.Codec<A, I, R>,
      ) =>
        HttpClientResponse.schemaBodyJson(schema)(response).pipe(
          Effect.mapError((cause) => new NomadError({ op, cause })),
        );
      const lookup = <A, I, R>(op: string, url: string, schema: Schema.Codec<A, I, R>) =>
        call(op, Effect.succeed(HttpClientRequest.get(url))).pipe(
          Effect.flatMap((response) =>
            response.status === 404
              ? Effect.succeed(Option.none<A>())
              : HttpClientResponse.filterStatusOk(response).pipe(
                  Effect.mapError((cause) => new NomadError({ op, cause })),
                  Effect.flatMap((ok) => decode(op, ok, Schema.NullOr(schema))),
                  Effect.map(Option.fromNullishOr),
                ),
          ),
        );

      return Nomad.of({
        jobs: () =>
          requestJson("jobs", "GET", "/v1/jobs?meta=true").pipe(
            Effect.flatMap((response) => decode("jobs", response, Schema.Array(JobListItemSchema))),
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
              decode("service", response, Schema.Array(ServiceLocationSchema)),
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
            Schema.decodeUnknownEffect(Schema.fromJsonString(AllocationEventBatch))(line).pipe(
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
