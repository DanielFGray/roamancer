import * as Alchemy from "alchemy";
import * as Provider from "alchemy/Provider";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { Job, secretPolicyPaths, workloadRole } from "./Job.ts";
import { Nomad } from "./Nomad.ts";
import type { Deployment, JobSnapshot } from "./Nomad.ts";
import { OperationJournal } from "./OperationJournal.ts";
import { OpenBao } from "./OpenBao.ts";

export interface NomadJob extends Alchemy.Resource<
  "Nomad.Job",
  Job,
  {
    id: string;
    modifyIndex: number;
    owner: string;
  }
> {}

export const NomadJob = Alchemy.Resource<NomadJob>("Nomad.Job");

export class NomadJobDeployFailed extends Schema.TaggedError<NomadJobDeployFailed>()(
  "NomadJobDeployFailed",
  {
    job: Schema.String,
    message: Schema.String,
  },
) {}

const ownerOf = (job: JobSnapshot) => Option.fromNullishOr(job.Meta?.["alchemy.owner"]);

const providerOf = (job: JobSnapshot) => Option.fromNullishOr(job.Meta?.["alchemy.provider"]);

const attributes = (job: JobSnapshot, owner: string) => ({
  id: job.ID,
  modifyIndex: job.JobModifyIndex,
  owner,
});

const deploymentIsHealthy = (job: JobSnapshot, deployment: Deployment) =>
  deployment.JobVersion === job.Version &&
  deployment.JobModifyIndex === job.JobModifyIndex &&
  deployment.Status === "successful";

export const NomadJobProvider = () =>
  Provider.effect(
    NomadJob,
    Effect.gen(function* () {
      const nomad = yield* Nomad;
      const journal = yield* OperationJournal;
      const openBao = yield* OpenBao;
      return NomadJob.Provider.of({
        list: Effect.fn(function* () {
          const jobs = yield* nomad.jobs();
          return Arr.filterMap(jobs, (job) => {
            const owner = Option.fromNullishOr(job.Meta?.["alchemy.owner"]);
            const provider = Option.fromNullishOr(job.Meta?.["alchemy.provider"]);
            return Option.match(owner, {
              onNone: () => Result.failVoid,
              onSome: (owner) =>
                Option.match(provider, {
                  onNone: () => Result.failVoid,
                  onSome: (name) =>
                    name === "Nomad.Job"
                      ? Result.succeed({ id: job.ID, modifyIndex: job.JobModifyIndex, owner })
                      : Result.failVoid,
                }),
            });
          });
        }),
        diff: Effect.fn(function* ({ news, fqn }) {
          if (!isResolved(news)) return undefined;
          if (yield* journal.hasPending(fqn)) return { action: "update" as const };
          const current = yield* nomad.job(news.name);
          return yield* Option.match(current, {
            onNone: () => Effect.succeed({ action: "update" as const }),
            onSome: (job) =>
              Option.match(ownerOf(job), {
                onNone: () => Effect.succeed({ action: "update" as const }),
                onSome: (owner) =>
                  owner !== fqn
                    ? Effect.succeed({ action: "update" as const })
                    : nomad.plan(news, fqn).pipe(
                        Effect.flatMap((plan) => {
                          if (plan.Diff.Type !== "None")
                            return Effect.succeed({ action: "update" as const });
                          return nomad.deployment(news.name).pipe(
                            Effect.map((deployment) =>
                              Option.match(deployment, {
                                onNone: () => ({ action: "update" as const }),
                                onSome: (value) =>
                                  deploymentIsHealthy(job, value)
                                    ? { action: "noop" as const }
                                    : { action: "update" as const },
                              }),
                            ),
                          );
                        }),
                      ),
              }),
          });
        }),
        reconcile: Effect.fn(function* ({ news, output, fqn }) {
          const secretPaths = secretPolicyPaths(news);
          yield* secretPaths.length === 0
            ? Effect.void
            : openBao.configureWorkloadRole({
                name: workloadRole(news.name),
                job: news.name,
                secretPaths,
              });
          return yield* journal.run(
            {
              resourceId: fqn,
              provider: "Nomad.Job",
              target: news.name,
              action: "reconcile",
            },
            Effect.gen(function* () {
              const current = yield* nomad.job(news.name);
              const alreadyHealthy = yield* Option.match(current, {
                onNone: () => Effect.succeed(Option.none<JobSnapshot>()),
                onSome: (job) =>
                  Option.match(ownerOf(job), {
                    onNone: () => Effect.succeed(Option.none<JobSnapshot>()),
                    onSome: (owner) =>
                      owner !== fqn
                        ? Effect.succeed(Option.none<JobSnapshot>())
                        : nomad
                            .plan(news, fqn)
                            .pipe(
                              Effect.flatMap((plan) =>
                                plan.Diff.Type !== "None"
                                  ? Effect.succeed(Option.none<JobSnapshot>())
                                  : nomad
                                      .deployment(news.name)
                                      .pipe(
                                        Effect.map((deployment) =>
                                          Option.flatMap(deployment, (value) =>
                                            deploymentIsHealthy(job, value)
                                              ? Option.some(job)
                                              : Option.none(),
                                          ),
                                        ),
                                      ),
                              ),
                            ),
                  }),
              });

              return yield* Option.match(alreadyHealthy, {
                onSome: (job) => Effect.succeed(attributes(job, fqn)),
                onNone: () => {
                  // A failed apply can leave Alchemy state behind Nomad. Use the live index
                  // so a retry can safely finish an update that Nomad already accepted.
                  const expectedModifyIndex = Option.match(current, {
                    onNone: () => 0,
                    onSome: (job) => job.JobModifyIndex,
                  });
                  return nomad.register(news, fqn, expectedModifyIndex).pipe(
                    Effect.flatMap((registration) =>
                      settle(nomad, news.name, fqn, registration.JobModifyIndex),
                    ),
                    Effect.flatMap((settled) =>
                      Option.match(settled, {
                        onNone: () =>
                          Effect.fail(
                            new NomadJobDeployFailed({
                              job: news.name,
                              message:
                                "Nomad did not report this job version healthy before its deadline",
                            }),
                          ),
                        onSome: ({ job }) => Effect.succeed(attributes(job, fqn)),
                      }),
                    ),
                  );
                },
              });
            }),
          );
        }),
        delete: Effect.fn(function* ({ output, fqn }) {
          yield* journal.run(
            {
              resourceId: fqn,
              provider: "Nomad.Job",
              target: output.id,
              action: "delete",
            },
            Effect.gen(function* () {
              const current = yield* nomad.job(output.id);
              yield* Option.match(current, {
                onNone: () => Effect.void,
                onSome: (job) =>
                  Option.match(ownerOf(job), {
                    onNone: () =>
                      Effect.fail(
                        new NomadJobDeployFailed({
                          job: output.id,
                          message:
                            "refusing to delete a Nomad job without Alchemy ownership metadata",
                        }),
                      ),
                    onSome: (owner) =>
                      owner !== fqn
                        ? Effect.fail(
                            new NomadJobDeployFailed({
                              job: output.id,
                              message:
                                "refusing to delete a Nomad job owned by another Alchemy stack",
                            }),
                          )
                        : nomad.stop(output.id),
                  }),
              });
            }),
          );
        }),
        read: Effect.fn(function* ({ id, fqn }) {
          const current = yield* nomad.job(id);
          return Option.getOrUndefined(
            Option.map(current, (job) =>
              Option.match(ownerOf(job), {
                onNone: () => Unowned({ id: job.ID, modifyIndex: job.JobModifyIndex, owner: "" }),
                onSome: (owner) =>
                  owner === fqn ? attributes(job, owner) : Unowned(attributes(job, owner)),
              }),
            ),
          );
        }),
      });
    }),
  );

const settle = Effect.fn(function* (
  nomad: typeof Nomad.Service,
  name: string,
  owner: string,
  modifyIndex: number,
) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const current = yield* nomad.job(name);
    const outcome = yield* Option.match(current, {
      onNone: () =>
        Effect.succeed(
          Option.none<{
            job: JobSnapshot;
            deployment: Deployment;
          }>(),
        ),
      onSome: (job) =>
        job.JobModifyIndex !== modifyIndex
          ? Effect.succeed(Option.none())
          : Option.match(ownerOf(job), {
              onNone: () => Effect.succeed(Option.none()),
              onSome: (actualOwner) =>
                actualOwner !== owner
                  ? Effect.succeed(Option.none())
                  : nomad
                      .deployment(name)
                      .pipe(
                        Effect.map((deployment) =>
                          Option.flatMap(deployment, (value) =>
                            value.JobModifyIndex !== modifyIndex
                              ? Option.none()
                              : deploymentIsHealthy(job, value)
                                ? Option.some({ job, deployment: value })
                                : value.Status === "failed" || value.Status === "cancelled"
                                  ? Option.none()
                                  : Option.none(),
                          ),
                        ),
                      ),
            }),
    });
    if (Option.match(outcome, { onNone: () => false, onSome: () => true })) return outcome;
    yield* Effect.sleep("1 second");
  }
  return Option.none();
});
