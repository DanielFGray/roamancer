/**
 * The control-host half of `ops dev db`: a queued job that provisions an app's dev
 * databases on the dev Postgres server (DevServer.ts), through the admin connection the
 * PostgresDatabase provider uses.
 *
 * Every app's dev databases share that server, its memory limit and its connection slots, so
 * every dev login is fenced: a connection limit, and per-session defaults for statement and
 * idle-transaction timeouts, work memory, and a temp-file cap that only a superuser can raise.
 *
 * The job touches only databases it derives from the request (Declaration.ts), and only when
 * they are absent or owned by that dev database's owner role or migration login.
 * graphile-migrate recreates the shadow database as the migration login when the app sets no
 * databaseOwner, so that owner is reassigned to the owner role, not refused.
 */
import * as Arr from "effect/Array";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as S from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { postgresAdmin, postgresLoginRole } from "../Cartridge.ts";
import { Nomad } from "../Nomad.ts";
import { OpenBao } from "../OpenBao.ts";
import { adminConnection, postgresRoles } from "../PostgresDatabase.ts";
import { devServer } from "./DevServer.ts";
import {
  type PostgresAdminLayer,
  type PostgresDatabaseDeclaration,
  provisionPostgresDatabase,
  readDatabaseOwner,
  runFormatted,
} from "../PostgresProvisioning.ts";
import {
  type DevDbAction,
  type DevDbClusterAction,
  type DevDbClusterSubmit,
  DevDbMarker,
  type DevDbSubmit,
  databaseDeclarations,
  declarationsForDatabase,
  type DevDbRequest,
  devDatabaseNames,
  devLoginRoles,
  entryDatabases,
  markedDevDatabase,
  ownedDatabases,
} from "./Declaration.ts";

/**
 * Per login. Every checkout and agent of an app shares its two logins, and the test, shadow and
 * root URLs all use the migration login. One rfchat test run takes 8 connections, so 32 lets
 * about three agents test one app at once, with room for migrations.
 */
const connectionLimit = 32;
const sessionDefaults = [
  ["statement_timeout", "5min"],
  ["idle_in_transaction_session_timeout", "5min"],
  ["work_mem", "4MB"],
  ["maintenance_work_mem", "32MB"],
  ["temp_file_limit", "1GB"],
] as const;

/** Refused: a database the job derived exists under an owner no dev role is. */
export class DevDbRefused extends S.TaggedError<DevDbRefused>()("DevDbRefused", {
  database: S.String,
  owner: S.String,
}) {
  override get message() {
    return `database '${this.database}' is owned by '${this.owner}', not by its dev roles; ops dev db leaves it alone`;
  }
}

/** Refused: `reset` named a database the request does not own. */
export class DevDbUnknownDatabase extends S.TaggedError<DevDbUnknownDatabase>()(
  "DevDbUnknownDatabase",
  { database: S.String, owned: S.Array(S.String) },
) {
  override get message() {
    return `'${this.database}' is not a dev database of this app; it owns ${this.owned.join(", ")}`;
  }
}

/** The job body: the action against the dev Postgres server. */
export const devDbJob = Effect.fn("devdb.job")(function* (submit: DevDbSubmit) {
  yield* runDevDbAction(submit.request, submit.action, yield* devServerAdminLayer);
});

/** The job body of an action on every app's dev databases. */
export const devDbClusterJob = Effect.fn("devdb.clusterJob")(function* (
  submit: DevDbClusterSubmit,
) {
  yield* runDevDbClusterAction(submit.action, yield* devServerAdminLayer);
});

const devServerAdminLayer = Effect.gen(function* () {
  const openBao = yield* OpenBao;
  const nomad = yield* Nomad;
  const server = (yield* devServer()).name;
  return (yield* adminConnection({ props: postgresAdmin({ server }), openBao, nomad })).adminLayer;
});

/** One action through `adminLayer`; the seam the integration test drives. */
export const runDevDbAction = <E, R>(
  request: DevDbRequest,
  action: DevDbAction,
  adminLayer: PostgresAdminLayer<E, R>,
) =>
  Match.value(action).pipe(
    Match.tagsExhaustive({
      Up: () =>
        provisionAll(request, databaseDeclarations(request), adminLayer).pipe(
          Effect.andThen(reportUndeclared(request).pipe(Effect.provide(adminLayer("postgres")))),
        ),
      Reset: ({ database }) =>
        Option.match(declarationsForDatabase(request, database), {
          onNone: () =>
            Effect.fail(new DevDbUnknownDatabase({ database, owned: ownedDatabases(request) })),
          onSome: (declarations) =>
            Effect.forEach(declarations, (declaration) =>
              dropDatabase(request, declaration.name).pipe(Effect.provide(adminLayer("postgres"))),
            ).pipe(Effect.andThen(provisionAll(request, declarations, adminLayer))),
        }),
      List: () => listDatabases(request).pipe(Effect.provide(adminLayer("postgres"))),
    }),
  );

/** One action on every app's marked dev databases, through `adminLayer`. */
export const runDevDbClusterAction = <E, R>(
  action: DevDbClusterAction,
  adminLayer: PostgresAdminLayer<E, R>,
) =>
  Match.value(action).pipe(
    Match.tagsExhaustive({
      Stale: () => listStale().pipe(Effect.provide(adminLayer("postgres"))),
      Drop: (drop) => dropMarked(drop).pipe(Effect.provide(adminLayer("postgres"))),
    }),
  );

const provisionAll = Effect.fn("devdb.provisionAll")(function* <E, R>(
  request: DevDbRequest,
  declarations: ReadonlyArray<PostgresDatabaseDeclaration>,
  adminLayer: PostgresAdminLayer<E, R>,
) {
  yield* Effect.forEach(declarations, (declaration) =>
    claim(request, declaration.name).pipe(
      Effect.provide(adminLayer("postgres")),
      Effect.andThen(provisionPostgresDatabase(declaration, adminLayer)),
      Effect.andThen(mark(request, declaration.name).pipe(Effect.provide(adminLayer("postgres")))),
    ),
  );
  yield* fenceLogins(request).pipe(Effect.provide(adminLayer("postgres")));
  const names = declarations.map((declaration) => declaration.name);
  yield* Console.log("provisioned:");
  yield* Effect.forEach(
    request.postgres.flatMap((entry) => {
      const derived = devDatabaseNames(request.app, entry.database);
      if (!names.includes(derived.live)) {
        return Object.values(derived).filter((name) => names.includes(name));
      }
      const copies = (["shadow", "test"] as const)
        .filter((target) => names.includes(derived[target]))
        .map((target) => `_${target}`);
      return [
        copies.length === 0 ? derived.live : `${derived.live} (with ${copies.join(" and ")})`,
      ];
    }),
    (line) => Console.log(`  ${line}`),
  );
});

/** The request's entry that derives the dev database `database`. */
const entryFor = (request: DevDbRequest, database: string) =>
  Option.match(
    Arr.findFirst(request.postgres, (entry) => entryDatabases(request, entry).includes(database)),
    {
      onNone: () =>
        Effect.fail(new DevDbUnknownDatabase({ database, owned: ownedDatabases(request) })),
      onSome: Effect.succeed,
    },
  );

/**
 * Makes `database` safe to provision: absent, or owned by its dev owner role. A database the
 * migration login owns is handed to the owner role; any other owner is refused.
 */
const claim = Effect.fn("devdb.claim")(function* (request: DevDbRequest, database: string) {
  const sql = yield* SqlClient.SqlClient;
  const live = devDatabaseNames(request.app, (yield* entryFor(request, database)).database).live;
  const owners = {
    owner: postgresRoles(live).owner,
    migration: postgresLoginRole(live, "migration"),
  };
  const current = yield* readDatabaseOwner(database);
  yield* Option.match(current, {
    onNone: () => Effect.void,
    onSome: (owner) =>
      owner === owners.owner
        ? Effect.void
        : owner === owners.migration
          ? sql`ALTER DATABASE ${sql(database)} OWNER TO ${sql(owners.owner)}`.pipe(Effect.asVoid)
          : Effect.fail(new DevDbRefused({ database, owner })),
  });
});

const dropDatabase = Effect.fn("devdb.dropDatabase")(function* (
  request: DevDbRequest,
  database: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* claim(request, database);
  yield* sql`DROP DATABASE IF EXISTS ${sql(database)} WITH (FORCE)`;
});

/**
 * Sets each login's password from the workstation's verifier on every run, because the
 * workstation's password file is the source of truth, then its connection limit and session
 * defaults.
 */
const fenceLogins = Effect.fn("devdb.fenceLogins")(function* (request: DevDbRequest) {
  const sql = yield* SqlClient.SqlClient;
  const logins = request.postgres.flatMap((entry) => {
    const live = devDatabaseNames(request.app, entry.database).live;
    return [
      [postgresLoginRole(live, "api"), entry.logins.api],
      [postgresLoginRole(live, "migration"), entry.logins.migration],
    ] as const;
  });
  yield* Effect.forEach(logins, ([role, verifier]) =>
    Effect.gen(function* () {
      yield* runFormatted(sql, "ALTER ROLE %I PASSWORD %L", [role, verifier], "set password", role);
      yield* sql`ALTER ROLE ${sql(role)} CONNECTION LIMIT ${sql.literal(String(connectionLimit))}`;
      yield* Effect.forEach(
        sessionDefaults,
        ([setting, value]) =>
          sql`ALTER ROLE ${sql(role)} SET ${sql.literal(setting)} = ${sql.literal(`'${value}'`)}`,
      );
    }),
  );
});

const listDatabases = Effect.fn("devdb.listDatabases")(function* (request: DevDbRequest) {
  const sql = yield* SqlClient.SqlClient;
  const owned = ownedDatabases(request);
  const rows = yield* sql<{ readonly name: string; readonly owner: string }>`
    SELECT datname AS name, pg_get_userbyid(datdba) AS owner
    FROM pg_database WHERE datname IN ${sql.in(owned)} ORDER BY datname
  `;
  if (rows.length === 0) return yield* Console.log(`No dev databases of '${request.app}' yet.`);
  yield* Effect.forEach(rows, (row) => Console.log(`${row.name}\t${row.owner}`));
});

/** Writes the marker that names `database`'s app and cartridge database, dated now. */
const mark = Effect.fn("devdb.mark")(function* (request: DevDbRequest, database: string) {
  const sql = yield* SqlClient.SqlClient;
  const entry = yield* entryFor(request, database);
  const lastUp = DateTime.formatIso(yield* DateTime.now);
  const comment = yield* encodeMarker({
    opsDevDb: { app: request.app, database: entry.database, lastUp },
  });
  yield* runFormatted(
    sql,
    "COMMENT ON DATABASE %I IS %L",
    [database, comment],
    "mark dev database",
    database,
  );
});

const encodeMarker = S.encodeEffect(S.fromJsonString(DevDbMarker));
const decodeMarker = S.decodeUnknownOption(S.fromJsonString(DevDbMarker));

/**
 * Every dev database on the server whose marker it can trust: the marker parses, derives the
 * database's name, and names a role that may own it. A comment that only looks like a marker
 * is ignored, so no action touches a database it does not derive.
 */
const readMarked = Effect.fn("devdb.readMarked")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly name: string;
    readonly owner: string;
    readonly comment: string;
    readonly size: string;
  }>`
    SELECT d.datname AS name, pg_get_userbyid(d.datdba) AS owner,
           shobj_description(d.oid, 'pg_database') AS comment,
           pg_database_size(d.oid)::text AS size
    FROM pg_database d
    WHERE shobj_description(d.oid, 'pg_database') IS NOT NULL
    ORDER BY d.datname
  `;
  return rows.flatMap((row) =>
    decodeMarker(row.comment).pipe(
      Option.flatMap((marker) =>
        markedDevDatabase(row.name, marker).pipe(
          Option.filter(({ owners }) => owners.includes(row.owner)),
          Option.map(({ live }) => ({
            name: row.name,
            live,
            ...marker.opsDevDb,
            sizeBytes: Number(row.size),
          })),
        ),
      ),
      Option.toArray,
    ),
  );
});

/** After `up`: the app's marked dev databases that cartridge.json no longer declares. */
const reportUndeclared = Effect.fn("devdb.reportUndeclared")(function* (request: DevDbRequest) {
  const owned = ownedDatabases(request);
  const undeclared = (yield* readMarked()).filter(
    (marked) => marked.app === request.app && !owned.includes(marked.name),
  );
  if (undeclared.length === 0) return;
  yield* Console.log("not in cartridge.json any more; this drops them:");
  yield* Console.log(
    `  ops dev db drop ${request.app} ${undeclared.map((marked) => marked.name).join(" ")}`,
  );
});

/** Each app with marked dev databases, the one `up` reached least recently first. */
const listStale = Effect.fn("devdb.listStale")(function* () {
  const marked = yield* readMarked();
  if (marked.length === 0) return yield* Console.log("No marked dev databases.");
  const apps = Object.entries(Arr.groupBy(marked, (database) => database.app)).map(
    ([app, databases]) => ({
      app,
      count: databases.length,
      megabytes: Math.round(
        databases.reduce((total, database) => total + database.sizeBytes, 0) / 1048576,
      ),
      lastUp: databases.reduce(
        (latest, database) => (database.lastUp > latest ? database.lastUp : latest),
        "",
      ),
    }),
  );
  yield* Console.log("last up (UTC)\tapp\tdatabases\tsize");
  yield* Effect.forEach(
    Arr.sort(
      apps,
      Order.mapInput(Order.String, (app: (typeof apps)[number]) => app.lastUp),
    ),
    (app) =>
      Console.log(
        `${app.lastUp.slice(0, 16).replace("T", " ")}\t${app.app}\t${app.count}\t${app.megabytes} MB`,
      ),
  );
});

/**
 * Drops the app's marked dev databases that `drop` names, or all of them when it names none,
 * then the roles of each dev database none of whose marked databases remain: its two logins
 * and its owner and visitor roles. A name that is no marked dev database of the app fails
 * the action before anything is dropped. An unmarked database still owned by a role makes
 * that role's drop fail, and the error names it.
 */
const dropMarked = Effect.fn("devdb.dropMarked")(function* (
  drop: Extract<DevDbClusterAction, { readonly _tag: "Drop" }>,
) {
  const sql = yield* SqlClient.SqlClient;
  const marked = (yield* readMarked()).filter((database) => database.app === drop.app);
  const names = marked.map((database) => database.name);
  yield* Effect.forEach(drop.databases, (database) =>
    names.includes(database)
      ? Effect.void
      : Effect.fail(new DevDbUnknownDatabase({ database, owned: names })),
  );
  const targets =
    drop.databases.length === 0
      ? marked
      : marked.filter((database) => drop.databases.includes(database.name));
  if (targets.length === 0) {
    return yield* Console.log(`No marked dev databases of '${drop.app}'.`);
  }
  yield* Effect.forEach(targets, (target) =>
    sql`DROP DATABASE IF EXISTS ${sql(target.name)} WITH (FORCE)`.pipe(
      Effect.andThen(Console.log(`dropped ${target.name}`)),
    ),
  );
  const remaining = marked.filter((database) => !targets.includes(database));
  const emptied = Arr.dedupe(targets.map((target) => target.live)).filter(
    (live) => !remaining.some((database) => database.live === live),
  );
  yield* Effect.forEach(emptied, (live) =>
    Effect.forEach(
      [...devLoginRoles(live), postgresRoles(live).owner, postgresRoles(live).visitor],
      (role) => sql`DROP ROLE IF EXISTS ${sql(role)}`,
    ),
  );
});
