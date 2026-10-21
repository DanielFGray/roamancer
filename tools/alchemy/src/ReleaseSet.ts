import * as Alchemy from "alchemy";
import * as Provider from "alchemy/Provider";
import { isResolved } from "alchemy/Diff";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  adoptionAttributes,
  attributes,
  jobIsOwnedBy,
  type ReleaseSetOutput,
  ReleaseSetFailed,
  releaseById,
  serviceIsReady,
  validate,
} from "./ReleaseDecisions.ts";
import { jobName, type Release, ReleaseSetProps, toJobSpec } from "./ReleaseJob.ts";
import { Nomad, type JobSnapshot, type ServiceLocation } from "./Nomad.ts";
import { settle as settleDeployment, awaitSome } from "./Deployment.ts";
import { OperationJournal } from "./OperationJournal.ts";

export interface ReleaseSet extends Alchemy.Resource<
  "Nomad.ReleaseSet",
  ReleaseSetProps,
  ReleaseSetOutput
> {}

export const ReleaseSet = Alchemy.Resource<ReleaseSet>("Nomad.ReleaseSet");

export { ReleaseSetFailed } from "./ReleaseDecisions.ts";

/**
 * Each release is its own Nomad job. Its routes are tags on the job's service
 * (see `routeTags`), so the job spec is the whole desired state: Traefik
 * reads the routes from Nomad, and a plan that shows no job change means the
 * routes match too.
 */
export const ReleaseSetProvider = () =>
  Provider.effect(
    ReleaseSet,
    Effect.gen(function* () {
      const nomad = yield* Nomad;
      const journal = yield* OperationJournal;
      return ReleaseSet.Provider.of({
        list: () => Effect.succeed([]),
        diff: Effect.fn(function* ({ news, fqn, olds }) {
          if (!isResolved(news)) return undefined;
          return yield* Option.match(validate(news, olds), {
            onSome: Effect.fail,
            onNone: () =>
              Effect.gen(function* () {
                if (yield* journal.hasPending(fqn)) return { action: "update" as const };
                // A job this stack owns but the declaration dropped still has
                // to be removed, and an unhealthy release has to be settled.
                const settled =
                  (yield* undeclaredJobs(nomad, news, fqn)).length === 0 &&
                  (yield* allReleasesReady(nomad, news, fqn));
                return settled ? undefined : { action: "update" as const };
              }),
          });
        }),
        reconcile: Effect.fn(function* ({ news, olds, fqn }) {
          return yield* journal.run(
            {
              resourceId: fqn,
              provider: "Nomad.ReleaseSet",
              target: news.name,
              action: "reconcile",
            },
            Effect.gen(function* () {
              yield* Option.match(validate(news, olds), {
                onNone: () => Effect.void,
                onSome: Effect.fail,
              });
              // The selected release goes first. During a promotion it gains
              // the stable tags, and Nomad reports it healthy, before the
              // release it replaces loses them. Traefik applies each tag
              // change on its own schedule, so this order makes a gap
              // unlikely but does not rule one out.
              const selected = yield* releaseFor(news, news.selectedRelease);
              yield* ensureRelease(nomad, news, selected, fqn);
              yield* Effect.forEach(
                news.releases.filter((release) => release.id !== selected.id),
                (release) => ensureRelease(nomad, news, release, fqn),
              );
              yield* Effect.forEach(yield* undeclaredJobs(nomad, news, fqn), (job) =>
                nomad.stop(job.ID),
              );
              return attributes(news);
            }),
          );
        }),
        delete: Effect.fn(function* ({ olds, fqn }) {
          yield* journal.run(
            {
              resourceId: fqn,
              provider: "Nomad.ReleaseSet",
              target: olds.name,
              action: "delete",
            },
            Effect.forEach(olds.releases, (release) => removeRelease(nomad, release, olds, fqn)),
          );
        }),
        read: Effect.fn(function* ({ output, id, fqn, olds }) {
          if (output !== undefined) return output.id === id ? output : undefined;
          if (!isResolved(olds)) return undefined;
          return adoptionAttributes(olds, fqn, yield* nomad.jobs());
        }),
      });
    }),
  );

const ownerOf = (job: JobSnapshot) => Option.fromNullishOr(job.Meta?.["alchemy.owner"]);

const ownedJobs = Effect.fn(function* (nomad: typeof Nomad.Service, fqn: string) {
  return (yield* nomad.jobs()).filter(
    (job) =>
      job.Meta?.["alchemy.owner"] === fqn && job.Meta?.["alchemy.provider"] === "Nomad.ReleaseSet",
  );
});

/** Jobs this stack owns that no declared release names. */
const undeclaredJobs = Effect.fn(function* (
  nomad: typeof Nomad.Service,
  props: ReleaseSetProps,
  fqn: string,
) {
  const names = props.releases.map((release) => jobName(props, release));
  return (yield* ownedJobs(nomad, fqn)).filter((job) => !names.includes(job.ID));
});

const releaseFor = Effect.fn(function* (props: ReleaseSetProps, id: string) {
  return yield* Option.match(releaseById(props, id), {
    onNone: () =>
      Effect.fail(
        new ReleaseSetFailed({
          resource: props.name,
          message: `release '${id}' is missing from the desired release set`,
        }),
      ),
    onSome: Effect.succeed,
  });
});

const healthyService = Effect.fn(function* (
  nomad: typeof Nomad.Service,
  name: string,
  job: JobSnapshot,
  service: ServiceLocation,
) {
  const allocation = yield* nomad.allocation(service.AllocID);
  if (Option.isNone(allocation)) return false;
  const checks = yield* nomad.allocationChecks(service.AllocID);
  return serviceIsReady({
    service,
    jobName: name,
    jobVersion: job.Version,
    jobModifyIndex: job.JobModifyIndex,
    allocation,
    checks,
  });
});

const healthyRelease = Effect.fn(function* (
  nomad: typeof Nomad.Service,
  props: ReleaseSetProps,
  release: Release,
  owner: string,
  modifyIndex: number,
) {
  const name = jobName(props, release);
  const state = yield* nomad.job(name);
  if (Option.isNone(state)) return false;
  const job = state.value;
  if (!jobIsOwnedBy(job, owner) || job.JobModifyIndex !== modifyIndex) return false;
  const services = yield* nomad.service(name);
  const ready = yield* Effect.forEach(services, (service) =>
    healthyService(nomad, name, job, service),
  );
  return ready.some(Boolean);
});

const settleUnchanged = Effect.fn(function* (
  nomad: typeof Nomad.Service,
  props: ReleaseSetProps,
  release: Release,
  owner: string,
  modifyIndex: number,
) {
  const result = yield* awaitSome(
    healthyRelease(nomad, props, release, owner, modifyIndex).pipe(
      Effect.map((b) => (b ? Option.some(true) : Option.none<boolean>())),
    ),
  );
  return Option.isSome(result);
});

const ensureRelease = Effect.fn(function* (
  nomad: typeof Nomad.Service,
  props: ReleaseSetProps,
  release: Release,
  owner: string,
) {
  const name = jobName(props, release);
  const spec = toJobSpec(props, release, owner);
  const current = yield* nomad.job(name);
  const { index, registered } = yield* Option.match(current, {
    onNone: () =>
      nomad
        .registerRelease(name, spec, 0)
        .pipe(Effect.map((result) => ({ index: result.JobModifyIndex, registered: true }))),
    onSome: (job) =>
      Option.match(ownerOf(job), {
        onNone: () =>
          Effect.fail(
            new ReleaseSetFailed({
              resource: props.name,
              message: `refusing to manage Nomad job '${name}' without Alchemy ownership metadata`,
            }),
          ),
        onSome: (actualOwner) =>
          actualOwner !== owner
            ? Effect.fail(
                new ReleaseSetFailed({
                  resource: props.name,
                  message: `refusing to manage Nomad job '${name}' owned by another Alchemy resource`,
                }),
              )
            : nomad.planRelease(name, spec).pipe(
                Effect.flatMap((plan) =>
                  plan.Diff.Type === "None"
                    ? Effect.succeed({ index: job.JobModifyIndex, registered: false })
                    : nomad.registerRelease(name, spec, job.JobModifyIndex).pipe(
                        Effect.map((result) => ({
                          index: result.JobModifyIndex,
                          registered: true,
                        })),
                      ),
                ),
              ),
      }),
  });
  if (registered) {
    const settled = yield* settleDeployment(nomad, name, (job) => jobIsOwnedBy(job, owner), index);
    if (settled._tag === "Failed") {
      return yield* new ReleaseSetFailed({
        resource: props.name,
        message: `release '${release.id}': ${settled.reason}`,
      });
    }
  } else if (!(yield* settleUnchanged(nomad, props, release, owner, index))) {
    return yield* new ReleaseSetFailed({
      resource: props.name,
      message: `Nomad did not report release '${release.id}' healthy before its deadline`,
    });
  }
});

const allReleasesReady = Effect.fn(function* (
  nomad: typeof Nomad.Service,
  props: ReleaseSetProps,
  owner: string,
) {
  const ready = yield* Effect.forEach(props.releases, (release) =>
    nomad.job(jobName(props, release)).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(false),
          onSome: (job) =>
            nomad
              .planRelease(job.ID, toJobSpec(props, release, owner))
              .pipe(
                Effect.flatMap((plan) =>
                  plan.Diff.Type !== "None"
                    ? Effect.succeed(false)
                    : healthyRelease(nomad, props, release, owner, job.JobModifyIndex),
                ),
              ),
        }),
      ),
    ),
  );
  return ready.every(Boolean);
});

const removeRelease = Effect.fn(function* (
  nomad: typeof Nomad.Service,
  release: Release,
  props: ReleaseSetProps,
  owner: string,
) {
  const name = jobName(props, release);
  const current = yield* nomad.job(name);
  yield* Option.match(current, {
    onNone: () => Effect.void,
    onSome: (job) =>
      Option.match(ownerOf(job), {
        onNone: () =>
          Effect.fail(
            new ReleaseSetFailed({
              resource: props.name,
              message: `refusing to delete Nomad job '${name}' without Alchemy ownership metadata`,
            }),
          ),
        onSome: (actualOwner) =>
          actualOwner === owner && jobIsOwnedBy(job, owner)
            ? nomad.stop(name)
            : Effect.fail(
                new ReleaseSetFailed({
                  resource: props.name,
                  message: `refusing to delete Nomad job '${name}' owned by another Alchemy resource`,
                }),
              ),
      }),
  });
});
