import { Schema as S } from "effect";
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

// A public route to the service through Traefik. Path prefixes narrow the host, and a longer
// rule wins in Traefik, so an API under a static site's host takes its paths from the site.
export const Route = S.Struct({
  host: S.String.check(
    S.isPattern(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/),
  ),
  pathPrefixes: S.optionalKey(S.NonEmptyArray(S.String.check(S.isPattern(/^\/[A-Za-z0-9_./-]*$/)))),
  responseHeaders: S.optionalKey(
    S.Array(S.Struct({ name: S.String.check(S.isPattern(/^[A-Za-z0-9-]+$/)), value: S.String })),
  ),
});
export type Route = typeof Route.Type;

export const KvSecretReference = S.TaggedStruct("KvSecret", {
  path: SecretPath,
  key: SecretKey,
  env: EnvironmentVariable,
});
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
export const SecretReference = S.Union([
  KvSecretReference,
  PostgresCredentialsReference,
  ValkeyCredentialsReference,
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
]);
export type CartridgeSecretReference = typeof CartridgeSecretReference.Type;

export const workloadRole = (jobName: string) => `alchemy-${jobName}`;

export const secretPolicyPath = (secret: SecretReference) =>
  Match.value(secret).pipe(
    Match.when({ _tag: "KvSecret" }, (value) => value.path),
    Match.when({ _tag: "PostgresCredentials" }, (value) => value.credentialPath),
    Match.when({ _tag: "ValkeyCredentials" }, (value) => value.credentialPath),
    Match.exhaustive,
  );

/** The OpenBao paths a job reads, across its service task and its migration task, for its one workload role. */
export const secretPolicyPaths = (job: Job) =>
  [...(job.secrets ?? []), ...(job.migrate?.secrets ?? [])].map(secretPolicyPath);

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

const JobBaseFields = {
  name: ResourceName,
  image: S.String,
  hostPort: S.Union([
    S.Literals(["dynamic"]),
    S.Number.check(S.isInt(), S.isGreaterThan(0), S.isLessThanOrEqualTo(65_535)),
  ]),
  containerPort: S.Number.check(S.isInt(), S.isGreaterThan(0), S.isLessThanOrEqualTo(65_535)),
  healthCheck: S.optionalKey(HealthCheck),
  cpu: S.Number.check(S.isInt(), S.isGreaterThan(0)),
  memoryMB: S.Number.check(S.isInt(), S.isGreaterThan(0)),
  networkMode: S.Literals(["bridge", "pasta", "host"]),
  identity: S.optionalKey(S.Struct({ env: S.Boolean })),
  storage: S.optionalKey(Storage),
  readOnlyMounts: S.optionalKey(S.Array(Storage)),
  placement: S.optionalKey(Placement),
  routes: S.optionalKey(S.Array(Route)),
  environment: S.Array(S.Struct({ name: EnvironmentVariable, value: S.String })),
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
export const ExpandedSecretReference = S.Union([
  KvSecretReference,
  ExpandedPostgresCredentials,
  ExpandedValkeyCredentials,
]);
export type ExpandedSecretReference = typeof ExpandedSecretReference.Type;

// A step that runs to completion in the service image before the service starts, with its own secrets.
const migrateStep = <S extends S.Top>(secret: S) =>
  S.Struct({
    command: S.optionalKey(S.String),
    args: S.optionalKey(S.Array(S.String)),
    secrets: S.optionalKey(S.Array(secret)),
  });

const hostNetworkPorts = S.makeFilter(
  (job: { networkMode: string; hostPort: string | number; containerPort: number }) =>
    job.networkMode === "host" && job.hostPort !== job.containerPort
      ? "host networking requires a fixed hostPort equal to containerPort"
      : undefined,
);

export const ExpandedJob = S.Struct({
  ...JobBaseFields,
  secrets: S.optionalKey(S.Array(ExpandedSecretReference)),
  migrate: S.optionalKey(migrateStep(ExpandedSecretReference)),
}).check(hostNetworkPorts);
export type ExpandedJob = typeof ExpandedJob.Type;

export const Job = S.Struct({
  ...JobBaseFields,
  secrets: S.optionalKey(S.Array(SecretReference)),
  migrate: S.optionalKey(migrateStep(SecretReference)),
}).check(hostNetworkPorts);
export type Job = typeof Job.Type;

export const CartridgeJob = S.Struct({
  ...JobBaseFields,
  secrets: S.optionalKey(S.Array(CartridgeSecretReference)),
  migrate: S.optionalKey(migrateStep(CartridgeSecretReference)),
}).check(hostNetworkPorts);
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
        Match.exhaustive,
      ),
    )
    .join("\n"),
});

const toNetwork = (job: Job) =>
  job.hostPort === "dynamic"
    ? { DynamicPorts: [{ Label: "service", To: job.containerPort }] }
    : {
        ReservedPorts: [
          {
            Label: "service",
            Value: job.hostPort,
            To: job.networkMode === "host" ? undefined : job.containerPort,
          },
        ],
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
    ports: ["service"],
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
const toScheduling = (placement: Placement | undefined) =>
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
  const routerTags = routes.flatMap((route, index) => {
    const router = `${service}-${index}`;
    const paths = route.pathPrefixes?.map((prefix) => `PathPrefix(\`${prefix}\`)`) ?? [];
    const rule =
      paths.length === 0
        ? `Host(\`${route.host}\`)`
        : `Host(\`${route.host}\`) && (${paths.join(" || ")})`;
    const headers = route.responseHeaders ?? [];
    return [
      `traefik.http.routers.${router}.rule=${rule}`,
      `traefik.http.routers.${router}.entrypoints=web`,
      `traefik.http.routers.${router}.service=${service}`,
      ...(headers.length === 0
        ? []
        : [
            ...headers.map(
              (header) =>
                `traefik.http.middlewares.${router}-headers.headers.customresponseheaders.${header.name}=${header.value}`,
            ),
            `traefik.http.routers.${router}.middlewares=${router}-headers`,
          ]),
    ];
  });
  return ["traefik.enable=true", ...healthTags, ...routerTags];
};
