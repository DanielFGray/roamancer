import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import { NodeFileSystem } from "@effect/platform-node";
import { fileURLToPath } from "node:url";
import {
  AppCartridge,
  expand,
  resolve,
  kvKeys,
  missingSecrets,
  decodeFile,
  Cartridge,
} from "./Cartridge.ts";
import * as Deployments from "./Deployments.ts";
import { routeTags } from "./Job.ts";
import * as ConfigProvider from "effect/ConfigProvider";
import type * as FileSystem from "effect/FileSystem";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as S from "effect/Schema";

describe("cartridge v2", () => {
  it("derives names for a database and Valkey access", () => {
    const cartridge = S.decodeUnknownSync(Cartridge)({
      apiVersion: "server-ansible/v2",
      name: "app-needs",
      postgres: [{ database: "app_needs" }],
      valkey: {},
      services: [],
    });
    const resources = expand(cartridge);
    const db = resources.find(
      (r): r is Extract<(typeof resources)[number], { _tag: "PostgresDatabase" }> =>
        r._tag === "PostgresDatabase",
    );
    assert.ok(db);
    assert.equal(db.database.name, "app_needs");
    assert.equal(db.database.ownerRole, "app_needs_owner");
    assert.equal(db.database.visitorRole, "app_needs_visitor");
    const va = resources.find(
      (r): r is Extract<(typeof resources)[number], { _tag: "ValkeyAccess" }> =>
        r._tag === "ValkeyAccess",
    );
    assert.ok(va);
    assert.equal(va.access.resourceName, "app_needs");
    assert.equal(va.access.keyPrefix, "app-needs");
  });

  it("resolves a database role entry to that database's role name", async () => {
    const cartridge = await Effect.runPromise(
      decodeFile(
        fileURLToPath(new URL("../examples/apps/giglist/cartridge.json", import.meta.url)),
        AppCartridge,
      ).pipe(Effect.provide(NodeFileSystem.layer)),
    );
    const service = expand(cartridge).find((resource) => resource._tag === "NomadService");
    assert.ok(service);
    assert.deepEqual(
      service.service.environment.filter((entry) => entry.name.startsWith("DATABASE_")),
      [
        { name: "DATABASE_NAME", value: "giglist" },
        { name: "DATABASE_OWNER", value: "giglist_owner" },
        { name: "DATABASE_VISITOR", value: "giglist_visitor" },
      ],
    );
  });

  describe("app namespace", () => {
    const job = (overrides: Record<string, unknown>) => ({
      name: "shop-web",
      image: "img",
      hostPort: "dynamic",
      containerPort: 80,
      cpu: 100,
      memoryMB: 128,
      networkMode: "bridge",
      environment: [],
      connections: [],
      secrets: [],
      ...overrides,
    });
    const app = (overrides: Record<string, unknown>) => ({
      apiVersion: "server-ansible/v2",
      name: "shop",
      services: [],
      ...overrides,
    });
    const kv = (path: string) => ({ _tag: "KvSecret", path, key: "k", env: "K" });

    it("accepts identities equal to or under the app name", () => {
      S.decodeUnknownSync(AppCartridge)(
        app({
          postgres: [{ database: "shop" }, { database: "shop_audit" }],
          services: [
            job({
              name: "shop",
              storage: { volume: "shop-data", mountPath: "/data" },
              secrets: [kv("secret/data/shop"), kv("secret/data/shop/mail")],
            }),
            job({ name: "shop-worker" }),
          ],
        }),
      );
    });

    const rejected: ReadonlyArray<[string, Record<string, unknown>, string]> = [
      ["database", { postgres: [{ database: "other_db" }] }, "Database 'other_db'"],
      ["service", { services: [job({ name: "other-web" })] }, "Service 'other-web'"],
      ["name that only shares a prefix", { services: [job({ name: "shopping" })] }, "'shopping'"],
      [
        "KV path",
        { services: [job({ secrets: [kv("secret/data/other")] })] },
        "KV path 'secret/data/other'",
      ],
      [
        "KV path that only shares a prefix",
        { services: [job({ secrets: [kv("secret/data/shopping")] })] },
        "'secret/data/shopping'",
      ],
      [
        "volume",
        { services: [job({ storage: { volume: "other-data", mountPath: "/data" } })] },
        "Volume 'other-data'",
      ],
    ];
    for (const [what, overrides, message] of rejected) {
      it(`rejects a ${what} outside the app's namespace`, () => {
        assert.throws(() => S.decodeUnknownSync(AppCartridge)(app(overrides)), {
          message: new RegExp(message.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")),
        });
      });
    }

    it("does not hold platform cartridges to it", () => {
      S.decodeUnknownSync(Cartridge)(app({ services: [job({ name: "traefik" })] }));
    });
  });

  it("rejects a PostgresCredentials naming a database not in postgres", () => {
    assert.throws(() =>
      S.decodeUnknownSync(Cartridge)({
        apiVersion: "server-ansible/v2",
        name: "app-needs",
        postgres: [{ database: "app_needs" }],
        services: [
          {
            name: "svc",
            image: "img",
            hostPort: "dynamic",
            containerPort: 80,
            cpu: 100,
            memoryMB: 128,
            networkMode: "bridge",
            environment: [],
            connections: [],
            secrets: [
              {
                _tag: "PostgresCredentials",
                database: "missing_db",
                login: "api",
                usernameEnv: "U",
              },
            ],
          },
        ],
      }),
    );
  });

  it("rejects ValkeyCredentials without valkey", () => {
    assert.throws(() =>
      S.decodeUnknownSync(Cartridge)({
        apiVersion: "server-ansible/v2",
        name: "app-needs",
        services: [
          {
            name: "svc",
            image: "img",
            hostPort: "dynamic",
            containerPort: 80,
            cpu: 100,
            memoryMB: 128,
            networkMode: "bridge",
            environment: [],
            connections: [],
            secrets: [
              {
                _tag: "ValkeyCredentials",
                usernameEnv: "U",
              },
            ],
          },
        ],
      }),
    );
  });

  it("rejects a secret with no env field", () => {
    assert.throws(() =>
      S.decodeUnknownSync(Cartridge)({
        apiVersion: "server-ansible/v2",
        name: "app-needs",
        postgres: [{ database: "app_needs" }],
        services: [
          {
            name: "svc",
            image: "img",
            hostPort: "dynamic",
            containerPort: 80,
            cpu: 100,
            memoryMB: 128,
            networkMode: "bridge",
            environment: [],
            connections: [],
            secrets: [
              {
                _tag: "PostgresCredentials",
                database: "app_needs",
                login: "api",
              },
            ],
          },
        ],
      }),
    );
  });

  it("rejects a migrate PostgresCredentials naming an undeclared database", () => {
    assert.throws(() =>
      S.decodeUnknownSync(Cartridge)({
        apiVersion: "server-ansible/v2",
        name: "app-needs",
        postgres: [{ database: "app_needs" }],
        services: [
          {
            name: "svc",
            image: "img",
            hostPort: "dynamic",
            containerPort: 80,
            cpu: 100,
            memoryMB: 128,
            networkMode: "bridge",
            environment: [],
            connections: [],
            secrets: [],
            migrate: {
              command: "graphile-migrate",
              args: ["migrate"],
              secrets: [
                {
                  _tag: "PostgresCredentials",
                  database: "missing_db",
                  login: "migration",
                  usernameEnv: "U",
                },
              ],
            },
          },
        ],
      }),
    );
  });

  it("serves a tailnet-only service through Tailscale Serve and registers no Traefik route", () => {
    const cartridge = S.decodeUnknownSync(Cartridge)({
      apiVersion: "server-ansible/v2",
      name: "private-app",
      services: [
        {
          name: "private-app",
          image: "img",
          hostPort: "dynamic",
          containerPort: 80,
          cpu: 100,
          memoryMB: 128,
          networkMode: "bridge",
          environment: [],
          connections: [],
          secrets: [],
          routes: [{ access: "tailnet" }],
        },
      ],
    });
    const resources = expand(cartridge);
    assert.deepEqual(
      resources.map((resource) => resource._tag),
      ["TailscaleServe", "NomadService"],
    );
    const service = resources.find((resource) => resource._tag === "NomadService");
    assert.ok(service && service._tag === "NomadService");
    assert.deepEqual(
      routeTags({ ...service.service, environment: [], secrets: [], migrate: undefined }),
      [],
    );
  });

  it("rejects migrate on a server declaration", () => {
    assert.throws(() =>
      S.decodeUnknownSync(Cartridge)({
        apiVersion: "server-ansible/v2",
        name: "app-needs",
        servers: [
          {
            _tag: "PostgresServer",
            service: {
              name: "postgres",
              image: "img",
              hostPort: "dynamic",
              containerPort: 5432,
              cpu: 100,
              memoryMB: 128,
              networkMode: "bridge",
              environment: [],
              connections: [],
              secrets: [],
              migrate: {
                secrets: [
                  {
                    _tag: "KvSecret",
                    path: "secret/data/x",
                    key: "k",
                    env: "E",
                  },
                ],
              },
            },
          },
        ],
        services: [],
      }),
    );
  });

  it("accepts a service listed before the service it connects to, and expand puts the dependency first", () => {
    const cartridge = S.decodeUnknownSync(Cartridge)({
      apiVersion: "server-ansible/v2",
      name: "app-needs",
      services: [
        {
          name: "consumer",
          image: "img",
          hostPort: "dynamic",
          containerPort: 80,
          cpu: 100,
          memoryMB: 128,
          networkMode: "bridge",
          environment: [],
          connections: [{ service: "provider", hostEnv: "H", portEnv: "P" }],
          secrets: [],
        },
        {
          name: "provider",
          image: "img",
          hostPort: "dynamic",
          containerPort: 80,
          cpu: 100,
          memoryMB: 128,
          networkMode: "bridge",
          environment: [],
          connections: [],
          secrets: [],
        },
      ],
    });
    const resources = expand(cartridge);
    assert.deepEqual(
      resources.map((resource) => ("service" in resource ? resource.service.name : resource._tag)),
      ["provider", "consumer"],
    );
  });

  it("rejects a two-job cycle, naming both jobs", () => {
    assert.throws(
      () =>
        S.decodeUnknownSync(Cartridge)({
          apiVersion: "server-ansible/v2",
          name: "app-needs",
          services: [
            {
              name: "consumer",
              image: "img",
              hostPort: "dynamic",
              containerPort: 80,
              cpu: 100,
              memoryMB: 128,
              networkMode: "bridge",
              environment: [],
              connections: [{ service: "provider", hostEnv: "H", portEnv: "P" }],
              secrets: [],
            },
            {
              name: "provider",
              image: "img",
              hostPort: "dynamic",
              containerPort: 80,
              cpu: 100,
              memoryMB: 128,
              networkMode: "bridge",
              environment: [],
              connections: [{ service: "consumer", hostEnv: "H", portEnv: "P" }],
              secrets: [],
            },
          ],
        }),
      /Services consumer, provider form a dependency cycle/,
    );
  });

  it("rejects a connection to an undeclared service", () => {
    assert.throws(
      () =>
        S.decodeUnknownSync(Cartridge)({
          apiVersion: "server-ansible/v2",
          name: "app-needs",
          services: [
            {
              name: "consumer",
              image: "img",
              hostPort: "dynamic",
              containerPort: 80,
              cpu: 100,
              memoryMB: 128,
              networkMode: "bridge",
              environment: [],
              connections: [{ service: "missing", hostEnv: "H", portEnv: "P" }],
              secrets: [],
            },
          ],
        }),
      /Service 'consumer' connects to undeclared service 'missing'/,
    );
  });

  it("rejects duplicate job names", () => {
    assert.throws(() =>
      S.decodeUnknownSync(Cartridge)({
        apiVersion: "server-ansible/v2",
        name: "app-needs",
        services: [
          {
            name: "svc",
            image: "img",
            hostPort: "dynamic",
            containerPort: 80,
            cpu: 100,
            memoryMB: 128,
            networkMode: "bridge",
            environment: [],
            connections: [],
            secrets: [],
          },
          {
            name: "svc",
            image: "img",
            hostPort: "dynamic",
            containerPort: 80,
            cpu: 100,
            memoryMB: 128,
            networkMode: "bridge",
            environment: [],
            connections: [],
            secrets: [],
          },
        ],
      }),
    );
  });

  it("rejects a cartridge declaring both servers and postgres", () => {
    assert.throws(() =>
      S.decodeUnknownSync(Cartridge)({
        apiVersion: "server-ansible/v2",
        name: "app-needs",
        servers: [
          {
            _tag: "PostgresServer",
            service: {
              name: "postgres",
              image: "img",
              hostPort: "dynamic",
              containerPort: 5432,
              cpu: 100,
              memoryMB: 128,
              networkMode: "bridge",
              environment: [],
              connections: [],
              secrets: [],
            },
          },
        ],
        postgres: [{ database: "app_needs" }],
        services: [],
      }),
    );
  });

  it("rejects duplicate database names", () => {
    assert.throws(() =>
      S.decodeUnknownSync(Cartridge)({
        apiVersion: "server-ansible/v2",
        name: "app-needs",
        postgres: [{ database: "app_needs" }, { database: "app_needs" }],
        services: [],
      }),
    );
  });

  it("expands app-needs with derived credential roles", () => {
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
              _tag: "ValkeyCredentials",
              usernameEnv: "VALKEY_USER",
              passwordEnv: "VALKEY_PASSWORD",
              urlEnv: "VALKEY_URL",
            },
          ],
        },
      ],
    });
    const resources = expand(cartridge);
    const service = resources.find(
      (r): r is Extract<(typeof resources)[number], { _tag: "NomadService" }> =>
        r._tag === "NomadService",
    );
    assert.ok(service);
    const pg = service.service.secrets?.find((s) => s._tag === "PostgresCredentials");
    const vk = service.service.secrets?.find((s) => s._tag === "ValkeyCredentials");
    assert.equal(pg?.role, "alchemy_app_needs_api");
    assert.equal(vk?.access, "app_needs");
  });

  it("passes declared extensions to the database and rejects names that are not identifiers", () => {
    const declare = (extensions: ReadonlyArray<string>) => ({
      apiVersion: "server-ansible/v2",
      name: "app-needs",
      postgres: [{ database: "app_needs", extensions }],
      services: [],
    });
    const resources = expand(S.decodeUnknownSync(Cartridge)(declare(["uuid-ossp", "pgtap"])));
    const database = resources.find((r) => r._tag === "PostgresDatabase");
    assert.ok(database);
    assert.deepEqual(database.database.extensions, ["uuid-ossp", "pgtap"]);
    assert.throws(() => S.decodeUnknownSync(Cartridge)(declare(['pgtap"; DROP'])));
  });

  it("preserves ingress network, identity and mount declarations during expansion", async () => {
    const cartridge = await Effect.runPromise(
      decodeFile(
        fileURLToPath(new URL("../platform/ingress/cartridge.json", import.meta.url)),
        Cartridge,
      ).pipe(Effect.provide(NodeFileSystem.layer)),
    );
    const resource = expand(cartridge).find((entry) => entry._tag === "NomadService");
    assert.ok(resource);
    assert.equal(resource.service.networkMode, "host");
    assert.deepEqual(resource.service.identity, { env: true });
    assert.deepEqual(resource.service.readOnlyMounts, [
      { volume: "traefik-routes", mountPath: "/var/lib/traefik-routes" },
      { volume: "nix-store", mountPath: "/nix/store" },
    ]);
  });

  const committed = [
    ["../platform/observability/cartridge.json", Cartridge],
    ["../platform/ingress/cartridge.json", Cartridge],
    ["../platform/data/cartridge.json", Cartridge],
    ["../examples/app-needs/cartridge.json", AppCartridge],
    ["../examples/apps/giglist/cartridge.json", AppCartridge],
    ["../examples/apps/noneuclid/cartridge.json", AppCartridge],
    ["../examples/apps/postgres-garden/cartridge.json", AppCartridge],
  ] as const;
  for (const [rel, schema] of committed) {
    it(`loads ${rel}`, async () => {
      const cartridge = await Effect.runPromise(
        decodeFile(fileURLToPath(new URL(rel, import.meta.url)), schema).pipe(
          Effect.provide(NodeFileSystem.layer),
        ),
      );
      assert.ok(cartridge);
    });
  }

  describe("resolve", () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const giglistFile = fileURLToPath(
      new URL("../examples/apps/giglist/cartridge.json", import.meta.url),
    );
    const scratch = () => mkdtempSync(join(tmpdir(), "resolve-"));
    const run = <A, E>(
      effect: Effect.Effect<A, E, Deployments.Deployments | FileSystem.FileSystem>,
      env: Record<string, string> = {},
    ) =>
      Effect.runPromise(
        effect.pipe(
          Effect.provide(Deployments.layer(join(scratch(), "d.sqlite"))),
          Effect.provide(NodeFileSystem.layer),
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(env))),
        ),
      );

    it("finds a platform cartridge by its name, not its folder", async () => {
      const found = await run(resolve(root, "platform-data"));
      assert.equal(found.name, "platform-data");
    });

    it("reads an app from the file ops sent", async () => {
      const found = await run(resolve(root, "giglist"), { CARTRIDGE_FILE: giglistFile });
      assert.equal(found.name, "giglist");
    });

    it("refuses a sent cartridge whose name is not the stage", async () => {
      await assert.rejects(run(resolve(root, "postgres-garden"), { CARTRIDGE_FILE: giglistFile }), {
        message: /stage 'postgres-garden' was given the cartridge of 'giglist'/,
      });
    });

    it("reads an app from its newest recorded deployment", async () => {
      const found = await run(
        Effect.gen(function* () {
          const deployments = yield* Deployments.Deployments;
          const cartridge = readFileSync(giglistFile, "utf8");
          yield* deployments.record({ name: "giglist", origin: "o", revision: "r", cartridge });
          return yield* resolve(root, "giglist");
        }),
      );
      assert.equal(found.name, "giglist");
    });

    it("refuses an app with neither", async () => {
      await assert.rejects(run(resolve(root, "giglist")), { message: /no recorded deployment/ });
    });
  });

  it("groups the KV keys a cartridge reads by path, across service and migration", () => {
    const kv = (path: string, key: string) => ({ _tag: "KvSecret", path, key, env: "E" });
    const service = (
      name: string,
      secrets: ReadonlyArray<unknown>,
      migrate: ReadonlyArray<unknown>,
    ) => ({
      name,
      image: "img",
      hostPort: "dynamic",
      containerPort: 80,
      cpu: 100,
      memoryMB: 128,
      networkMode: "bridge",
      environment: [],
      connections: [],
      secrets,
      migrate: { command: "m", args: [], secrets: migrate },
    });
    const cartridge = S.decodeUnknownSync(Cartridge)({
      apiVersion: "server-ansible/v2",
      name: "app",
      services: [
        service(
          "web",
          [kv("secret/data/app", "a"), kv("secret/data/app", "b")],
          [kv("secret/data/app", "a")],
        ),
        service("worker", [kv("secret/data/shared", "c")], []),
      ],
    });
    assert.deepEqual(
      kvKeys(cartridge),
      new Map([
        ["secret/data/app", ["a", "b"]],
        ["secret/data/shared", ["c"]],
      ]),
    );
    assert.deepEqual(
      missingSecrets(kvKeys(cartridge), new Map([["secret/data/app", ["b", "unused"]]])),
      [
        { path: "secret/data/app", key: "a" },
        { path: "secret/data/shared", key: "c" },
      ],
    );
  });
});
