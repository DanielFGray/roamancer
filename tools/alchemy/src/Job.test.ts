import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as S from "effect/Schema";
import { Job, toJobSpec, secretPolicyPaths } from "./Job.ts";

describe("Nomad workload rendering", () => {
  it("places a job on one named node, on every node, or anywhere", () => {
    const job = S.decodeUnknownSync(Job)({
      name: "edge",
      image: "registry.cluster:5000/edge@sha256:0",
      hostPort: 80,
      containerPort: 80,
      cpu: 100,
      memoryMB: 64,
      networkMode: "host",
      environment: [],
      connections: [],
      placement: { _tag: "Node", name: "atheist" },
    });
    const scheduling = (spec: ReturnType<typeof toJobSpec>) => [spec.Type, spec.Constraints];
    assert.deepEqual(scheduling(toJobSpec(job, "o")), [
      "service",
      [{ LTarget: "${node.unique.name}", RTarget: "atheist", Operand: "=" }],
    ]);
    assert.deepEqual(scheduling(toJobSpec({ ...job, placement: { _tag: "EveryNode" } }, "o")), [
      "system",
      undefined,
    ]);
    assert.deepEqual(scheduling(toJobSpec({ ...job, placement: undefined }, "o")), [
      "service",
      undefined,
    ]);
    assert.equal(
      S.decodeUnknownOption(Job)({ ...job, placement: { _tag: "Node", name: "" } })._tag,
      "None",
    );
  });
  it("routes a host and its API paths through Traefik tags, checked on the service's health path", () => {
    const job = S.decodeUnknownSync(Job)({
      name: "giglist-api",
      image: "registry.cluster:5000/giglist@sha256:0",
      hostPort: "dynamic",
      containerPort: 3000,
      healthCheck: { type: "http", path: "/api/health" },
      cpu: 200,
      memoryMB: 256,
      networkMode: "bridge",
      environment: [],
      connections: [],
      routes: [
        {
          host: "giglist.dfg.rocks",
          pathPrefixes: ["/api"],
          responseHeaders: [{ name: "X-Frame-Options", value: "DENY" }],
        },
      ],
    });
    assert.deepEqual(toJobSpec(job, "giglist/giglist-api").TaskGroups[0].Services[0].Tags, [
      "traefik.enable=true",
      "traefik.http.services.giglist-api.loadbalancer.healthcheck.path=/api/health",
      "traefik.http.services.giglist-api.loadbalancer.healthcheck.interval=5s",
      "traefik.http.routers.giglist-api-0.rule=Host(`giglist.dfg.rocks`) && (PathPrefix(`/api`))",
      "traefik.http.routers.giglist-api-0.entrypoints=web",
      "traefik.http.routers.giglist-api-0.service=giglist-api",
      "traefik.http.middlewares.giglist-api-0-headers.headers.customresponseheaders.X-Frame-Options=DENY",
      "traefik.http.routers.giglist-api-0.middlewares=giglist-api-0-headers",
    ]);
    assert.deepEqual(
      toJobSpec({ ...job, routes: undefined }, "o").TaskGroups[0].Services[0].Tags,
      [],
    );
    assert.equal(
      S.decodeUnknownOption(Job)({ ...job, routes: [{ host: "a`) || Host(`b" }] })._tag,
      "None",
    );
  });
  it("gives every task the node's OTLP collector address, which the job's own environment overrides", () => {
    const job = S.decodeUnknownSync(Job)({
      name: "app",
      image: "registry.cluster:5000/app@sha256:0",
      hostPort: "dynamic",
      containerPort: 3000,
      cpu: 100,
      memoryMB: 128,
      networkMode: "bridge",
      environment: [
        { name: "OTEL_TRACES_EXPORTER", value: "otlp" },
        { name: "OTEL_EXPORTER_OTLP_ENDPOINT", value: "http://collector.example:4318" },
      ],
      connections: [],
    });
    assert.deepEqual(toJobSpec(job, "app/app").TaskGroups[0].Tasks[0].Env, {
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.example:4318",
      OTEL_TRACES_EXPORTER: "otlp",
    });
  });
  it("exposes the default workload identity without port translation for a host-network task", () => {
    const job = S.decodeUnknownSync(Job)({
      name: "ingress",
      image: "docker.io/library/traefik:v3.7.13",
      hostPort: 18080,
      containerPort: 18080,
      cpu: 100,
      memoryMB: 128,
      networkMode: "host",
      identity: { env: true },
      environment: [],
      connections: [],
      readOnlyMounts: [{ volume: "traefik-routes", mountPath: "/etc/traefik/routes" }],
    });
    const spec = toJobSpec(job, "platform-ingress/ingress");
    assert.deepEqual(spec.TaskGroups[0].Networks, [
      { ReservedPorts: [{ Label: "service", Value: 18080, To: undefined }] },
    ]);
    const task = spec.TaskGroups[0].Tasks[0];
    assert.equal(task.Config.network_mode, "host");
    assert.equal(task.Config.ports, undefined);
    assert.deepEqual(task.Identity, { Env: true });
    assert.deepEqual(task.Env, {
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://host.containers.internal:4318",
    });
    assert.deepEqual(spec.TaskGroups[0].Volumes, {
      "readonly-0": { Name: "readonly-0", Type: "host", Source: "traefik-routes", ReadOnly: true },
    });
    assert.deepEqual(task.VolumeMounts, [
      { Volume: "readonly-0", Destination: "/etc/traefik/routes", ReadOnly: true },
    ]);
    for (const hostPort of ["dynamic", 18081]) {
      assert.equal(S.decodeUnknownOption(Job)({ ...job, hostPort })._tag, "None");
    }
  });
  it("renders a dynamic service port and runtime-only secret references", () => {
    const job = S.decodeUnknownSync(Job)({
      name: "proof-app",
      image: "registry.example.test/proof-app:trial",
      hostPort: "dynamic",
      containerPort: 8080,
      healthCheck: { type: "http", path: "/_healthz" },
      cpu: 250,
      memoryMB: 256,
      networkMode: "bridge",
      environment: [],
      connections: [{ service: "proof-postgres", hostEnv: "PGHOST", portEnv: "PGPORT" }],
      secrets: [
        {
          _tag: "KvSecret",
          path: "secret/data/proof-app",
          key: "database_password",
          env: "APP_SECRET",
        },
        {
          _tag: "PostgresCredentials",
          role: "alchemy-proof-app-database",
          credentialPath: "database/creds/alchemy-proof-app-database",
          usernameEnv: "PGUSER",
          passwordEnv: "PGPASSWORD",
        },
        {
          _tag: "ValkeyCredentials",
          access: "proof_cache",
          credentialPath: "secret/data/valkey/proof_cache",
          usernameEnv: "VALKEY_USER",
          passwordEnv: "VALKEY_PASSWORD",
        },
      ],
    });

    const spec = toJobSpec(job, "ProofStack/app");
    const group = spec.TaskGroups[0];
    const task = group.Tasks[0];

    assert.deepEqual(group.Networks[0], {
      DynamicPorts: [{ Label: "service", To: 8080 }],
    });
    assert.deepEqual(group.Services[0].Checks?.[0], {
      Name: "health",
      Type: "http",
      Path: "/_healthz",
      Interval: 10_000_000_000,
      Timeout: 5_000_000_000,
      OnUpdate: "require_healthy",
    });
    assert.equal(task.Config.network_mode, "bridge");
    assert.deepEqual(task.Vault, { Role: "alchemy-proof-app", Env: false, DisableFile: true });
    assert.match(task.Templates[0].EmbeddedTmpl, /nomadService "proof-postgres"/);
    assert.match(task.Templates[1].EmbeddedTmpl, /secret\/data\/proof-app/);
    assert.match(task.Templates[1].EmbeddedTmpl, /APP_SECRET=.*\.Data\.data "database_password"/);
    assert.match(task.Templates[1].EmbeddedTmpl, /database\/creds\/alchemy-proof-app-database/);
    assert.match(task.Templates[1].EmbeddedTmpl, /PGUSER=.*\.Data\.username/);
    assert.match(task.Templates[1].EmbeddedTmpl, /PGPASSWORD=.*\.Data\.password/);
    assert.match(task.Templates[1].EmbeddedTmpl, /secret\/data\/valkey\/proof_cache/);
    assert.match(task.Templates[1].EmbeddedTmpl, /VALKEY_USER=.*\.Data\.data\.username/);
    assert.match(task.Templates[1].EmbeddedTmpl, /VALKEY_PASSWORD=.*\.Data\.data\.password/);
  });

  it("assembles a PostgreSQL URL from the dynamic credential and the server address", () => {
    const job = S.decodeUnknownSync(Job)({
      name: "proof-app",
      image: "registry.example.test/proof-app:trial",
      hostPort: "dynamic",
      containerPort: 8080,
      cpu: 250,
      memoryMB: 256,
      networkMode: "bridge",
      environment: [],
      connections: [],
      secrets: [
        {
          _tag: "PostgresCredentials",
          role: "alchemy-proof-app-database",
          credentialPath: "database/creds/alchemy-proof-app-database",
          usernameEnv: "PGUSER",
          passwordEnv: "PGPASSWORD",
          url: { env: "DATABASE_URL", server: "shared-postgres", database: "proof_app" },
        },
      ],
    });

    const task = toJobSpec(job, "ProofStack/app").TaskGroups[0].Tasks[0];
    const template = task.Templates[0].EmbeddedTmpl;

    assert.match(template, /\{\{- \$username := \.Data\.username \}\}/);
    assert.match(template, /\{\{- range nomadService "shared-postgres" \}\}/);
    assert.match(
      template,
      /DATABASE_URL=\{\{ printf "postgresql:\/\/%s:%s@%s:%d\/proof_app\?sslmode=disable" \$username \$password \.Address \.Port \| toJSON \}\}/,
    );
  });

  it("assembles a Valkey URL from the ACL credential and the server address", () => {
    const job = S.decodeUnknownSync(Job)({
      name: "proof-app",
      image: "registry.example.test/proof-app:trial",
      hostPort: "dynamic",
      containerPort: 8080,
      cpu: 250,
      memoryMB: 256,
      networkMode: "bridge",
      environment: [],
      connections: [],
      secrets: [
        {
          _tag: "ValkeyCredentials",
          access: "proof_cache",
          credentialPath: "secret/data/valkey/proof_cache",
          usernameEnv: "VALKEY_USER",
          passwordEnv: "VALKEY_PASSWORD",
          url: { env: "VALKEY_URL", server: "shared-valkey" },
        },
      ],
    });

    const task = toJobSpec(job, "ProofStack/app").TaskGroups[0].Tasks[0];
    const template = task.Templates[0].EmbeddedTmpl;

    assert.match(template, /\{\{- \$username := \.Data\.data\.username \}\}/);
    assert.match(template, /\{\{- range nomadService "shared-valkey" \}\}/);
    assert.match(
      template,
      /VALKEY_URL=\{\{ printf "redis:\/\/%s:%s@%s:%d" \$username \$password \.Address \.Port \| toJSON \}\}/,
    );
  });

  it("renders no URL line for credentials without a url", () => {
    const job = S.decodeUnknownSync(Job)({
      name: "proof-app",
      image: "registry.example.test/proof-app:trial",
      hostPort: "dynamic",
      containerPort: 8080,
      cpu: 250,
      memoryMB: 256,
      networkMode: "bridge",
      environment: [],
      connections: [],
      secrets: [
        {
          _tag: "PostgresCredentials",
          role: "alchemy-proof-app-database",
          credentialPath: "database/creds/alchemy-proof-app-database",
          usernameEnv: "PGUSER",
          passwordEnv: "PGPASSWORD",
        },
      ],
    });

    const task = toJobSpec(job, "ProofStack/app").TaskGroups[0].Tasks[0];
    const template = task.Templates[0].EmbeddedTmpl;

    assert.doesNotMatch(template, /nomadService/);
    assert.doesNotMatch(template, /printf/);
  });

  it("allows a client task without a local service health check", () => {
    const job = S.decodeUnknownSync(Job)({
      name: "database-client",
      image: "docker.io/library/postgres:16-alpine",
      hostPort: "dynamic",
      containerPort: 8080,
      cpu: 100,
      memoryMB: 128,
      networkMode: "bridge",
      environment: [],
      connections: [],
    });

    assert.equal(toJobSpec(job, "ProofStack/client").TaskGroups[0].Services[0].Checks, undefined);
  });

  it("derives policy paths from both main and migrate secrets", () => {
    const job = S.decodeUnknownSync(Job)({
      name: "proof-app",
      image: "registry.example.test/proof-app:trial",
      hostPort: "dynamic",
      containerPort: 8080,
      cpu: 250,
      memoryMB: 256,
      networkMode: "bridge",
      environment: [],
      connections: [],
      secrets: [
        {
          _tag: "PostgresCredentials",
          role: "alchemy-proof-app-database",
          credentialPath: "database/creds/alchemy-proof-app-api",
          usernameEnv: "PGUSER",
          passwordEnv: "PGPASSWORD",
        },
      ],
      migrate: {
        command: "graphile-migrate",
        args: ["migrate"],
        secrets: [
          {
            _tag: "PostgresCredentials",
            role: "alchemy-proof-app-database",
            credentialPath: "database/creds/alchemy-proof-app-migration",
            usernameEnv: "MIGUSER",
            passwordEnv: "MIGPASSWORD",
          },
        ],
      },
    });

    assert.deepEqual(secretPolicyPaths(job), [
      "database/creds/alchemy-proof-app-api",
      "database/creds/alchemy-proof-app-migration",
    ]);
  });

  it("renders a migrate prestart task with only its own secrets", () => {
    const job = S.decodeUnknownSync(Job)({
      name: "proof-app",
      image: "registry.example.test/proof-app:trial",
      hostPort: "dynamic",
      containerPort: 8080,
      cpu: 250,
      memoryMB: 256,
      networkMode: "bridge",
      environment: [],
      connections: [],
      secrets: [
        {
          _tag: "KvSecret",
          path: "secret/data/proof-app",
          key: "database_password",
          env: "APP_SECRET",
        },
      ],
      migrate: {
        command: "graphile-migrate",
        args: ["migrate"],
        secrets: [
          {
            _tag: "KvSecret",
            path: "secret/data/proof-app/migrate",
            key: "database_password",
            env: "MIG_SECRET",
          },
        ],
      },
    });

    const spec = toJobSpec(job, "ProofStack/app");
    const tasks = spec.TaskGroups[0].Tasks;
    assert.equal(tasks.length, 2);

    // toJobSpec lists the migration task before the server task.
    const prestart = tasks[0];
    assert.ok(prestart !== undefined && "Lifecycle" in prestart);
    assert.equal(prestart.Name, "migrate");
    assert.deepEqual(prestart.Lifecycle, { Hook: "prestart", Sidecar: false });
    assert.equal(prestart.Config.image, "registry.example.test/proof-app:trial");
    assert.equal(prestart.Config.command, "graphile-migrate");
    assert.deepEqual(prestart.Config.args, ["migrate"]);
    assert.equal(prestart.Templates.length, 1);
    assert.match(prestart.Templates[0].EmbeddedTmpl, /secret\/data\/proof-app\/migrate/);
    assert.doesNotMatch(prestart.Templates[0].EmbeddedTmpl, /secret\/data\/proof-app"/);

    const main = tasks.find((task) => task.Name === "server");
    assert.ok(main);
    assert.equal(main.Templates.length, 1);
    assert.match(main.Templates[0].EmbeddedTmpl, /secret\/data\/proof-app"/);
    assert.doesNotMatch(main.Templates[0].EmbeddedTmpl, /secret\/data\/proof-app\/migrate/);
  });
});
