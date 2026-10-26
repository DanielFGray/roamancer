import * as Effect from "effect/Effect";
import * as Arr from "effect/Array";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as S from "effect/Schema";
import type { ExpandedResource } from "./Cartridge.ts";
import { Job, ExpandedJob, ExpandedSecretReference, SecretReference } from "./Job.ts";
import { PostgresDatabaseProps } from "./PostgresDatabase.ts";
import { ValkeyAccessConfig } from "./ValkeyAccess.ts";
import { AdminCredentialProps } from "./AdminCredential.ts";
import { TailscaleServeProps, backendPort } from "./TailscaleServe.ts";

type NomadJobOutput = {
  readonly id: string;
};

type PostgresDatabaseOutput = {
  readonly id: string;
  readonly name: string;
  readonly server: string;
  readonly credentialPath: string;
  readonly migrationCredentialPath: string;
};

type ValkeyAccessOutput = {
  readonly id: string;
  readonly credentialPath: string;
};

type AdminCredentialOutput = {
  readonly path: string;
};

type TailscaleServeOutput = { readonly id: string; readonly port: number; readonly url: string };
type DeployedServe = { readonly name: string; readonly resource: TailscaleServeOutput };

type DeployedService = {
  readonly name: string;
  readonly resource: NomadJobOutput;
};

type DeployedValkeyAccess = {
  readonly name: string;
  readonly server: string;
  readonly resource: ValkeyAccessOutput;
};

type DeployedPostgresDatabase = {
  readonly role: string;
  readonly credentialPath: string;
  readonly resource: PostgresDatabaseOutput;
};

export class ComposeError extends S.TaggedError<ComposeError>()("ComposeError", {
  message: S.String,
}) {}

export type DeployedState = {
  readonly services: ReadonlyArray<DeployedService>;
  readonly valkeyAccesses: ReadonlyArray<DeployedValkeyAccess>;
  readonly postgresDatabases: ReadonlyArray<DeployedPostgresDatabase>;
  readonly tailnetServes: ReadonlyArray<DeployedServe>;
  readonly outputs: ReadonlyArray<{
    readonly kind: string;
    readonly id: string;
    readonly name: string;
  }>;
};

// The resource constructors composition calls. alchemy.run.ts passes the Alchemy resources;
// tests pass fakes, so each constructor is typed by the outputs composition reads.
export type Constructors<R> = {
  readonly NomadJob: (id: string, props: Job) => Effect.Effect<NomadJobOutput, never, R>;
  readonly PostgresDatabase: (
    id: string,
    props: PostgresDatabaseProps,
  ) => Effect.Effect<PostgresDatabaseOutput, never, R>;
  readonly ValkeyAccess: (
    id: string,
    props: ValkeyAccessConfig,
  ) => Effect.Effect<ValkeyAccessOutput, never, R>;
  readonly TailscaleServe: (
    id: string,
    props: TailscaleServeProps,
  ) => Effect.Effect<TailscaleServeOutput, never, R>;
  readonly AdminCredential: (
    id: string,
    props: AdminCredentialProps,
  ) => Effect.Effect<AdminCredentialOutput, never, R>;
};

/**
 * Declare one Alchemy resource per expanded resource, in order, wiring each job to the outputs it depends on.
 *
 * Alchemy keys resources by logical ID within a stack. A job keeps its name as its ID; every other
 * resource kind gets its own prefix or suffix, so a database, a Valkey access and a job named after
 * the same app never share an ID.
 */
export const compose = <R>(
  resources: ReadonlyArray<ExpandedResource>,
  constructors: Constructors<R>,
): Effect.Effect<DeployedState, ComposeError, R> =>
  Effect.reduce(
    resources,
    () => initialState(),
    (state, declaration) =>
      Match.value(declaration).pipe(
        Match.when({ _tag: "TailscaleServe" }, ({ serviceName }) =>
          Effect.gen(function* () {
            const resource = yield* constructors.TailscaleServe(
              `tailscale-serve-${serviceName}`,
              {},
            );
            return {
              ...state,
              tailnetServes: Arr.append(state.tailnetServes, { name: serviceName, resource }),
              outputs: Arr.append(state.outputs, {
                kind: "TailscaleServe",
                id: resource.id,
                name: serviceName,
              }),
            };
          }),
        ),
        Match.when({ _tag: "NomadService" }, ({ service }) =>
          declareJob("NomadService", service, state, [], constructors),
        ),
        Match.when({ _tag: "PostgresDatabase" }, ({ database }) =>
          Effect.gen(function* () {
            const resource = yield* constructors.PostgresDatabase(
              `postgres-database-${database.name}`,
              database,
            );
            return {
              ...state,
              postgresDatabases: Arr.appendAll(state.postgresDatabases, [
                {
                  role: database.credentialRole,
                  credentialPath: resource.credentialPath,
                  resource,
                },
                {
                  role: database.migrationCredentialRole,
                  credentialPath: resource.migrationCredentialPath,
                  resource,
                },
              ]),
              outputs: Arr.append(state.outputs, {
                kind: "PostgresDatabase",
                id: resource.id,
                name: database.name,
              }),
            };
          }),
        ),
        Match.tag("PostgresServer", "ValkeyServer", (declaration) =>
          Effect.gen(function* () {
            const service = declaration.service;
            const config =
              declaration._tag === "PostgresServer"
                ? { engine: "postgres" as const, env: "POSTGRES_PASSWORD", kind: "PostgresServer" }
                : { engine: "valkey" as const, env: "VALKEY_ADMIN_PASSWORD", kind: "ValkeyServer" };
            const adminCredential = yield* constructors.AdminCredential(
              `${service.name}-admin-credential`,
              {
                engine: config.engine,
                server: service.name,
              },
            );
            const adminSecret = {
              _tag: "KvSecret" as const,
              path: adminCredential.path,
              key: "password",
              env: config.env,
            };
            return yield* declareJob(config.kind, service, state, [adminSecret], constructors);
          }),
        ),
        Match.when({ _tag: "ValkeyAccess" }, ({ access }) =>
          Effect.gen(function* () {
            const resource = yield* constructors.ValkeyAccess(
              `valkey-access-${access.resourceName}`,
              access,
            );
            return {
              ...state,
              valkeyAccesses: Arr.append(state.valkeyAccesses, {
                name: access.resourceName,
                server: access.server,
                resource,
              }),
              outputs: Arr.append(state.outputs, {
                kind: "ValkeyAccess",
                id: resource.id,
                name: access.resourceName,
              }),
            };
          }),
        ),
        Match.exhaustive,
      ),
  );

const initialState = (): DeployedState => ({
  services: Arr.empty<DeployedService>(),
  valkeyAccesses: Arr.empty<DeployedValkeyAccess>(),
  postgresDatabases: Arr.empty<DeployedPostgresDatabase>(),
  tailnetServes: Arr.empty<DeployedServe>(),
  outputs: Arr.empty<{ readonly kind: string; readonly id: string; readonly name: string }>(),
});

const resolveConnections = (service: ExpandedJob, state: DeployedState) =>
  Effect.forEach(service.connections, (connection) =>
    Option.match(
      Arr.findFirst(state.services, (entry) => entry.name === connection.service),
      {
        onNone: () => Effect.die(new Error(`unresolved dependency '${connection.service}'`)),
        onSome: (provider) => Effect.succeed({ ...connection, service: provider.resource.id }),
      },
    ),
  );

const resolveSecrets = (secrets: ReadonlyArray<ExpandedSecretReference>, state: DeployedState) =>
  Effect.forEach(secrets, (secret) =>
    Match.value(secret).pipe(
      Match.when({ _tag: "ValkeyCredentials" }, (value) =>
        Option.match(
          Arr.findFirst(state.valkeyAccesses, (entry) => entry.name === value.access),
          {
            onNone: () => Effect.die(new Error(`unresolved Valkey access '${value.access}'`)),
            onSome: (access) =>
              Effect.succeed<SecretReference>({
                _tag: "ValkeyCredentials",
                access: value.access,
                credentialPath: access.resource.credentialPath,
                usernameEnv: value.usernameEnv,
                passwordEnv: value.passwordEnv,
                url:
                  value.url === undefined
                    ? undefined
                    : { env: value.url.env, server: access.server },
              }),
          },
        ),
      ),
      Match.when({ _tag: "PostgresCredentials" }, (value) =>
        Option.match(
          Arr.findFirst(state.postgresDatabases, (entry) => entry.role === value.role),
          {
            onNone: () => Effect.die(new Error(`unresolved PostgreSQL role '${value.role}'`)),
            onSome: (database) =>
              Effect.succeed<SecretReference>({
                _tag: "PostgresCredentials",
                role: value.role,
                credentialPath: database.credentialPath,
                usernameEnv: value.usernameEnv,
                passwordEnv: value.passwordEnv,
                url:
                  value.url === undefined
                    ? undefined
                    : {
                        env: value.url.env,
                        server: database.resource.server,
                        database: database.resource.name,
                      },
              }),
          },
        ),
      ),
      Match.when({ _tag: "KvSecret" }, (s) => Effect.succeed<SecretReference>(s)),
      Match.exhaustive,
    ),
  );

const declareJob = <R>(
  kind: string,
  service: ExpandedJob,
  state: DeployedState,
  extraSecrets: ReadonlyArray<ExpandedSecretReference>,
  constructors: Constructors<R>,
) =>
  Effect.gen(function* () {
    const connections = yield* resolveConnections(service, state);
    const secrets = yield* resolveSecrets([...(service.secrets ?? []), ...extraSecrets], state);
    const migrateSecrets = yield* resolveSecrets(service.migrate?.secrets ?? [], state);
    const migrate =
      service.migrate === undefined
        ? undefined
        : { ...service.migrate, secrets: migrateSecrets.length === 0 ? undefined : migrateSecrets };
    const environment = yield* Effect.forEach(service.environment, (entry) =>
      "value" in entry
        ? Effect.succeed(entry)
        : Option.match(
            Arr.findFirst(state.tailnetServes, (serve) => serve.name === entry.route),
            {
              onNone: () =>
                Effect.fail(
                  new ComposeError({ message: `unresolved tailnet route '${entry.route}'` }),
                ),
              onSome: (serve) => Effect.succeed({ name: entry.name, value: serve.resource.url }),
            },
          ),
    );
    const hostPort = service.routes?.some((route) => route.access === "tailnet")
      ? Option.match(
          Arr.findFirst(state.tailnetServes, (serve) => serve.name === service.name),
          {
            onNone: () =>
              Effect.fail(
                new ComposeError({ message: `unresolved Tailscale Serve '${service.name}'` }),
              ),
            onSome: (serve) => Effect.succeed(backendPort(serve.resource.port)),
          },
        )
      : Effect.succeed(service.hostPort);
    const resource = yield* constructors.NomadJob(service.name, {
      ...service,
      hostPort: yield* hostPort,
      environment,
      connections,
      secrets: secrets.length === 0 ? undefined : secrets,
      migrate,
    });
    const next: DeployedState = {
      ...state,
      services: Arr.append(state.services, { name: service.name, resource }),
      outputs: Arr.append(state.outputs, { kind, id: resource.id, name: service.name }),
    };
    return next;
  });
