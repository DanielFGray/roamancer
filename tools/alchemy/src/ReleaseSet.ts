import * as Alchemy from "alchemy";
import * as Provider from "alchemy/Provider";
import { isResolved } from "alchemy/Diff";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Caddy from "./Caddy.ts";
import {
  adoptionAttributes,
  attributes,
  candidateOf,
  jobIsOwnedBy,
  type ReleaseSetOutput,
  ReleaseSetFailed,
  releaseById,
  previewRouteId,
  routeDecision,
  serviceIsReady,
  stableRouteId,
  validate,
} from "./ReleaseDecisions.ts";
import { jobName, previewHost, type Release, ReleaseSetProps, toJobSpec } from "./ReleaseJob.ts";
import { Nomad, type JobSnapshot, type ServiceLocation } from "./Nomad.ts";
import { OperationJournal } from "./OperationJournal.ts";

export interface ReleaseSet extends Alchemy.Resource<
  "Nomad.ReleaseSet",
  ReleaseSetProps,
  ReleaseSetOutput
> {}

export const ReleaseSet = Alchemy.Resource<ReleaseSet>("Nomad.ReleaseSet");

export { ReleaseSetFailed } from "./ReleaseDecisions.ts";

type RuntimeRelease = {
  readonly upstream: string;
};

const ownerOf = (job: JobSnapshot) => Option.fromNullishOr(job.Meta?.["alchemy.owner"]);

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

const upstreamOf = (service: ServiceLocation) => `${service.Address}:${service.Port}`;

const healthyService = Effect.fn(function* (
  nomad: typeof Nomad.Service,
  name: string,
  job: JobSnapshot,
  service: ServiceLocation,
) {
  const allocation = yield* nomad.allocation(service.AllocID);
  return yield* Option.match(allocation, {
    onNone: () => Effect.succeed(Option.none<RuntimeRelease>()),
    onSome: (value) =>
      nomad.allocationChecks(service.AllocID).pipe(
        Effect.map((checks) => {
          const ready = serviceIsReady({
            service,
            jobName: name,
            jobVersion: job.Version,
            jobModifyIndex: job.JobModifyIndex,
            allocation: Option.some(value),
            checks,
          });
          return ready
            ? Option.some({ upstream: upstreamOf(service) })
            : Option.none<RuntimeRelease>();
        }),
      ),
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
  if (Option.isNone(state)) return Option.none<RuntimeRelease>();
  const job = state.value;
  if (!jobIsOwnedBy(job, owner) || job.JobModifyIndex !== modifyIndex) {
    return Option.none<RuntimeRelease>();
  }
  const services = yield* nomad.service(name);
  const ready = yield* Effect.forEach(services, (service) =>
    healthyService(nomad, name, job, service),
  );
  return Option.flatten(Arr.findFirst(ready, Option.isSome));
});

const settle = Effect.fn(function* (
  nomad: typeof Nomad.Service,
  props: ReleaseSetProps,
  release: Release,
  owner: string,
  modifyIndex: number,
) {
  for (let attempt = 0; attempt < 180; attempt++) {
    const ready = yield* healthyRelease(nomad, props, release, owner, modifyIndex);
    if (Option.isSome(ready)) return ready;
    yield* Effect.sleep("1 second");
  }
  return Option.none<RuntimeRelease>();
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
  const index = yield* Option.match(current, {
    onNone: () =>
      nomad.registerRelease(name, spec, 0).pipe(Effect.map((result) => result.JobModifyIndex)),
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
            : nomad
                .planRelease(name, spec)
                .pipe(
                  Effect.flatMap((plan) =>
                    plan.Diff.Type === "None"
                      ? Effect.succeed(job.JobModifyIndex)
                      : nomad
                          .registerRelease(name, spec, job.JobModifyIndex)
                          .pipe(Effect.map((result) => result.JobModifyIndex)),
                  ),
                ),
      }),
  });
  return yield* settle(nomad, props, release, owner, index).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            new ReleaseSetFailed({
              resource: props.name,
              message: `Nomad did not report release '${release.id}' healthy before its deadline`,
            }),
          ),
        onSome: Effect.succeed,
      }),
    ),
  );
});

const allReleasesReady = Effect.fn(function* (
  nomad: typeof Nomad.Service,
  props: ReleaseSetProps,
  owner: string,
) {
  return yield* Effect.forEach(props.releases, (release) =>
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
                    : healthyRelease(nomad, props, release, owner, job.JobModifyIndex).pipe(
                        Effect.map(Option.isSome),
                      ),
                ),
              ),
        }),
      ),
    ),
  ).pipe(Effect.map((ready) => ready.every(Boolean)));
});

export const ReleaseSetProvider = () =>
  Provider.effect(
    ReleaseSet,
    Effect.gen(function* () {
      const nomad = yield* Nomad;
      const caddy = yield* Caddy.Caddy;
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
                const jobs = yield* nomad.jobs();
                const names = news.releases.map((release) => jobName(news, release));
                const hasUnexpectedJob = jobs.some(
                  (job) =>
                    job.Meta?.["alchemy.owner"] === fqn &&
                    job.Meta?.["alchemy.provider"] === "Nomad.ReleaseSet" &&
                    !names.includes(job.ID),
                );
                // A job this stack owns but the declaration dropped still has
                // to be removed, and an unhealthy release has to be settled.
                if (hasUnexpectedJob || !(yield* allReleasesReady(nomad, news, fqn))) {
                  return { action: "update" as const };
                }
                const selected = yield* releaseFor(news, news.selectedRelease);
                const selectedJob = yield* nomad.job(jobName(news, selected));
                const selectedRuntime = yield* healthyRelease(
                  nomad,
                  news,
                  selected,
                  fqn,
                  Option.match(selectedJob, {
                    onNone: () => 0,
                    onSome: (job) => job.JobModifyIndex,
                  }),
                );
                const stableMatches = yield* Option.match(selectedRuntime, {
                  onNone: () => Effect.succeed(false),
                  onSome: (runtime) =>
                    caddy.routeTargets(
                      stableRouteId(fqn, news.domain),
                      news.domain,
                      selected.id,
                      runtime.upstream,
                    ),
                });
                const candidateMatches = yield* Option.match(candidateOf(news), {
                  onNone: () => Effect.succeed(true),
                  onSome: (candidateId) =>
                    Effect.gen(function* () {
                      const candidate = yield* releaseFor(news, candidateId);
                      const job = yield* nomad.job(jobName(news, candidate));
                      return yield* Option.match(job, {
                        onNone: () => Effect.succeed(false),
                        onSome: (value) =>
                          healthyRelease(nomad, news, candidate, fqn, value.JobModifyIndex).pipe(
                            Effect.flatMap(
                              Option.match({
                                onNone: () => Effect.succeed(false),
                                onSome: (runtime) =>
                                  caddy.routeTargets(
                                    previewRouteId(fqn, news.domain, candidate.id),
                                    previewHost(news, candidate),
                                    candidate.id,
                                    runtime.upstream,
                                  ),
                              }),
                            ),
                          ),
                      });
                    }),
                });
                const stalePreview = Option.match(Option.fromNullishOr(olds), {
                  onNone: () => false,
                  onSome: (oldProps) =>
                    Option.match(candidateOf(oldProps), {
                      onNone: () => false,
                      onSome: (oldCandidate) =>
                        !Option.match(candidateOf(news), {
                          onNone: () => false,
                          onSome: (newCandidate) => newCandidate === oldCandidate,
                        }),
                    }),
                });
                return routeDecision({
                  stableMatches,
                  candidateMatches,
                  stalePreview,
                });
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
              const selected = yield* releaseFor(news, news.selectedRelease);
              const selectedRuntime = yield* ensureRelease(nomad, news, selected, fqn);
              yield* caddy.applyRoute(
                Caddy.makeRoute(
                  stableRouteId(fqn, news.domain),
                  news.domain,
                  selected.id,
                  selectedRuntime.upstream,
                ),
              );
              const runtimes = yield* Effect.forEach(
                news.releases.filter((release) => release.id !== selected.id),
                (release) =>
                  ensureRelease(nomad, news, release, fqn).pipe(
                    Effect.map((runtime) => [release.id, runtime] as const),
                  ),
              );
              const runtimeById = new Map(runtimes);
              const candidate = yield* Option.match(candidateOf(news), {
                onNone: () => Effect.succeed(Option.none<Release>()),
                onSome: (id) => releaseFor(news, id).pipe(Effect.map(Option.some)),
              });
              yield* Option.match(candidate, {
                onNone: () => Effect.void,
                onSome: (release) => {
                  return Option.match(Option.fromNullishOr(runtimeById.get(release.id)), {
                    onNone: () =>
                      Effect.fail(
                        new ReleaseSetFailed({
                          resource: news.name,
                          message: `candidate release '${release.id}' has no healthy Nomad service`,
                        }),
                      ),
                    onSome: (runtime) =>
                      caddy.applyRoute(
                        Caddy.makeRoute(
                          previewRouteId(fqn, news.domain, release.id),
                          previewHost(news, release),
                          release.id,
                          runtime.upstream,
                        ),
                      ),
                  });
                },
              });
              yield* Effect.forEach(olds?.releases ?? [], (oldRelease) =>
                Option.match(candidate, {
                  onNone: () => caddy.deleteRoute(previewRouteId(fqn, news.domain, oldRelease.id)),
                  onSome: (currentCandidate) =>
                    currentCandidate.id === oldRelease.id
                      ? Effect.void
                      : caddy.deleteRoute(previewRouteId(fqn, news.domain, oldRelease.id)),
                }),
              );
              const wanted = new Set(news.releases.map((release) => release.id));
              yield* Effect.forEach(olds?.releases ?? [], (oldRelease) =>
                wanted.has(oldRelease.id)
                  ? Effect.void
                  : removeRelease(nomad, oldRelease, news, fqn),
              );
              const liveJobs = yield* nomad.jobs();
              yield* Effect.forEach(
                liveJobs.filter(
                  (job) =>
                    job.Meta?.["alchemy.owner"] === fqn &&
                    job.Meta?.["alchemy.provider"] === "Nomad.ReleaseSet" &&
                    !news.releases.some((release) => job.ID === jobName(news, release)),
                ),
                (job) =>
                  Option.match(Option.fromNullishOr(job.Meta?.["alchemy.release"]), {
                    // Without a release ID its preview route cannot be derived;
                    // preserve the job rather than deleting an unidentified resource.
                    onNone: () =>
                      Effect.logWarning(
                        `Leaving owned Nomad job '${job.ID}' in place because release metadata is missing`,
                      ),
                    onSome: (releaseId) =>
                      caddy
                        .deleteRoute(previewRouteId(fqn, news.domain, releaseId))
                        .pipe(Effect.andThen(nomad.stop(job.ID))),
                  }),
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
            Effect.gen(function* () {
              yield* caddy.deleteRoute(stableRouteId(fqn, olds.domain));
              yield* Effect.forEach(olds.releases, (release) =>
                caddy.deleteRoute(previewRouteId(fqn, olds.domain, release.id)),
              );
              yield* Effect.forEach(olds.releases, (release) =>
                removeRelease(nomad, release, olds, fqn),
              );
            }),
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
