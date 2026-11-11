import { describe, it, before, after } from "node:test";
import * as assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";
import * as PgClient from "@effect/sql-pg/PgClient";
import {
  loginRolePolicy,
  provisionPostgresDatabase,
  type PostgresDatabaseDeclaration,
} from "./PostgresProvisioning.ts";
import { databaseCreationStatements } from "./OpenBao.ts";
import { postgresContainer } from "./testing/postgresContainer.ts";

const PORT = 55417;
const PASSWORD = "provision-test";
const container = postgresContainer("alchemy-postgres-provisioning-test", PORT, PASSWORD);

const adminLayer = (database: string) =>
  PgClient.layerFrom(
    PgClient.makeClient({
      host: "127.0.0.1",
      port: PORT,
      database,
      username: "postgres",
      password: Redacted.make(PASSWORD),
      applicationName: "alchemy-postgres-provisioning-test",
    }),
  );

const declaration = (
  overrides: Partial<PostgresDatabaseDeclaration> = {},
): PostgresDatabaseDeclaration => ({
  name: "app_needs",
  ownerRole: "app_needs_owner",
  visitorRole: "app_needs_visitor",
  extensions: ["pgcrypto"],
  logins: [
    {
      name: "alchemy_app_needs_api",
      memberOf: "app_needs_visitor",
      inherit: false,
      createDatabases: false,
      password: Redacted.make("api-secret"),
    },
    {
      name: "alchemy_app_needs_migration",
      memberOf: "app_needs_owner",
      inherit: true,
      createDatabases: true,
      password: Redacted.make("migration-secret"),
    },
  ],
  ...overrides,
});

const query = <A>(database: string, effect: Effect.Effect<A, unknown, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(adminLayer(database))));

const loginState = (names: ReadonlyArray<string>) =>
  query(
    "postgres",
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const roles = yield* sql<{
        readonly rolname: string;
        readonly rolcanlogin: boolean;
        readonly rolinherit: boolean;
        readonly rolpassword: string | null;
        readonly rolconfig: ReadonlyArray<string> | null;
      }>`
        SELECT r.rolname, r.rolcanlogin, r.rolinherit, a.rolpassword, r.rolconfig
        FROM pg_roles r
        JOIN pg_authid a ON a.oid = r.oid
        WHERE r.rolname IN ${sql.in(names)}
        ORDER BY r.rolname
      `;
      const members = yield* sql<{
        readonly member: string;
        readonly role: string;
      }>`
        SELECT m.rolname AS member, g.rolname AS role
        FROM pg_auth_members am
        JOIN pg_roles m ON m.oid = am.member
        JOIN pg_roles g ON g.oid = am.roleid
        WHERE m.rolname IN ${sql.in(names)}
        ORDER BY m.rolname, g.rolname
      `;
      return { roles, members };
    }),
  );

describe("loginRolePolicy", () => {
  it("is the single source OpenBao creation statements use for options and session role", () => {
    const api = loginRolePolicy(false);
    assert.equal(api.options, "LOGIN NOINHERIT");
    assert.equal(
      api.sessionRoleStatement('"{{name}}"', '"setlist_visitor"'),
      'ALTER ROLE "{{name}}" RESET role',
    );

    const migration = loginRolePolicy(true);
    assert.equal(migration.options, "LOGIN");
    assert.equal(
      migration.sessionRoleStatement('"{{name}}"', '"setlist_owner"'),
      'ALTER ROLE "{{name}}" SET role = "setlist_owner"',
    );

    assert.equal(
      databaseCreationStatements({
        database: "setlist",
        memberOf: "setlist_visitor",
        inherit: false,
      }),
      `CREATE ROLE "{{name}}" WITH ${api.options} PASSWORD '{{password}}' VALID UNTIL '{{expiration}}'; GRANT "setlist_visitor" TO "{{name}}"; GRANT CONNECT ON DATABASE "setlist" TO "{{name}}"; ${api.sessionRoleStatement('"{{name}}"', '"setlist_visitor"')};`,
    );
  });
});

describe("provisionPostgresDatabase", () => {
  before(container.start);
  after(container.remove);

  it("makes the cluster match the declaration, and a repeat run is a no-op", async () => {
    const names = ["alchemy_app_needs_api", "alchemy_app_needs_migration"] as const;
    const first = await Effect.runPromise(provisionPostgresDatabase(declaration(), adminLayer));
    assert.equal(first.created, true);

    const afterCreate = await loginState(names);

    const second = await Effect.runPromise(
      provisionPostgresDatabase(
        declaration({
          logins: [
            {
              name: "alchemy_app_needs_api",
              memberOf: "app_needs_visitor",
              inherit: false,
              createDatabases: false,
              password: Redacted.make("api-secret-changed"),
            },
            {
              name: "alchemy_app_needs_migration",
              memberOf: "app_needs_owner",
              inherit: true,
              createDatabases: true,
              password: Redacted.make("migration-secret-changed"),
            },
          ],
        }),
        adminLayer,
      ),
    );
    assert.equal(second.created, false);

    const afterRepeat = await loginState(names);
    assert.deepEqual(
      afterRepeat.roles.map((row) => row.rolpassword),
      afterCreate.roles.map((row) => row.rolpassword),
      "repeat run must not change passwords",
    );
    assert.deepEqual(afterRepeat.members, afterCreate.members);
    assert.deepEqual(
      afterRepeat.roles.map((row) => ({
        name: row.rolname,
        login: row.rolcanlogin,
        inherit: row.rolinherit,
        config: row.rolconfig,
      })),
      afterCreate.roles.map((row) => ({
        name: row.rolname,
        login: row.rolcanlogin,
        inherit: row.rolinherit,
        config: row.rolconfig,
      })),
    );

    const owner = await query(
      "postgres",
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{ readonly owner: string }>`
        SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = ${"app_needs"}
      `;
        return { owner: rows[0]?.owner };
      }),
    );
    assert.equal(owner.owner, "app_needs_owner");

    const extensions = await query(
      "app_needs",
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{ readonly extname: string }>`
        SELECT extname FROM pg_extension WHERE extname = ${"pgcrypto"}
      `;
        return { count: rows.length };
      }),
    );
    assert.equal(extensions.count, 1);

    assert.deepEqual(
      afterRepeat.roles.map((row) => ({
        name: row.rolname,
        login: row.rolcanlogin,
        inherit: row.rolinherit,
      })),
      [
        { name: "alchemy_app_needs_api", login: true, inherit: false },
        { name: "alchemy_app_needs_migration", login: true, inherit: true },
      ],
    );
    assert.deepEqual(afterRepeat.members, [
      { member: "alchemy_app_needs_api", role: "app_needs_visitor" },
      { member: "alchemy_app_needs_migration", role: "app_needs_owner" },
    ]);
  });

  it("creates a missing extension on an existing database on the next run", async () => {
    await Effect.runPromise(
      provisionPostgresDatabase(
        declaration({
          name: "repair_db",
          ownerRole: "repair_db_owner",
          visitorRole: "repair_db_visitor",
          logins: [],
        }),
        adminLayer,
      ),
    );

    await query(
      "repair_db",
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DROP EXTENSION IF EXISTS pgcrypto`;
      }),
    );

    const before = await query(
      "repair_db",
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{ readonly extname: string }>`
        SELECT extname FROM pg_extension WHERE extname = ${"pgcrypto"}
      `;
        return rows.length;
      }),
    );
    assert.equal(before, 0);

    const result = await Effect.runPromise(
      provisionPostgresDatabase(
        declaration({
          name: "repair_db",
          ownerRole: "repair_db_owner",
          visitorRole: "repair_db_visitor",
          logins: [],
        }),
        adminLayer,
      ),
    );
    assert.equal(result.created, false);

    const after = await query(
      "repair_db",
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{ readonly extname: string }>`
        SELECT extname FROM pg_extension WHERE extname = ${"pgcrypto"}
      `;
        return rows.length;
      }),
    );
    assert.equal(after, 1);
  });
});
