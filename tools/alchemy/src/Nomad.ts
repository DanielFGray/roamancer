import { Context, Effect, Layer, Option, Redacted, Schema as S, Stream } from "effect";
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
  // The scheduler: "service" places Count allocations, "system" one on each node.
  Type: S.String,
  Version: S.Number,
  // Nomad sets this once a deployment of this version succeeds.
  Stable: S.Boolean,
  JobModifyIndex: S.Number,
  Meta: S.NullOr(NomadMeta),
  // A task of a driver other than podman or docker has no image.
  TaskGroups: S.Array(
    S.Struct({
      Tasks: S.Array(S.Struct({ Config: S.Struct({ image: S.optionalKey(S.String) }) })),
    }),
  ),
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

// Time is nanoseconds since the Unix epoch.
const TaskEvent = S.Struct({ Type: S.String, DisplayMessage: S.String, Time: S.Number });

const TaskState = S.Struct({
  State: S.String,
  Failed: S.Boolean,
  Restarts: S.Number,
  // Why a task is not running: a blocked template, a failed pull, a restart.
  Events: S.NullOr(S.Array(TaskEvent)),
});

export const AllocationSummarySchema = S.Struct({
  ID: S.String,
  TaskGroup: S.String,
  DesiredStatus: S.String,
  ClientStatus: S.String,
  JobVersion: S.Number,
  // Nanoseconds since the Unix epoch.
  CreateTime: S.Number,
  TaskStates: S.NullOr(S.Record(S.String, TaskState)),
});
export type AllocationSummary = typeof AllocationSummarySchema.Type;

export type LogStream = "stdout" | "stderr";

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
    readonly stop: (name: string) => Effect.Effect<void, NomadError>;
    readonly allocations: (
      job: string,
    ) => Effect.Effect<ReadonlyArray<AllocationSummary>, NomadError>;
    /** The last `bytes` bytes of one task's log. */
    readonly logs: (
      allocation: string,
      task: string,
      stream: LogStream,
      bytes: number,
    ) => Effect.Effect<string, NomadError>;
    /** One task's log lines from now on, as Nomad writes them. Ends when the task stops. */
    readonly followLogs: (
      allocation: string,
      task: string,
      stream: LogStream,
    ) => Stream.Stream<string, NomadError>;
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
        stop: (name) =>
          requestJson("stop", "DELETE", `/v1/job/${encodeURIComponent(name)}?purge=true`).pipe(
            Effect.asVoid,
          ),
        allocations: (job) =>
          requestJson("allocations", "GET", `/v1/job/${encodeURIComponent(job)}/allocations`).pipe(
            Effect.flatMap((response) =>
              decode("allocations", response, S.Array(AllocationSummarySchema)),
            ),
          ),
        logs: (allocation, task, stream, bytes) => {
          const query = new URLSearchParams({
            task,
            type: stream,
            plain: "true",
            origin: "end",
            offset: String(bytes),
          });
          return requestJson(
            "logs",
            "GET",
            `/v1/client/fs/logs/${encodeURIComponent(allocation)}?${query}`,
          ).pipe(
            Effect.flatMap((response) =>
              response.text.pipe(Effect.mapError((cause) => new NomadError({ op: "logs", cause }))),
            ),
          );
        },
        followLogs: (allocation, task, stream) => {
          const query = new URLSearchParams({
            task,
            type: stream,
            plain: "true",
            follow: "true",
            origin: "end",
            // Nomad replays the whole log for origin=end with offset 0 (seen on 2.0.7). One
            // byte back starts inside the last line, which TaskLog.parse drops as partial.
            offset: "1",
          });
          return HttpClientResponse.stream(
            requestJson(
              "follow logs",
              "GET",
              `/v1/client/fs/logs/${encodeURIComponent(allocation)}?${query}`,
            ),
          ).pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.mapError((cause) => new NomadError({ op: "follow logs", cause })),
          );
        },
      });
    }).pipe(Effect.orDie),
  );
