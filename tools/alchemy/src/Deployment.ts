import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import { progressDeadlineMillis } from "./Job.ts";
import { Nomad } from "./Nomad.ts";
import type { Deployment, JobSnapshot } from "./Nomad.ts";

export type Settled =
  | { readonly _tag: "Healthy"; readonly job: JobSnapshot; readonly deployment: Deployment }
  | { readonly _tag: "Failed"; readonly reason: string };

export const deploymentIsHealthy = (job: JobSnapshot, deployment: Deployment) =>
  deployment.JobVersion === job.Version &&
  deployment.JobModifyIndex === job.JobModifyIndex &&
  deployment.Status === "successful";

/**
 * Poll `check` once a second until it returns a value. Give up one minute past the
 * progress deadline that toJobSpec gives Nomad, so a deployment Nomad never reports
 * cannot hold a run forever.
 */
export const awaitSome = <A, E, R>(check: Effect.Effect<Option.Option<A>, E, R>) =>
  Effect.repeat(check, {
    schedule: Schedule.spaced("1 second"),
    until: (o) => Option.isSome(o),
  }).pipe(Effect.timeoutOption(progressDeadlineMillis + 60_000), Effect.map(Option.flatten));

/**
 * Wait for Nomad's verdict on the deployment of the registered job version. Nomad itself fails a
 * deployment that misses the progress deadline in toJobSpec's Update block, so the wait follows
 * the deployment's status. Its own bound, one minute past that deadline, only covers a job or
 * deployment that never appears.
 */
export const settle = Effect.fn(function* (
  nomad: Pick<typeof Nomad.Service, "job" | "deployment">,
  name: string,
  isOwned: (job: JobSnapshot) => boolean,
  modifyIndex: number,
) {
  const outcome = yield* awaitSome(deploymentOutcome(nomad, name, isOwned, modifyIndex));
  if (Option.isNone(outcome)) {
    const settled: Settled = {
      _tag: "Failed",
      reason: "Nomad reported no deployment for this job version before its progress deadline",
    };
    return settled;
  }
  return outcome.value;
});

/** The deployment's verdict, or none while Nomad has not decided yet. */
export const deploymentOutcome = (
  nomad: Pick<typeof Nomad.Service, "job" | "deployment">,
  name: string,
  isOwned: (job: JobSnapshot) => boolean,
  modifyIndex: number,
) =>
  Effect.gen(function* () {
    const pending = Option.none<Settled>();
    const failed = (reason: string) => Option.some<Settled>({ _tag: "Failed", reason });
    const current = yield* nomad.job(name);
    if (Option.isNone(current)) return pending;
    const job = current.value;
    if (job.JobModifyIndex !== modifyIndex)
      return failed("a newer registration replaced this job version");
    if (!isOwned(job)) return failed("another owner took over this job");
    const deployment = yield* nomad.deployment(name);
    if (Option.isNone(deployment) || deployment.value.JobModifyIndex !== modifyIndex)
      return pending;
    if (deploymentIsHealthy(job, deployment.value)) {
      return Option.some<Settled>({ _tag: "Healthy", job, deployment: deployment.value });
    }
    return deployment.value.Status === "failed" || deployment.value.Status === "cancelled"
      ? failed(`Nomad deployment ${deployment.value.Status}: ${deployment.value.StatusDescription}`)
      : pending;
  });
