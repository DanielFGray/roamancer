import * as Alchemy from "alchemy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Arr from "effect/Array";
import * as Equal from "effect/Equal";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as S from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as PgClient from "@effect/sql-pg/PgClient";
import { ChildProcess } from "effect/process";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import * as Stream from "effect/Stream";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { objectRestoreList, roleRestoreList, remapRoles } from "./RestoreList.ts";
import { KvSecretReference } from "./Job.ts";
import { Nomad } from "./Nomad.ts";
import { OpenBao } from "./OpenBao.ts";
import { OperationJournal } from "./OperationJournal.ts";
import {
  createDatabase,
  ensureDatabaseRoles,
  ensureExtensions,
  lockDatabase,
  provisionPostgresDatabase,
  PostgresProvisioningError,
  readDatabaseOwner,
  type PostgresDatabaseDeclaration,
} from "./PostgresProvisioning.ts";
import { dependencyRegistrationRetry, firstServiceLocation } from "./ServiceRegistration.ts";

const DatabaseIdentifier = S.String.check(S.isPattern(/^[a-z][a-z0-9_]{0,62}$/));
const ResourceName = S.String.check(S.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/));
const EngineName = S.String.check(S.isPattern(/^alchemy_[a-z][a-z0-9_]{0,54}$/));
const CredentialRoleName = S.String.check(S.isPattern(/^alchemy_[a-z][a-z0-9_]{0,54}$/));
export const ExtensionName = S.String.check(S.isPattern(/^[a-z][a-z0-9_-]{0,62}$/));

export const PostgresDatabaseProps = S.Struct({
  name: DatabaseIdentifier,
  server: ResourceName,
  extensions: S.Array(ExtensionName),
  adminUsername: DatabaseIdentifier,
  adminCredential: KvSecretReference,
  // Owns the database and its tables. Its members run migrations.
  ownerRole: DatabaseIdentifier,
  // Holds the grants that application SQL uses. The API login switches to it with SET ROLE.
  visitorRole: DatabaseIdentifier,
  connectionName: EngineName,
  // The API login. It joins the visitor role and does not inherit its rights.
  credentialRole: CredentialRoleName,
  // The migration login. It joins the owner role.
  migrationCredentialRole: CredentialRoleName,
  // When set, the database is created as a copy of this live database.
  copyFrom: S.optional(DatabaseIdentifier),
  defaultTtl: S.String.check(S.isPattern(/^[1-9][0-9]*(s|m|h)$/)),
  maxTtl: S.String.check(S.isPattern(/^[1-9][0-9]*(s|m|h)$/)),
});
export type PostgresDatabaseProps = typeof PostgresDatabaseProps.Type;

export const postgresRoles = (database: string) => ({
  owner: `${database}_owner`,
  visitor: `${database}_visitor`,
});

export interface PostgresDatabase extends Alchemy.Resource<
  "Postgres.Database",
  PostgresDatabaseProps,
  {
    id: string;
    name: string;
    server: string;
    ownerRole: string;
    visitorRole: string;
    connectionName: string;
    credentialRole: string;
    credentialPath: string;
    migrationCredentialRole: string;
    migrationCredentialPath: string;
    // True when this resource created the database as a copy. Only such a database is
    // dropped on delete, so a copyFrom written into a live cartridge cannot drop live data.
    copy: boolean;
  }
> {}

export const PostgresDatabase = Alchemy.Resource<PostgresDatabase>("Postgres.Database");

export class PostgresDatabaseError extends S.TaggedError<PostgresDatabaseError>()(
  "PostgresDatabaseError",
  {
    operation: S.String,
    target: S.String,
    detail: S.optional(S.String),
  },
) {
  override get message() {
    return `${this.operation}: ${this.target}${Option.match(Option.fromNullishOr(this.detail), {
      onNone: () => "",
      onSome: (detail) => `: ${detail}`,
    })}`;
  }
}

/** Where OpenBao mints a new login of a database credential role. */
export const loginCredentialPath = (role: string) => `database/creds/${role}`;

const attributes = (id: string, props: PostgresDatabaseProps, copy: boolean) => ({
  id,
  copy,
  name: props.name,
  server: props.server,
  ownerRole: props.ownerRole,
  visitorRole: props.visitorRole,
  connectionName: props.connectionName,
  credentialRole: props.credentialRole,
  credentialPath: loginCredentialPath(props.credentialRole),
  migrationCredentialRole: props.migrationCredentialRole,
  migrationCredentialPath: loginCredentialPath(props.migrationCredentialRole),
});

const provisioningError = (error: PostgresProvisioningError) =>
  new PostgresDatabaseError({
    operation: error.operation,
    target: error.target,
    detail: error.detail,
  });

const databaseDeclaration = (props: PostgresDatabaseProps): PostgresDatabaseDeclaration => ({
  name: props.name,
  ownerRole: props.ownerRole,
  visitorRole: props.visitorRole,
  extensions: props.extensions,
  // OpenBao issues dynamic logins; the shared operation only creates logins that
  // carry a static password (ops). The provider leaves this list empty.
  logins: [],
});

/**
 * The temporary name a copy of `target` is built under: deterministic, so a retry finds the
 * leftover of an earlier failure, distinct for every target, and 45 characters long.
 */
const copyDatabaseName = Effect.fn("PostgresDatabase.copyDatabaseName")(function* (target: string) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly name: string }>`
    SELECT 'alchemy_copy_' || md5(${target}) AS name
  `.pipe(
    Effect.mapError(() => new PostgresDatabaseError({ operation: "name temporary copy", target })),
  );
  return yield* Option.match(Arr.head(rows), {
    onNone: () =>
      Effect.fail(new PostgresDatabaseError({ operation: "name temporary copy", target })),
    onSome: (row) => Effect.succeed(row.name),
  });
});

const renameDatabase = Effect.fn("PostgresDatabase.renameDatabase")(function* (
  from: string,
  to: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER DATABASE ${sql(from)} RENAME TO ${sql(to)}`.pipe(
    Effect.asVoid,
    Effect.mapError(() => new PostgresDatabaseError({ operation: "rename database", target: to })),
  );
});

const hostForConnectionUrl = (address: string) =>
  address.includes(":") ? `[${address}]` : address;

// OpenBao fills in {{username}} and {{password}} for each credential it issues.
const connectionUrl = (
  location: { readonly Address: string; readonly Port: number },
  database: string,
) =>
  `postgresql://{{username}}:{{password}}@${hostForConnectionUrl(location.Address)}:${location.Port}/${database}?sslmode=disable`;

const runStep = Effect.fn("PostgresDatabase.runStep")(function* (input: {
  readonly operation: string;
  readonly target: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
}) {
  const spawner = yield* ChildProcessSpawner;
  const handle = yield* spawner.spawn(
    ChildProcess.make(input.command, input.args, {
      env: input.env,
      // Adds the password to the inherited environment; without it the child has no PATH.
      extendEnv: true,
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  // Read both pipes at once: a child that fills one pipe while the other is being
  // drained blocks forever.
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      Stream.mkString(Stream.decodeText(handle.stdout)),
      Stream.mkString(Stream.decodeText(handle.stderr)),
      handle.exitCode,
    ],
    { concurrency: "unbounded" },
  );
  if (exitCode !== 0) {
    return yield* new PostgresDatabaseError({
      operation: input.operation,
      target: input.target,
      detail: stderr.trim(),
    });
  }
  return stdout;
}, Effect.scoped);

const dropDatabase = Effect.fn("PostgresDatabase.dropDatabase")(function* (name: string) {
  const sql = yield* SqlClient.SqlClient;
  const databases = yield* sql<{ readonly name: string }>`
    SELECT datname AS name FROM pg_database WHERE datname = ${name}
  `.pipe(
    Effect.mapError(
      () => new PostgresDatabaseError({ operation: "find database to drop", target: name }),
    ),
  );
  yield* Option.match(Arr.head(databases), {
    onNone: () => Effect.void,
    onSome: () =>
      Effect.gen(function* () {
        yield* sql`ALTER DATABASE ${sql(name)} WITH ALLOW_CONNECTIONS false`.pipe(
          Effect.asVoid,
          Effect.mapError(
            () =>
              new PostgresDatabaseError({
                operation: "disable database connections",
                target: name,
              }),
          ),
        );
        yield* sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${name}`.pipe(
          Effect.asVoid,
          Effect.mapError(
            () =>
              new PostgresDatabaseError({ operation: "terminate database sessions", target: name }),
          ),
        );
        yield* sql`DROP DATABASE IF EXISTS ${sql(name)}`.pipe(
          Effect.asVoid,
          Effect.mapError(
            () => new PostgresDatabaseError({ operation: "drop database", target: name }),
          ),
        );
      }),
  });
});

export const copyDatabase = Effect.fn("PostgresDatabase.copyDatabase")(function* (input: {
  readonly source: string;
  // The real target database: its role names drive --role and ACL remapping.
  readonly target: string;
  // The database the dump is actually restored into (a temporary name while copying).
  readonly into: string;
  readonly location: { readonly Address: string; readonly Port: number };
  readonly admin: string;
  readonly password: Redacted.Redacted<string>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tmpDir = yield* fs.makeTempDirectoryScoped();
  const dumpFile = path.join(tmpDir, "dump.fc");
  const listFile = path.join(tmpDir, "list");
  const roleBearingListFile = path.join(tmpDir, "role-bearing-list");
  const restoreFile = path.join(tmpDir, "restore.sql");
  const env = { PGPASSWORD: Redacted.value(input.password) };
  const connectionArgs = [
    "-h",
    input.location.Address,
    "-p",
    String(input.location.Port),
    "-U",
    input.admin,
  ];
  const sourceRoles = postgresRoles(input.source);
  // Refuse the copy before dumping when a function or procedure names a live role as
  // free text: such a reference cannot be renamed by the restore step.
  const roleIdentifierPattern = `\\m(${sourceRoles.owner}|${sourceRoles.visitor})\\M`;
  const functionRoleQuery = `SELECT n.nspname || '.' || p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_%' AND (p.prosrc ~ '${roleIdentifierPattern}' OR EXISTS (SELECT 1 FROM unnest(COALESCE(p.proconfig, ARRAY[]::text[])) AS c(cfg) WHERE c.cfg ~ '${roleIdentifierPattern}')) ORDER BY 1;`;
  const functionRoleMatches = yield* runStep({
    operation: "check function role references",
    target: input.source,
    command: "psql",
    args: [
      ...connectionArgs,
      "-d",
      input.source,
      "-v",
      "ON_ERROR_STOP=1",
      "-At",
      "-c",
      functionRoleQuery,
    ],
    env,
  });
  const offendingFunctions = functionRoleMatches
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (offendingFunctions.length > 0) {
    return yield* new PostgresDatabaseError({
      operation: "check function role references",
      target: input.source,
      detail: offendingFunctions.join(", "),
    });
  }
  yield* runStep({
    operation: "pg_dump",
    target: input.source,
    command: "pg_dump",
    args: ["-Fc", ...connectionArgs, "-f", dumpFile, input.source],
    env,
  });
  const listText = yield* runStep({
    operation: "pg_restore -l",
    target: input.source,
    command: "pg_restore",
    args: ["-l", dumpFile],
    env,
  });
  yield* fs.writeFileString(listFile, objectRestoreList(listText));
  yield* fs.writeFileString(roleBearingListFile, roleRestoreList(listText));
  const restSql = yield* runStep({
    operation: "pg_restore rest script",
    target: input.target,
    command: "pg_restore",
    args: [
      "--no-owner",
      `--role=${postgresRoles(input.target).owner}`,
      "-L",
      listFile,
      "-f",
      "-",
      dumpFile,
    ],
    env,
  });
  const roleBearingSql = yield* runStep({
    operation: "pg_restore role-bearing script",
    target: input.target,
    command: "pg_restore",
    args: ["-L", roleBearingListFile, "-f", "-", dumpFile],
    env,
  });
  const targetRoles = postgresRoles(input.target);
  const remappedRoleBearingSql = remapRoles(
    remapRoles(roleBearingSql, sourceRoles.owner, targetRoles.owner),
    sourceRoles.visitor,
    targetRoles.visitor,
  );
  yield* fs.writeFileString(restoreFile, `${restSql}\n${remappedRoleBearingSql}`);
  yield* runStep({
    operation: "psql restore transaction",
    target: input.into,
    command: "psql",
    args: [
      "--single-transaction",
      "-v",
      "ON_ERROR_STOP=1",
      ...connectionArgs,
      "-d",
      input.into,
      "-f",
      restoreFile,
    ],
    env,
  });
}, Effect.scoped);

/**
 * The server's address, its admin password, and a client layer for one of its databases.
 * `ops dev db` provisions developer databases through this same connection.
 */
export const adminConnection = Effect.fn("PostgresDatabase.adminConnection")(function* (input: {
  readonly props: Pick<PostgresDatabaseProps, "server" | "adminUsername" | "adminCredential">;
  readonly openBao: typeof OpenBao.Service;
  readonly nomad: typeof Nomad.Service;
}) {
  const location = yield* serverLocation(input.props.server, input.nomad);
  const password = yield* input.openBao.readKv(
    input.props.adminCredential.path,
    input.props.adminCredential.key,
  );
  const adminLayer = (database: string) =>
    PgClient.layerFrom(
      PgClient.makeClient({
        host: location.Address,
        port: location.Port,
        database,
        username: input.props.adminUsername,
        password,
        applicationName: "alchemy-postgres-provider",
      }),
    );
  return { location, password, adminLayer };
});

/** Where the Nomad service `server` listens, waiting a bounded time for it to register. */
export const serverLocation = (server: string, nomad: typeof Nomad.Service) =>
  firstServiceLocation(server, nomad.service(server), dependencyRegistrationRetry).pipe(
    Effect.catchTag("ServiceNotRegistered", () =>
      Effect.fail(
        new PostgresDatabaseError({ operation: "find PostgreSQL service", target: server }),
      ),
    ),
  );

const reconcile = Effect.fn("PostgresDatabase.reconcile")(function* (input: {
  readonly id: string;
  readonly news: PostgresDatabaseProps;
  readonly output: Option.Option<PostgresDatabase["Attributes"]>;
  readonly openBao: typeof OpenBao.Service;
  readonly nomad: typeof Nomad.Service;
}) {
  const { location, password, adminLayer } = yield* adminConnection({
    props: input.news,
    openBao: input.openBao,
    nomad: input.nomad,
  });
  const connectError = () =>
    Effect.fail(
      new PostgresDatabaseError({
        operation: "connect to PostgreSQL",
        target: input.news.server,
      }),
    );
  const catchProvision = Effect.catchTags({
    PostgresProvisioningError: (error: PostgresProvisioningError) =>
      Effect.fail(provisioningError(error)),
    SqlError: () => connectError(),
  });

  // One deploy at a time creates or copies a database. The plain path uses the shared
  // provisioner (its own lock). The copy path holds the lock across dump and rename.
  const created = yield* Option.match(Option.fromNullishOr(input.news.copyFrom), {
    onNone: () =>
      provisionPostgresDatabase(databaseDeclaration(input.news), adminLayer).pipe(
        Effect.map((result) => result.created),
        catchProvision,
      ),
    onSome: (source) =>
      Effect.scoped(
        Effect.gen(function* () {
          const lockPool = yield* Layer.build(adminLayer("postgres"));
          yield* lockDatabase(input.news.name).pipe(
            Effect.provideContext(lockPool),
            catchProvision,
          );
          yield* ensureDatabaseRoles({
            name: input.news.name,
            ownerRole: input.news.ownerRole,
            visitorRole: input.news.visitorRole,
          }).pipe(Effect.provide(adminLayer("postgres")), catchProvision);

          const target = input.news.name;
          const ownerRole = input.news.ownerRole;

          const owner = yield* readDatabaseOwner(target).pipe(
            Effect.provide(adminLayer("postgres")),
            catchProvision,
          );
          if (Option.isSome(owner)) {
            // The real name only ever holds a finished copy, so an existing database is not copied again.
            if (owner.value !== ownerRole) {
              return yield* new PostgresDatabaseError({
                operation: "validate database owner",
                target,
              });
            }
            yield* ensureExtensions({
              database: target,
              ownerRole,
              extensions: input.news.extensions,
            }).pipe(Effect.provide(adminLayer(target)), catchProvision);
            return false;
          }
          // The copy is built under a temporary name and renamed into place only once it has
          // committed. A leftover temporary database from an earlier failure is dropped first.
          const into = yield* copyDatabaseName(target).pipe(
            Effect.provide(adminLayer("postgres")),
            Effect.catchTag("SqlError", connectError),
          );
          const dropInto = dropDatabase(into).pipe(
            Effect.provide(adminLayer("postgres")),
            Effect.catchTag("SqlError", connectError),
          );
          yield* Effect.gen(function* () {
            yield* dropInto;
            yield* createDatabase({ name: into, ownerRole }).pipe(
              Effect.provide(adminLayer("postgres")),
              catchProvision,
            );
            yield* ensureExtensions({
              database: into,
              ownerRole,
              extensions: input.news.extensions,
            }).pipe(Effect.provide(adminLayer(into)), catchProvision);
            yield* copyDatabase({
              source,
              target,
              into,
              location,
              admin: input.news.adminUsername,
              password,
            });
            yield* renameDatabase(into, target).pipe(
              Effect.provide(adminLayer("postgres")),
              Effect.catchTag("SqlError", connectError),
            );
          }).pipe(
            Effect.onError(() =>
              dropInto.pipe(
                Effect.catchTag("PostgresDatabaseError", (error) =>
                  Effect.logError(`Failed to clean up a failed database copy: ${error.message}`),
                ),
                Effect.ignore,
              ),
            ),
          );
          return true;
        }),
      ),
  });

  const engineConfigName = input.news.connectionName;
  const url = connectionUrl(location, input.news.name);
  const ttls = {
    databaseConfig: engineConfigName,
    database: input.news.name,
    ownerRole: input.news.ownerRole,
    defaultTtl: input.news.defaultTtl,
    maxTtl: input.news.maxTtl,
  };
  yield* input.openBao.configurePostgres(
    {
      name: engineConfigName,
      allowedRoles: [input.news.credentialRole, input.news.migrationCredentialRole],
      connectionUrl: url,
      username: input.news.adminUsername,
      password,
    },
    [
      {
        ...ttls,
        name: input.news.credentialRole,
        memberOf: input.news.visitorRole,
        inherit: false,
      },
      {
        ...ttls,
        name: input.news.migrationCredentialRole,
        memberOf: input.news.ownerRole,
        inherit: true,
      },
    ],
  );
  const copy =
    Option.exists(input.output, (output) => output.copy) ||
    (created && input.news.copyFrom !== undefined);
  return attributes(input.id, input.news, copy);
});

export const PostgresDatabaseProvider = () =>
  Provider.effect(
    PostgresDatabase,
    Effect.gen(function* () {
      const nomad = yield* Nomad;
      const openBao = yield* OpenBao;
      const journal = yield* OperationJournal;
      // The copy of a staged database runs pg_dump and pg_restore and writes their files.
      const platform = yield* Effect.context<
        ChildProcessSpawner | FileSystem.FileSystem | Path.Path
      >();

      return PostgresDatabase.Provider.of({
        list: () => Effect.succeed([]),
        stables: ["id"],
        // OpenBao keeps the server address it was given, so props alone cannot show that the
        // PostgreSQL job moved. Compare the stored URL with the address Nomad lists now.
        diff: Effect.fn(function* ({ news }) {
          if (!isResolved(news)) return undefined;
          const [locations, stored] = yield* Effect.all([
            nomad.service(news.server),
            openBao.readPostgresConnectionUrl(news.connectionName),
          ]);
          const current = Option.map(Arr.head(locations), (location) =>
            connectionUrl(location, news.name),
          );
          return Option.isSome(current) && Equal.equals(current, stored)
            ? undefined
            : { action: "update" as const };
        }),
        reconcile: Effect.fn(function* ({ news, output, fqn }) {
          return yield* journal.run(
            {
              resourceId: fqn,
              provider: "Postgres.Database",
              target: `${news.server}/${news.name}`,
              action: "reconcile",
            },
            reconcile({ id: fqn, news, output: Option.fromNullishOr(output), openBao, nomad }).pipe(
              Effect.provideContext(platform),
            ),
          );
        }),
        delete: Effect.fn(function* ({ fqn, olds, output }) {
          yield* journal.run(
            {
              resourceId: fqn,
              provider: "Postgres.Database",
              target: `${olds.server}/${olds.name}`,
              action: "delete",
            },
            // Database data and roles outlive an Alchemy deployment, so deletion only
            // releases state ownership. A copy is the exception: its writes are discarded
            // by design, so deleting it drops the database and its own roles.
            output.copy
              ? Effect.gen(function* () {
                  const { adminLayer } = yield* adminConnection({ props: olds, openBao, nomad });
                  const sql = adminLayer("postgres");
                  yield* dropDatabase(olds.name).pipe(
                    Effect.provide(sql),
                    Effect.catchTag("SqlError", () =>
                      Effect.fail(
                        new PostgresDatabaseError({
                          operation: "connect to PostgreSQL",
                          target: olds.server,
                        }),
                      ),
                    ),
                  );
                  yield* Effect.forEach(
                    [olds.ownerRole, olds.visitorRole],
                    (role) =>
                      Effect.gen(function* () {
                        const client = yield* SqlClient.SqlClient;
                        yield* client`DROP ROLE IF EXISTS ${client(role)}`.pipe(
                          Effect.asVoid,
                          Effect.mapError(
                            () =>
                              new PostgresDatabaseError({
                                operation: "drop database role",
                                target: role,
                              }),
                          ),
                        );
                      }).pipe(Effect.provide(sql)),
                    { discard: true },
                  );
                })
              : Effect.void,
          );
        }),
      });
    }),
  );
