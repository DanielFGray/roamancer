/**
 * One JSON-line request and response per socket connection. Every request is validated
 * with Schema before the store or starter runs. Submit carries command-specific data only.
 */
import { Schema as S } from "effect";
import { JobState } from "./Kinds.ts";
import { BuildMemoryMB } from "../BuildLimits.ts";
import { Job, JobSubmit, maxBuildBytes } from "./Schema.ts";

/** A submit is a job payload under the `submit` tag; the front end stores it as sent. */
export const Submit = S.Union(
  JobSubmit.members.map((member) => S.TaggedStruct("submit", member.fields)),
);
export type Submit = typeof Submit.Type;
export const List = S.TaggedStruct("list", {});
export const Show = S.TaggedStruct("show", { id: S.Number });
export const Wait = S.TaggedStruct("wait", { id: S.Number });
export const Cancel = S.TaggedStruct("cancel", { id: S.Number });
export const Token = S.TaggedStruct("token", { value: S.String });
/** A finished job asks the front end to start the oldest queued row. */
export const Next = S.TaggedStruct("next", {});

/** The git tree hash an app image is built from (SHA-1 or SHA-256 repositories). */
export const ImageKey = S.String.check(S.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/));
export const ImageDigest = S.String.check(S.isPattern(/^sha256:[0-9a-f]{64}$/));
const ImageName = { repository: S.NonEmptyString, key: ImageKey };
/**
 * The digest recorded for `key` in `repository`. Only the runner's build job records one, after
 * the registry answered for it: the registry accepts pushes from every node without
 * credentials, so its tag proves nothing, but a recorded digest names fixed content.
 */
export const FindImage = S.TaggedStruct("findImage", ImageName);

/**
 * Build an app's tree. The request line is followed by exactly `size` bytes, a tar of the
 * exported tree. The front end stores the tar and queues a `build` job; the answer is
 * `submitted` with that job's id. A tar cannot ride in a JSON submit, which the queue keeps.
 */
export const BuildUpload = S.TaggedStruct("build", {
  repository: S.NonEmptyString,
  key: ImageKey,
  memoryMaxMB: BuildMemoryMB,
  size: S.Int.check(S.isBetween({ minimum: 1, maximum: maxBuildBytes })),
});
export type BuildUpload = typeof BuildUpload.Type;

const Hex40 = S.String.check(S.isPattern(/^[0-9a-f]{40}$/));
const Hex64 = S.String.check(S.isPattern(/^[0-9a-f]{64}$/));

/** Record that an app's tree passed its tests on the operator's machine. Not a job. */
export const Signoff = S.TaggedStruct("signoff", {
  app: S.String,
  tree: Hex40,
  commit: Hex40,
  summary: S.String,
  logSha256: Hex64,
});
export type Signoff = typeof Signoff.Type;

/**
 * Set one key at a KV v2 path with the `ops login` token, which the front end holds. Not a job:
 * the front end writes it at once and stores nothing, so the value never reaches the queue.
 */
export const SetSecret = S.TaggedStruct("setSecret", {
  path: S.String.check(S.isPattern(/^secret\/data\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/)),
  key: S.String.check(S.isPattern(/^[A-Za-z0-9._-]+$/)),
  value: S.NonEmptyString,
});
export type SetSecret = typeof SetSecret.Type;

/** List stored signoffs for one app, newest first. */
export const Signoffs = S.TaggedStruct("signoffs", { app: S.String });
export type Signoffs = typeof Signoffs.Type;

export const SignoffRecord = S.Struct({
  id: S.Number,
  app: S.String,
  tree: S.String,
  commit: S.String,
  summary: S.String,
  logSha256: S.String,
  createdAt: S.String,
});
export type SignoffRecord = typeof SignoffRecord.Type;

export const Request = S.Union([
  Submit,
  List,
  Show,
  Wait,
  Cancel,
  Token,
  Next,
  FindImage,
  Signoff,
  Signoffs,
  SetSecret,
  BuildUpload,
]);
export type Request = typeof Request.Type;

export const Response = S.Union([
  S.TaggedStruct("submitted", { id: S.Number }),
  S.TaggedStruct("listed", { jobs: S.Array(Job) }),
  S.TaggedStruct("shown", { job: Job, unit: S.String }),
  S.TaggedStruct("waited", {
    id: S.Number,
    state: JobState,
    exitCode: S.NullOr(S.Number),
  }),
  S.TaggedStruct("canceled", { job: Job }),
  S.TaggedStruct("tokenStored", {}),
  S.TaggedStruct("next", { started: S.NullOr(S.Number) }),
  S.TaggedStruct("imageFound", { digest: S.NullOr(ImageDigest) }),
  S.TaggedStruct("signedOff", { id: S.Number }),
  S.TaggedStruct("signoffsListed", { signoffs: S.Array(SignoffRecord) }),
  S.TaggedStruct("secretSet", {}),
  S.TaggedStruct("error", { message: S.String }),
]);
export type Response = typeof Response.Type;

/**
 * A request fails on a key its schema does not declare. `ops` runs from the operator's
 * checkout and the runner from the commit of the last `ops rebuild`, so a request can be
 * newer than the runner that reads it. Dropping the unknown key would run that request with
 * an older meaning; failing makes the operator rebuild first.
 */
const exactKeys = { onExcessProperty: "error" } as const;

export const decodeRequest = S.decodeUnknownSync(Request, exactKeys);

/** Appended to a refused request's message: the usual cause is a runner older than `ops`. */
export const newerRequestHint =
  " (if ops here is newer than this runner, run `ops rebuild` for this host)";

/** Decode one JSON request line against `schema`, failing on undeclared keys. */
export const decodeRequestLine = <Schema extends S.Constraint>(schema: Schema) =>
  S.decodeUnknownEffect(S.fromJsonString(schema), exactKeys);
