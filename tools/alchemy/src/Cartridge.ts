import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Graph from "effect/Graph";
import * as S from "effect/Schema";
import {
  CartridgeJob,
  CartridgeSecretReference,
  ExpandedJob,
  ExpandedSecretReference,
  ResourceName,
} from "./Job.ts";
import { ExtensionName, PostgresDatabaseProps } from "./PostgresDatabase.ts";
import { ValkeyAccessConfig } from "./ValkeyAccess.ts";
import { adminCredentialPath } from "./AdminCredential.ts";

const AppName = S.String.check(
  S.isPattern(/^[a-z][a-z0-9-]{0,30}$/),
  S.makeFilter((value) => (value === "default" ? 'must not be "default"' : undefined)),
);

const DatabaseName = S.String.check(S.isPattern(/^[a-z][a-z0-9_]{0,39}$/));

const PostgresServerDeclaration = S.TaggedStruct("PostgresServer", {
  service: CartridgeJob,
});
const ValkeyServerDeclaration = S.TaggedStruct("ValkeyServer", {
  service: CartridgeJob,
});

const PostgresEntry = S.Struct({
  database: DatabaseName,
  server: S.optionalKey(ResourceName),
  // Created in the database before migrations run. Each must be in the server's image.
  extensions: S.optionalKey(S.Array(ExtensionName)),
});

const ValkeyEntry = S.Struct({
  server: S.optionalKey(ResourceName),
  access: S.optionalKey(S.Literals(["read-only", "read-write"])),
});

export const Cartridge = S.Struct({
  apiVersion: S.Literals(["server-ansible/v2"]),
  name: AppName,
  servers: S.optionalKey(S.Array(S.Union([PostgresServerDeclaration, ValkeyServerDeclaration]))),
  postgres: S.optionalKey(S.Array(PostgresEntry)),
  valkey: S.optionalKey(ValkeyEntry),
  services: S.Array(CartridgeJob),
}).check(
  S.makeFilter((cartridge) => {
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
    const allJobs = declaredJobs(cartridge).map(({ job }) => job);
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
    const declaredJobNames = new Set(allJobs.map((job) => job.name));
    const undeclaredIssues = allJobs.flatMap((job) =>
      job.connections
        .filter((connection) => !declaredJobNames.has(connection.service))
        .map(
          (connection) =>
            `Service '${job.name}' connects to undeclared service '${connection.service}'`,
        ),
    );
    issues.push(...undeclaredIssues);
    const jobGraph = buildJobGraph(allJobs);
    if (!Graph.isAcyclic(jobGraph)) {
      const cycleIssues = Graph.stronglyConnectedComponents(jobGraph)
        .filter(
          (component) =>
            component.length > 1 ||
            (component.length === 1 && Graph.hasEdge(jobGraph, component[0], component[0])),
        )
        .map((component) => {
          const names = [...component].sort((a, b) => a - b).map((index) => allJobs[index].name);
          return `Services ${names.join(", ")} form a dependency cycle`;
        });
      issues.push(...cycleIssues);
    }
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
    identity: job.identity,
    storage: job.storage,
    readOnlyMounts: job.readOnlyMounts,
    node: job.node,
    routes: job.routes,
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
  const databaseResources = (cartridge.postgres ?? []).map((entry) => {
    const database = entry.database;
    const server = entry.server ?? "postgres";
    const props: PostgresDatabaseProps = {
      name: database,
      server,
      extensions: entry.extensions ?? [],
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

  return [...databaseResources, ...valkeyResource, ...orderedJobResources(cartridge)];
};

/** The folders under the Alchemy root that hold one cartridge each. */
export const cartridgeFolders = ["apps", "platform"] as const;

/**
 * Finds the cartridge named `name` under `root`, in `apps/<folder>/cartridge.json`
 * or `platform/<folder>/cartridge.json`. A folder's name need not match its
 * cartridge's name (platform/data holds platform-data), so every cartridge is read.
 */
export const find = Effect.fn("Cartridge.find")(function* (root: string, name: string) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Effect.forEach(cartridgeFolders, (folder) =>
    fs
      .readDirectory(`${root}/${folder}`)
      .pipe(
        Effect.map((entries) =>
          entries.map((entry) => `${root}/${folder}/${entry}/cartridge.json`),
        ),
      ),
  ).pipe(
    Effect.map((lists) => lists.flat()),
    Effect.flatMap(Effect.filter((path) => fs.exists(path))),
    Effect.mapError(
      (cause) =>
        new Config.ConfigError(
          new ConfigProvider.SourceError({
            message: `Could not list cartridges in '${root}'`,
            cause,
          }),
        ),
    ),
  );
  const cartridges = yield* Effect.forEach(paths, (path) =>
    decodeFile(path).pipe(Effect.map((cartridge) => ({ path, cartridge }))),
  );
  const found = cartridges.find((entry) => entry.cartridge.name === name);
  if (found === undefined) {
    const known = cartridges.map((entry) => entry.cartridge.name).join(", ");
    return yield* Effect.fail(
      new Config.ConfigError(
        new ConfigProvider.SourceError({
          message: `No cartridge named '${name}'. Known: ${known}`,
        }),
      ),
    );
  }
  return found;
});

/** Each OpenBao KV path the cartridge's services read, with the keys it reads there. */
export const kvKeys = (cartridge: Cartridge) => {
  const references = cartridge.services.flatMap((service) =>
    [...(service.secrets ?? []), ...(service.migrate?.secrets ?? [])].filter(
      (secret) => secret._tag === "KvSecret",
    ),
  );
  return new Map(
    [...new Set(references.map((reference) => reference.path))].map((path) => [
      path,
      [...new Set(references.filter((r) => r.path === path).map((r) => r.key))],
    ]),
  );
};

/** Read and validate one cartridge file. */
export const decodeFile = Effect.fn("Cartridge.decodeFile")(function* (path: string) {
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
  const cartridge = yield* S.decodeUnknownEffect(S.fromJsonString(Cartridge), {
    onExcessProperty: "error",
  })(contents).pipe(Effect.mapError((cause) => new Config.ConfigError(cause)));
  return cartridge;
});

/**
 * Jobs in dependency order. compose declares resources one at a time and wires a
 * job only to services declared before it, so each job must come after every job
 * it connects to.
 */
const orderedJobResources = (cartridge: Cartridge): ReadonlyArray<ExpandedResource> => {
  const jobs = declaredJobs(cartridge);
  const order = Graph.topo(buildJobGraph(jobs.map(({ job }) => job)));
  return [...Graph.values(order)].map(
    (index) =>
      ({
        _tag: jobs[index]._tag,
        service: toRenderedJob(cartridge, jobs[index].job),
      }) as ExpandedResource,
  );
};

/**
 * Every job with the resource kind it expands to, in declaration order: servers'
 * services, then services. Node indexes in buildJobGraph are positions in this list.
 */
const declaredJobs = (cartridge: {
  readonly servers?: ReadonlyArray<{
    readonly _tag: "PostgresServer" | "ValkeyServer";
    readonly service: CartridgeJob;
  }>;
  readonly services: ReadonlyArray<CartridgeJob>;
}) => [
  ...(cartridge.servers ?? []).map((server) => ({ _tag: server._tag, job: server.service })),
  ...cartridge.services.map((job) => ({ _tag: "NomadService" as const, job })),
];

// Graph.topo emits a node before its outgoing neighbours, so each edge runs from the
// connected-to job to the job that connects to it.
const buildJobGraph = (jobs: ReadonlyArray<CartridgeJob>): Graph.DirectedGraph<number, string> => {
  const indexByName = new Map<string, number>();
  jobs.forEach((job, index) => {
    if (!indexByName.has(job.name)) indexByName.set(job.name, index);
  });
  return Graph.directed<number, string>((mutable) => {
    const nodes = jobs.map((_, index) => Graph.addNode(mutable, index));
    jobs.forEach((job, index) => {
      for (const connection of job.connections) {
        const provider = indexByName.get(connection.service);
        if (provider !== undefined) {
          Graph.addEdge(mutable, nodes[provider], nodes[index], connection.service);
        }
      }
    });
  });
};
