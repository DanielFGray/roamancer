import { after, before, describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { Effect, Option, Redacted } from "effect";
import { databaseCreationStatements, databaseRevocationStatements, OpenBao } from "./OpenBao.ts";
import { devOpenBao } from "./testing/devOpenBao.ts";

describe("PostgreSQL credential statements", () => {
  it("creates the API login without inherited rights, as a member of the visitor role", () => {
    const sql = databaseCreationStatements({
      database: "setlist",
      memberOf: "setlist_visitor",
      inherit: false,
    });

    assert.equal(
      sql,
      `CREATE ROLE "{{name}}" WITH LOGIN NOINHERIT PASSWORD '{{password}}' VALID UNTIL '{{expiration}}'; GRANT "setlist_visitor" TO "{{name}}"; GRANT CONNECT ON DATABASE "setlist" TO "{{name}}"; ALTER ROLE "{{name}}" RESET role;`,
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

describe("writeKvKey against OpenBao", () => {
  const token = "test-root";
  const bao = devOpenBao(token);

  const run = <A, E>(effect: Effect.Effect<A, E, OpenBao>) =>
    Effect.runPromise(effect.pipe(Effect.provide(bao.layer())));

  const softDelete = async (path: string) => {
    const response = await fetch(`${bao.address()}/v1/${path}`, {
      method: "DELETE",
      headers: { "X-Vault-Token": token },
    });
    assert.equal(response.status, 204, await response.text());
  };

  before(bao.start);
  after(bao.stop);

  it("writes a key again after a soft delete of its path", async () => {
    const path = "secret/data/alchemy/write-kv-key-soft-delete";
    await run(
      Effect.gen(function* () {
        const bao = yield* OpenBao;
        yield* bao.writeKvKey(path, "token", Redacted.make("first"));
        yield* bao.writeKvKey(path, "other", Redacted.make("kept-before-delete"));
        yield* Effect.promise(() => softDelete(path));
        yield* bao.writeKvKey(path, "token", Redacted.make("second"));
        const value = yield* bao.readKv(path, "token");
        assert.equal(Redacted.value(value), "second");
        // Soft-deleted keys are absent: the write is only the key being set, not a merge.
        const data = yield* bao.readKvData(path);
        assert.deepEqual(Option.getOrNull(data), { token: "second" });
      }),
    );
  });
});
