import * as Alchemy from "alchemy";
import * as Provider from "alchemy/Provider";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as S from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as PgClient from "@effect/sql-pg/PgClient";
import { KvSecretReference } from "./Job.ts";
import { Nomad } from "./Nomad.ts";
import { OpenBao } from "./OpenBao.ts";
import { OperationJournal } from "./OperationJournal.ts";
import { dependencyRegistrationRetry, firstServiceLocation } from "./ServiceRegistration.ts";

const DatabaseIdentifier = S.String.check(S.isPattern(/^[a-z][a-z0-9_]{0,62}$/));
const ResourceName = S.String.check(S.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/));
const EngineName = S.String.check(S.isPattern(/^alchemy_[a-z][a-z0-9_]{0,54}$/));
const CredentialRoleName = S.String.check(S.isPattern(/^alchemy_[a-z][a-z0-9_]{0,54}$/));

export const PostgresDatabaseProps = S.Struct({
  name: DatabaseIdentifier,
  server: ResourceName,
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
  defaultTtl: S.String.check(S.isPattern(/^[1-9][0-9]*(s|m|h)$/)),
  maxTtl: S.String.check(S.isPattern(/^[1-9][0-9]*(s|m|h)$/)),
});
export type PostgresDatabaseProps = typeof PostgresDatabaseProps.Type;

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
  }
> {}

export const PostgresDatabase = Alchemy.Resource<PostgresDatabase>("Postgres.Database");

export class PostgresDatabaseError extends S.TaggedError<PostgresDatabaseError>()(
  "PostgresDatabaseError",
  {
    operation: S.String,
    target: S.String,
  },
) {}

const attributes = (id: string, props: PostgresDatabaseProps) => ({
  id,
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
            () => new PostgresDatabaseError({ operation: "create group role", target }),
          ),
        ),
      onSome: (canLogin) =>
        canLogin
          ? Effect.fail(
              new PostgresDatabaseError({ operation: "validate group role", target: role }),
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
      () => new PostgresDatabaseError({ operation: "lock database", target: input.name }),
    ),
  );

  yield* ensureGroupRole(sql, input.ownerRole, input.name);
  yield* ensureGroupRole(sql, input.visitorRole, input.name);
  // CREATE DATABASE ... OWNER requires the creator to be a member of the owner role, and a role
  // that creates another role does not become its member on PostgreSQL 17.
  yield* sql`GRANT ${sql(input.ownerRole)} TO CURRENT_USER`.pipe(
    Effect.asVoid,
    Effect.mapError(
      () => new PostgresDatabaseError({ operation: "grant owner role", target: input.name }),
    ),
  );

  const databases = yield* sql<{ readonly owner: string }>`
      SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = ${input.name}
    `.pipe(
    Effect.mapError(
      () => new PostgresDatabaseError({ operation: "read database", target: input.name }),
    ),
  );
  const databaseOwner = Option.map(Arr.head(databases), (database) => database.owner);
  yield* Option.match(databaseOwner, {
    onNone: () =>
      sql`CREATE DATABASE ${sql(input.name)} OWNER ${sql(input.ownerRole)}`.pipe(
        Effect.asVoid,
        Effect.mapError(
          () => new PostgresDatabaseError({ operation: "create database", target: input.name }),
        ),
      ),
    onSome: (owner) =>
      owner === input.ownerRole
        ? Effect.void
        : Effect.fail(
            new PostgresDatabaseError({ operation: "validate database owner", target: input.name }),
          ),
  });

  return yield* Effect.void;
});

const hostForConnectionUrl = (address: string) =>
  address.includes(":") ? `[${address}]` : address;

const reconcile = Effect.fn("PostgresDatabase.reconcile")(function* (input: {
  readonly id: string;
  readonly news: PostgresDatabaseProps;
  readonly openBao: typeof OpenBao.Service;
  readonly nomad: typeof Nomad.Service;
}) {
  const location = yield* firstServiceLocation(
    input.news.server,
    input.nomad.service(input.news.server),
    dependencyRegistrationRetry,
  ).pipe(
    Effect.catchTag("ServiceNotRegistered", () =>
      Effect.fail(
        new PostgresDatabaseError({
          operation: "find PostgreSQL service",
          target: input.news.server,
        }),
      ),
    ),
  );
  const password = yield* input.openBao.readKv(
    input.news.adminCredential.path,
    input.news.adminCredential.key,
  );
  const databaseLayer = PgClient.layerFrom(
    PgClient.makeClient({
      host: location.Address,
      port: location.Port,
      database: "postgres",
      username: input.news.adminUsername,
      password,
      applicationName: "alchemy-postgres-provider",
    }),
  );
  yield* provisionDatabase({
    username: input.news.adminUsername,
    password,
    name: input.news.name,
    ownerRole: input.news.ownerRole,
    visitorRole: input.news.visitorRole,
  }).pipe(
    Effect.provide(databaseLayer),
    Effect.catchTag("SqlError", () =>
      Effect.fail(
        new PostgresDatabaseError({
          operation: "connect to PostgreSQL",
          target: input.news.server,
        }),
      ),
    ),
  );

  const engineConfigName = input.news.connectionName;
  const url = `postgresql://{{username}}:{{password}}@${hostForConnectionUrl(location.Address)}:${location.Port}/${input.news.name}?sslmode=disable`;
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
  return attributes(input.id, input.news);
});

export const PostgresDatabaseProvider = () =>
  Provider.effect(
    PostgresDatabase,
    Effect.gen(function* () {
      const nomad = yield* Nomad;
      const openBao = yield* OpenBao;
      const journal = yield* OperationJournal;

      return PostgresDatabase.Provider.of({
        list: () => Effect.succeed([]),
        stables: ["id"],
        reconcile: Effect.fn(function* ({ news, fqn }) {
          return yield* journal.run(
            {
              resourceId: fqn,
              provider: "Postgres.Database",
              target: `${news.server}/${news.name}`,
              action: "reconcile",
            },
            reconcile({ id: fqn, news, openBao, nomad }),
          );
        }),
        delete: Effect.fn(function* ({ fqn, olds }) {
          // Database data and roles outlive an Alchemy deployment. Deletion only releases state ownership.
          yield* journal.run(
            {
              resourceId: fqn,
              provider: "Postgres.Database",
              target: `${olds.server}/${olds.name}`,
              action: "delete",
            },
            Effect.void,
          );
        }),
      });
    }),
  );
