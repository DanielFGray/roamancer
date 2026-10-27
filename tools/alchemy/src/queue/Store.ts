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
} from "./Errors.ts";
import {
  JobCommand,
  JobState,
  JobSubmit,
  type Job as JobT,
  type JobState as JobStateT,
  type JobSubmit as JobSubmitT,
  stageOf,
} from "./Schema.ts";

const JobRow = S.Struct({
  id: S.Number,
  command: JobCommand,
  payload: S.String,
  state: JobState,
  exit_code: S.NullOr(S.Number),
  created_at: S.String,
  started_at: S.NullOr(S.String),
  finished_at: S.NullOr(S.String),
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

    const enqueue = Effect.fn("Store.enqueue")(function* (submit: JobSubmitT) {
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
     * Unit body: starting → running. Fails when canceled or recovered mid-flight
     * so the Alchemy command never runs.
     */
    const claim = Effect.fn("Store.claim")(function* (id: number) {
      const rows = yield* sql<{ id: number }>`
        UPDATE jobs
        SET state = 'running'
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
            stages.add(stageOf(job.submit));
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
                origin: "",
                revision: "",
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

    return {
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
  | InvalidJobRow;
