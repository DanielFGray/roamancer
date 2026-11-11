import { describe, it, before, after } from "node:test";
import * as assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";
import * as PgClient from "@effect/sql-pg/PgClient";
import { postgresLoginRole } from "./Cartridge.ts";
import { renderRow, runReadOnly } from "./DbQuery.ts";
import { OpenBao } from "./OpenBao.ts";
import { loginCredentialPath } from "./PostgresDatabase.ts";
import { devOpenBao } from "./testing/devOpenBao.ts";
import { postgresContainer } from "./testing/postgresContainer.ts";

const PORT = 55420;
const ADMIN = "db-query-test-admin";
const container = postgresContainer("alchemy-ops-db-query-test", PORT, ADMIN);
const bao = devOpenBao("db-query-test-root");
const role = postgresLoginRole("app", "migration");

const clientLayer = (username: string, password: Redacted.Redacted<string>) =>
  PgClient.layerFrom(
    PgClient.makeClient({
      host: "127.0.0.1",
      port: PORT,
      database: "postgres",
      username,
      password,
      applicationName: "ops-db-query-test",
    }),
  );

const admin = (statement: string, params: ReadonlyArray<string> = []) =>
  Effect.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(statement, params)).pipe(
      Effect.provide(clientLayer("postgres", Redacted.make(ADMIN))),
    ),
  );

/**
 * Run `statement` as the job does: a new migration login from OpenBao, revoked when done.
 * Returns the login's name with the outcome, so a test can look for the login afterwards.
 */
const query = (statement: string) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const login = yield* (yield* OpenBao).postgresLogin(loginCredentialPath(role));
        const outcome = yield* Effect.result(
          runReadOnly(statement).pipe(Effect.provide(clientLayer(login.username, login.password))),
        );
        return { username: login.username, outcome };
      }),
    ).pipe(Effect.provide(bao.layer())),
  );

const rowsOf = async (statement: string) => {
  const { outcome } = await query(statement);
  assert.equal(outcome._tag, "Success", outcome._tag === "Failure" ? outcome.failure.message : "");
  return outcome._tag === "Success" ? outcome.success : [];
};

const refusalOf = async (statement: string): Promise<{ readonly message: string }> => {
  const { outcome } = await query(statement);
  assert.equal(outcome._tag, "Failure");
  return outcome._tag === "Failure" ? outcome.failure : assert.fail("the statement ran");
};

const notes = async () => (await admin("SELECT body FROM notes")).length;

describe("ops db query", () => {
  before(async () => {
    await Promise.all([container.start(), bao.start()]);
    await admin("CREATE ROLE app_owner NOLOGIN");
    await admin("CREATE TABLE notes (body text)");
    await admin("ALTER TABLE notes OWNER TO app_owner");
    await admin("INSERT INTO notes VALUES ('kept')");
    const mounted = await fetch(`${bao.address()}/v1/sys/mounts/database`, {
      method: "POST",
      headers: { "X-Vault-Token": "db-query-test-root" },
      body: JSON.stringify({ type: "database" }),
    });
    assert.equal(mounted.status, 204, await mounted.text());
    // The engine and role the PostgresDatabase provider writes for a deployed database.
    await Effect.runPromise(
      Effect.flatMap(OpenBao, (openBao) =>
        openBao.configurePostgres(
          {
            name: "alchemy_app",
            allowedRoles: [role],
            connectionUrl: `postgresql://{{username}}:{{password}}@127.0.0.1:${PORT}/postgres?sslmode=disable`,
            username: "postgres",
            password: Redacted.make(ADMIN),
          },
          [
            {
              name: role,
              databaseConfig: "alchemy_app",
              database: "postgres",
              ownerRole: "app_owner",
              memberOf: "app_owner",
              inherit: true,
              defaultTtl: "1h",
              maxTtl: "24h",
            },
          ],
        ),
      ).pipe(Effect.provide(bao.layer())),
    );
  });

  after(() => {
    bao.stop();
    container.remove();
  });

  it("reads as the owner role, and the login is gone afterwards", async () => {
    const { username, outcome } = await query("SELECT body, current_user AS role FROM notes");
    assert.deepEqual(outcome._tag === "Success" ? outcome.success : outcome, [
      { body: "kept", role: "app_owner" },
    ]);
    assert.deepEqual(await admin("SELECT 1 FROM pg_roles WHERE rolname = $1", [username]), []);
  });

  it("prints a count, which the driver returns as a bigint, from a file that ends in ';'", async () => {
    const rows = await rowsOf("SELECT count(*) AS notes FROM notes;\n");
    assert.deepEqual(rows.map(renderRow), ['{"notes":"1"}']);
  });

  for (const [statement, refusal] of [
    ["INSERT INTO notes VALUES ('written')", "read-only transaction (SQLSTATE 25006)"],
    ["COMMIT; INSERT INTO notes VALUES ('written')", "multiple commands"],
    ["SET TRANSACTION READ WRITE; INSERT INTO notes VALUES ('written')", "multiple commands"],
  ] as const) {
    it(`refuses ${statement}, and the table is unchanged`, async () => {
      assert.match(
        (await refusalOf(statement)).message,
        new RegExp(refusal.replace(/[()]/g, "\\$&")),
      );
      assert.equal(await notes(), 1);
    });
  }
});
