import { Effect } from "effect"
import { Database } from "bun:sqlite"
import { STATE_DB_PATH } from "../lib/config.ts"

// ---------------------------------------------------------------------------
// Service
//
// Opens the SQLite state database. If the path is inaccessible (e.g. running
// the CLI remotely), creates an in-memory stub so HTTP-only commands still
// work. Direct/local commands that need the DB will fail with clear errors.
// ---------------------------------------------------------------------------

const openDb = () => {
  try {
    const db = new Database(STATE_DB_PATH, { create: true })
    db.exec("PRAGMA journal_mode=WAL")
    db.exec("PRAGMA foreign_keys=ON")
    return db
  } catch {
    // Fall back to in-memory DB for remote CLI usage
    return new Database(":memory:")
  }
}

export class StateDb extends Effect.Service<StateDb>()("infra/StateDb", {
  effect: Effect.sync(() => {
    const db = openDb()

    db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        name TEXT PRIMARY KEY,
        repo TEXT NOT NULL,
        promoted_stage TEXT,
        promoted_previous TEXT
      )
    `)

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
    `)

    // Migration: add healthcheck_path if missing (existing databases)
    try {
      db.exec(`ALTER TABLE stages ADD COLUMN healthcheck_path TEXT`)
    } catch {
      // column already exists
    }

    return { db }
  }),
}) {}
