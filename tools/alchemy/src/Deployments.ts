/**
 * The record of each app deployment on the control host: which cartridge, with its image
 * digests already pinned, from which repository and commit. An app's cartridge lives in
 * the app's own repository, so this record is the host's only copy of what each app runs.
 * Plans, drift checks and secret checks read the newest record; a rollback re-applies an
 * older one. The table shares Alchemy's operation journal file, so one backup covers both
 * (nixos/backup-operations.md).
 */
import * as path from "node:path";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { SqliteClient } from "@effect/sql-sqlite-node";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as S from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

export const Deployment = S.Struct({
  id: S.Number,
  name: S.String,
  // The repository's root commit: it names the repository whatever its remotes are called.
  origin: S.String,
  revision: S.String,
  cartridge: S.String,
  deployedAt: S.String,
  // The signoff a reconcile release rested on; null for a release recorded before releases needed one.
  signoff: S.NullOr(S.Number),
});
export type Deployment = typeof Deployment.Type;

/** Refused when a name already deployed from one repository is deployed from another. */
export class OriginMismatch extends S.TaggedError<OriginMismatch>()("OriginMismatch", {
  name: S.String,
  recorded: S.String,
  offered: S.String,
}) {
  override get message() {
    return `'${this.name}' was first deployed from the repository with root commit ${this.recorded}; this cartridge comes from ${this.offered}. An app name belongs to one repository.`;
  }
}

type DeploymentsError = SqlError.SqlError | S.SchemaError;

export class Deployments extends Context.Service<
  Deployments,
  {
    /** Newest first. */
    readonly list: (name: string) => Effect.Effect<ReadonlyArray<Deployment>, DeploymentsError>;
    readonly latest: (name: string) => Effect.Effect<Option.Option<Deployment>, DeploymentsError>;
    /** The newest deployment of every recorded app. */
    readonly newest: () => Effect.Effect<ReadonlyArray<Deployment>, DeploymentsError>;
    readonly get: (
      name: string,
      id: number,
    ) => Effect.Effect<Option.Option<Deployment>, DeploymentsError>;
    /** Fails unless `origin` is the repository the name was first deployed from. */
    readonly checkOrigin: (
      name: string,
      origin: string,
    ) => Effect.Effect<void, DeploymentsError | OriginMismatch>;
    readonly record: (
      deployment: Omit<Deployment, "id" | "deployedAt" | "signoff"> & {
        readonly signoff?: number | null;
      },
    ) => Effect.Effect<Deployment, DeploymentsError | OriginMismatch>;
  }
>()("alchemy/Deployments") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS deployments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    origin TEXT NOT NULL,
    revision TEXT NOT NULL,
    cartridge TEXT NOT NULL,
    deployed_at TEXT NOT NULL
  )`;
  // A table made before releases recorded their signoff lacks the column.
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(deployments)`;
  if (!columns.some((column) => column.name === "signoff")) {
    yield* sql`ALTER TABLE deployments ADD COLUMN signoff INTEGER`;
  }
  const rows = S.decodeUnknownEffect(S.Array(Deployment));
  const select = (where: ReturnType<typeof sql.and>) =>
    sql`SELECT id, name, origin, revision, cartridge, deployed_at AS "deployedAt", signoff
        FROM deployments WHERE ${where} ORDER BY id DESC`.pipe(Effect.flatMap(rows));

  const list = (name: string) => select(sql.and([sql`name = ${name}`]));
  const latest = (name: string) =>
    list(name).pipe(Effect.map((all) => Option.fromNullishOr(all[0])));
  const checkOrigin = Effect.fn("Deployments.checkOrigin")(function* (
    name: string,
    origin: string,
  ) {
    const first = (yield* list(name)).at(-1);
    if (first !== undefined && first.origin !== origin) {
      return yield* new OriginMismatch({ name, recorded: first.origin, offered: origin });
    }
  });

  return Deployments.of({
    list,
    latest,
    newest: () => select(sql.and([sql`id IN (SELECT MAX(id) FROM deployments GROUP BY name)`])),
    get: (name, id) =>
      select(sql.and([sql`name = ${name}`, sql`id = ${id}`])).pipe(
        Effect.map((found) => Option.fromNullishOr(found[0])),
      ),
    checkOrigin,
    record: Effect.fn("Deployments.record")(function* (deployment) {
      yield* checkOrigin(deployment.name, deployment.origin);
      const deployedAt = new Date(
        yield* Effect.clockWith((clock) => Effect.succeed(clock.currentTimeMillisUnsafe())),
      ).toISOString();
      yield* sql`INSERT INTO deployments ${sql.insert({
        name: deployment.name,
        origin: deployment.origin,
        revision: deployment.revision,
        cartridge: deployment.cartridge,
        deployed_at: deployedAt,
        signoff: deployment.signoff ?? null,
      })}`;
      return Option.getOrThrow(yield* latest(deployment.name));
    }),
  });
});

/** Deployments in the operation journal's file. */
export const layer = (filename = ".alchemy/operations.sqlite") =>
  Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(path.dirname(filename), { recursive: true });
      return Layer.effect(Deployments, make).pipe(Layer.provide(SqliteClient.layer({ filename })));
    }),
  ).pipe(Layer.provide(NodeFileSystem.layer));
