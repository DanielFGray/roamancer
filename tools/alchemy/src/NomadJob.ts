import * as Alchemy from "alchemy";
import * as Provider from "alchemy/Provider";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as S from "effect/Schema";
import { Job, secretPolicyPaths, toScheduling, workloadRole } from "./Job.ts";
import { settle } from "./Deployment.ts";
import { Nomad } from "./Nomad.ts";
import type { JobSnapshot } from "./Nomad.ts";
import { OperationJournal } from "./OperationJournal.ts";
import { OpenBao } from "./OpenBao.ts";
import * as TaskLog from "./TaskLog.ts";

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

export class NomadJobDeployFailed extends S.TaggedError<NomadJobDeployFailed>()(
  "NomadJobDeployFailed",
  {
    job: S.String,
    message: S.String,
  },
) {}

const ownerOf = (job: JobSnapshot) => Option.fromNullishOr(job.Meta?.["alchemy.owner"]);

const attributes = (job: JobSnapshot, owner: string) => ({
  id: job.ID,
  modifyIndex: job.JobModifyIndex,
  owner,
});

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
          const live = yield* liveState(nomad, news, fqn);
          return live._tag === "Stable"
            ? { action: "noop" as const }
            : { action: "update" as const };
        }),
        reconcile: Effect.fn(function* ({ news, fqn }) {
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
              const live = yield* liveState(nomad, news, fqn);
              if (live._tag === "Stable") return attributes(live.job, fqn);
              if (live._tag === "Unstable") {
                return yield* new NomadJobDeployFailed({
                  job: news.name,
                  message:
                    "Nomad already has this exact job version, and its deployment never succeeded. Nomad deploys only a changed job, so fix the cause and change the job, or stop it first.",
                });
              }
              // Nomad refuses to register a job under another type, such as a service job
              // that becomes a system job to run on every node. Purge ours first, so the
              // registration creates the job anew; the job is down until it is placed again.
              const retyped = Option.filter(
                live.current,
                (job) =>
                  job.Type !== toScheduling(news.placement).Type &&
                  Option.getOrUndefined(ownerOf(job)) === fqn,
              );
              const current = yield* Option.match(retyped, {
                onNone: () => Effect.succeed(live.current),
                onSome: (job) => nomad.stop(job.ID).pipe(Effect.as(Option.none<JobSnapshot>())),
              });
              // A failed apply can leave Alchemy state behind Nomad. Use the live index
              // so a retry can safely finish an update that Nomad already accepted.
              const expectedModifyIndex = Option.match(current, {
                onNone: () => 0,
                onSome: (job) => job.JobModifyIndex,
              });
              const registration = yield* nomad.register(news, fqn, expectedModifyIndex);
              const settled = yield* settle(
                nomad,
                news.name,
                (job) => Option.getOrUndefined(ownerOf(job)) === fqn,
                registration.JobModifyIndex,
              );
              if (settled._tag === "Failed") {
                return yield* new NomadJobDeployFailed({ job: news.name, message: settled.reason });
              }
              return attributes(settled.job, fqn);
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
        logs: ({ output, options }) => TaskLog.recent(nomad, output.id, options),
        tail: ({ output }) => TaskLog.follow(nomad, output.id),
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

/**
 * How the live job compares with the desired one. Nomad registers nothing for an unchanged spec,
 * so an unchanged job is final: Stable once a deployment of its version succeeded, Unstable if
 * none did. Nomad keeps `Stable` on the job version but garbage-collects finished deployments,
 * so the deployment record cannot answer this an hour later.
 */
type LiveState =
  | { readonly _tag: "Changed"; readonly current: Option.Option<JobSnapshot> }
  | { readonly _tag: "Stable"; readonly job: JobSnapshot }
  | { readonly _tag: "Unstable"; readonly job: JobSnapshot };

const liveState = Effect.fn("NomadJob.liveState")(function* (
  nomad: typeof Nomad.Service,
  news: Job,
  fqn: string,
) {
  const current = yield* nomad.job(news.name);
  const owned = Option.filter(current, (job) => Option.getOrUndefined(ownerOf(job)) === fqn);
  const changed: LiveState = { _tag: "Changed", current };
  if (Option.isNone(owned)) return changed;
  const plan = yield* nomad.plan(news, fqn);
  if (plan.Diff.Type !== "None") return changed;
  const unchanged: LiveState = owned.value.Stable
    ? { _tag: "Stable", job: owned.value }
    : { _tag: "Unstable", job: owned.value };
  return unchanged;
});
