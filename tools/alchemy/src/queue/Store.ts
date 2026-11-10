/**
 * SQLite job queue. Schema lives with the store; migrations run on open.
 * Reservation of the next job is an atomic UPDATE — unit process state is not consulted.
 */
import * as path from "node:path";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Context, Effect, FileSystem, Layer, Option, Schema as S } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";
import {
  CancelRefused,
  InvalidJobRow,
  JobNotActive,
  JobNotFound,
  JobNotStarting,
  PlanStale,
} from "./Errors.ts";
import { JobCommand, JobState, ReconcileStatus, type JobState as JobStateT } from "./Kinds.ts";
import {
  JobSubmit,
  type DeploySubmit,
  type Job as JobT,
  type JobSubmit as JobSubmitT,
  recoveryStage,
} from "./Schema.ts";

const JobRow = S.Struct({
  id: S.Number,
  command: JobCommand,
  payload: S.String,
  state: JobState,
  exit_code: S.NullOr(S.Number),
  runner_revision: S.NullOr(S.String),
  created_at: S.String,
  started_at: S.NullOr(S.String),
  finished_at: S.NullOr(S.String),
});

const SignoffRow = S.Struct({
  id: S.Number,
  app: S.String,
  tree: S.String,
  commit: S.String,
  summary: S.String,
  log_sha256: S.String,
  created_at: S.String,
});

/** A stored local-test signoff; newest row for an app+tree wins at read time. */
export type Signoff = {
  readonly id: number;
  readonly app: string;
  readonly tree: string;
  readonly commit: string;
  readonly summary: string;
  readonly logSha256: string;
  readonly createdAt: string;
};

export type SignoffInput = {
  readonly app: string;
  readonly tree: string;
  readonly commit: string;
  readonly summary: string;
  readonly logSha256: string;
};

const toSignoff = (row: typeof SignoffRow.Type): Signoff => ({
  id: row.id,
  app: row.app,
  tree: row.tree,
  commit: row.commit,
  summary: row.summary,
  logSha256: row.log_sha256,
  createdAt: row.created_at,
});

const ReconcileRow = S.Struct({
  app: S.String,
  seen_commit: S.NullOr(S.String),
  seen_tree: S.NullOr(S.String),
  tried_tree: S.NullOr(S.String),
  tried_commit: S.NullOr(S.String),
  tried_result: S.NullOr(S.Literals(["released", "failed"])),
  tried_job: S.NullOr(S.Number),
  status: ReconcileStatus,
  detail: S.String,
  checked_at: S.String,
});

/**
 * What reconcile knows about one app. `tried*` is the last tree it released or failed to
 * release; a tree that only waited for a signoff or a login is not in it.
 */
export type Reconcile = {
  readonly app: string;
  /** The head of `main` reconcile last read, and its tree. */
  readonly seenCommit: string | null;
  readonly seenTree: string | null;
  readonly triedTree: string | null;
  readonly triedCommit: string | null;
  readonly triedResult: "released" | "failed" | null;
  /** The queue job of that try. */
  readonly triedJob: number | null;
  /** The last outcome of any kind, with the sentence `ops dash` shows for it. */
  readonly status: ReconcileStatus;
  readonly detail: string;
  readonly checkedAt: string;
};

const toReconcile = (row: typeof ReconcileRow.Type): Reconcile => ({
  app: row.app,
  seenCommit: row.seen_commit,
  seenTree: row.seen_tree,
  triedTree: row.tried_tree,
  triedCommit: row.tried_commit,
  triedResult: row.tried_result,
  triedJob: row.tried_job,
  status: row.status,
  detail: row.detail,
  checkedAt: row.checked_at,
});

const decodePayload = S.decodeUnknownEffect(S.fromJsonString(JobSubmit));
const encodePayload = S.encodeEffect(S.fromJsonString(JobSubmit));

const toJob = Effect.fn("Store.toJob")(function* (row: typeof JobRow.Type) {
  const submit = yield* decodePayload(row.payload).pipe(
    Effect.mapError((cause) => new InvalidJobRow({ cause })),
  );
  return {
    id: row.id,
    submit,
    state: row.state,
    exitCode: row.exit_code,
    runnerRevision: row.runner_revision,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  } satisfies JobT;
});

const nowSql = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

export class Store extends Context.Service<Store>()("alchemy/queue/Store", {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY NOT NULL
      )
    `;

    const applied = yield* sql<{ version: number }>`
      SELECT version FROM schema_migrations ORDER BY version
    `.pipe(Effect.map((rows) => new Set(rows.map((r) => r.version))));

    if (!applied.has(1)) {
      yield* sql`
        CREATE TABLE jobs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          command TEXT NOT NULL,
          payload TEXT NOT NULL,
          state TEXT NOT NULL CHECK (
            state IN (
              'queued','starting','running','succeeded','failed','interrupted','canceled'
            )
          ),
          exit_code INTEGER,
          created_at TEXT NOT NULL,
          started_at TEXT,
          finished_at TEXT
        )
      `;
      yield* sql`CREATE INDEX jobs_state ON jobs(state)`;
      yield* sql`CREATE INDEX jobs_created ON jobs(created_at)`;
      yield* sql`INSERT INTO schema_migrations (version) VALUES (1)`;
      applied.add(1);
    }

    // Existing databases from migration 1 lack the column; new opens apply 1 then 2.
    if (!applied.has(2)) {
      yield* sql`ALTER TABLE jobs ADD COLUMN runner_revision TEXT`;
      yield* sql`INSERT INTO schema_migrations (version) VALUES (2)`;
    }

    // `dash` was a job until the fleet service took the snapshot out of the queue. Its rows
    // record one-time reads, and the schema can no longer decode them.
    if (!applied.has(3)) {
      yield* sql`DELETE FROM jobs WHERE command = 'dash'`;
      yield* sql`INSERT INTO schema_migrations (version) VALUES (3)`;
      applied.add(3);
    }

    if (!applied.has(4)) {
      yield* sql`
        CREATE TABLE images (
          repository TEXT NOT NULL,
          key TEXT NOT NULL,
          digest TEXT NOT NULL,
          recorded_at TEXT NOT NULL,
          PRIMARY KEY (repository, key)
        )
      `;
      yield* sql`INSERT INTO schema_migrations (version) VALUES (4)`;
      applied.add(4);
    }

    // Local test signoffs keyed by tree; reconcile reads these, the queue does not run them.
    if (!applied.has(5)) {
      yield* sql`
        CREATE TABLE signoffs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          app TEXT NOT NULL,
          tree TEXT NOT NULL,
          "commit" TEXT NOT NULL,
          summary TEXT NOT NULL,
          log_sha256 TEXT NOT NULL,
          created_at TEXT NOT NULL
        )
      `;
      yield* sql`CREATE INDEX signoffs_app_created ON signoffs(app, created_at DESC)`;
      yield* sql`INSERT INTO schema_migrations (version) VALUES (5)`;
      applied.add(5);
    }

    // What reconcile saw and tried per app: the head of `main` it last read, the tree it
    // last released or tried (a failed build or deploy is a try), and its last outcome.
    if (!applied.has(6)) {
      yield* sql`
        CREATE TABLE reconciles (
          app TEXT PRIMARY KEY NOT NULL,
          seen_commit TEXT,
          seen_tree TEXT,
          tried_tree TEXT,
          tried_commit TEXT,
          tried_result TEXT CHECK (tried_result IN ('released','failed')),
          tried_job INTEGER,
          status TEXT NOT NULL,
          detail TEXT NOT NULL,
          checked_at TEXT NOT NULL
        )
      `;
      yield* sql`INSERT INTO schema_migrations (version) VALUES (6)`;
      applied.add(6);
    }

    const selectJob = SqlSchema.findOne({
      Request: S.Number,
      Result: JobRow,
      execute: (id) => sql`SELECT * FROM jobs WHERE id = ${id}`,
    });

    const get = Effect.fn("Store.get")(function* (id: number) {
      const row = yield* selectJob(id).pipe(
        Effect.catchTag("NoSuchElementError", () => Effect.fail(new JobNotFound({ id }))),
      );
      return yield* toJob(row);
    });

    const getOption = Effect.fn("Store.getOption")(function* (id: number) {
      return yield* get(id).pipe(
        Effect.asSome,
        Effect.catchTag("JobNotFound", () => Effect.succeedNone),
      );
    });

    /**
     * Queue a job. An app has at most one reconcile job of each kind (timer or retry) waiting or
     * running, so a second request returns that job: the timer fires every minute whatever a
     * release takes. A retry never merges into a timer job, which would skip the tried tree. A new
     * reconcile also removes the app's finished reconcile jobs that tried nothing, so a minute
     * timer does not fill the queue's list; the journal keeps their output.
     */
    const enqueue = Effect.fn("Store.enqueue")(function* (submit: JobSubmitT) {
      if (submit.command !== "reconcile") return yield* insert(submit);
      const app = submit.app;
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const active = yield* sql<{ id: number }>`
            SELECT id FROM jobs
            WHERE command = 'reconcile'
              AND json_extract(payload, '$.app') = ${app}
              AND coalesce(json_extract(payload, '$.retry'), 0) = ${submit.retry ? 1 : 0}
              AND state IN ('queued', 'starting', 'running')
            LIMIT 1
          `;
          if (active[0] !== undefined) return yield* get(active[0].id);
          yield* sql`
            DELETE FROM jobs
            WHERE command = 'reconcile'
              AND json_extract(payload, '$.app') = ${app}
              AND state IN ('succeeded', 'canceled')
              AND id NOT IN (SELECT tried_job FROM reconciles WHERE tried_job IS NOT NULL)
          `;
          return yield* insert(submit);
        }),
      );
    });

    const insert = Effect.fn("Store.insert")(function* (submit: JobSubmitT) {
      const payload = yield* encodePayload(submit).pipe(Effect.orDie);
      const rows = yield* sql<{ id: number }>`
        INSERT INTO jobs (command, payload, state, created_at)
        VALUES (${submit.command}, ${payload}, 'queued', ${sql.literal(nowSql)})
        RETURNING id
      `;
      const id = rows[0]?.id;
      if (id === undefined) {
        return yield* Effect.die(new Error("INSERT RETURNING produced no id"));
      }
      return yield* get(id);
    });

    /**
     * Atomically take the next queued job: only succeeds when no starting/running
     * row exists. Returns none if the queue is idle-empty or already reserved.
     */
    const reserveNext = Effect.fn("Store.reserveNext")(function* () {
      const rows = yield* sql<{ id: number }>`
        UPDATE jobs
        SET state = 'starting', started_at = ${sql.literal(nowSql)}
        WHERE id = (
          SELECT id FROM jobs
          WHERE state = 'queued'
          ORDER BY id
          LIMIT 1
        )
        AND NOT EXISTS (
          SELECT 1 FROM jobs WHERE state IN ('starting', 'running')
        )
        RETURNING id
      `;
      const id = rows[0]?.id;
      if (id === undefined) return Option.none<JobT>();
      return Option.some(yield* get(id));
    });

    /**
     * Unit body: starting → running, recording the runner revision that runs it.
     * Fails when canceled or recovered mid-flight so the Alchemy command never runs.
     */
    const claim = Effect.fn("Store.claim")(function* (id: number, runnerRevision: string | null) {
      const rows = yield* sql<{ id: number }>`
        UPDATE jobs
        SET state = 'running',
            runner_revision = ${runnerRevision}
        WHERE id = ${id} AND state = 'starting'
        RETURNING id
      `;
      if (rows[0] === undefined) {
        const job = yield* get(id);
        return yield* Effect.fail(new JobNotStarting({ id, state: job.state }));
      }
      return yield* get(id);
    });

    const finish = Effect.fn("Store.finish")(function* (id: number, exitCode: number) {
      const state: JobStateT = exitCode === 0 ? "succeeded" : "failed";
      const rows = yield* sql<{ id: number }>`
        UPDATE jobs
        SET state = ${state},
            exit_code = ${exitCode},
            finished_at = ${sql.literal(nowSql)}
        WHERE id = ${id} AND state = 'running'
        RETURNING id
      `;
      if (rows[0] === undefined) {
        const job = yield* get(id);
        return yield* Effect.fail(new JobNotActive({ id, state: job.state }));
      }
      return yield* get(id);
    });

    /**
     * ExecStopPost / token failure: force a terminal state from queued, starting, or running.
     */
    const abandon = Effect.fn("Store.abandon")(function* (
      id: number,
      state: "failed" | "interrupted",
      exitCode: number,
    ) {
      const rows = yield* sql<{ id: number }>`
        UPDATE jobs
        SET state = ${state},
            exit_code = ${exitCode},
            finished_at = ${sql.literal(nowSql)}
        WHERE id = ${id} AND state IN ('queued', 'starting', 'running')
        RETURNING id
      `;
      if (rows[0] === undefined) return yield* getOption(id);
      return Option.some(yield* get(id));
    });

    const interrupt = Effect.fn("Store.interrupt")(function* (id: number) {
      const rows = yield* sql<{ id: number }>`
        UPDATE jobs
        SET state = 'interrupted',
            finished_at = ${sql.literal(nowSql)}
        WHERE id = ${id} AND state IN ('starting', 'running')
        RETURNING id
      `;
      if (rows[0] === undefined) {
        const job = yield* get(id);
        return yield* Effect.fail(new JobNotActive({ id, state: job.state }));
      }
      return yield* get(id);
    });

    /**
     * Cancel queued or starting rows. A starting cancel wins over claim: the unit
     * body then fails JobNotStarting and does not run Alchemy. Running is refused.
     */
    const cancel = Effect.fn("Store.cancel")(function* (id: number) {
      const rows = yield* sql<{ id: number }>`
        UPDATE jobs
        SET state = 'canceled',
            finished_at = ${sql.literal(nowSql)}
        WHERE id = ${id} AND state IN ('queued', 'starting')
        RETURNING id
      `;
      if (rows[0] === undefined) {
        const job = yield* get(id);
        return yield* Effect.fail(new CancelRefused({ id, state: job.state }));
      }
      return yield* get(id);
    });

    /**
     * Crash recovery in one transaction: every starting/running row → interrupted,
     * then one plan job enqueued per distinct stage (skips if a plan is already queued).
     */
    const recoverInterrupted = Effect.fn("Store.recoverInterrupted")(function* () {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const active = yield* sql<typeof JobRow.Type>`
            SELECT * FROM jobs WHERE state IN ('starting', 'running')
          `;
          const stages = new Set<string>();
          for (const row of active) {
            const job = yield* toJob(row);
            const stage = recoveryStage(job.submit);
            if (Option.isSome(stage)) stages.add(stage.value);
            yield* sql`
              UPDATE jobs
              SET state = 'interrupted',
                  finished_at = ${sql.literal(nowSql)}
              WHERE id = ${row.id}
            `;
          }
          const enqueued: Array<JobT> = [];
          for (const stage of stages) {
            const existing = yield* sql<{ id: number }>`
              SELECT id FROM jobs
              WHERE state = 'queued'
                AND command = 'plan'
                AND json_extract(payload, '$.stage') = ${stage}
              LIMIT 1
            `;
            if (existing[0] !== undefined) continue;
            enqueued.push(
              yield* enqueue({
                command: "plan",
                stage,
                cartridge: null,
                revision: "",
                stagedImage: null,
              }),
            );
          }
          return enqueued;
        }),
      );
    });

    const list = Effect.fn("Store.list")(function* (opts?: { state?: JobStateT; limit?: number }) {
      const limit = opts?.limit ?? 50;
      const rows =
        opts?.state !== undefined
          ? yield* sql<typeof JobRow.Type>`
              SELECT * FROM jobs WHERE state = ${opts.state}
              ORDER BY id DESC LIMIT ${sql.literal(String(limit))}
            `
          : yield* sql<typeof JobRow.Type>`
              SELECT * FROM jobs ORDER BY id DESC LIMIT ${sql.literal(String(limit))}
            `;
      return yield* Effect.forEach(rows, toJob, { concurrency: 1 });
    });

    const recordSignoff = Effect.fn("Store.recordSignoff")(function* (input: SignoffInput) {
      const rows = yield* sql<typeof SignoffRow.Type>`
        INSERT INTO signoffs (app, tree, "commit", summary, log_sha256, created_at)
        VALUES (
          ${input.app},
          ${input.tree},
          ${input.commit},
          ${input.summary},
          ${input.logSha256},
          ${sql.literal(nowSql)}
        )
        RETURNING *
      `;
      const row = rows[0];
      if (row === undefined) {
        return yield* Effect.die(new Error("INSERT RETURNING produced no signoff"));
      }
      return toSignoff(row);
    });

    const listSignoffs = Effect.fn("Store.listSignoffs")(function* (app: string) {
      const rows = yield* sql<typeof SignoffRow.Type>`
        SELECT * FROM signoffs WHERE app = ${app}
        ORDER BY created_at DESC, id DESC
      `;
      return rows.map(toSignoff);
    });

    /** What reconcile last recorded for `app`; none before its first run. */
    const getReconcile = Effect.fn("Store.getReconcile")(function* (app: string) {
      const rows = yield* sql<typeof ReconcileRow.Type>`
        SELECT * FROM reconciles WHERE app = ${app}
      `;
      return Option.fromNullishOr(rows[0]).pipe(Option.map(toReconcile));
    });

    /** Every app reconcile has run for, by name. */
    const listReconciles = Effect.fn("Store.listReconciles")(function* () {
      const rows = yield* sql<typeof ReconcileRow.Type>`SELECT * FROM reconciles ORDER BY app`;
      return rows.map(toReconcile);
    });

    /** Replace the app's record; the store stamps `checkedAt`. */
    const saveReconcile = Effect.fn("Store.saveReconcile")(function* (
      next: Omit<Reconcile, "checkedAt">,
    ) {
      yield* sql`
        INSERT INTO reconciles (
          app, seen_commit, seen_tree, tried_tree, tried_commit, tried_result, tried_job,
          status, detail, checked_at
        ) VALUES (
          ${next.app}, ${next.seenCommit}, ${next.seenTree}, ${next.triedTree},
          ${next.triedCommit}, ${next.triedResult}, ${next.triedJob},
          ${next.status}, ${next.detail}, ${sql.literal(nowSql)}
        )
        ON CONFLICT (app) DO UPDATE SET
          seen_commit = excluded.seen_commit,
          seen_tree = excluded.seen_tree,
          tried_tree = excluded.tried_tree,
          tried_commit = excluded.tried_commit,
          tried_result = excluded.tried_result,
          tried_job = excluded.tried_job,
          status = excluded.status,
          detail = excluded.detail,
          checked_at = excluded.checked_at
      `;
    });
    /**
     * Deploy gate: the named plan must be a succeeded plan of the same stage and
     * cartridge, run by the same runner revision, with no later finished job.
     */
    const requireFreshPlan = Effect.fn("Store.requireFreshPlan")(function* (
      deploy: DeploySubmit,
      runnerRevision: string | null,
    ) {
      const planJobId = deploy.planJobId;
      const stale = (reason: string) => Effect.fail(new PlanStale({ planJobId, reason }));
      const found = yield* getOption(planJobId);
      if (Option.isNone(found)) return yield* stale("no such job");
      const plan = found.value;
      if (plan.submit.command !== "plan") return yield* stale("not a plan");
      if (plan.state !== "succeeded" || plan.finishedAt === null) {
        return yield* stale(`the plan ${plan.state}`);
      }
      if (plan.submit.stage !== deploy.stage) return yield* stale("another stage");
      if (plan.submit.cartridge !== deploy.cartridge) return yield* stale("another cartridge");
      if (plan.submit.stagedImage !== deploy.stagedImage)
        return yield* stale("another staged image");
      if (plan.submit.revision !== deploy.revision) return yield* stale("another commit");
      if (plan.runnerRevision !== runnerRevision) return yield* stale("another runner revision");
      // Only a job that changes resources outdates a plan; reads and plans in between do not.
      const later = yield* sql<{ id: number }>`
        SELECT id FROM jobs
        WHERE command IN ('deploy', 'destroy', 'rollback')
          AND finished_at IS NOT NULL
          AND (
            finished_at > ${plan.finishedAt}
            OR (finished_at = ${plan.finishedAt} AND id > ${planJobId})
          )
        LIMIT 1
      `;
      if (later[0] !== undefined) return yield* stale(`job ${later[0].id} changed resources since`);
    });

    /** Record `digest` as the image of `key`; a later push of the same key replaces it. */
    const recordImage = Effect.fn("Store.recordImage")(function* (image: {
      readonly repository: string;
      readonly key: string;
      readonly digest: string;
    }) {
      yield* sql`
        INSERT INTO images (repository, key, digest, recorded_at)
        VALUES (${image.repository}, ${image.key}, ${image.digest}, ${sql.literal(nowSql)})
        ON CONFLICT (repository, key)
        DO UPDATE SET digest = excluded.digest, recorded_at = excluded.recorded_at
      `;
    });

    /** The digest recorded for `key` in `repository`, or none. */
    const findImage = Effect.fn("Store.findImage")(function* (image: {
      readonly repository: string;
      readonly key: string;
    }) {
      const rows = yield* sql<{ digest: string }>`
        SELECT digest FROM images WHERE repository = ${image.repository} AND key = ${image.key}
      `;
      return Option.fromNullishOr(rows[0]?.digest);
    });

    return {
      recordImage,
      findImage,
      enqueue,
      get,
      getOption,
      reserveNext,
      claim,
      finish,
      abandon,
      interrupt,
      cancel,
      recoverInterrupted,
      list,
      recordSignoff,
      listSignoffs,
      getReconcile,
      listReconciles,
      saveReconcile,
      requireFreshPlan,
    } as const;
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}

/** Store over a SQLite file; creates the parent directory when missing. */
export const layer = (filename: string) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(path.dirname(filename), { recursive: true });
      return Store.layer.pipe(Layer.provide(SqliteClient.layer({ filename })));
    }),
  );

export type StoreError =
  | SqlError.SqlError
  | S.SchemaError
  | JobNotFound
  | JobNotStarting
  | JobNotActive
  | CancelRefused
  | InvalidJobRow
  | PlanStale;
