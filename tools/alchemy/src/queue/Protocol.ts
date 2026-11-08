/**
 * One JSON-line request and response per socket connection. Every request is validated
 * with Schema before the store or starter runs. Submit carries command-specific data only.
 */
import { Schema as S } from "effect";
import { JobState } from "./Kinds.ts";
import { Job, JobSubmit } from "./Schema.ts";

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
 * `ops` pushed `digest` as the image of `key` in `repository`. The record, not the
 * registry's tag, decides which image a later release of the same tree reuses: the registry
 * accepts pushes from every node without credentials, but a digest names fixed content.
 */
export const RecordImage = S.TaggedStruct("recordImage", { ...ImageName, digest: ImageDigest });
export const FindImage = S.TaggedStruct("findImage", ImageName);
export const Request = S.Union([
  Submit,
  List,
  Show,
  Wait,
  Cancel,
  Token,
  Next,
  RecordImage,
  FindImage,
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
  S.TaggedStruct("imageRecorded", {}),
  S.TaggedStruct("imageFound", { digest: S.NullOr(ImageDigest) }),
  S.TaggedStruct("error", { message: S.String }),
]);
export type Response = typeof Response.Type;

export const decodeRequest = S.decodeUnknownSync(Request);
