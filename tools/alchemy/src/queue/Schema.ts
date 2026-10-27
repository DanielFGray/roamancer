/**
 * A queued Alchemy operation: data only. The runner is Nix-pinned; the row carries a
 * command-specific payload. No free argv reaches a child process.
 */
import { Schema as S } from "effect";

export const JobCommand = S.Literals(["plan", "deploy", "destroy", "rollback", "drift"]);
export type JobCommand = typeof JobCommand.Type;

export const JobState = S.Literals([
  "queued",
  "starting",
  "running",
  "succeeded",
  "failed",
  "interrupted",
  "canceled",
]);
export type JobState = typeof JobState.Type;

/** plan | deploy | destroy | drift: one stage name, optional cartridge retention. */
export const StageSubmit = S.Struct({
  command: S.Literals(["plan", "deploy", "destroy", "drift"]),
  stage: S.NonEmptyString,
  cartridge: S.NullOr(S.String),
  origin: S.String,
  revision: S.String,
});
export type StageSubmit = typeof StageSubmit.Type;

/** rollback: recorded deployment identity only. */
export const RollbackSubmit = S.Struct({
  command: S.Literals(["rollback"]),
  name: S.NonEmptyString,
  deploymentId: S.Number.check(S.isInt(), S.isGreaterThan(0)),
});
export type RollbackSubmit = typeof RollbackSubmit.Type;

export const JobSubmit = S.Union([StageSubmit, RollbackSubmit]);
export type JobSubmit = typeof JobSubmit.Type;

export const Job = S.Struct({
  id: S.Number,
  submit: JobSubmit,
  state: JobState,
  exitCode: S.NullOr(S.Number),
  createdAt: S.String,
  startedAt: S.NullOr(S.String),
  finishedAt: S.NullOr(S.String),
});
export type Job = typeof Job.Type;

/** systemd template unit that runs one job. */
export const unitName = (id: number) => `alchemy-job@${id}.service`;

/** Stage name for recovery plan enqueue. */
export const stageOf = (submit: JobSubmit): string =>
  submit.command === "rollback" ? submit.name : submit.stage;
