import * as Alchemy from "alchemy";
import * as Provider from "alchemy/Provider";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as PgClient from "@effect/sql-pg/PgClient";
import { KvSecretReference } from "./Job.ts";
import { Nomad } from "./Nomad.ts";
import { OpenBao } from "./OpenBao.ts";
import { OperationJournal } from "./OperationJournal.ts";
import { dependencyRegistrationRetry, firstServiceLocation } from "./ServiceRegistration.ts";

const DatabaseIdentifier = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]{0,62}$/));
const ResourceName = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/));
const EngineName = Schema.String.check(Schema.isPattern(/^alchemy_[a-z][a-z0-9_]{0,54}$/));
const CredentialRoleName = Schema.String.check(Schema.isPattern(/^alchemy_[a-z][a-z0-9_]{0,54}$/));

export const PostgresDatabaseProps = Schema.Struct({
  resourceName: ResourceName,
  name: DatabaseIdentifier,
  server: ResourceName,
  adminUsername: DatabaseIdentifier,
  adminCredential: KvSecretReference,
  ownerRole: DatabaseIdentifier,
  connectionName: EngineName,
  credentialRole: CredentialRoleName,
  defaultTtl: Schema.String.check(Schema.isPattern(/^[1-9][0-9]*(s|m|h)$/)),
  maxTtl: Schema.String.check(Schema.isPattern(/^[1-9][0-9]*(s|m|h)$/)),
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
    connectionName: string;
    credentialRole: string;
    credentialPath: string;
  }
> {}

export const PostgresDatabase = Alchemy.Resource<PostgresDatabase>("Postgres.Database");

export class PostgresDatabaseError extends Schema.TaggedError<PostgresDatabaseError>()(
  "PostgresDatabaseError",
  {
    operation: Schema.String,
    target: Schema.String,
  },
) {}

const attributes = (id: string, props: PostgresDatabaseProps) => ({
  id,
  name: props.name,
  server: props.server,
  ownerRole: props.ownerRole,
  connectionName: props.connectionName,
  credentialRole: props.credentialRole,
  credentialPath: `database/creds/${props.credentialRole}`,
});

const provisionDatabase = Effect.fn("PostgresDatabase.provision")(function* (input: {
  readonly username: string;
  readonly password: Redacted.Redacted<string>;
  readonly name: string;
  readonly ownerRole: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const lock = `alchemy:${input.name}`;

  yield* sql`SELECT pg_advisory_lock(hashtextextended(${lock}, 0))`.pipe(
    Effect.asVoid,
    Effect.mapError(
      () => new PostgresDatabaseError({ operation: "lock database", target: input.name }),
    ),
  );

  const owners = yield* sql<{ readonly rolcanlogin: boolean }>`
      SELECT rolcanlogin FROM pg_roles WHERE rolname = ${input.ownerRole}
    `.pipe(
    Effect.mapError(
      () => new PostgresDatabaseError({ operation: "read owner role", target: input.name }),
    ),
  );
  const ownerLogin = Option.map(Arr.head(owners), (role) => role.rolcanlogin);
  yield* Option.match(ownerLogin, {
    onNone: () =>
      sql`CREATE ROLE ${sql(input.ownerRole)} NOLOGIN`.pipe(
        Effect.asVoid,
        Effect.mapError(
          () => new PostgresDatabaseError({ operation: "create owner role", target: input.name }),
        ),
      ),
    onSome: (canLogin) =>
      canLogin
        ? Effect.fail(
            new PostgresDatabaseError({
              operation: "validate owner role",
              target: input.ownerRole,
            }),
          )
        : Effect.void,
  });

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
  const credentialRole = input.news.credentialRole;
  const url = `postgresql://{{username}}:{{password}}@${hostForConnectionUrl(location.Address)}:${location.Port}/${input.news.name}?sslmode=disable`;
  yield* input.openBao.configurePostgres(
    {
      name: engineConfigName,
      allowedRole: credentialRole,
      connectionUrl: url,
      username: input.news.adminUsername,
      password,
    },
    {
      name: credentialRole,
      databaseConfig: engineConfigName,
      database: input.news.name,
      ownerRole: input.news.ownerRole,
      defaultTtl: input.news.defaultTtl,
      maxTtl: input.news.maxTtl,
    },
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
