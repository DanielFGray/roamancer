/**
 * A queued Alchemy operation: data only. The runner is Nix-pinned; the row carries a
 * command-specific payload. No free argv reaches a child process.
 */
import { Option, Schema as S } from "effect";

export const JobCommand = S.Literals([
  "plan",
  "deploy",
  "destroy",
  "rollback",
  "drift",
  "state",
  "deployment",
  "status",
  "stage-image",
  "place-queued",
  "dash",
]);
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

/**
 * plan | destroy | drift: one stage, the cartridge `ops` sent (null: the recorded one), the
 * app repository's root commit and released commit ("" when none was sent), and the image a
 * `-staged` stage runs.
 */
export const StageSubmit = S.Struct({
  command: S.Literals(["plan", "destroy", "drift"]),
  stage: S.NonEmptyString,
  cartridge: S.NullOr(S.String),
  origin: S.String,
  revision: S.String,
  stagedImage: S.NullOr(S.NonEmptyString),
});
export type StageSubmit = typeof StageSubmit.Type;

/** deploy: same stage fields plus the plan job that must still be fresh. */
export const DeploySubmit = S.Struct({
  ...StageSubmit.fields,
  command: S.Literals(["deploy"]),
  planJobId: S.Number.check(S.isInt(), S.isGreaterThan(0)),
});
export type DeploySubmit = typeof DeploySubmit.Type;

/** rollback: recorded deployment identity only. */
export const RollbackSubmit = S.Struct({
  command: S.Literals(["rollback"]),
  name: S.NonEmptyString,
  deploymentId: S.Number.check(S.isInt(), S.isGreaterThan(0)),
});
export type RollbackSubmit = typeof RollbackSubmit.Type;

/*
 * Stageless jobs: host commands that run as jobs because only the runner user can read
 * Alchemy state, the deployment record and the controller Nomad token. Taking turns with
 * deploys means a read never sees a deploy half done. None of them changes a stage.
 */

/** state list [path] | state read <path>: Alchemy's state store. */
export const StateListSubmit = S.Struct({
  command: S.Literals(["state"]),
  verb: S.Literals(["list"]),
  path: S.NullOr(S.NonEmptyString),
});
export const StateReadSubmit = S.Struct({
  command: S.Literals(["state"]),
  verb: S.Literals(["read"]),
  path: S.NonEmptyString,
});

/** deployment: list recorded deployments for one app name. */
export const DeploymentSubmit = S.Struct({
  command: S.Literals(["deployment"]),
  name: S.NonEmptyString,
});

/** status: each service's newest Nomad allocations. */
export const StatusSubmit = S.Struct({
  command: S.Literals(["status"]),
  name: S.NonEmptyString,
});

/**
 * stage-image: the image a staged instance runs. `stable` fails unless every staged job is
 * deployed; `expect` fails unless the staged image has that image's digest.
 */
export const StageImageSubmit = S.Struct({
  command: S.Literals(["stage-image"]),
  name: S.NonEmptyString,
  stable: S.Boolean,
  expect: S.NullOr(S.NonEmptyString),
});

/** dash: each job's health, each node's load, and each app's newest release. */
export const DashSubmit = S.Struct({
  command: S.Literals(["dash"]),
});

/** place-queued: ask Nomad to place every job with queued allocations again. */
export const PlaceQueuedSubmit = S.Struct({
  command: S.Literals(["place-queued"]),
});

export const StagelessSubmit = S.Union([
  StateListSubmit,
  StateReadSubmit,
  DeploymentSubmit,
  StatusSubmit,
  StageImageSubmit,
  PlaceQueuedSubmit,
  DashSubmit,
]);
export type StagelessSubmit = typeof StagelessSubmit.Type;

export const JobSubmit = S.Union([
  StageSubmit,
  DeploySubmit,
  RollbackSubmit,
  ...StagelessSubmit.members,
]);
export type JobSubmit = typeof JobSubmit.Type;

export const Job = S.Struct({
  id: S.Number,
  submit: JobSubmit,
  state: JobState,
  exitCode: S.NullOr(S.Number),
  runnerRevision: S.NullOr(S.String),
  createdAt: S.String,
  startedAt: S.NullOr(S.String),
  finishedAt: S.NullOr(S.String),
});
export type Job = typeof Job.Type;

/** systemd template unit that runs one job. */
export const unitName = (id: number) => `alchemy-job@${id}.service`;

/** The stage crash recovery plans again after this job; none for a stageless job. */
export const recoveryStage = (submit: JobSubmit): Option.Option<string> => {
  switch (submit.command) {
    case "plan":
    case "deploy":
    case "destroy":
    case "drift":
      return Option.some(submit.stage);
    case "rollback":
      return Option.some(submit.name);
    default:
      return Option.none();
  }
};
