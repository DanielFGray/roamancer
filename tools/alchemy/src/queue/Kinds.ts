/**
 * The queue's two closed vocabularies: what a job does and where it stands. This module
 * imports only Schema, so the fleet page can decode runner jobs in a browser.
 */
import { Schema as S } from "effect";

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
  "dev-db",
  "dev-db-cluster",
  "db-query",
  "build",
  "reconcile",
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
 * Where reconcile left a stage, the app live or its staged copy, on its last run
 * (docs/design/continuous-deployment.md). `released`, `staged` and `failed` are tries; the others are not, so the same tree is looked at again.
 */
export const ReconcileStatus = S.Literals([
  "no-branch",
  "unreachable",
  "waiting-signoff",
  "waiting-login",
  "released",
  "staged",
  "failed",
]);
export type ReconcileStatus = typeof ReconcileStatus.Type;
