import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { databaseCreationStatements, databaseRevocationStatements } from "./OpenBao.ts";

describe("PostgreSQL credential statements", () => {
  it("creates the API login without inherited rights, as a member of the visitor role", () => {
    const sql = databaseCreationStatements({
      database: "setlist",
      memberOf: "setlist_visitor",
      inherit: false,
    });

    assert.equal(
      sql,
      `CREATE ROLE "{{name}}" WITH LOGIN NOINHERIT PASSWORD '{{password}}' VALID UNTIL '{{expiration}}'; GRANT "setlist_visitor" TO "{{name}}"; GRANT CONNECT ON DATABASE "setlist" TO "{{name}}";`,
    );
  });

  it("creates the migration login as a member of the owner role that starts each session as it", () => {
    const sql = databaseCreationStatements({
      database: "setlist",
      memberOf: "setlist_owner",
      inherit: true,
    });

    assert.equal(
      sql,
      `CREATE ROLE "{{name}}" WITH LOGIN PASSWORD '{{password}}' VALID UNTIL '{{expiration}}'; GRANT "setlist_owner" TO "{{name}}"; GRANT CONNECT ON DATABASE "setlist" TO "{{name}}"; ALTER ROLE "{{name}}" SET role = "setlist_owner";`,
    );
  });

  it("hands a revoked login's objects to the owner before dropping it", () => {
    assert.equal(
      databaseRevocationStatements({ ownerRole: "setlist_owner" }),
      `GRANT "{{name}}" TO CURRENT_USER; REASSIGN OWNED BY "{{name}}" TO "setlist_owner"; DROP OWNED BY "{{name}}"; DROP ROLE IF EXISTS "{{name}}";`,
    );
  });

  it("grants nothing on the public schema, which setlist's migrations revoke", () => {
    const sql = databaseCreationStatements({
      database: "setlist",
      memberOf: "setlist_visitor",
      inherit: false,
    });

    assert.equal(sql.includes("public"), false);
  });
});
