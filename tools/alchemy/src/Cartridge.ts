import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Arr from "effect/Array";
import * as Schema from "effect/Schema";
import {
  CartridgeJob,
  CartridgeSecretReference,
  DatabaseIdentifier,
  ExpandedJob,
  ExpandedSecretReference,
  ResourceName,
} from "./Job.ts";
import { PostgresDatabaseProps } from "./PostgresDatabase.ts";
import { ValkeyAccessConfig } from "./ValkeyAccess.ts";
import { adminCredentialPath } from "./AdminCredential.ts";

const AppName = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9-]{0,30}$/),
  Schema.makeFilter((value) => (value === "default" ? 'must not be "default"' : undefined)),
);

const DatabaseName = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]{0,39}$/));

const PostgresServerDeclaration = Schema.TaggedStruct("PostgresServer", {
  service: CartridgeJob,
});
const ValkeyServerDeclaration = Schema.TaggedStruct("ValkeyServer", {
  service: CartridgeJob,
});

const PostgresEntry = Schema.Struct({
  database: DatabaseName,
  server: Schema.optionalKey(ResourceName),
});

const ValkeyEntry = Schema.Struct({
  server: Schema.optionalKey(ResourceName),
  access: Schema.optionalKey(Schema.Literals(["read-only", "read-write"])),
});

export const Cartridge = Schema.Struct({
  apiVersion: Schema.Literals(["server-ansible/v2"]),
  name: AppName,
  servers: Schema.optionalKey(
    Schema.Array(Schema.Union([PostgresServerDeclaration, ValkeyServerDeclaration])),
  ),
  postgres: Schema.optionalKey(Schema.Array(PostgresEntry)),
  valkey: Schema.optionalKey(ValkeyEntry),
  services: Schema.Array(CartridgeJob),
}).check(
  Schema.makeFilter((cartridge) => {
    const issues: Array<string> = [];
    if (
      (cartridge.servers?.length ?? 0) > 0 &&
      ((cartridge.postgres?.length ?? 0) > 0 || cartridge.valkey !== undefined)
    ) {
      issues.push("a cartridge cannot both declare servers and postgres/valkey");
    }
    const allJobNames = [
      ...(cartridge.servers ?? []).map((server) => server.service.name),
      ...cartridge.services.map((service) => service.name),
    ];
    const duplicateJobNames = allJobNames.filter(
      (name, index) => allJobNames.indexOf(name) !== index,
    );
    issues.push(...duplicateJobNames.map((name) => `duplicate job name '${name}'`));
    const dbNames = (cartridge.postgres ?? []).map((entry) => entry.database);
    const duplicateDbNames = dbNames.filter((name, index) => dbNames.indexOf(name) !== index);
    issues.push(...duplicateDbNames.map((name) => `duplicate database '${name}'`));
    const appUnderscore = appIdentifier(cartridge.name);
    issues.push(
      ...(cartridge.postgres ?? [])
        .map((entry) => entry.database)
        .filter(
          (database) => !(database === appUnderscore || database.startsWith(`${appUnderscore}_`)),
        )
        .map((database) => `Database '${database}' must equal or start with '${appUnderscore}_'`),
    );
    const allJobs = [
      ...(cartridge.servers ?? []).map((server) => server.service),
      ...cartridge.services,
    ];
    const secretIssues = allJobs.flatMap((job) => {
      const jobSecrets = [...(job.secrets ?? []), ...(job.migrate?.secrets ?? [])];
      return jobSecrets.flatMap((secret) => {
        const result: Array<string> = [];
        if (secret._tag === "PostgresCredentials") {
          const found = (cartridge.postgres ?? []).some(
            (entry) => entry.database === secret.database,
          );
          if (!found)
            result.push(
              `PostgresCredentials references database '${secret.database}' not in \`postgres\``,
            );
        }
        if (secret._tag === "ValkeyCredentials" && cartridge.valkey === undefined) {
          result.push("ValkeyCredentials requires `valkey`");
        }
        return result;
      });
    });
    const serverMigrateIssues = (cartridge.servers ?? [])
      .filter((server) => server.service.migrate !== undefined)
      .map(() => "server declarations may not declare `migrate`");
    issues.push(...secretIssues);
    issues.push(...serverMigrateIssues);
    const seenServices = new Set<string>();
    const connectionIssues = allJobs.flatMap((job) => {
      const result = job.connections
        .filter((connection) => !seenServices.has(connection.service))
        .map(
          (connection) =>
            `Service '${job.name}' must follow its service dependency '${connection.service}'`,
        );
      seenServices.add(job.name);
      return result;
    });
    issues.push(...connectionIssues);
    return issues.length === 0 ? undefined : issues;
  }),
);
export type Cartridge = typeof Cartridge.Type;

export type ExpandedResource =
  | { readonly _tag: "PostgresServer"; readonly service: ExpandedJob }
  | { readonly _tag: "ValkeyServer"; readonly service: ExpandedJob }
  | { readonly _tag: "NomadService"; readonly service: ExpandedJob }
  | { readonly _tag: "PostgresDatabase"; readonly database: PostgresDatabaseProps }
  | { readonly _tag: "ValkeyAccess"; readonly access: ValkeyAccessConfig };

export const postgresLoginRole = (database: string, login: "api" | "migration") =>
  login === "api" ? `alchemy_${database}_api` : `alchemy_${database}_migration`;

// PostgreSQL and Valkey identifiers allow "_" but not "-", so derived database and ACL user names use this form.
export const appIdentifier = (name: string) => name.replace(/-/g, "_");

const mapSecret = (
  cartridge: Cartridge,
  secret: CartridgeSecretReference,
): ExpandedSecretReference => {
  if (secret._tag === "KvSecret") return secret;
  if (secret._tag === "PostgresCredentials") {
    const database = secret.database;
    const role = postgresLoginRole(database, secret.login);
    const result: ExpandedSecretReference = {
      _tag: "PostgresCredentials",
      role,
      usernameEnv: secret.usernameEnv,
      passwordEnv: secret.passwordEnv,
      url: secret.urlEnv === undefined ? undefined : { env: secret.urlEnv },
    };
    return result;
  }
  // ValkeyCredentials
  const appUnderscore = appIdentifier(cartridge.name);
  const result: ExpandedSecretReference = {
    _tag: "ValkeyCredentials",
    access: appUnderscore,
    usernameEnv: secret.usernameEnv,
    passwordEnv: secret.passwordEnv,
    url: secret.urlEnv === undefined ? undefined : { env: secret.urlEnv },
  };
  return result;
};

const toRenderedJob = (cartridge: Cartridge, job: CartridgeJob): ExpandedJob => {
  const secrets = (job.secrets ?? []).map((secret) => mapSecret(cartridge, secret));
  const migrateSecrets = (job.migrate?.secrets ?? []).map((secret) => mapSecret(cartridge, secret));
  const migrate =
    job.migrate === undefined
      ? undefined
      : {
          command: job.migrate.command,
          args: job.migrate.args,
          secrets: migrateSecrets.length === 0 ? undefined : migrateSecrets,
        };
  const rendered: ExpandedJob = {
    name: job.name,
    image: job.image,
    hostPort: job.hostPort,
    containerPort: job.containerPort,
    healthCheck: job.healthCheck,
    cpu: job.cpu,
    memoryMB: job.memoryMB,
    networkMode: job.networkMode,
    storage: job.storage,
    environment: job.environment,
    command: job.command,
    args: job.args,
    connections: job.connections,
    secrets: secrets.length === 0 ? undefined : secrets,
    migrate,
  };
  return rendered;
};

export const expand = (cartridge: Cartridge): ReadonlyArray<ExpandedResource> => {
  const serverResources = (cartridge.servers ?? []).map((server) => {
    const renderedJob = toRenderedJob(cartridge, server.service);
    const tag = server._tag === "PostgresServer" ? "PostgresServer" : "ValkeyServer";
    return { _tag: tag, service: renderedJob } as ExpandedResource;
  });

  const databaseResources = (cartridge.postgres ?? []).map((entry) => {
    const database = entry.database;
    const server = entry.server ?? "postgres";
    const props: PostgresDatabaseProps = {
      resourceName: database,
      name: database,
      server,
      adminUsername: "postgres",
      adminCredential: {
        _tag: "KvSecret",
        path: adminCredentialPath("postgres", server),
        key: "password",
        env: "POSTGRES_PASSWORD",
      },
      ownerRole: `${database}_owner`,
      visitorRole: `${database}_visitor`,
      connectionName: `alchemy_${database}`,
      credentialRole: postgresLoginRole(database, "api"),
      migrationCredentialRole: postgresLoginRole(database, "migration"),
      defaultTtl: "1h",
      maxTtl: "24h",
    };
    return { _tag: "PostgresDatabase", database: props } as ExpandedResource;
  });

  const valkeyResource: ReadonlyArray<ExpandedResource> =
    cartridge.valkey === undefined
      ? []
      : [
          {
            _tag: "ValkeyAccess",
            access: {
              resourceName: appIdentifier(cartridge.name),
              server: cartridge.valkey.server ?? "valkey",
              adminUsername: "default",
              keyPrefix: cartridge.name,
              access: cartridge.valkey.access ?? "read-write",
            },
          } as ExpandedResource,
        ];

  const serviceResources = cartridge.services.map((job) => ({
    _tag: "NomadService",
    service: toRenderedJob(cartridge, job),
  })) as ReadonlyArray<ExpandedResource>;

  return [...serverResources, ...databaseResources, ...valkeyResource, ...serviceResources];
};

/** Read and validate the project-owned workload declaration. */
export const load = Effect.fn(function* () {
  const path = yield* Config.String("ALCHEMY_CARTRIDGE");
  const fs = yield* FileSystem.FileSystem;
  const contents = yield* fs.readFileString(path).pipe(
    Effect.mapError(
      (cause) =>
        new Config.ConfigError(
          new ConfigProvider.SourceError({
            message: `Could not read Alchemy cartridge at '${path}'`,
            cause,
          }),
        ),
    ),
  );
  const cartridge = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Cartridge), {
    onExcessProperty: "error",
  })(contents).pipe(Effect.mapError((cause) => new Config.ConfigError(cause)));
  return cartridge;
});
