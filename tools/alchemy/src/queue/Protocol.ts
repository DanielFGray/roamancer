/**
 * One JSON-line request and response per socket connection. Every request is validated
 * with Schema before the store or starter runs. Submit carries command-specific data only.
 */
import { Schema as S } from "effect";
import { Job, JobState } from "./Schema.ts";

export const SubmitStage = S.TaggedStruct("submit", {
  command: S.Literals(["plan", "deploy", "destroy", "drift"]),
  stage: S.NonEmptyString,
  cartridge: S.NullOr(S.String),
  origin: S.String,
  revision: S.String,
});

export const SubmitRollback = S.TaggedStruct("submit", {
  command: S.Literals(["rollback"]),
  name: S.NonEmptyString,
  deploymentId: S.Number.check(S.isInt(), S.isGreaterThan(0)),
});

export const Submit = S.Union([SubmitStage, SubmitRollback]);
export const List = S.TaggedStruct("list", {});
export const Show = S.TaggedStruct("show", { id: S.Number });
export const Wait = S.TaggedStruct("wait", { id: S.Number });
export const Cancel = S.TaggedStruct("cancel", { id: S.Number });
export const Token = S.TaggedStruct("token", { value: S.String });
/** A finished job asks the front end to start the oldest queued row. */
export const Next = S.TaggedStruct("next", {});

export const Request = S.Union([Submit, List, Show, Wait, Cancel, Token, Next]);
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
  S.TaggedStruct("error", { message: S.String }),
]);
export type Response = typeof Response.Type;

export const decodeRequest = S.decodeUnknownSync(Request);
