import { Schema as S } from "effect";
import * as Match from "effect/Match";

export const ResourceName = S.String.check(
  S.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/),
);
const EnvironmentVariable = S.String.check(S.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/));
const SecretPath = S.String.check(
  S.isPattern(/^secret\/data\/[A-Za-z0-9][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.-]*)*$/),
);
const DatabaseCredentialPath = S.String.check(
  S.isPattern(/^database\/creds\/[A-Za-z0-9_.-]+$/),
);
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

const JobBaseFields = {
  name: ResourceName,
  image: S.String,
  hostPort: S.Union([
    S.Literals(["dynamic"]),
    S.Number.check(
      S.isInt(),
      S.isGreaterThan(0),
      S.isLessThanOrEqualTo(65_535),
    ),
  ]),
  containerPort: S.Number.check(
    S.isInt(),
    S.isGreaterThan(0),
    S.isLessThanOrEqualTo(65_535),
  ),
  healthCheck: S.optionalKey(HealthCheck),
  cpu: S.Number.check(S.isInt(), S.isGreaterThan(0)),
  memoryMB: S.Number.check(S.isInt(), S.isGreaterThan(0)),
  networkMode: S.Literals(["bridge", "pasta"]),
  storage: S.optionalKey(Storage),
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

export const ExpandedJob = S.Struct({
  ...JobBaseFields,
  secrets: S.optionalKey(S.Array(ExpandedSecretReference)),
  migrate: S.optionalKey(migrateStep(ExpandedSecretReference)),
});
export type ExpandedJob = typeof ExpandedJob.Type;

export const Job = S.Struct({
  ...JobBaseFields,
  secrets: S.optionalKey(S.Array(SecretReference)),
  migrate: S.optionalKey(migrateStep(SecretReference)),
});
export type Job = typeof Job.Type;

export const CartridgeJob = S.Struct({
  ...JobBaseFields,
  secrets: S.optionalKey(S.Array(CartridgeSecretReference)),
  migrate: S.optionalKey(migrateStep(CartridgeSecretReference)),
});
export type CartridgeJob = typeof CartridgeJob.Type;

const toServiceTemplate = (connections: ReadonlyArray<ServiceConnection>) => ({
  DestPath: "secrets/services.env",
  Envvars: true,
  ChangeMode: "restart",
  EmbeddedTmpl: connections
    .map((connection) =>
      [
        '{{- range nomadService "' + connection.service + '" -}}',
        connection.hostEnv + "={{ .Address }}",
        connection.portEnv + "={{ .Port }}",
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
    '?sslmode=disable" $username $password .Address .Port | toJSON }}',
  "{{- end }}",
];

// ValkeyAccess and the admin credential hex-encode their passwords, so the URL needs no escaping.
const valkeyUrlLines = (url: typeof ValkeyUrlReference.Type) => [
  "{{- $username := .Data.data.username }}",
  "{{- $password := .Data.data.password }}",
  '{{- range nomadService "' + url.server + '" }}',
  url.env + '={{ printf "redis://%s:%s@%s:%d" $username $password .Address .Port | toJSON }}',
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
            value.env + '={{ index .Data.data "' + value.key + '" | toJSON }}',
            "{{- end }}",
          ].join("\n"),
        ),
        Match.when({ _tag: "PostgresCredentials" }, (value) =>
          [
            '{{- with secret "' + value.credentialPath + '" -}}',
            ...(value.usernameEnv === undefined
              ? []
              : [value.usernameEnv + "={{ .Data.username | toJSON }}"]),
            ...(value.passwordEnv === undefined
              ? []
              : [value.passwordEnv + "={{ .Data.password | toJSON }}"]),
            ...(value.url === undefined ? [] : postgresUrlLines(value.url)),
            "{{- end }}",
          ].join("\n"),
        ),
        Match.when({ _tag: "ValkeyCredentials" }, (value) =>
          [
            '{{- with secret "' + value.credentialPath + '" -}}',
            ...(value.usernameEnv === undefined
              ? []
              : [value.usernameEnv + "={{ .Data.data.username | toJSON }}"]),
            ...(value.passwordEnv === undefined
              ? []
              : [value.passwordEnv + "={{ .Data.data.password | toJSON }}"]),
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
    : { ReservedPorts: [{ Label: "service", Value: job.hostPort, To: job.containerPort }] };

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
    Type: "service",
    Datacenters: ["dc1"],
    Meta: { "alchemy.owner": owner, "alchemy.provider": "Nomad.Job" },
    TaskGroups: [
      {
        Name: "service",
        Count: 1,
        Networks: [toNetwork(job)],
        Volumes:
          job.storage === undefined
            ? {}
            : { data: { Name: "data", Type: "host", Source: job.storage.volume, ReadOnly: false } },
        Services: [
          {
            Name: job.name,
            PortLabel: "service",
            Provider: "nomad",
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
    ports: task.ports.length === 0 ? undefined : task.ports,
    command: task.command,
    args: task.args,
  },
  Env: Object.fromEntries(job.environment.map((variable) => [variable.name, variable.value])),
  VolumeMounts:
    job.storage === undefined
      ? []
      : [{ Volume: "data", Destination: job.storage.mountPath, ReadOnly: false }],
  Resources: { CPU: job.cpu, MemoryMB: job.memoryMB },
  Vault:
    task.secrets.length === 0
      ? undefined
      : { Role: workloadRole(job.name), Env: false, DisableFile: true },
  Templates: task.templates.concat(task.secrets.length === 0 ? [] : [toSecretTemplate(task.secrets)]),
});
