import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Graph from "effect/Graph";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as S from "effect/Schema";
import {
  CartridgeEnvironmentEntry,
  CartridgeJob,
  CartridgeSecretReference,
  cartridgeArray,
  ExpandedJob,
  ExpandedSecretReference,
  ResourceName,
} from "./Job.ts";
import { ExtensionName, postgresRoles, PostgresDatabaseProps } from "./PostgresDatabase.ts";
import { ValkeyAccessConfig } from "./ValkeyAccess.ts";
import { adminCredentialPath } from "./AdminCredential.ts";
import { Deployments } from "./Deployments.ts";

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

/** One database a cartridge provisions: name, optional server, extensions, optional copy source. */
export const PostgresEntry = S.Struct({
  database: DatabaseName,
  server: S.optionalKey(ResourceName),
  // Created in the database before migrations run. Each must be in the server's image.
  extensions: cartridgeArray(ExtensionName),
  // A live database this one is created as a copy of. The copy has its own owner and visitor
  // roles; expand derives them from the copy's own database name, never from this one.
  copyFrom: S.optionalKey(DatabaseName),
});
export type PostgresEntry = typeof PostgresEntry.Type;

const ValkeyEntry = S.Struct({
  server: S.optionalKey(ResourceName),
  access: S.optionalKey(S.Literals(["read-only", "read-write"])),
});

export const Cartridge = S.Struct({
  apiVersion: S.Literals(["server-ansible/v2"]),
  name: AppName,
  servers: cartridgeArray(S.Union([PostgresServerDeclaration, ValkeyServerDeclaration])),
  postgres: cartridgeArray(PostgresEntry),
  valkey: S.optionalKey(ValkeyEntry),
  services: S.Array(CartridgeJob),
}).check(
  S.makeFilter((cartridge) => {
    const issues: Array<string> = [];
    if (
      cartridge.servers.length > 0 &&
      (cartridge.postgres.length > 0 || cartridge.valkey !== undefined)
    ) {
      issues.push("a cartridge cannot both declare servers and postgres/valkey");
    }
    const allJobNames = [
      ...cartridge.servers.map((server) => server.service.name),
      ...cartridge.services.map((service) => service.name),
    ];
    const duplicateJobNames = allJobNames.filter(
      (name, index) => allJobNames.indexOf(name) !== index,
    );
    issues.push(...duplicateJobNames.map((name) => `duplicate job name '${name}'`));
    const dbNames = cartridge.postgres.map((entry) => entry.database);
    const duplicateDbNames = dbNames.filter((name, index) => dbNames.indexOf(name) !== index);
    issues.push(...duplicateDbNames.map((name) => `duplicate database '${name}'`));
    const allJobs = declaredJobs(cartridge).map(({ job }) => job);
    const secretIssues = allJobs.flatMap((job) => {
      const jobSecrets = [...job.secrets, ...(job.migrate?.secrets ?? [])];
      return jobSecrets.flatMap((secret) => {
        const result: Array<string> = [];
        if (secret._tag === "PostgresCredentials") {
          const found = cartridge.postgres.some((entry) => entry.database === secret.database);
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
    const serverMigrateIssues = cartridge.servers
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
    const routeIssues = allJobs.flatMap((job) =>
      job.environment.flatMap((entry) => {
        if (!("route" in entry)) return [];
        const target = allJobs.find((candidate) => candidate.name === entry.route);
        if (target === undefined) {
          return [`Service '${job.name}' references undeclared tailnet route '${entry.route}'`];
        }
        return target.routes.some((route) => route.access === "tailnet")
          ? []
          : [`Service '${job.name}' references '${entry.route}', which has no tailnet route`];
      }),
    );
    issues.push(...undeclaredIssues, ...routeIssues);
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

/**
 * A cartridge that comes from an app's own repository. Every identity it declares that
 * grants access (Nomad job, and through it the OpenBao role `alchemy-<job>`; database
 * and its roles; KV path; host volume) must lie in the app's namespace, so the `name`
 * alone decides what the app can reach and one app's cartridge cannot claim another's.
 * Route hostnames cannot follow from the name and stay the operator's to review.
 * Platform cartridges declare shared identities (`postgres`, `traefik`) and are trusted
 * because they live in this repository.
 */
export const AppCartridge = Cartridge.check(
  S.makeFilter((cartridge) => {
    const issues = namespaceIssues(cartridge);
    return issues.length === 0 ? undefined : issues;
  }),
);

const namespaceIssues = (cartridge: Cartridge): ReadonlyArray<string> => {
  const app = cartridge.name;
  const appUnderscore = appIdentifier(app);
  const within = (value: string, prefix: string, separator: string) =>
    value === prefix || value.startsWith(`${prefix}${separator}`);
  const jobs = declaredJobs(cartridge).map(({ job }) => job);
  const kvPaths = jobs.flatMap((job) =>
    [...job.secrets, ...(job.migrate?.secrets ?? [])].flatMap((secret) =>
      secret._tag === "KvSecret" ? [secret.path] : [],
    ),
  );
  const volumes = jobs.flatMap((job) => [
    ...(job.storage === undefined ? [] : [job.storage.volume]),
    ...(job.readOnlyMounts ?? []).map((mount) => mount.volume),
  ]);
  return [
    ...cartridge.postgres
      .map((entry) => entry.database)
      .filter((database) => !within(database, appUnderscore, "_"))
      .map((database) => `Database '${database}' must equal or start with '${appUnderscore}_'`),
    ...jobs
      .filter((job) => !within(job.name, app, "-"))
      .map((job) => `Service '${job.name}' must equal or start with '${app}-'`),
    ...[...new Set(kvPaths)]
      .filter((path) => !within(path, `secret/data/${app}`, "/"))
      .map((path) => `KV path '${path}' must equal or start with 'secret/data/${app}/'`),
    ...[...new Set(volumes)]
      .filter((volume) => !within(volume, app, "-"))
      .map((volume) => `Volume '${volume}' must equal or start with '${app}-'`),
  ];
};

export type ExpandedResource =
  | { readonly _tag: "PostgresServer"; readonly service: ExpandedJob }
  | { readonly _tag: "ValkeyServer"; readonly service: ExpandedJob }
  | { readonly _tag: "NomadService"; readonly service: ExpandedJob }
  | { readonly _tag: "PostgresDatabase"; readonly database: PostgresDatabaseProps }
  | { readonly _tag: "ValkeyAccess"; readonly access: ValkeyAccessConfig }
  | { readonly _tag: "TailscaleServe"; readonly serviceName: string };

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

/**
 * The value one cartridge environment entry becomes in a rendered task: a literal value stands
 * as it is, and a database role resolves through the one role-name convention, so no cartridge
 * ever spells a role name.
 */
const environmentValue = (entry: CartridgeEnvironmentEntry) =>
  "value" in entry
    ? entry
    : "database" in entry
      ? { name: entry.name, value: postgresRoles(entry.database)[entry.role] }
      : entry;

const toRenderedJob = (cartridge: Cartridge, job: CartridgeJob): ExpandedJob => {
  const secrets = job.secrets.map((secret) => mapSecret(cartridge, secret));
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
    placement: job.placement,
    routes: job.routes,
    environment: job.environment.map(environmentValue),
    command: job.command,
    args: job.args,
    connections: job.connections,
    secrets: secrets.length === 0 ? undefined : secrets,
    migrate,
  };
  return rendered;
};

export const expand = (cartridge: Cartridge): ReadonlyArray<ExpandedResource> => {
  const databaseResources = cartridge.postgres.map((entry) => {
    const database = entry.database;
    const server = entry.server ?? "postgres";
    const roles = postgresRoles(database);
    const props: PostgresDatabaseProps = {
      name: database,
      server,
      extensions: entry.extensions,
      adminUsername: "postgres",
      adminCredential: {
        _tag: "KvSecret",
        path: adminCredentialPath("postgres", server),
        key: "password",
        env: "POSTGRES_PASSWORD",
      },
      ownerRole: roles.owner,
      visitorRole: roles.visitor,
      copyFrom: entry.copyFrom,
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

/**
 * The cartridge a stage named `name` deploys. A platform cartridge is read from
 * `platform/<folder>/cartridge.json` under `root`; a folder's name need not match its
 * cartridge's name (platform/data holds platform-data). Any other name is an app, whose
 * cartridge lives in its own repository: the file in CARTRIDGE_FILE when `ops` sent one,
 * otherwise the newest deployment recorded on this host.
 */
export const resolve = Effect.fn("Cartridge.resolve")(function* (root: string, name: string) {
  const platform = yield* findPlatform(root, name);
  if (Option.isSome(platform)) return platform.value;
  const sent = yield* Config.option(Config.String("CARTRIDGE_FILE"));
  const cartridge = yield* Option.match(sent, {
    onSome: (path) => decodeFile(path, AppCartridge),
    onNone: () =>
      Effect.gen(function* () {
        const deployments = yield* Deployments;
        const latest = yield* deployments.latest(name).pipe(Effect.mapError(configError));
        return yield* Option.match(latest, {
          onSome: (deployment) => decodeText(deployment.cartridge, AppCartridge),
          onNone: () =>
            Effect.fail(
              configError(
                `'${name}' is no platform cartridge and has no recorded deployment; run \`ops release\` in its repository first`,
              ),
            ),
        });
      }),
  });
  if (cartridge.name !== name) {
    return yield* Effect.fail(
      configError(`stage '${name}' was given the cartridge of '${cartridge.name}'`),
    );
  }
  return cartridge;
});

const findPlatform = Effect.fn("Cartridge.findPlatform")(function* (root: string, name: string) {
  const fs = yield* FileSystem.FileSystem;
  const folders = yield* fs
    .readDirectory(`${root}/platform`)
    .pipe(Effect.mapError((cause) => configError(`Could not list cartridges in '${root}'`, cause)));
  const paths = yield* Effect.filter(
    folders.map((folder) => `${root}/platform/${folder}/cartridge.json`),
    (path) => fs.exists(path).pipe(Effect.orElseSucceed(() => false)),
  );
  const cartridges = yield* Effect.forEach(paths, (path) => decodeFile(path, Cartridge));
  return Option.fromNullishOr(cartridges.find((cartridge) => cartridge.name === name));
});

/** Each OpenBao KV path the cartridge's services read, with the keys it reads there. */
export const kvKeys = (cartridge: Cartridge) => {
  const references = cartridge.services.flatMap((service) =>
    [...service.secrets, ...(service.migrate?.secrets ?? [])].filter(
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

/**
 * Each KV path and key the cartridge reads that is not in `stored`, the key names stored at
 * each path. A task waits on its template forever for such a key.
 */
export const missingSecrets = (
  cartridge: Cartridge,
  stored: ReadonlyMap<string, ReadonlyArray<string>>,
) =>
  [...kvKeys(cartridge)].flatMap(([path, keys]) =>
    keys.filter((key) => !(stored.get(path) ?? []).includes(key)).map((key) => ({ path, key })),
  );

/** Read one cartridge file and validate it against `schema`: AppCartridge or Cartridge. */
export const decodeFile = Effect.fn("Cartridge.decodeFile")(function* (
  path: string,
  schema: typeof Cartridge,
) {
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
  return yield* decodeText(contents, schema);
});

/** Validate one cartridge document against `schema`: AppCartridge or Cartridge. */
export const decodeText = (contents: string, schema: typeof Cartridge) =>
  S.decodeUnknownEffect(S.fromJsonString(schema), { onExcessProperty: "error" })(contents).pipe(
    Effect.mapError((cause) => new Config.ConfigError(cause)),
  );

const configError = (message: unknown, cause?: unknown) =>
  new Config.ConfigError(
    new ConfigProvider.SourceError({
      message: typeof message === "string" ? message : String(message),
      cause: cause ?? (typeof message === "string" ? undefined : message),
    }),
  );

/**
 * Jobs in dependency order. compose declares resources one at a time and wires a
 * job only to services declared before it, so each job must come after every job
 * it connects to.
 */
const orderedJobResources = (cartridge: Cartridge): ReadonlyArray<ExpandedResource> => {
  const jobs = declaredJobs(cartridge);
  const order = Graph.topo(buildJobGraph(jobs.map(({ job }) => job)));
  return [...Graph.values(order)].flatMap((index) => {
    const { _tag, job } = jobs[index];
    const service = toRenderedJob(cartridge, job);
    const serveResources: ReadonlyArray<ExpandedResource> = job.routes.some(
      (route) => route.access === "tailnet",
    )
      ? [{ _tag: "TailscaleServe", serviceName: job.name }]
      : [];
    const jobResource = Match.value(_tag).pipe(
      Match.when(
        "PostgresServer",
        () => ({ _tag: "PostgresServer", service }) satisfies ExpandedResource,
      ),
      Match.when(
        "ValkeyServer",
        () => ({ _tag: "ValkeyServer", service }) satisfies ExpandedResource,
      ),
      Match.when(
        "NomadService",
        () => ({ _tag: "NomadService", service }) satisfies ExpandedResource,
      ),
      Match.exhaustive,
    );
    return [...serveResources, jobResource];
  });
};

/**
 * Every job with the resource kind it expands to, in declaration order: servers'
 * services, then services. Node indexes in buildJobGraph are positions in this list.
 */
const declaredJobs = (cartridge: {
  readonly servers: ReadonlyArray<{
    readonly _tag: "PostgresServer" | "ValkeyServer";
    readonly service: CartridgeJob;
  }>;
  readonly services: ReadonlyArray<CartridgeJob>;
}) => [
  ...cartridge.servers.map((server) => ({ _tag: server._tag, job: server.service })),
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
      const dependencies = [
        ...job.connections.map((connection) => connection.service),
        ...job.environment.flatMap((entry) =>
          "route" in entry && entry.route !== job.name ? [entry.route] : [],
        ),
      ];
      for (const dependency of dependencies) {
        const provider = indexByName.get(dependency);
        if (provider !== undefined) {
          Graph.addEdge(mutable, nodes[provider], nodes[index], dependency);
        }
      }
    });
  });
};
