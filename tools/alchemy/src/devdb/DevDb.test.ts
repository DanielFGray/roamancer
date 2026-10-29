import { describe, it, before, after } from "node:test";
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";
import * as PgClient from "@effect/sql-pg/PgClient";
import { postgresLoginRole } from "../Cartridge.ts";
import { provisionPostgresDatabase } from "../PostgresProvisioning.ts";
import { applyManagedKeys } from "./EnvFile.ts";
import { databaseDeclarations, managedEnvKeys, managedEnvValues } from "./Declaration.ts";
import type { DevDbCartridge } from "./DevDbCartridge.ts";

const PORT = 55418;
const CONTAINER = "alchemy-ops-devdb-test";
const PASSWORD = "devdb-test-admin";

const adminLayer = (database: string) =>
  PgClient.layerFrom(
    PgClient.makeClient({
      host: "127.0.0.1",
      port: PORT,
      database,
      username: "postgres",
      password: Redacted.make(PASSWORD),
      applicationName: "ops-devdb-test",
    }),
  );

const cartridge = {
  postgres: [{ database: "giglist", extensions: ["pgcrypto"] }],
  services: [
    {
      secrets: [
        {
          _tag: "PostgresCredentials",
          database: "giglist",
          login: "migration",
          urlEnv: "DATABASE_URL",
        },
        {
          _tag: "PostgresCredentials",
          database: "giglist",
          login: "api",
          urlEnv: "AUTH_DATABASE_URL",
        },
      ],
      migrate: { secrets: [] },
    },
  ],
} as DevDbCartridge;

const waitReady = async () => {
  for (let attempt = 0; attempt < 40; attempt++) {
    const result = spawnSync(
      "docker",
      ["exec", CONTAINER, "pg_isready", "-U", "postgres", "-h", "127.0.0.1"],
      { encoding: "utf8" },
    );
    if (result.status === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("test postgres did not become ready");
};

describe("ops dev db provision + env", () => {
  before(async () => {
    spawnSync("docker", ["rm", "-f", CONTAINER], { encoding: "utf8" });
    const started = spawnSync(
      "docker",
      [
        "run",
        "-d",
        "--name",
        CONTAINER,
        "-e",
        `POSTGRES_PASSWORD=${PASSWORD}`,
        "-p",
        `127.0.0.1:${PORT}:5432`,
        "postgres:17-alpine",
      ],
      { encoding: "utf8" },
    );
    assert.equal(started.status, 0, started.stderr);
    await waitReady();
  });

  after(() => {
    spawnSync("docker", ["rm", "-f", CONTAINER], { encoding: "utf8" });
  });

  const passwords = new Map([
    [postgresLoginRole("giglist", "api"), "api-secret"],
    [postgresLoginRole("giglist", "migration"), "migration-secret"],
  ]);
  const passwordFor = (role: string) => Redacted.make(passwords.get(role)!);

  it("provisions from the cartridge mapping and a second env write is identical", async () => {
    const [declaration] = databaseDeclarations(cartridge, passwordFor);
    assert.ok(declaration);

    const first = await Effect.runPromise(provisionPostgresDatabase(declaration, adminLayer));
    assert.equal(first.created, true);
    const second = await Effect.runPromise(provisionPostgresDatabase(declaration, adminLayer));
    assert.equal(second.created, false);

    const owner = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{ readonly owner: string }>`
          SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = ${"giglist"}
        `;
        return rows[0]?.owner;
      }).pipe(Effect.provide(adminLayer("postgres"))),
    );
    assert.equal(owner, "giglist_owner");

    const dir = mkdtempSync(join(tmpdir(), "ops-devdb-env-"));
    try {
      const envPath = join(dir, ".env");
      writeFileSync(envPath, "NODE_ENV=development\nSECRET=keep\nDATABASE_URL=old\n");
      const values = managedEnvValues(managedEnvKeys(cartridge), (role) => passwords.get(role)!);
      const once = applyManagedKeys(readFileSync(envPath, "utf8"), values);
      writeFileSync(envPath, once);
      const twice = applyManagedKeys(readFileSync(envPath, "utf8"), values);
      assert.equal(twice, once);
      assert.match(once, /^NODE_ENV=development$/m);
      assert.match(once, /^SECRET=keep$/m);
      assert.match(once, /DATABASE_URL=postgresql:\/\/alchemy_giglist_migration:/);
      assert.match(once, /AUTH_DATABASE_URL=postgresql:\/\/alchemy_giglist_api:/);
      assert.equal(twice, once, "second env write must be identical");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // graphile-migrate commit runs these statements through ROOT_DATABASE_URL, which ops
  // points at `postgres` as the migration login. Apps set databaseOwner to the owner role.
  it("lets the migration login drop and recreate the shadow database", async () => {
    for (const declaration of databaseDeclarations(cartridge, passwordFor)) {
      await Effect.runPromise(provisionPostgresDatabase(declaration, adminLayer));
    }
    const rootUrl = managedEnvValues(managedEnvKeys(cartridge), (role) =>
      passwords.get(role)!,
    ).ROOT_DATABASE_URL;
    assert.ok(rootUrl !== undefined, "ops writes ROOT_DATABASE_URL");
    const root = new URL(rootUrl);
    root.port = String(PORT);
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DROP DATABASE IF EXISTS giglist_shadow`;
        yield* sql`CREATE DATABASE giglist_shadow OWNER giglist_owner`;
        yield* sql`REVOKE ALL ON DATABASE giglist_shadow FROM PUBLIC`;
      }).pipe(
        Effect.provide(PgClient.layerFrom(PgClient.makeClient({ url: Redacted.make(root.href) }))),
      ),
    );
  });
});
