import { Effect, Schema as S } from "effect";
import { Database } from "bun:sqlite";
import { STATE_DB_PATH } from "../lib/config.ts";

export class StateDbOpenError extends S.TaggedError<StateDbOpenError>()("StateDbOpenError", {
  path: S.String,
  message: S.String,
}) {}

// ---------------------------------------------------------------------------
// Service
//
// Opens the SQLite state database and fails clearly if its configured path is
// inaccessible. Remote CLI commands use InfraClient and do not open this DB.
// ---------------------------------------------------------------------------

const openDb = Effect.try({
  try: () => {
    const db = new Database(STATE_DB_PATH, { create: true });
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA foreign_keys=ON");
    return db;
  },
  catch: (error) =>
    new StateDbOpenError({
      path: STATE_DB_PATH,
      message: `Failed to open state database at ${STATE_DB_PATH}: ${error instanceof Error ? error.message : String(error)}`,
    }),
});

export class StateDb extends Effect.Service<StateDb>()("infra/StateDb", {
  effect: Effect.gen(function* () {
    const db = yield* openDb;

    db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        name TEXT PRIMARY KEY,
        repo TEXT NOT NULL,
        promoted_stage TEXT,
        promoted_previous TEXT
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS stages (
        project TEXT NOT NULL REFERENCES projects(name) ON DELETE CASCADE,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('static', 'service')),
        ref TEXT NOT NULL,
        hash TEXT NOT NULL,
        port INTEGER,
        host TEXT NOT NULL,
        domain TEXT NOT NULL,
        deployed_at TEXT NOT NULL,
        healthcheck_path TEXT,
        PRIMARY KEY (project, name)
      )
    `);

    // The migration is idempotent; an existing column is not an application error.
    yield* Effect.try({
      try: () => db.exec(`ALTER TABLE stages ADD COLUMN healthcheck_path TEXT`),
      catch: () => undefined,
    }).pipe(Effect.ignore);

    return { db };
  }),
}) {}
