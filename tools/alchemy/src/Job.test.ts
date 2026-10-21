import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as Schema from "effect/Schema";
import { Job, toJobSpec } from "./Job.ts";

describe("Nomad workload rendering", () => {
  it("renders a dynamic service port and runtime-only secret references", () => {
    const job = Schema.decodeUnknownSync(Job)({
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
      vault: {
        role: "alchemy-proof-app",
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
      },
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
    const job = Schema.decodeUnknownSync(Job)({
      name: "proof-app",
      image: "registry.example.test/proof-app:trial",
      hostPort: "dynamic",
      containerPort: 8080,
      cpu: 250,
      memoryMB: 256,
      networkMode: "bridge",
      environment: [],
      connections: [],
      vault: {
        role: "alchemy-proof-app",
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
      },
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

  it("renders no URL line for credentials without a url", () => {
    const job = Schema.decodeUnknownSync(Job)({
      name: "proof-app",
      image: "registry.example.test/proof-app:trial",
      hostPort: "dynamic",
      containerPort: 8080,
      cpu: 250,
      memoryMB: 256,
      networkMode: "bridge",
      environment: [],
      connections: [],
      vault: {
        role: "alchemy-proof-app",
        secrets: [
          {
            _tag: "PostgresCredentials",
            role: "alchemy-proof-app-database",
            credentialPath: "database/creds/alchemy-proof-app-database",
            usernameEnv: "PGUSER",
            passwordEnv: "PGPASSWORD",
          },
        ],
      },
    });

    const task = toJobSpec(job, "ProofStack/app").TaskGroups[0].Tasks[0];
    const template = task.Templates[0].EmbeddedTmpl;

    assert.doesNotMatch(template, /nomadService/);
    assert.doesNotMatch(template, /printf/);
  });

  it("allows a client task without a local service health check", () => {
    const job = Schema.decodeUnknownSync(Job)({
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
});
