import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import { NodeFileSystem } from "@effect/platform-node";
import { fileURLToPath } from "node:url";
import { expand, load, Cartridge } from "./Cartridge.ts";
import * as Schema from "effect/Schema";

describe("cartridge v2", () => {
  it("derives names for a database and Valkey access", () => {
    const cartridge = Schema.decodeUnknownSync(Cartridge)({
      apiVersion: "server-ansible/v2",
      name: "app-needs",
      postgres: [{ database: "app_needs" }],
      valkey: {},
      services: [],
    });
    const resources = expand(cartridge);
    const db = resources.find(
      (r): r is Extract<typeof resources[number], { _tag: "PostgresDatabase" }> => r._tag === "PostgresDatabase",
    );
    assert.ok(db);
    assert.equal(db.database.resourceName, "app_needs");
    assert.equal(db.database.ownerRole, "app_needs_owner");
    assert.equal(db.database.visitorRole, "app_needs_visitor");
    const va = resources.find(
      (r): r is Extract<typeof resources[number], { _tag: "ValkeyAccess" }> => r._tag === "ValkeyAccess",
    );
    assert.ok(va);
    assert.equal(va.access.resourceName, "app_needs");
    assert.equal(va.access.keyPrefix, "app-needs");
  });

  it("rejects a database name that does not start with the app name", () => {
    assert.throws(() =>
      Schema.decodeUnknownSync(Cartridge)({
        apiVersion: "server-ansible/v2",
        name: "app-needs",
        postgres: [{ database: "other_db" }],
        services: [],
      }),
    );
  });

  it("rejects a PostgresCredentials naming a database not in postgres", () => {
    assert.throws(() =>
      Schema.decodeUnknownSync(Cartridge)({
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
      Schema.decodeUnknownSync(Cartridge)({
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
      Schema.decodeUnknownSync(Cartridge)({
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

  it("rejects a service before a service it connects to", () => {
    assert.throws(() =>
      Schema.decodeUnknownSync(Cartridge)({
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
      }),
    );
  });

  it("rejects duplicate job names", () => {
    assert.throws(() =>
      Schema.decodeUnknownSync(Cartridge)({
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
      Schema.decodeUnknownSync(Cartridge)({
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
      Schema.decodeUnknownSync(Cartridge)({
        apiVersion: "server-ansible/v2",
        name: "app-needs",
        postgres: [{ database: "app_needs" }, { database: "app_needs" }],
        services: [],
      }),
    );
  });

  it("expands app-needs with derived credential roles", () => {
    const cartridge = Schema.decodeUnknownSync(Cartridge)({
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
      (r): r is Extract<typeof resources[number], { _tag: "NomadService" }> => r._tag === "NomadService",
    );
    assert.ok(service);
    const pg = service.service.secrets?.find((s) => s._tag === "PostgresCredentials");
    const vk = service.service.secrets?.find((s) => s._tag === "ValkeyCredentials");
    assert.equal(pg?.role, "alchemy_app_needs_api");
    assert.equal(vk?.access, "app_needs");
  });

  const committed = [
    "../platform/observability/cartridge.json",
    "../platform/data/cartridge.json",
    "../examples/app-needs/cartridge.json",
  ];
  for (const rel of committed) {
    it(`loads ${rel}`, async () => {
      process.env.ALCHEMY_CARTRIDGE = fileURLToPath(new URL(rel, import.meta.url));
      const cartridge = await Effect.runPromise(load().pipe(Effect.provide(NodeFileSystem.layer)));
      assert.ok(cartridge);
    });
  }
});