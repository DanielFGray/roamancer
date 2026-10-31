/**
 * The control-host half of `ops dev db`: a queued job that provisions an app's dev
 * databases on the app's live Postgres server, through the admin connection the
 * PostgresDatabase provider uses.
 *
 * The dev databases share the server, its memory cap and its connection slots with the live
 * databases, so every dev login is fenced: a connection limit, and per-session defaults for
 * statement and idle-transaction timeouts, work memory, and a temp-file cap that only a
 * superuser can raise.
 *
 * The job touches only databases it derives from the request (Declaration.ts), and only when
 * they are absent or owned by that dev database's owner role or migration login.
 * graphile-migrate recreates the shadow database as the migration login when the app sets no
 * databaseOwner, so that owner is reassigned to the owner role, not refused.
 */
import * as Arr from "effect/Array";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as S from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { postgresAdmin, postgresLoginRole } from "../Cartridge.ts";
import { Nomad } from "../Nomad.ts";
import { OpenBao } from "../OpenBao.ts";
import { adminConnection, postgresRoles } from "../PostgresDatabase.ts";
import {
  type PostgresAdminLayer,
  type PostgresDatabaseDeclaration,
  provisionPostgresDatabase,
  readDatabaseOwner,
  runFormatted,
} from "../PostgresProvisioning.ts";
import {
  type DevDbAction,
  type DevDbSubmit,
  databaseDeclarations,
  declarationsForDatabase,
  type DevDbRequest,
  devDatabaseNames,
  ownedDatabases,
} from "./Declaration.ts";

/** Per login: two apps' test pools fit beside the live apps' connections. */
const connectionLimit = 8;
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

/** The job body: the action against the app's Postgres server. */
export const devDbJob = Effect.fn("devdb.job")(function* (submit: DevDbSubmit) {
  const openBao = yield* OpenBao;
  const nomad = yield* Nomad;
  const { adminLayer } = yield* adminConnection({ props: postgresAdmin({}), openBao, nomad });
  yield* runDevDbAction(submit.request, submit.action, adminLayer);
});

/** One action through `adminLayer`; the seam the integration test drives. */
export const runDevDbAction = <E, R>(
  request: DevDbRequest,
  action: DevDbAction,
  adminLayer: PostgresAdminLayer<E, R>,
) =>
  Match.value(action).pipe(
    Match.tagsExhaustive({
      Up: () => provisionAll(request, databaseDeclarations(request), adminLayer),
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

const provisionAll = Effect.fn("devdb.provisionAll")(function* <E, R>(
  request: DevDbRequest,
  declarations: ReadonlyArray<PostgresDatabaseDeclaration>,
  adminLayer: PostgresAdminLayer<E, R>,
) {
  yield* Effect.forEach(declarations, (declaration) =>
    claim(request, declaration.name).pipe(
      Effect.provide(adminLayer("postgres")),
      Effect.andThen(provisionPostgresDatabase(declaration, adminLayer)),
    ),
  );
  yield* fenceLogins(request).pipe(Effect.provide(adminLayer("postgres")));
  yield* Console.log(
    `provisioned ${declarations.map((declaration) => declaration.name).join(", ")}`,
  );
});

/** The roles that may own one derived database: the dev owner role and the migration login. */
const devOwners = (request: DevDbRequest, database: string) =>
  Arr.findFirst(request.postgres, (entry) =>
    Object.values(devDatabaseNames(request.app, entry.database)).includes(database),
  ).pipe(
    Option.map((entry) => {
      const live = devDatabaseNames(request.app, entry.database).live;
      return { owner: postgresRoles(live).owner, migration: postgresLoginRole(live, "migration") };
    }),
  );

/**
 * Makes `database` safe to provision: absent, or owned by its dev owner role. A database the
 * migration login owns is handed to the owner role; any other owner is refused.
 */
const claim = Effect.fn("devdb.claim")(function* (request: DevDbRequest, database: string) {
  const sql = yield* SqlClient.SqlClient;
  const owners = yield* Option.match(devOwners(request, database), {
    onNone: () =>
      Effect.fail(new DevDbUnknownDatabase({ database, owned: ownedDatabases(request) })),
    onSome: Effect.succeed,
  });
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
