import { Effect, Schema as S } from "effect";
import { StateDb } from "./StateDb.ts";
import { PORT_RANGE_START } from "../lib/config.ts";

// ---------------------------------------------------------------------------
// Schemas (unchanged — callers depend on these shapes)
// ---------------------------------------------------------------------------

export const StageInfo = S.Struct({
  type: S.Literal("static", "service"),
  ref: S.String,
  hash: S.String,
  port: S.NullOr(S.Number),
  host: S.String,
  domain: S.String,
  deployed_at: S.String,
  healthcheck_path: S.optional(S.String),
});

export const ProjectMeta = S.Struct({
  repo: S.String,
  promoted: S.NullOr(S.String),
  promoted_previous: S.NullOr(S.String),
  stages: S.Record({ key: S.String, value: StageInfo }),
});

export type StageInfo = typeof StageInfo.Type;
export type ProjectMeta = typeof ProjectMeta.Type;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class DeployMetaError extends S.TaggedError<DeployMetaError>()("DeployMetaError", {
  message: S.String,
}) {}

export type DeployMetaErr = DeployMetaError;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class DeployMeta extends Effect.Service<DeployMeta>()("infra/DeployMeta", {
  effect: Effect.gen(function* () {
    const { db } = yield* StateDb;

    const getStmt = db.prepare(`SELECT * FROM projects WHERE name = ?`);
    const stagesStmt = db.prepare(`SELECT * FROM stages WHERE project = ?`);
    const listStmt = db.prepare(`SELECT name FROM projects`);
    const deleteStmt = db.prepare(`DELETE FROM projects WHERE name = ?`);
    const upsertProject = db.prepare(`
        INSERT INTO projects (name, repo, promoted_stage, promoted_previous)
        VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT(name) DO UPDATE SET
          repo = ?2, promoted_stage = ?3, promoted_previous = ?4
      `);
    const deleteStages = db.prepare(`DELETE FROM stages WHERE project = ?`);
    const insertStage = db.prepare(`
        INSERT INTO stages (project, name, type, ref, hash, port, host, domain, deployed_at, healthcheck_path)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
      `);
    const usedPortsStmt = db.prepare(
      `SELECT port FROM stages WHERE port IS NOT NULL ORDER BY port`,
    );

    return {
      getProject: (name: string) =>
        Effect.sync(() => {
          const row = getStmt.get(name) as {
            name: string;
            repo: string;
            promoted_stage: string | null;
            promoted_previous: string | null;
          } | null;
          if (!row) return null;

          const stageRows = stagesStmt.all(name) as Array<{
            project: string;
            name: string;
            type: "static" | "service";
            ref: string;
            hash: string;
            port: number | null;
            host: string;
            domain: string;
            deployed_at: string;
            healthcheck_path: string | null;
          }>;

          const stages: Record<string, StageInfo> = {};
          for (const s of stageRows) {
            stages[s.name] = {
              type: s.type,
              ref: s.ref,
              hash: s.hash,
              port: s.port,
              host: s.host,
              domain: s.domain,
              deployed_at: s.deployed_at,
              ...(s.healthcheck_path ? { healthcheck_path: s.healthcheck_path } : {}),
            };
          }

          return {
            repo: row.repo,
            promoted: row.promoted_stage,
            promoted_previous: row.promoted_previous,
            stages,
          } satisfies ProjectMeta;
        }),

      saveProject: (name: string, meta: ProjectMeta) =>
        Effect.sync(() => {
          db.transaction(() => {
            upsertProject.run(name, meta.repo, meta.promoted, meta.promoted_previous);
            deleteStages.run(name);
            for (const [stageName, info] of Object.entries(meta.stages)) {
              insertStage.run(
                name,
                stageName,
                info.type,
                info.ref,
                info.hash,
                info.port,
                info.host,
                info.domain,
                info.deployed_at,
                info.healthcheck_path ?? null,
              );
            }
          })();
        }),

      listProjects: () =>
        Effect.sync(() => {
          const rows = listStmt.all() as Array<{ name: string }>;
          return rows.map((r) => r.name);
        }),

      deleteProject: (name: string) =>
        Effect.sync(() => {
          deleteStmt.run(name);
        }),

      allocatePort: () =>
        Effect.try({
          try: () => {
            const PORT_MAX = 65535;
            const usedRows = usedPortsStmt.all() as Array<{ port: number }>;
            const used = new Set(usedRows.map((r) => r.port));

            let port = PORT_RANGE_START;
            while (used.has(port)) port++;
            return port <= PORT_MAX ? port : null;
          },
          catch: (error) =>
            new DeployMetaError({
              message: `Failed to allocate port: ${error instanceof Error ? error.message : String(error)}`,
            }),
        }).pipe(
          Effect.flatMap((port) =>
            port === null
              ? Effect.fail(
                  new DeployMetaError({
                    message: `No available ports (all ${PORT_RANGE_START}-65535 in use)`,
                  }),
                )
              : Effect.succeed(port),
          ),
        ),

      releasePort: (_port: number) => Effect.void,
    };
  }),
  dependencies: [StateDb.Default],
}) {}
