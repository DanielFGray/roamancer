import { Effect, Schema as S } from "effect";
import * as Match from "effect/Match";

export const ResourceName = S.String.check(S.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/));
const EnvironmentVariable = S.String.check(S.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/));
const SecretPath = S.String.check(
  S.isPattern(/^secret\/data\/[A-Za-z0-9][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.-]*)*$/),
);
const DatabaseCredentialPath = S.String.check(S.isPattern(/^database\/creds\/[A-Za-z0-9_.-]+$/));
const SecretKey = S.String.check(S.isPattern(/^[A-Za-z0-9_-]+$/));
export const DatabaseIdentifier = S.String.check(S.isPattern(/^[a-z][a-z0-9_]{0,62}$/));
export const ServiceConnection = S.Struct({
  service: ResourceName,
  hostEnv: EnvironmentVariable,
  portEnv: EnvironmentVariable,
});
export type ServiceConnection = typeof ServiceConnection.Type;

export const HealthCheck = S.Union([
  S.Struct({
    type: S.Literals(["http"]),
    path: S.String.check(S.isPattern(/^\/[A-Za-z0-9_./-]*$/)),
  }),
  S.Struct({ type: S.Literals(["tcp"]) }),
]);
export type HealthCheck = typeof HealthCheck.Type;

// Public routes carry host routing details. A tailnet route carries none: Tailscale Serve gives it
// an HTTPS port on the control host and Traefik finds the job by name (see `tailnetPath`).
const RouteHost = S.String.check(
  S.isPattern(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/),
);
const PublicRoute = S.Struct({
  access: S.Literals(["public"]).pipe(S.withDecodingDefaultKey(Effect.succeed("public" as const))),
  host: RouteHost,
  pathPrefixes: S.optionalKey(S.NonEmptyArray(S.String.check(S.isPattern(/^\/[A-Za-z0-9_./-]*$/)))),
  responseHeaders: S.optionalKey(
    S.Array(S.Struct({ name: S.String.check(S.isPattern(/^[A-Za-z0-9-]+$/)), value: S.String })),
  ),
});
const TailnetRoute = S.Struct({ access: S.Literals(["tailnet"]) });
export const Route = S.Union([PublicRoute, TailnetRoute]);
export type Route = typeof Route.Type;

export const KvSecretReference = S.TaggedStruct("KvSecret", {
  path: SecretPath,
  key: SecretKey,
  env: EnvironmentVariable,
});
/** One key at a KV v2 path that a resource reads at deploy time; no job receives it. */
export const KvKey = S.Struct({ path: SecretPath, key: SecretKey });
export type KvKey = typeof KvKey.Type;
const PostgresUrlReference = S.Struct({
  env: EnvironmentVariable,
  server: ResourceName,
  database: DatabaseIdentifier,
});
const PostgresCredentialsReference = S.TaggedStruct("PostgresCredentials", {
  role: ResourceName,
  credentialPath: DatabaseCredentialPath,
  usernameEnv: S.optionalKey(EnvironmentVariable),
  passwordEnv: S.optionalKey(EnvironmentVariable),
  url: S.optionalKey(PostgresUrlReference),
});
const ValkeyUrlReference = S.Struct({
  env: EnvironmentVariable,
  server: ResourceName,
});
const ValkeyCredentialsReference = S.TaggedStruct("ValkeyCredentials", {
  access: S.String.check(S.isPattern(/^[a-z][a-z0-9_]{0,39}$/)),
  credentialPath: SecretPath,
  usernameEnv: S.optionalKey(EnvironmentVariable),
  passwordEnv: S.optionalKey(EnvironmentVariable),
  url: S.optionalKey(ValkeyUrlReference),
});

// The bucket, its region and the key live together at `credentialPath` (GarageBucket.ts), so a
// rendered task reads them from one place; only the S3 endpoint comes from Nomad.
const ObjectStoreCredentialsReference = S.TaggedStruct("ObjectStoreCredentials", {
  access: ResourceName,
  credentialPath: SecretPath,
  server: ResourceName,
  ...objectStoreEnvFields(),
});
export const SecretReference = S.Union([
  KvSecretReference,
  PostgresCredentialsReference,
  ValkeyCredentialsReference,
  ObjectStoreCredentialsReference,
]);
export type SecretReference = typeof SecretReference.Type;

const atLeastOneEnvironmentVariable = S.makeFilter(
  (value: { usernameEnv?: string; passwordEnv?: string; urlEnv?: string }) =>
    value.usernameEnv === undefined && value.passwordEnv === undefined && value.urlEnv === undefined
      ? "at least one environment variable is required"
      : undefined,
);

export const ValkeyCredentialsDeclaration = S.TaggedStruct("ValkeyCredentials", {
  usernameEnv: S.optionalKey(EnvironmentVariable),
  passwordEnv: S.optionalKey(EnvironmentVariable),
  urlEnv: S.optionalKey(EnvironmentVariable),
}).check(atLeastOneEnvironmentVariable);
/** The environment names an object store credential may render; each is optional. */
function objectStoreEnvFields() {
  return {
    endpointEnv: S.optionalKey(EnvironmentVariable),
    regionEnv: S.optionalKey(EnvironmentVariable),
    bucketEnv: S.optionalKey(EnvironmentVariable),
    accessKeyIdEnv: S.optionalKey(EnvironmentVariable),
    secretAccessKeyEnv: S.optionalKey(EnvironmentVariable),
  };
}

const atLeastOneObjectStoreEnv = S.makeFilter((value: Record<string, unknown>) =>
  Object.keys(objectStoreEnvFields()).some((key) => value[key] !== undefined)
    ? undefined
    : "at least one environment variable is required",
);

export const ObjectStoreCredentialsDeclaration = S.TaggedStruct(
  "ObjectStoreCredentials",
  objectStoreEnvFields(),
).check(atLeastOneObjectStoreEnv);
export const PostgresCredentialsDeclaration = S.TaggedStruct("PostgresCredentials", {
  database: DatabaseIdentifier,
  login: S.Literals(["api", "migration"]),
  usernameEnv: S.optionalKey(EnvironmentVariable),
  passwordEnv: S.optionalKey(EnvironmentVariable),
  urlEnv: S.optionalKey(EnvironmentVariable),
}).check(atLeastOneEnvironmentVariable);
export const CartridgeSecretReference = S.Union([
  KvSecretReference,
  PostgresCredentialsDeclaration,
  ValkeyCredentialsDeclaration,
  ObjectStoreCredentialsDeclaration,
]);
export type CartridgeSecretReference = typeof CartridgeSecretReference.Type;

export const workloadRole = (jobName: string) => `alchemy-${jobName}`;

export const secretPolicyPath = (secret: SecretReference) =>
  Match.value(secret).pipe(
    Match.when({ _tag: "KvSecret" }, (value) => value.path),
    Match.when({ _tag: "PostgresCredentials" }, (value) => value.credentialPath),
    Match.when({ _tag: "ValkeyCredentials" }, (value) => value.credentialPath),
    Match.when({ _tag: "ObjectStoreCredentials" }, (value) => value.credentialPath),
    Match.exhaustive,
  );

/** The OpenBao paths a job reads, across its service task and its migration task, for its one workload role. */
export const secretPolicyPaths = (job: Job) =>
  [...(job.secrets ?? []), ...(job.migrate?.secrets ?? [])].map(secretPolicyPath);

const Port = S.Number.check(S.isInt(), S.isGreaterThan(0), S.isLessThanOrEqualTo(65_535));

/**
 * A port beside the job's service port. It gets a dynamic host port, and Nomad registers it as
 * the service `portServiceName(job, name)`, so a job can serve one API to apps and another to
 * the platform. `service` is the label of the main port.
 */
const NamedPort = S.Struct({
  name: S.String.check(
    S.isPattern(/^[a-z][a-z0-9]{0,15}$/),
    S.makeFilter((name) => (name === "service" ? 'must not be "service"' : undefined)),
  ),
  containerPort: Port,
});
type NamedPort = typeof NamedPort.Type;

/** The Nomad service that a job's named port registers. */
export const portServiceName = (job: string, port: string) => `${job}-${port}`;

const Storage = S.Struct({
  volume: ResourceName,
  mountPath: S.String.check(S.isPattern(/^\/[A-Za-z0-9_./-]+$/)),
});

// Where Nomad runs the job. Without a placement, Nomad picks any eligible node, and a host
// volume still keeps a stateful job on the machine that holds the volume.
export const Placement = S.Union([
  // One copy on each node, such as an agent that serves the node it runs on.
  S.TaggedStruct("EveryNode", {}),
  // Only the node with this Nomad agent `name`, such as the machine with a public address.
  S.TaggedStruct("Node", { name: S.NonEmptyString }),
]);
export type Placement = typeof Placement.Type;

/**
 * An array a cartridge file may leave out: an absent list decodes as empty, so the code that
 * reads a cartridge never tests for the key. The runtime schemas keep their arrays optional,
 * because Compose drops a list that resolves to nothing.
 */
export const cartridgeArray = <A extends S.Constraint>(schema: A) =>
  S.Array(schema).pipe(S.withDecodingDefaultKey(Effect.succeed([])));

/**
 * One entry of a cartridge job's `environment`: a literal value, a role of one of the
 * cartridge's databases, a tailnet route, or the cartridge's Valkey key prefix. A cartridge never
 * spells a role name or a key prefix; it names what it wants, and `Cartridge.expand` resolves
 * that to the value of that instance, so a staged copy gets its own.
 */
export const CartridgeEnvironmentEntry = S.Union([
  S.Struct({ name: EnvironmentVariable, value: S.String }),
  S.Struct({
    name: EnvironmentVariable,
    database: DatabaseIdentifier,
    role: S.Literals(["owner", "visitor"]),
  }),
  S.Struct({ name: EnvironmentVariable, route: ResourceName }),
  S.Struct({ name: EnvironmentVariable, valkey: S.Literals(["keyPrefix"]) }),
]);
export type CartridgeEnvironmentEntry = typeof CartridgeEnvironmentEntry.Type;

/** One entry of a rendered job's `environment`: the name and value the task sees. */
const EnvironmentValue = S.Union([
  S.Struct({ name: EnvironmentVariable, value: S.String }),
  S.Struct({ name: EnvironmentVariable, route: ResourceName }),
]);

const JobBaseFields = {
  name: ResourceName,
  image: S.String,
  hostPort: S.Union([
    S.Literals(["dynamic"]),
    S.Number.check(S.isInt(), S.isGreaterThan(0), S.isLessThanOrEqualTo(65_535)),
  ]),
  containerPort: Port,
  ports: S.optionalKey(S.Array(NamedPort)),
  healthCheck: S.optionalKey(HealthCheck),
  cpu: S.Number.check(S.isInt(), S.isGreaterThan(0)),
  memoryMB: S.Number.check(S.isInt(), S.isGreaterThan(0)),
  networkMode: S.Literals(["bridge", "pasta", "host"]),
  identity: S.optionalKey(S.Struct({ env: S.Boolean })),
  storage: S.optionalKey(Storage),
  readOnlyMounts: S.optionalKey(S.Array(Storage)),
  placement: S.optionalKey(Placement),
  routes: S.optionalKey(S.Array(Route)),
  command: S.optionalKey(S.String),
  args: S.optionalKey(S.Array(S.String)),
  connections: S.Array(ServiceConnection),
};

export const ExpandedPostgresCredentials = S.TaggedStruct("PostgresCredentials", {
  role: ResourceName,
  usernameEnv: S.optionalKey(EnvironmentVariable),
  passwordEnv: S.optionalKey(EnvironmentVariable),
  url: S.optionalKey(S.Struct({ env: EnvironmentVariable })),
});
export const ExpandedValkeyCredentials = S.TaggedStruct("ValkeyCredentials", {
  access: S.String.check(S.isPattern(/^[a-z][a-z0-9_]{0,39}$/)),
  usernameEnv: S.optionalKey(EnvironmentVariable),
  passwordEnv: S.optionalKey(EnvironmentVariable),
  url: S.optionalKey(S.Struct({ env: EnvironmentVariable })),
});
export const ExpandedObjectStoreCredentials = S.TaggedStruct("ObjectStoreCredentials", {
  access: ResourceName,
  ...objectStoreEnvFields(),
});
export const ExpandedSecretReference = S.Union([
  KvSecretReference,
  ExpandedPostgresCredentials,
  ExpandedValkeyCredentials,
  ExpandedObjectStoreCredentials,
]);
export type ExpandedSecretReference = typeof ExpandedSecretReference.Type;

/**
 * A step that runs to completion in the service image before the service starts, with its own
 * secrets. The secrets field itself is a parameter: a cartridge file may leave it out, so the
 * cartridge schema decodes an absent list as empty, while the runtime schemas Compose builds
 * keep it optional and drop a list that resolves to nothing.
 */
const migrateStep = <S extends S.Constraint>(secrets: S) =>
  S.Struct({
    command: S.optionalKey(S.String),
    args: S.optionalKey(S.Array(S.String)),
    secrets,
  });

const atMostOneTailnetRoute = S.makeFilter((job: { routes?: ReadonlyArray<Route> }) =>
  (job.routes?.filter((route) => route.access === "tailnet").length ?? 0) > 1
    ? "a job may have at most one tailnet route"
    : undefined,
);

const hostNetworkPorts = S.makeFilter(
  (job: {
    networkMode: string;
    hostPort: string | number;
    containerPort: number;
    ports?: ReadonlyArray<NamedPort>;
    routes?: ReadonlyArray<Route>;
  }) => {
    if (job.networkMode === "host" && job.routes?.some((route) => route.access === "tailnet")) {
      return "tailnet routes require bridge or pasta networking";
    }
    if (job.networkMode === "host" && (job.ports?.length ?? 0) > 0) {
      return "named ports require bridge or pasta networking";
    }
    return job.networkMode === "host" && job.hostPort !== job.containerPort
      ? "host networking requires a fixed hostPort equal to containerPort"
      : undefined;
  },
);

export const ExpandedJob = S.Struct({
  ...JobBaseFields,
  environment: S.Array(EnvironmentValue),
  secrets: S.optionalKey(S.Array(ExpandedSecretReference)),
  migrate: S.optionalKey(migrateStep(S.optionalKey(S.Array(ExpandedSecretReference)))),
}).check(hostNetworkPorts, atMostOneTailnetRoute);
export type ExpandedJob = typeof ExpandedJob.Type;

export const Job = S.Struct({
  ...JobBaseFields,
  environment: S.Array(S.Struct({ name: EnvironmentVariable, value: S.String })),
  secrets: S.optionalKey(S.Array(SecretReference)),
  migrate: S.optionalKey(migrateStep(S.optionalKey(S.Array(SecretReference)))),
}).check(hostNetworkPorts, atMostOneTailnetRoute);
export type Job = typeof Job.Type;

/**
 * What a cartridge file says about one job. It may leave `routes`, `secrets` and migrate
 * `secrets` out, and it states the environment as literal values or database roles, so those
 * keys are decoded rather than left optional.
 */
export const CartridgeJob = S.Struct({
  ...JobBaseFields,
  environment: S.Array(CartridgeEnvironmentEntry),
  routes: cartridgeArray(Route),
  secrets: cartridgeArray(CartridgeSecretReference),
  migrate: S.optionalKey(migrateStep(cartridgeArray(CartridgeSecretReference))),
}).check(hostNetworkPorts, atMostOneTailnetRoute);
export type CartridgeJob = typeof CartridgeJob.Type;

// Ends each environment line in a rendered template. A trim marker (`{{-`) strips the template
// text before it, so a plain newline would be lost to the next block's `{{- with` and two
// variables would share a line. The output of an action is never trimmed.
const lineEnd = '{{ "\\n" }}';

const toServiceTemplate = (connections: ReadonlyArray<ServiceConnection>) => ({
  DestPath: "secrets/services.env",
  Envvars: true,
  ChangeMode: "restart",
  EmbeddedTmpl: connections
    .map((connection) =>
      [
        '{{- range nomadService "' + connection.service + '" -}}',
        connection.hostEnv + "={{ .Address }}" + lineEnd,
        connection.portEnv + "={{ .Port }}" + lineEnd,
        "{{- end }}",
      ].join("\n"),
    )
    .join("\n"),
});

/**
 * Assemble a PostgreSQL URL from the dynamic credential and the Nomad service address.
 * The password is written into the URL unescaped, so it must use URL-safe characters.
 * The generated passwords are alphanumeric, but that is an assumption about OpenBao's
 * generator, not a check. Confirm it on the first live credential before relying on the URL.
 */
const postgresUrlLines = (url: typeof PostgresUrlReference.Type) => [
  "{{- $username := .Data.username }}",
  "{{- $password := .Data.password }}",
  '{{- range nomadService "' + url.server + '" }}',
  url.env +
    '={{ printf "postgresql://%s:%s@%s:%d/' +
    url.database +
    '?sslmode=disable" $username $password .Address .Port | toJSON }}' +
    lineEnd,
  "{{- end }}",
];

// ValkeyAccess and the admin credential hex-encode their passwords, so the URL needs no escaping.
const valkeyUrlLines = (url: typeof ValkeyUrlReference.Type) => [
  "{{- $username := .Data.data.username }}",
  "{{- $password := .Data.data.password }}",
  '{{- range nomadService "' + url.server + '" }}',
  url.env +
    '={{ printf "redis://%s:%s@%s:%d" $username $password .Address .Port | toJSON }}' +
    lineEnd,
  "{{- end }}",
];

const objectStoreLines = (value: typeof ObjectStoreCredentialsReference.Type) => [
  ...(value.endpointEnv === undefined
    ? []
    : [
        '{{- range nomadService "' + value.server + '" }}',
        value.endpointEnv + '={{ printf "http://%s:%d" .Address .Port | toJSON }}' + lineEnd,
        "{{- end }}",
      ]),
  ...(
    [
      [value.regionEnv, "region"],
      [value.bucketEnv, "bucket"],
      [value.accessKeyIdEnv, "accessKeyId"],
      [value.secretAccessKeyEnv, "secretAccessKey"],
    ] as const
  ).flatMap(([env, key]) =>
    env === undefined ? [] : [env + "={{ .Data.data." + key + " | toJSON }}" + lineEnd],
  ),
];

const toSecretTemplate = (secrets: ReadonlyArray<SecretReference>) => ({
  DestPath: "secrets/openbao.env",
  Envvars: true,
  ChangeMode: "restart",
  EmbeddedTmpl: secrets
    .map((secret) =>
      Match.value(secret).pipe(
        Match.when({ _tag: "KvSecret" }, (value) =>
          [
            '{{- with secret "' + value.path + '" -}}',
            value.env + '={{ index .Data.data "' + value.key + '" | toJSON }}' + lineEnd,
            "{{- end }}",
          ].join("\n"),
        ),
        Match.when({ _tag: "PostgresCredentials" }, (value) =>
          [
            '{{- with secret "' + value.credentialPath + '" -}}',
            ...(value.usernameEnv === undefined
              ? []
              : [value.usernameEnv + "={{ .Data.username | toJSON }}" + lineEnd]),
            ...(value.passwordEnv === undefined
              ? []
              : [value.passwordEnv + "={{ .Data.password | toJSON }}" + lineEnd]),
            ...(value.url === undefined ? [] : postgresUrlLines(value.url)),
            "{{- end }}",
          ].join("\n"),
        ),
        Match.when({ _tag: "ValkeyCredentials" }, (value) =>
          [
            '{{- with secret "' + value.credentialPath + '" -}}',
            ...(value.usernameEnv === undefined
              ? []
              : [value.usernameEnv + "={{ .Data.data.username | toJSON }}" + lineEnd]),
            ...(value.passwordEnv === undefined
              ? []
              : [value.passwordEnv + "={{ .Data.data.password | toJSON }}" + lineEnd]),
            ...(value.url === undefined ? [] : valkeyUrlLines(value.url)),
            "{{- end }}",
          ].join("\n"),
        ),
        Match.when({ _tag: "ObjectStoreCredentials" }, (value) =>
          [
            '{{- with secret "' + value.credentialPath + '" -}}',
            ...objectStoreLines(value),
            "{{- end }}",
          ].join("\n"),
        ),
        Match.exhaustive,
      ),
    )
    .join("\n"),
});

const toNetwork = (job: Job) => {
  const named = (job.ports ?? []).map((port) => ({ Label: port.name, To: port.containerPort }));
  return job.hostPort === "dynamic"
    ? { DynamicPorts: [{ Label: "service", To: job.containerPort }, ...named] }
    : {
        ReservedPorts: [
          {
            Label: "service",
            Value: job.hostPort,
            To: job.networkMode === "host" ? undefined : job.containerPort,
          },
        ],
        ...(named.length === 0 ? {} : { DynamicPorts: named }),
      };
};

const toHealthCheck = (healthCheck: HealthCheck) =>
  healthCheck.type === "http"
    ? {
        Name: "health",
        Type: "http",
        Path: healthCheck.path,
        Interval: 10_000_000_000,
        Timeout: 5_000_000_000,
        OnUpdate: "require_healthy",
      }
    : {
        Name: "health",
        Type: "tcp",
        Interval: 10_000_000_000,
        Timeout: 5_000_000_000,
        OnUpdate: "require_healthy",
      };

/** Render one workload job. Service references and secret paths are metadata, not values. */
// Nomad fails a deployment that does not progress within this time; NomadJob waits for that verdict.
export const progressDeadlineMillis = 600_000;

export const toJobSpec = (job: Job, owner: string) => {
  const serverTask = toTask(job, {
    name: "server",
    ports: ["service", ...(job.ports ?? []).map((port) => port.name)],
    command: job.command,
    args: job.args,
    secrets: job.secrets ?? [],
    templates: job.connections.length === 0 ? [] : [toServiceTemplate(job.connections)],
  });
  // Nomad runs a non-sidecar prestart task to completion before the server task
  // starts, on every allocation start; if it fails, the server task never starts.
  const migrateTasks =
    job.migrate === undefined
      ? []
      : [
          {
            ...toTask(job, {
              name: "migrate",
              ports: [],
              command: job.migrate.command,
              args: job.migrate.args,
              secrets: job.migrate.secrets ?? [],
              templates: [],
            }),
            Lifecycle: { Hook: "prestart" as const, Sidecar: false },
          },
        ];
  const tasks = [...migrateTasks, serverTask];

  return {
    ID: job.name,
    Name: job.name,
    ...toScheduling(job.placement),
    Datacenters: ["dc1"],
    Meta: { "alchemy.owner": owner, "alchemy.provider": "Nomad.Job" },
    TaskGroups: [
      {
        Name: "service",
        Count: 1,
        Networks: [toNetwork(job)],
        Volumes: Object.fromEntries(
          toMounts(job).map((mount) => [
            mount.name,
            {
              Name: mount.name,
              Type: "host",
              Source: mount.volume,
              ReadOnly: mount.readOnly,
            },
          ]),
        ),
        Services: [
          {
            Name: job.name,
            PortLabel: "service",
            Provider: "nomad",
            Tags: routeTags(job),
            Checks: job.healthCheck === undefined ? undefined : [toHealthCheck(job.healthCheck)],
          },
          ...(job.ports ?? []).map((port) => ({
            Name: portServiceName(job.name, port.name),
            PortLabel: port.name,
            Provider: "nomad",
            Tags: [],
            Checks: undefined,
          })),
        ],
        Tasks: tasks,
      },
    ],
    Update: {
      MaxParallel: 1,
      HealthCheck: "checks",
      MinHealthyTime: 10_000_000_000,
      HealthyDeadline: 180_000_000_000,
      ProgressDeadline: progressDeadlineMillis * 1_000_000,
      AutoRevert: true,
    },
  };
};

// Nomad's system scheduler runs one allocation on each eligible node; its service scheduler
// places Count allocations wherever the constraints allow.
export const toScheduling = (placement: Placement | undefined) =>
  placement === undefined
    ? { Type: "service" as const, Constraints: undefined }
    : Match.value(placement).pipe(
        Match.tagsExhaustive({
          EveryNode: () => ({ Type: "system" as const, Constraints: undefined }),
          Node: ({ name }) => ({
            Type: "service" as const,
            Constraints: [{ LTarget: "${node.unique.name}", RTarget: name, Operand: "=" }],
          }),
        }),
      );

const toMounts = (job: Job) => [
  ...(job.storage === undefined ? [] : [{ ...job.storage, name: "data", readOnly: false }]),
  ...(job.readOnlyMounts ?? []).map((mount, index) => ({
    ...mount,
    name: `readonly-${index}`,
    readOnly: true,
  })),
];

// The platform's OpenTelemetry collector holds OTLP/HTTP's standard port on every node
// (platform/observability/cartridge.json). Inside a rootless Podman container the node's LAN address
// is the container's own, so a task reaches the host only through host.containers.internal. The
// value never changes, so no job restarts when the collector does. An app exports only the signals
// its own OTEL_<SIGNAL>_EXPORTER variables turn on.
const otlpEndpoint = "http://host.containers.internal:4318";

const toTask = (
  job: Job,
  task: {
    readonly name: string;
    readonly ports: ReadonlyArray<string>;
    readonly command: string | undefined;
    readonly args: ReadonlyArray<string> | undefined;
    readonly secrets: ReadonlyArray<SecretReference>;
    readonly templates: ReadonlyArray<ReturnType<typeof toServiceTemplate>>;
  },
) => ({
  Name: task.name,
  Driver: "podman" as const,
  Config: {
    image: job.image,
    network_mode: job.networkMode,
    ports: job.networkMode === "host" || task.ports.length === 0 ? undefined : task.ports,
    command: task.command,
    args: task.args,
  },
  Identity: job.identity === undefined ? undefined : { Env: job.identity.env },
  Env: {
    OTEL_EXPORTER_OTLP_ENDPOINT: otlpEndpoint,
    ...Object.fromEntries(job.environment.map((variable) => [variable.name, variable.value])),
  },
  VolumeMounts: toMounts(job).map((mount) => ({
    Volume: mount.name,
    Destination: mount.mountPath,
    ReadOnly: mount.readOnly,
  })),
  Resources: { CPU: job.cpu, MemoryMB: job.memoryMB },
  Vault:
    task.secrets.length === 0
      ? undefined
      : { Role: workloadRole(job.name), Env: false, DisableFile: true },
  Templates: task.templates.concat(
    task.secrets.length === 0 ? [] : [toSecretTemplate(task.secrets)],
  ),
});

/**
 * The Traefik entrypoint that serves tailnet routes: plain HTTP on the ingress node, which only
 * the control host's Tailscale Serve reaches (platform/ingress/cartridge.json and its README).
 */
export const tailnetEntrypoint = { name: "tailnet", port: 18081 } as const;

/**
 * The path that Tailscale Serve puts before each request of a job's tailnet route. Every Serve
 * port sends the same Host to Traefik, so the path tells the routes apart; Traefik strips it.
 */
export const tailnetPath = (job: string) => `/_tailnet/${job}/`;

/**
 * The Traefik tags for a job's routes. Traefik's Nomad provider reads them from the service
 * registration, so a route follows the allocation's address and port with no reconcile.
 * Nomad registers a service before it is ready, so a job with an HTTP check has Traefik
 * check the same path too.
 */
export const routeTags = (job: Job): ReadonlyArray<string> => {
  const routes = job.routes ?? [];
  if (routes.length === 0) return [];
  const service = job.name;
  const healthTags =
    job.healthCheck?.type === "http"
      ? [
          `traefik.http.services.${service}.loadbalancer.healthcheck.path=${job.healthCheck.path}`,
          `traefik.http.services.${service}.loadbalancer.healthcheck.interval=5s`,
        ]
      : [];
  const routerTags = routes.flatMap((route, index) =>
    route.access === "public"
      ? publicRouterTags(service, `${service}-${index}`, route)
      : tailnetRouterTags(service),
  );
  return ["traefik.enable=true", ...healthTags, ...routerTags];
};

const publicRouterTags = (
  service: string,
  router: string,
  route: Extract<Route, { access: "public" }>,
) => {
  const paths = route.pathPrefixes?.map((prefix) => `PathPrefix(\`${prefix}\`)`) ?? [];
  const rule =
    paths.length === 0
      ? `Host(\`${route.host}\`)`
      : `Host(\`${route.host}\`) && (${paths.join(" || ")})`;
  const headers = route.responseHeaders ?? [];
  const middlewares = headers.length === 0 ? [] : [`${router}-headers`];
  return [
    `traefik.http.routers.${router}.rule=${rule}`,
    `traefik.http.routers.${router}.entrypoints=web`,
    `traefik.http.routers.${router}.service=${service}`,
    ...headers.map(
      (header) =>
        `traefik.http.middlewares.${router}-headers.headers.customresponseheaders.${header.name}=${header.value}`,
    ),
    ...(middlewares.length === 0
      ? []
      : [`traefik.http.routers.${router}.middlewares=${middlewares.join(",")}`]),
  ];
};

// StripPrefix records the removed path in X-Forwarded-Prefix. The job never sees the path,
// so a second middleware removes that header: an app that honours it would build wrong links.
const tailnetRouterTags = (service: string) => {
  const router = `${service}-tailnet`;
  const prefix = tailnetPath(service).slice(0, -1);
  return [
    `traefik.http.routers.${router}.rule=PathPrefix(\`${tailnetPath(service)}\`)`,
    `traefik.http.routers.${router}.entrypoints=${tailnetEntrypoint.name}`,
    `traefik.http.routers.${router}.service=${service}`,
    `traefik.http.middlewares.${router}-strip.stripprefix.prefixes=${prefix}`,
    `traefik.http.middlewares.${router}-unprefix.headers.customrequestheaders.X-Forwarded-Prefix=`,
    `traefik.http.routers.${router}.middlewares=${router}-strip,${router}-unprefix`,
  ];
};
