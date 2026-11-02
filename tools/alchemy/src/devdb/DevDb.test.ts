import { describe, it, before, after } from "node:test";
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as S from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as PgClient from "@effect/sql-pg/PgClient";
import { BunServices } from "@effect/platform-bun";
import { TestConsole } from "effect/testing";
import { DevDbRequest } from "./Declaration.ts";
import { runDevDbAction, runDevDbClusterAction } from "./Host.ts";
import { scramVerifier } from "./Scram.ts";

const PORT = 55418;
const CONTAINER = "alchemy-ops-devdb-test";
const ADMIN = "devdb-test-admin";

const clientLayer = (username: string, password: string, database: string) =>
  PgClient.layerFrom(
    PgClient.makeClient({
      host: "127.0.0.1",
      port: PORT,
      database,
      username,
      password: Redacted.make(password),
      applicationName: "ops-devdb-test",
    }),
  );
const adminLayer = (database: string) => clientLayer("postgres", ADMIN, database);

const query = <A extends object>(
  layer: ReturnType<typeof clientLayer>,
  run: (sql: SqlClient.SqlClient) => Effect.Effect<ReadonlyArray<A>, unknown>,
) => Effect.runPromise(Effect.flatMap(SqlClient.SqlClient, run).pipe(Effect.provide(layer)));

const request = (passwords: { readonly api: string; readonly migration: string }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return S.decodeUnknownSync(DevDbRequest)({
        app: "giglist",
        postgres: [
          {
            database: "giglist",
            extensions: ["pgcrypto"],
            shadow: true,
            test: true,
            logins: {
              api: yield* scramVerifier(Redacted.make(passwords.api)),
              migration: yield* scramVerifier(Redacted.make(passwords.migration)),
            },
          },
        ],
      });
    }).pipe(Effect.provide(BunServices.layer)),
  );

const run = (devRequest: DevDbRequest, action: Parameters<typeof runDevDbAction>[1]) =>
  Effect.runPromise(runDevDbAction(devRequest, action, adminLayer));

const ownerOf = async (database: string) =>
  (
    await query<{ readonly owner: string }>(
      adminLayer("postgres"),
      (sql) =>
        sql`SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = ${database}`,
    )
  ).map((row) => row.owner);

const migration = "alchemy_giglist_dev_migration";

describe("ops dev db host job", () => {
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
        `POSTGRES_PASSWORD=${ADMIN}`,
        "-p",
        `127.0.0.1:${PORT}:5432`,
        "postgres:17-alpine",
      ],
      { encoding: "utf8" },
    );
    assert.equal(started.status, 0, started.stderr);
    for (let attempt = 0; attempt < 40; attempt++) {
      const ready = spawnSync(
        "docker",
        ["exec", CONTAINER, "pg_isready", "-U", "postgres", "-h", "127.0.0.1"],
        { encoding: "utf8" },
      );
      if (ready.status === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.fail("test postgres did not become ready");
  });

  after(() => {
    spawnSync("docker", ["rm", "-f", CONTAINER], { encoding: "utf8" });
  });

  it("provisions the dev databases and its logins sign in with the workstation passwords", async () => {
    await run(await request({ api: "api-one", migration: "migration-one" }), { _tag: "Up" });
    for (const database of ["giglist_dev", "giglist_dev_shadow", "giglist_dev_test"]) {
      assert.deepEqual(await ownerOf(database), ["giglist_dev_owner"]);
    }
    const settings = await query<{ readonly timeout: string; readonly temp: string }>(
      clientLayer(migration, "migration-one", "giglist_dev"),
      (sql) =>
        sql`SELECT current_setting('statement_timeout') AS timeout, current_setting('temp_file_limit') AS temp`,
    );
    assert.deepEqual(settings, [{ timeout: "5min", temp: "1GB" }]);
    await query(
      clientLayer("alchemy_giglist_dev_api", "api-one", "giglist_dev"),
      (sql) => sql`SELECT 1`,
    );
  });

  it("sets each login's password again on every run", async () => {
    await run(await request({ api: "api-two", migration: "migration-two" }), { _tag: "Up" });
    await query(clientLayer(migration, "migration-two", "giglist_dev"), (sql) => sql`SELECT 1`);
  });

  // pgsodium installs into its own schema and grants it to PUBLIC, as this setup does.
  it("leaves an extension's own schema to the owner role", async () => {
    await query(adminLayer("giglist_dev"), (sql) =>
      sql`CREATE SCHEMA ext`.pipe(
        Effect.andThen(sql`CREATE EXTENSION citext SCHEMA ext`),
        Effect.andThen(sql`GRANT USAGE ON SCHEMA ext TO PUBLIC`),
      ),
    );
    await run(await request({ api: "api-two", migration: "migration-two" }), { _tag: "Up" });
    const usage = await query<{ readonly visitor: boolean; readonly owner: boolean }>(
      adminLayer("giglist_dev"),
      (sql) =>
        sql`SELECT has_schema_privilege('giglist_dev_visitor', 'ext', 'USAGE') AS visitor,
                   has_schema_privilege('giglist_dev_owner', 'ext', 'USAGE') AS owner`,
    );
    assert.deepEqual(usage, [{ visitor: false, owner: true }]);
  });

  // graphile-migrate commit drops and recreates the shadow through ROOT_DATABASE_URL.
  it("takes back a shadow database that graphile-migrate recreated as the migration login", async () => {
    await query(clientLayer(migration, "migration-two", "postgres"), (sql) =>
      sql`SET role = none`.pipe(
        Effect.andThen(sql`DROP DATABASE giglist_dev_shadow`),
        Effect.andThen(sql`CREATE DATABASE giglist_dev_shadow`),
      ),
    );
    assert.deepEqual(await ownerOf("giglist_dev_shadow"), [migration]);
    const devRequest = await request({ api: "api-two", migration: "migration-two" });
    await run(devRequest, { _tag: "Up" });
    await run(devRequest, { _tag: "Reset", database: "giglist_dev_shadow" });
    assert.deepEqual(await ownerOf("giglist_dev_shadow"), ["giglist_dev_owner"]);
  });

  it("refuses to reset a database the request does not own", async () => {
    await query(adminLayer("postgres"), (sql) => sql`CREATE DATABASE giglist`);
    const devRequest = await request({ api: "api-two", migration: "migration-two" });
    await assert.rejects(run(devRequest, { _tag: "Reset", database: "giglist" }), {
      message: /'giglist' is not a dev database of this app/,
    });
    assert.deepEqual(await ownerOf("giglist"), ["postgres"]);
  });

  describe("eviction", () => {
    const passwords = { api: "api-two", migration: "migration-two" };
    // The request with a second cartridge database beside giglist.
    const twoEntries = async () => {
      const one = await request(passwords);
      return S.decodeUnknownSync(DevDbRequest)({
        ...one,
        postgres: one.postgres.flatMap((entry) => [entry, { ...entry, database: "giglist_extra" }]),
      });
    };
    // An action's console lines; a failed action rejects.
    const output = (program: Effect.Effect<void, unknown>) =>
      Effect.runPromise(
        program.pipe(Effect.andThen(TestConsole.logLines), Effect.provide(TestConsole.layer)),
      ).then((lines) => lines.map(String));
    const up = (devRequest: typeof DevDbRequest.Type) =>
      output(runDevDbAction(devRequest, { _tag: "Up" }, adminLayer));
    const cluster = (action: Parameters<typeof runDevDbClusterAction>[0]) =>
      output(runDevDbClusterAction(action, adminLayer));
    const roleExists = async (role: string) =>
      (
        await query<{ readonly found: boolean }>(
          adminLayer("postgres"),
          (sql) => sql`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${role}) AS found`,
        )
      ).map((row) => row.found);

    it("dates each app's dev databases, and stale lists the app", async () => {
      await up(await twoEntries());
      const lines = await cluster({ _tag: "Stale" });
      assert.match(
        lines.find((line) => line.includes("\tgiglist\t")) ?? "",
        /\tgiglist\t6\t\d+ MB$/,
      );
    });

    it("names a database the cartridge no longer declares, and drop removes it with its logins", async () => {
      const lines = await up(await request(passwords));
      assert.ok(
        lines.includes(
          "  ops dev db drop giglist giglist_dev_extra giglist_dev_extra_shadow giglist_dev_extra_test",
        ),
        lines.join("\n"),
      );
      await cluster({
        _tag: "Drop",
        app: "giglist",
        databases: ["giglist_dev_extra", "giglist_dev_extra_shadow", "giglist_dev_extra_test"],
      });
      assert.deepEqual(await ownerOf("giglist_dev_extra"), []);
      assert.deepEqual(await roleExists("giglist_dev_extra_owner"), [false]);
      assert.deepEqual(await roleExists("alchemy_giglist_dev_extra_migration"), [false]);
      assert.deepEqual(await ownerOf("giglist_dev"), ["giglist_dev_owner"]);
    });

    // Dropping one copy must leave the dev database and the roles it still uses.
    it("drops a shadow the entry turned off and keeps its dev database", async () => {
      const one = await request(passwords);
      const noShadow = S.decodeUnknownSync(DevDbRequest)({
        ...one,
        postgres: one.postgres.map((entry) => ({ ...entry, shadow: false })),
      });
      const lines = await up(noShadow);
      assert.ok(lines.includes("  giglist_dev (with _test)"), lines.join("\n"));
      assert.ok(lines.includes("  ops dev db drop giglist giglist_dev_shadow"), lines.join("\n"));
      await cluster({ _tag: "Drop", app: "giglist", databases: ["giglist_dev_shadow"] });
      assert.deepEqual(await ownerOf("giglist_dev_shadow"), []);
      assert.deepEqual(await ownerOf("giglist_dev"), ["giglist_dev_owner"]);
      assert.deepEqual(await roleExists("giglist_dev_owner"), [true]);
      await query(clientLayer(migration, "migration-two", "giglist_dev"), (sql) => sql`SELECT 1`);
    });

    it("refuses a name that is no dev database of the app, and drops nothing", async () => {
      await assert.rejects(
        cluster({ _tag: "Drop", app: "giglist", databases: ["giglist_dev", "giglist"] }),
        { message: /'giglist' is not a dev database of this app/ },
      );
      assert.deepEqual(await ownerOf("giglist_dev"), ["giglist_dev_owner"]);
    });

    // A dev login owns its databases and may rewrite their comments, so a marker alone is no proof.
    it("leaves a database whose marker names it but whose owner is no dev role", async () => {
      await query(adminLayer("postgres"), (sql) =>
        sql`DROP DATABASE giglist_dev_test`.pipe(
          Effect.andThen(sql`CREATE DATABASE giglist_dev_test`),
          Effect.andThen(
            sql.unsafe(
              `COMMENT ON DATABASE giglist_dev_test IS '{"opsDevDb":{"app":"giglist","database":"giglist","lastUp":"2026-01-01T00:00:00.000Z"}}'`,
            ),
          ),
        ),
      );
      await cluster({ _tag: "Drop", app: "giglist", databases: [] });
      assert.deepEqual(await ownerOf("giglist_dev"), []);
      assert.deepEqual(await ownerOf("giglist_dev_test"), ["postgres"]);
    });
  });

  it("refuses a derived name that another role owns", async () => {
    await query(adminLayer("postgres"), (sql) =>
      sql`DROP DATABASE giglist_dev_test`.pipe(
        Effect.andThen(sql`CREATE DATABASE giglist_dev_test`),
      ),
    );
    const devRequest = await request({ api: "api-two", migration: "migration-two" });
    await assert.rejects(run(devRequest, { _tag: "Reset", database: "giglist_dev_test" }), {
      message: /owned by 'postgres', not by its dev roles/,
    });
    assert.deepEqual(await ownerOf("giglist_dev_test"), ["postgres"]);
  });
});
