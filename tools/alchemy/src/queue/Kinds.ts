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
  "build",
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
