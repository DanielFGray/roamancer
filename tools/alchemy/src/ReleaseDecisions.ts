import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type {
  AllocationChecks,
  AllocationSnapshot,
  JobListItem,
  JobSnapshot,
  ServiceLocation,
} from "./Nomad.ts";
import type { ReleaseSetProps } from "./ReleaseJob.ts";

/**
 * The rules that decide what a ReleaseSet does, kept out of the provider so they
 * can be read and tested without Nomad, Caddy or a journal.
 */

export type ReleaseSetOutput = {
  readonly id: string;
  readonly selectedRelease: string;
  readonly candidateRelease: string | null;
  readonly previewUrl: string | null;
  readonly releases: ReadonlyArray<string>;
};

export class ReleaseSetFailed extends Schema.TaggedError<ReleaseSetFailed>()("ReleaseSetFailed", {
  resource: Schema.String,
  message: Schema.String,
}) {}

export const candidateOf = (props: ReleaseSetProps) =>
  Option.isOption(props.candidateRelease) ? props.candidateRelease : Option.none<string>();

export const releaseById = (props: ReleaseSetProps, id: string) =>
  Arr.findFirst(props.releases, (release) => release.id === id);

export const previewUrl = (props: ReleaseSetProps, releaseId: string) =>
  `${props.scheme}://${releaseId}.${props.domain}`;

const routePrefix = (fqn: string, domain: string) => `alchemy-${fqn}-${domain}`;
export const stableRouteId = (fqn: string, domain: string) => `${routePrefix(fqn, domain)}-stable`;
export const previewRouteId = (fqn: string, domain: string, releaseId: string) =>
  `${routePrefix(fqn, domain)}-preview-${releaseId}`;

export const attributes = (props: ReleaseSetProps): ReleaseSetOutput => ({
  id: props.name,
  selectedRelease: props.selectedRelease,
  candidateRelease: Option.getOrNull(candidateOf(props)),
  previewUrl: Option.match(candidateOf(props), {
    onNone: () => null,
    onSome: (releaseId) => previewUrl(props, releaseId),
  }),
  releases: props.releases.map((release) => release.id),
});

/**
 * Rebuild a ReleaseSet's output from the ownership metadata its jobs carry.
 *
 * The engine calls `read` with no persisted output when a resource exists but
 * state is missing, and adopts whatever `read` returns. The set is adoptable
 * when every declared release has exactly one matching owned job. Extra owned
 * releases are safe to adopt: reconcile can remove them after it restores the
 * selected release. A partial or ambiguous match is not safe to adopt.
 */
export const adoptionAttributes = (
  props: ReleaseSetProps,
  fqn: string,
  jobs: ReadonlyArray<JobListItem>,
): ReleaseSetOutput | undefined => {
  const live = jobs
    .filter(
      (job) =>
        job.Meta?.["alchemy.owner"] === fqn &&
        job.Meta?.["alchemy.provider"] === "Nomad.ReleaseSet",
    )
    .flatMap((job) => Option.toArray(Option.fromNullishOr(job.Meta?.["alchemy.release"])));
  const complete = props.releases.every(
    (release) => live.filter((releaseId) => releaseId === release.id).length === 1,
  );
  const allOwnedJobsIdentified =
    live.length ===
    jobs.filter(
      (job) =>
        job.Meta?.["alchemy.owner"] === fqn &&
        job.Meta?.["alchemy.provider"] === "Nomad.ReleaseSet",
    ).length;
  return complete && allOwnedJobsIdentified ? attributes(props) : undefined;
};

export const validate = (props: ReleaseSetProps, olds: ReleaseSetProps | undefined) => {
  const ids = props.releases.map((release) => release.id);
  const selected = Arr.contains(ids, props.selectedRelease);
  const candidate = Option.match(candidateOf(props), {
    onNone: () => true,
    onSome: (id) => id !== props.selectedRelease && Arr.contains(ids, id),
  });
  const unique = new Set(ids).size === ids.length;
  const selectedImageUnchanged = Option.match(Option.fromNullishOr(olds), {
    onNone: () => true,
    onSome: (previous) =>
      previous.releases.every((oldRelease) =>
        Option.match(
          Arr.findFirst(props.releases, (release) => release.id === oldRelease.id),
          {
            onNone: () => true,
            onSome: (release) => release.image === oldRelease.image,
          },
        ),
      ),
  });
  return selected && candidate && unique && ids.length > 0 && selectedImageUnchanged
    ? Option.none<ReleaseSetFailed>()
    : Option.some(
        new ReleaseSetFailed({
          resource: props.name,
          message:
            "release IDs must be unique, selected and candidate releases must exist, candidate must differ from selected, and a release ID cannot change its image",
        }),
      );
};

export type RouteFacts = {
  readonly stableMatches: boolean;
  readonly candidateMatches: boolean;
  readonly stalePreview: boolean;
};

/** The route half of the diff: any mismatch means the next apply must update. */
export const routeDecision = (facts: RouteFacts) =>
  facts.stableMatches && facts.candidateMatches && !facts.stalePreview
    ? undefined
    : { action: "update" as const };

/**
 * A release is ready only when Nomad says the allocation it routed to is still
 * the running one for the job version we registered, and every healthiness
 * check on that allocation passes.
 *
 * Nomad removes completed deployments from its active-deployment lookup, so the
 * allocation's own deployment status is the durable record.
 */
export const serviceIsReady = (input: {
  readonly service: ServiceLocation;
  readonly jobName: string;
  readonly jobVersion: number;
  readonly jobModifyIndex: number;
  readonly allocation: Option.Option<AllocationSnapshot>;
  readonly checks: Option.Option<AllocationChecks>;
}): boolean => {
  return Option.match(input.allocation, {
    onNone: () => false,
    onSome: (allocation) => {
      const matchesJob =
        allocation.ID === input.service.AllocID &&
        allocation.JobID === input.jobName &&
        allocation.DesiredStatus === "run" &&
        allocation.ClientStatus === "running" &&
        allocation.DeploymentStatus?.Healthy === true &&
        allocation.Job.ID === input.jobName &&
        allocation.Job.Version === input.jobVersion &&
        allocation.Job.JobModifyIndex === input.jobModifyIndex;
      if (!matchesJob) return false;
      return Option.match(input.checks, {
        onNone: () => false,
        onSome: (checks) => {
          const health = Object.values(checks).filter(
            (check) => check.Service === input.jobName && check.Mode === "healthiness",
          );
          return health.length > 0 && health.every((check) => check.Status === "success");
        },
      });
    },
  });
};

/** Owner metadata must match before this stack mutates or deletes a job. */
export const jobIsOwnedBy = (job: JobSnapshot, fqn: string) =>
  job.Meta?.["alchemy.owner"] === fqn && job.Meta?.["alchemy.provider"] === "Nomad.ReleaseSet";
