import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as S from "effect/Schema";
import { expand, Cartridge } from "./Cartridge.ts";
import { compose } from "./Compose.ts";
import { Job } from "./Job.ts";
import { PostgresDatabaseProps } from "./PostgresDatabase.ts";
import { ValkeyAccessConfig } from "./ValkeyAccess.ts";
import { AdminCredentialProps } from "./AdminCredential.ts";
import { TailscaleServeProps } from "./TailscaleServe.ts";
import type { OpenObserveDashboardProps } from "./OpenObserveDashboard.ts";

const readCartridge = (rel: string) => {
  const path = fileURLToPath(new URL(rel, import.meta.url));
  const contents = readFileSync(path, "utf8");
  return S.decodeUnknownSync(Cartridge)(JSON.parse(contents));
};

const makeConstructors = () => {
  const nomadJobCalls: Array<{ id: string; props: Job }> = [];
  const postgresDatabaseCalls: Array<{ id: string; props: PostgresDatabaseProps }> = [];
  const valkeyAccessCalls: Array<{ id: string; props: ValkeyAccessConfig }> = [];
  const adminCredentialCalls: Array<{ id: string; props: AdminCredentialProps }> = [];
  const tailscaleServeCalls: Array<{ id: string; props: TailscaleServeProps }> = [];
  const dashboardCalls: Array<{ id: string; props: OpenObserveDashboardProps }> = [];
  // Alchemy keys resources by logical ID within a stack, so a repeated ID would merge two resources.
  const declaredIds = new Set<string>();
  const declare = <A>(id: string, output: A) =>
    declaredIds.has(id)
      ? Effect.die(new Error(`duplicate resource id '${id}'`))
      : Effect.sync(() => {
          declaredIds.add(id);
          return output;
        });

  const constructors = {
    NomadJob: (id: string, props: Job) => {
      nomadJobCalls.push({ id, props });
      return declare(id, { id: `${id}-nomad` });
    },
    PostgresDatabase: (id: string, props: PostgresDatabaseProps) => {
      postgresDatabaseCalls.push({ id, props });
      return declare(id, {
        id: `${id}-pg`,
        name: props.name,
        server: props.server,
        credentialPath: `db/creds/${props.credentialRole}`,
        migrationCredentialPath: `db/creds/${props.migrationCredentialRole}`,
      });
    },
    ValkeyAccess: (id: string, props: ValkeyAccessConfig) => {
      valkeyAccessCalls.push({ id, props });
      return declare(id, {
        id: `${id}-va`,
        credentialPath: `secret/data/valkey/${props.resourceName}`,
      });
    },
    TailscaleServe: (id: string, props: TailscaleServeProps) => {
      tailscaleServeCalls.push({ id, props });
      return declare(id, {
        id: `${id}-ts`,
        port: 9000,
        backendPort: 10000,
        url: `https://cynic.tail.example:9000`,
      });
    },
    AdminCredential: (id: string, props: AdminCredentialProps) => {
      adminCredentialCalls.push({ id, props });
      return declare(id, {
        id: `${id}-ac`,
        path: `secret/data/${props.engine}/servers/${props.server}`,
      });
    },
    OpenObserveDashboard: (id: string, props: OpenObserveDashboardProps) => {
      dashboardCalls.push({ id, props });
      return declare(id, { dashboardId: `${id}-oo`, hash: "1" });
    },
  };

  return {
    constructors,
    nomadJobCalls,
    postgresDatabaseCalls,
    valkeyAccessCalls,
    adminCredentialCalls,
    tailscaleServeCalls,
    dashboardCalls,
  };
};

describe("Compose", () => {
  it("declares a Serve lease before the job and resolves its route URL and backend port", async () => {
    const source = readCartridge("../examples/app-needs/cartridge.json");
    const service = source.services[0];
    const cartridge: Cartridge = {
      ...source,
      services: source.services.map((job) =>
        job.name === service.name
          ? {
              ...job,
              routes: [{ access: "tailnet" }],
              environment: [...job.environment, { name: "ROOT_URL", route: job.name }],
            }
          : job,
      ),
    };
    const { constructors, nomadJobCalls, tailscaleServeCalls } = makeConstructors();
    const deployed = await Effect.runPromise(compose(expand(cartridge), constructors));
    assert.deepEqual(
      deployed.tailnetServes.map((serve) => serve.resource.url),
      ["https://cynic.tail.example:9000"],
    );
    assert.equal(tailscaleServeCalls.length, 1);
    const job = nomadJobCalls.find((call) => call.id === service.name);
    assert.ok(job);
    assert.equal(job.props.hostPort, 10000);
    assert.ok(
      job.props.environment.some(
        (entry) =>
          "value" in entry &&
          entry.name === "ROOT_URL" &&
          entry.value === "https://cynic.tail.example:9000",
      ),
    );
  });
  it("composes app-needs: postgres and valkey servers, credential paths, urls", async () => {
    const cartridge = readCartridge("../examples/app-needs/cartridge.json");
    const resources = expand(cartridge);
    const { constructors, nomadJobCalls, postgresDatabaseCalls, valkeyAccessCalls } =
      makeConstructors();

    await Effect.runPromise(compose(resources, constructors));

    assert.equal(postgresDatabaseCalls.length, 1);
    assert.equal(postgresDatabaseCalls[0].props.server, "postgres");

    assert.equal(valkeyAccessCalls.length, 1);
    assert.equal(valkeyAccessCalls[0].props.server, "valkey");

    const serverJobs = nomadJobCalls.filter(
      (call) => call.id === "postgres" || call.id === "valkey",
    );
    assert.equal(serverJobs.length, 0);

    const appJob = nomadJobCalls.find((call) => call.id === "app-needs");
    assert.ok(appJob);

    const pgSecret = (appJob.props.secrets ?? []).find(
      (
        s,
      ): s is Extract<
        NonNullable<typeof appJob.props.secrets>[number],
        { _tag: "PostgresCredentials" }
      > => s._tag === "PostgresCredentials",
    );
    assert.ok(pgSecret);
    assert.equal(pgSecret.credentialPath, "db/creds/alchemy_app_needs_api");
    if (pgSecret.url !== undefined) {
      assert.equal(pgSecret.url.server, "postgres");
      assert.equal(pgSecret.url.database, "app_needs");
    }

    const vkSecret = (appJob.props.secrets ?? []).find(
      (
        s,
      ): s is Extract<
        NonNullable<typeof appJob.props.secrets>[number],
        { _tag: "ValkeyCredentials" }
      > => s._tag === "ValkeyCredentials",
    );
    assert.ok(vkSecret);
    assert.equal(vkSecret.credentialPath, "secret/data/valkey/app_needs");
    if (vkSecret.url !== undefined) {
      assert.equal(vkSecret.url.server, "valkey");
    }
  });

  it("routes migration and api logins to their credential paths", async () => {
    const cartridge = S.decodeUnknownSync(Cartridge)({
      apiVersion: "server-ansible/v2",
      name: "app-needs",
      postgres: [{ database: "app_needs" }],
      valkey: {},
      services: [
        {
          name: "app-needs",
          image: "example/app-needs:latest",
          hostPort: "dynamic",
          containerPort: 8080,
          cpu: 200,
          memoryMB: 256,
          networkMode: "bridge",
          environment: [],
          connections: [],
          secrets: [
            {
              _tag: "PostgresCredentials",
              database: "app_needs",
              login: "api",
              usernameEnv: "PGUSER",
              passwordEnv: "PGPASSWORD",
              urlEnv: "DATABASE_URL",
            },
            {
              _tag: "PostgresCredentials",
              database: "app_needs",
              login: "migration",
              usernameEnv: "MIGUSER",
              passwordEnv: "MIGPASSWORD",
            },
          ],
        },
      ],
    });
    const resources = expand(cartridge);
    const { constructors, nomadJobCalls } = makeConstructors();

    await Effect.runPromise(compose(resources, constructors));

    const appJob = nomadJobCalls.find((call) => call.id === "app-needs");
    assert.ok(appJob);
    const credentialPathByRole = new Map(
      (appJob.props.secrets ?? []).flatMap((secret) =>
        secret._tag === "PostgresCredentials"
          ? [[secret.role, secret.credentialPath] as const]
          : [],
      ),
    );
    assert.equal(
      credentialPathByRole.get("alchemy_app_needs_api"),
      "db/creds/alchemy_app_needs_api",
    );
    assert.equal(
      credentialPathByRole.get("alchemy_app_needs_migration"),
      "db/creds/alchemy_app_needs_migration",
    );
  });

  it("resolves a migrate step's login to the migration credential path", async () => {
    const cartridge = S.decodeUnknownSync(Cartridge)({
      apiVersion: "server-ansible/v2",
      name: "app-needs",
      postgres: [{ database: "app_needs" }],
      services: [
        {
          name: "app-needs",
          image: "example/app-needs:latest",
          hostPort: "dynamic",
          containerPort: 8080,
          cpu: 200,
          memoryMB: 256,
          networkMode: "bridge",
          environment: [],
          connections: [],
          secrets: [
            {
              _tag: "PostgresCredentials",
              database: "app_needs",
              login: "api",
              usernameEnv: "PGUSER",
              passwordEnv: "PGPASSWORD",
              urlEnv: "DATABASE_URL",
            },
          ],
          migrate: {
            command: "graphile-migrate",
            args: ["migrate"],
            secrets: [
              {
                _tag: "PostgresCredentials",
                database: "app_needs",
                login: "migration",
                usernameEnv: "MIGUSER",
                passwordEnv: "MIGPASSWORD",
              },
            ],
          },
        },
      ],
    });
    const resources = expand(cartridge);
    const { constructors, nomadJobCalls } = makeConstructors();

    await Effect.runPromise(compose(resources, constructors));

    const appJob = nomadJobCalls.find((call) => call.id === "app-needs");
    assert.ok(appJob);

    const mainSecret = (appJob.props.secrets ?? []).find(
      (
        s,
      ): s is Extract<
        NonNullable<typeof appJob.props.secrets>[number],
        { _tag: "PostgresCredentials" }
      > => s._tag === "PostgresCredentials",
    );
    assert.ok(mainSecret);
    assert.equal(mainSecret.credentialPath, "db/creds/alchemy_app_needs_api");

    const migrateSecret = (appJob.props.migrate?.secrets ?? []).find(
      (
        s,
      ): s is Extract<
        NonNullable<NonNullable<typeof appJob.props.migrate>["secrets"]>[number],
        { _tag: "PostgresCredentials" }
      > => s._tag === "PostgresCredentials",
    );
    assert.ok(migrateSecret);
    assert.equal(migrateSecret.credentialPath, "db/creds/alchemy_app_needs_migration");
  });

  it("gives platform/data server jobs one admin KvSecret each", async () => {
    const cartridge = readCartridge("../platform/data/cartridge.json");
    const resources = expand(cartridge);
    const { constructors, nomadJobCalls } = makeConstructors();

    await Effect.runPromise(compose(resources, constructors));

    const pgJob = nomadJobCalls.find((call) => call.id === "postgres");
    assert.ok(pgJob);
    assert.equal((pgJob.props.secrets ?? []).length, 1);
    const pgSecret = (pgJob.props.secrets ?? [])[0];
    assert.equal(pgSecret._tag, "KvSecret");
    assert.equal(pgSecret.env, "POSTGRES_PASSWORD");
    assert.equal(pgSecret.path, "secret/data/postgres/servers/postgres");

    const vkJob = nomadJobCalls.find((call) => call.id === "valkey");
    assert.ok(vkJob);
    assert.equal((vkJob.props.secrets ?? []).length, 1);
    const vkSecret = (vkJob.props.secrets ?? [])[0];
    assert.equal(vkSecret._tag, "KvSecret");
    assert.equal(vkSecret.env, "VALKEY_ADMIN_PASSWORD");
    assert.equal(vkSecret.path, "secret/data/valkey/servers/valkey");
  });

  it("resolves otel-collector connection to openobserve resource id", async () => {
    const cartridge = readCartridge("../platform/observability/cartridge.json");
    const resources = expand(cartridge);
    const { constructors, nomadJobCalls } = makeConstructors();

    await Effect.runPromise(compose(resources, constructors));

    const openobserveJob = nomadJobCalls.find((call) => call.id === "openobserve");
    const otelJob = nomadJobCalls.find((call) => call.id === "otel-collector");
    assert.ok(openobserveJob);
    assert.ok(otelJob);
    assert.equal(otelJob.props.connections[0].service, "openobserve-nomad");
  });

  it("points each dashboard at the output of its OpenObserve job", async () => {
    const cartridge = readCartridge("../platform/observability/cartridge.json");
    const dashboard = {
      server: "openobserve",
      username: "automation.default@sa.internal",
      token: { path: "secret/data/platform/openobserve", key: "automation_token" },
      dashboard: { version: 8 as const, title: "Services", description: "", tabs: [] },
    };
    const { constructors, dashboardCalls } = makeConstructors();

    const deployed = await Effect.runPromise(
      compose(
        [...expand(cartridge), { _tag: "OpenObserveDashboard", name: "services", dashboard }],
        constructors,
      ),
    );

    assert.deepEqual(
      dashboardCalls.map((call) => [call.id, call.props.server]),
      [["openobserve-dashboard-services", "openobserve-nomad"]],
    );
    assert.deepEqual(deployed.outputs.at(-1), {
      kind: "OpenObserveDashboard",
      id: "openobserve-dashboard-services-oo",
      name: "services",
    });
  });
});
