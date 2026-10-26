import * as Alchemy from "alchemy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Arr from "effect/Array";
import * as Equal from "effect/Equal";
import * as Effect from "effect/Effect";
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
import { filterAclRestoreList, filterRestoreList, remapAclRoles } from "./RestoreList.ts";
import { KvSecretReference } from "./Job.ts";
import { Nomad } from "./Nomad.ts";
import { OpenBao } from "./OpenBao.ts";
import { OperationJournal } from "./OperationJournal.ts";
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

const attributes = (id: string, props: PostgresDatabaseProps, copy: boolean) => ({
  id,
  copy,
  name: props.name,
  server: props.server,
  ownerRole: props.ownerRole,
  visitorRole: props.visitorRole,
  connectionName: props.connectionName,
  credentialRole: props.credentialRole,
  credentialPath: `database/creds/${props.credentialRole}`,
  migrationCredentialRole: props.migrationCredentialRole,
  migrationCredentialPath: `database/creds/${props.migrationCredentialRole}`,
});

// Creates a group role that cannot log in, or fails when the name already belongs to a login role.
// Logins join group roles, so a group that someone can log in as would hand out its rights directly.
const ensureGroupRole = (sql: SqlClient.SqlClient, role: string, target: string) =>
  Effect.gen(function* () {
    const roles = yield* sql<{ readonly rolcanlogin: boolean }>`
      SELECT rolcanlogin FROM pg_roles WHERE rolname = ${role}
    `.pipe(
      Effect.mapError(() => new PostgresDatabaseError({ operation: "read group role", target })),
    );
    const existing = Option.map(Arr.head(roles), (row) => row.rolcanlogin);
    yield* Option.match(existing, {
      onNone: () =>
        sql`CREATE ROLE ${sql(role)} NOLOGIN`.pipe(
          Effect.asVoid,
          Effect.mapError(
            () =>
              new PostgresDatabaseError({
                operation: "create group role",
                target,
              }),
          ),
        ),
      onSome: (canLogin) =>
        canLogin
          ? Effect.fail(
              new PostgresDatabaseError({
                operation: "validate group role",
                target: role,
              }),
            )
          : Effect.void,
    });
  });

const provisionDatabase = Effect.fn("PostgresDatabase.provision")(function* (input: {
  readonly username: string;
  readonly password: Redacted.Redacted<string>;
  readonly name: string;
  readonly ownerRole: string;
  readonly visitorRole: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const lock = `alchemy:${input.name}`;

  yield* sql`SELECT pg_advisory_lock(hashtextextended(${lock}, 0))`.pipe(
    Effect.asVoid,
    Effect.mapError(
      () =>
        new PostgresDatabaseError({
          operation: "lock database",
          target: input.name,
        }),
    ),
  );

  yield* ensureGroupRole(sql, input.ownerRole, input.name);
  yield* ensureGroupRole(sql, input.visitorRole, input.name);
  // CREATE DATABASE ... OWNER requires the creator to be a member of the owner role, and a role
  // that creates another role does not become its member on PostgreSQL 17.
  yield* sql`GRANT ${sql(input.ownerRole)} TO CURRENT_USER`.pipe(
    Effect.asVoid,
    Effect.mapError(
      () =>
        new PostgresDatabaseError({
          operation: "grant owner role",
          target: input.name,
        }),
    ),
  );

  const databases = yield* sql<{ readonly owner: string }>`
      SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = ${input.name}
    `.pipe(
    Effect.mapError(
      () =>
        new PostgresDatabaseError({
          operation: "read database",
          target: input.name,
        }),
    ),
  );
  const databaseOwner = Option.map(Arr.head(databases), (database) => database.owner);
  const created = yield* Option.match(databaseOwner, {
    onNone: () =>
      sql`CREATE DATABASE ${sql(input.name)} OWNER ${sql(input.ownerRole)}`.pipe(
        Effect.as(true),
        Effect.mapError(
          () =>
            new PostgresDatabaseError({
              operation: "create database",
              target: input.name,
            }),
        ),
      ),
    onSome: (owner) =>
      owner === input.ownerRole
        ? Effect.succeed(false)
        : Effect.fail(
            new PostgresDatabaseError({
              operation: "validate database owner",
              target: input.name,
            }),
          ),
  });

  return created;
});

// Runs as the admin, a superuser, so untrusted extensions work too. It checks every name before
// it creates any, so an extension missing from the server image changes nothing.
const createExtensions = Effect.fn("PostgresDatabase.createExtensions")(function* (input: {
  readonly database: string;
  readonly extensions: ReadonlyArray<string>;
}) {
  const sql = yield* SqlClient.SqlClient;
  const available = yield* sql<{ readonly name: string }>`
      SELECT name FROM pg_available_extensions WHERE name IN ${sql.in(input.extensions)}
    `.pipe(
    Effect.mapError(
      () =>
        new PostgresDatabaseError({
          operation: "read extensions",
          target: input.database,
        }),
    ),
  );
  const missing = input.extensions.filter(
    (extension) => !available.some((row) => row.name === extension),
  );
  if (missing.length > 0) {
    return yield* new PostgresDatabaseError({
      operation: "find extensions in the server image",
      target: missing.join(", "),
    });
  }
  yield* Effect.forEach(
    input.extensions,
    (extension) =>
      sql`CREATE EXTENSION IF NOT EXISTS ${sql(extension)}`.pipe(
        Effect.mapError(
          () =>
            new PostgresDatabaseError({
              operation: "create extension",
              target: extension,
            }),
        ),
      ),
    { discard: true },
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
  readonly target: string;
  readonly location: { readonly Address: string; readonly Port: number };
  readonly admin: string;
  readonly password: Redacted.Redacted<string>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tmpDir = yield* fs.makeTempDirectoryScoped();
  const dumpFile = path.join(tmpDir, "dump.fc");
  const listFile = path.join(tmpDir, "list");
  const aclListFile = path.join(tmpDir, "acl-list");
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
  yield* fs.writeFileString(listFile, filterRestoreList(listText));
  yield* fs.writeFileString(aclListFile, filterAclRestoreList(listText));
  const nonAclSql = yield* runStep({
    operation: "pg_restore non-ACL script",
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
  const aclSql = yield* runStep({
    operation: "pg_restore ACL script",
    target: input.target,
    command: "pg_restore",
    args: ["-L", aclListFile, "-f", "-", dumpFile],
    env,
  });
  const sourceRoles = postgresRoles(input.source);
  const targetRoles = postgresRoles(input.target);
  const remappedAclSql = remapAclRoles(
    remapAclRoles(aclSql, sourceRoles.owner, targetRoles.owner),
    sourceRoles.visitor,
    targetRoles.visitor,
  );
  yield* fs.writeFileString(restoreFile, `${nonAclSql}\n${remappedAclSql}`);
  yield* runStep({
    operation: "psql restore transaction",
    target: input.target,
    command: "psql",
    args: [
      "--single-transaction",
      "-v",
      "ON_ERROR_STOP=1",
      ...connectionArgs,
      "-d",
      input.target,
      "-f",
      restoreFile,
    ],
    env,
  });
}, Effect.scoped);

/** The server's address, its admin password, and a client layer for one of its databases. */
const adminConnection = Effect.fn("PostgresDatabase.adminConnection")(function* (input: {
  readonly props: PostgresDatabaseProps;
  readonly openBao: typeof OpenBao.Service;
  readonly nomad: typeof Nomad.Service;
}) {
  const location = yield* firstServiceLocation(
    input.props.server,
    input.nomad.service(input.props.server),
    dependencyRegistrationRetry,
  ).pipe(
    Effect.catchTag("ServiceNotRegistered", () =>
      Effect.fail(
        new PostgresDatabaseError({
          operation: "find PostgreSQL service",
          target: input.props.server,
        }),
      ),
    ),
  );
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
  const created = yield* provisionDatabase({
    username: input.news.adminUsername,
    password,
    name: input.news.name,
    ownerRole: input.news.ownerRole,
    visitorRole: input.news.visitorRole,
  }).pipe(Effect.provide(adminLayer("postgres")), Effect.catchTag("SqlError", connectError));
  // CREATE EXTENSION acts on the database of the connection, so this one opens the app's database.
  yield* Option.match(Option.fromNullishOr(input.news.copyFrom), {
    onNone: () =>
      created && input.news.extensions.length > 0
        ? createExtensions({ database: input.news.name, extensions: input.news.extensions }).pipe(
            Effect.provide(adminLayer(input.news.name)),
            Effect.catchTag("SqlError", connectError),
          )
        : Effect.void,
    onSome: (source) =>
      created
        ? Effect.gen(function* () {
            if (input.news.extensions.length > 0) {
              yield* createExtensions({
                database: input.news.name,
                extensions: input.news.extensions,
              }).pipe(
                Effect.provide(adminLayer(input.news.name)),
                Effect.catchTag("SqlError", connectError),
              );
            }
            yield* copyDatabase({
              source,
              target: input.news.name,
              location,
              admin: input.news.adminUsername,
              password,
            });
          }).pipe(
            Effect.onError(() =>
              dropDatabase(input.news.name).pipe(
                Effect.provide(adminLayer("postgres")),
                Effect.catchTag("SqlError", () =>
                  Effect.logError("Failed to connect while cleaning up a failed database copy"),
                ),
                Effect.catchTag("PostgresDatabaseError", (error) =>
                  Effect.logError(`Failed to clean up a failed database copy: ${error.message}`),
                ),
                Effect.ignore,
              ),
            ),
          )
        : Effect.void,
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
