import { Schema } from "effect";
import * as Match from "effect/Match";

export const ResourceName = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/));
const EnvironmentVariable = Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/));
const SecretPath = Schema.String.check(
  Schema.isPattern(/^secret\/data\/[A-Za-z0-9][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.-]*)*$/),
);
const DatabaseCredentialPath = Schema.String.check(
  Schema.isPattern(/^database\/creds\/[A-Za-z0-9_.-]+$/),
);
const SecretKey = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/));
export const DatabaseIdentifier = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]{0,62}$/));
export const ServiceConnection = Schema.Struct({
  service: ResourceName,
  hostEnv: EnvironmentVariable,
  portEnv: EnvironmentVariable,
});
export type ServiceConnection = typeof ServiceConnection.Type;

export const HealthCheck = Schema.Union([
  Schema.Struct({
    type: Schema.Literals(["http"]),
    path: Schema.String.check(Schema.isPattern(/^\/[A-Za-z0-9_./-]*$/)),
  }),
  Schema.Struct({ type: Schema.Literals(["tcp"]) }),
]);
export type HealthCheck = typeof HealthCheck.Type;

export const KvSecretReference = Schema.TaggedStruct("KvSecret", {
  path: SecretPath,
  key: SecretKey,
  env: EnvironmentVariable,
});
const PostgresUrlReference = Schema.Struct({
  env: EnvironmentVariable,
  server: ResourceName,
  database: DatabaseIdentifier,
});
const PostgresCredentialsReference = Schema.TaggedStruct("PostgresCredentials", {
  role: ResourceName,
  credentialPath: DatabaseCredentialPath,
  usernameEnv: Schema.optionalKey(EnvironmentVariable),
  passwordEnv: Schema.optionalKey(EnvironmentVariable),
  url: Schema.optionalKey(PostgresUrlReference),
});
const ValkeyUrlReference = Schema.Struct({
  env: EnvironmentVariable,
  server: ResourceName,
});
const ValkeyCredentialsReference = Schema.TaggedStruct("ValkeyCredentials", {
  access: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]{0,39}$/)),
  credentialPath: SecretPath,
  usernameEnv: Schema.optionalKey(EnvironmentVariable),
  passwordEnv: Schema.optionalKey(EnvironmentVariable),
  url: Schema.optionalKey(ValkeyUrlReference),
});
export const SecretReference = Schema.Union([
  KvSecretReference,
  PostgresCredentialsReference,
  ValkeyCredentialsReference,
]);
export type SecretReference = typeof SecretReference.Type;

const atLeastOneEnvironmentVariable = Schema.makeFilter((value: {
  usernameEnv?: string;
  passwordEnv?: string;
  urlEnv?: string;
}) =>
  value.usernameEnv === undefined &&
  value.passwordEnv === undefined &&
  value.urlEnv === undefined
    ? "at least one environment variable is required"
    : undefined,
);

export const ValkeyCredentialsDeclaration = Schema.TaggedStruct("ValkeyCredentials", {
  usernameEnv: Schema.optionalKey(EnvironmentVariable),
  passwordEnv: Schema.optionalKey(EnvironmentVariable),
  urlEnv: Schema.optionalKey(EnvironmentVariable),
}).check(atLeastOneEnvironmentVariable);
export const PostgresCredentialsDeclaration = Schema.TaggedStruct("PostgresCredentials", {
  database: DatabaseIdentifier,
  login: Schema.Literals(["api", "migration"]),
  usernameEnv: Schema.optionalKey(EnvironmentVariable),
  passwordEnv: Schema.optionalKey(EnvironmentVariable),
  urlEnv: Schema.optionalKey(EnvironmentVariable),
}).check(atLeastOneEnvironmentVariable);
export const CartridgeSecretReference = Schema.Union([
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

const Storage = Schema.Struct({
  volume: ResourceName,
  mountPath: Schema.String.check(Schema.isPattern(/^\/[A-Za-z0-9_./-]+$/)),
});

const JobBaseFields = {
  name: ResourceName,
  image: Schema.String,
  hostPort: Schema.Union([
    Schema.Literals(["dynamic"]),
    Schema.Number.check(
      Schema.isInt(),
      Schema.isGreaterThan(0),
      Schema.isLessThanOrEqualTo(65_535),
    ),
  ]),
  containerPort: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(65_535),
  ),
  healthCheck: Schema.optionalKey(HealthCheck),
  cpu: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  memoryMB: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  networkMode: Schema.Literals(["bridge", "pasta"]),
  storage: Schema.optionalKey(Storage),
  environment: Schema.Array(Schema.Struct({ name: EnvironmentVariable, value: Schema.String })),
  command: Schema.optionalKey(Schema.String),
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  connections: Schema.Array(ServiceConnection),
};

export const ExpandedPostgresCredentials = Schema.TaggedStruct("PostgresCredentials", {
  role: ResourceName,
  usernameEnv: Schema.optionalKey(EnvironmentVariable),
  passwordEnv: Schema.optionalKey(EnvironmentVariable),
  url: Schema.optionalKey(Schema.Struct({ env: EnvironmentVariable })),
});
export const ExpandedValkeyCredentials = Schema.TaggedStruct("ValkeyCredentials", {
  access: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]{0,39}$/)),
  usernameEnv: Schema.optionalKey(EnvironmentVariable),
  passwordEnv: Schema.optionalKey(EnvironmentVariable),
  url: Schema.optionalKey(Schema.Struct({ env: EnvironmentVariable })),
});
export const ExpandedSecretReference = Schema.Union([
  KvSecretReference,
  ExpandedPostgresCredentials,
  ExpandedValkeyCredentials,
]);
export type ExpandedSecretReference = typeof ExpandedSecretReference.Type;

export const ExpandedJob = Schema.Struct({
  ...JobBaseFields,
  secrets: Schema.optionalKey(Schema.Array(ExpandedSecretReference)),
});
export type ExpandedJob = typeof ExpandedJob.Type;

export const Job = Schema.Struct({
  ...JobBaseFields,
  secrets: Schema.optionalKey(Schema.Array(SecretReference)),
});
export type Job = typeof Job.Type;

export const CartridgeJob = Schema.Struct({
  ...JobBaseFields,
  secrets: Schema.optionalKey(Schema.Array(CartridgeSecretReference)),
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
            ...(value.usernameEnv === undefined ? [] : [value.usernameEnv + "={{ .Data.username | toJSON }}"]),
            ...(value.passwordEnv === undefined ? [] : [value.passwordEnv + "={{ .Data.password | toJSON }}"]),
            ...(value.url === undefined ? [] : postgresUrlLines(value.url)),
            "{{- end }}",
          ].join("\n"),
        ),
        Match.when({ _tag: "ValkeyCredentials" }, (value) =>
          [
            '{{- with secret "' + value.credentialPath + '" -}}',
            ...(value.usernameEnv === undefined ? [] : [value.usernameEnv + "={{ .Data.data.username | toJSON }}"]),
            ...(value.passwordEnv === undefined ? [] : [value.passwordEnv + "={{ .Data.data.password | toJSON }}"]),
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
export const toJobSpec = (job: Job, owner: string) => {
  const secrets = job.secrets ?? [];
  const templates = (
    job.connections.length === 0 ? [] : [toServiceTemplate(job.connections)]
  ).concat(
    secrets.length === 0 ? [] : [toSecretTemplate(secrets)],
  );

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
        Tasks: [
          {
            Name: "server",
            Driver: "podman",
            Config: {
              image: job.image,
              network_mode: job.networkMode,
              ports: ["service"],
              command: job.command,
              args: job.args,
            },
            Env: Object.fromEntries(
              job.environment.map((variable) => [variable.name, variable.value]),
            ),
            VolumeMounts:
              job.storage === undefined
                ? []
                : [{ Volume: "data", Destination: job.storage.mountPath, ReadOnly: false }],
            Resources: { CPU: job.cpu, MemoryMB: job.memoryMB },
            Vault:
              secrets.length === 0
                ? undefined
                : { Role: workloadRole(job.name), Env: false, DisableFile: true },
            Templates: templates,
          },
        ],
      },
    ],
    Update: {
      MaxParallel: 1,
      HealthCheck: "checks",
      MinHealthyTime: 10_000_000_000,
      HealthyDeadline: 180_000_000_000,
      ProgressDeadline: 600_000_000_000,
      AutoRevert: true,
    },
  };
};
