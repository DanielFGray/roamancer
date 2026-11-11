/**
 * The control-host half of `ops db query`: one SQL statement against a database of a deployed
 * stage, as a new login of that database's migration credential role, which joins its owner
 * role. The statement runs in a transaction Postgres holds read-only, and the job rolls it back.
 *
 * Postgres enforces the guarantee; nothing checks the SQL text. It rests on three facts:
 * - BEGIN READ ONLY, the statement and ROLLBACK run on one reserved connection;
 * - the statement goes through the extended query protocol, which refuses a string of more
 *   than one statement, so `COMMIT; INSERT ...` cannot end the transaction and then write;
 * - the login is no superuser, so the statement cannot SET ROLE out of the owner role.
 * Read-only stops changes to data and schema. It does not stop a function whose effect lies
 * outside the transaction, such as pg_terminate_backend or pg_advisory_lock.
 */
import * as Arr from "effect/Array";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as S from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as Cartridge from "./Cartridge.ts";
import { Nomad } from "./Nomad.ts";
import { OpenBao } from "./OpenBao.ts";
import * as Package from "./Package.ts";
import { loginCredentialPath, serverLocation } from "./PostgresDatabase.ts";
import type { DbQuerySubmit } from "./queue/Schema.ts";

/** A statement or a lock wait longer than these is cancelled; the job runs against live data. */
const statementTimeout = "1min";
const lockTimeout = "5s";

export class DbQueryError extends S.TaggedError<DbQueryError>()("DbQueryError", {
  message: S.String,
}) {}

/** The job body: print each result row as one JSON object per line. */
export const dbQueryJob = Effect.fn("DbQuery.job")(function* (submit: DbQuerySubmit) {
  const entries = yield* stageDatabases(submit.stage);
  const entry = yield* chooseDatabase(submit.stage, entries, submit.database);
  const location = yield* serverLocation(Cartridge.postgresAdmin(entry).server, yield* Nomad);
  const role = Cartridge.postgresLoginRole(entry.database, "migration");
  const login = yield* (yield* OpenBao).postgresLogin(loginCredentialPath(role)).pipe(
    Effect.mapError(
      () =>
        new DbQueryError({
          message: `OpenBao gave no login for ${role}; is ${submit.stage}'s database '${entry.database}' deployed?`,
        }),
    ),
  );
  const rows = yield* runReadOnly(submit.sql).pipe(
    Effect.provide(
      PgClient.layerFrom(
        PgClient.makeClient({
          host: location.Address,
          port: location.Port,
          database: entry.database,
          username: login.username,
          password: login.password,
          applicationName: "ops-db-query",
        }),
      ),
    ),
  );
  yield* Effect.forEach(rows, (row) => Console.log(renderRow(row)), { discard: true });
  yield* Console.error(`(${rows.length} ${rows.length === 1 ? "row" : "rows"})`);
}, Effect.scoped);

/** One row as one JSON line. The driver returns int8, such as count(*), as a bigint. */
export const renderRow = (row: object) =>
  JSON.stringify(row, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );

/**
 * The databases `stage` declares. A staged copy (`<app>-staged`) has no cartridge of its own:
 * the stack derives it from the app's at deploy time (alchemy.run.ts), so its databases are
 * the app's under the copy's names, never the live ones.
 */
const stageDatabases = (stage: string) =>
  Option.match(Cartridge.baseName(stage), {
    onNone: () =>
      Effect.map(Cartridge.resolve(Package.root, stage), (cartridge) => cartridge.postgres),
    onSome: (app) =>
      Effect.map(Cartridge.resolve(Package.root, app), (cartridge) =>
        cartridge.postgres.map((entry) => ({
          ...entry,
          database: Cartridge.instanceDatabaseName(app, "staged", entry.database),
        })),
      ),
  });

/** Run `statement` read-only and roll it back; the seam the integration test drives. */
export const runReadOnly = Effect.fn("DbQuery.runReadOnly")(
  function* (statement: string) {
    const connection = yield* (yield* SqlClient.SqlClient).reserve;
    const run = (text: string) => connection.executeUnprepared(text, [], undefined);
    yield* run("BEGIN READ ONLY");
    return yield* Effect.gen(function* () {
      yield* run(`SET LOCAL statement_timeout = '${statementTimeout}'`);
      yield* run(`SET LOCAL lock_timeout = '${lockTimeout}'`);
      return yield* run(statement);
    }).pipe(Effect.ensuring(Effect.ignore(run("ROLLBACK"))));
  },
  Effect.mapError((error) => new DbQueryError({ message: postgresMessage(error) })),
  Effect.scoped,
);

const chooseDatabase = (
  stage: string,
  entries: ReadonlyArray<Cartridge.PostgresEntry>,
  database: string | null,
) => {
  const names = entries.map((entry) => entry.database).join(", ");
  if (database !== null) {
    return Option.match(
      Arr.findFirst(entries, (entry) => entry.database === database),
      {
        onNone: () =>
          Effect.fail(
            new DbQueryError({
              message: `${stage} declares no database '${database}'; it declares: ${names || "none"}`,
            }),
          ),
        onSome: Effect.succeed,
      },
    );
  }
  const [only, ...rest] = entries;
  if (only !== undefined && rest.length === 0) return Effect.succeed(only);
  return Effect.fail(
    new DbQueryError({
      message:
        only === undefined
          ? `${stage} declares no database`
          : `${stage} declares ${entries.length} databases (${names}); pass --database`,
    }),
  );
};

/** The fields of a Postgres error that tell the operator what the statement did wrong. */
const PostgresNotice = S.Struct({
  message: S.String,
  code: S.optional(S.String),
  detail: S.optional(S.String),
  hint: S.optional(S.String),
  position: S.optional(S.String),
});

const postgresMessage = (error: SqlError.SqlError) =>
  Option.match(S.decodeUnknownOption(PostgresNotice)(error.reason.cause), {
    onNone: () => error.message,
    onSome: (notice) =>
      [
        `${notice.message}${notice.code === undefined ? "" : ` (SQLSTATE ${notice.code})`}`,
        notice.position === undefined ? "" : `at character ${notice.position}`,
        notice.detail ?? "",
        notice.hint === undefined ? "" : `hint: ${notice.hint}`,
      ]
        .filter((line) => line !== "")
        .join("\n"),
  });
