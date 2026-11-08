import { after, before, describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { ConfigProvider, Effect, Layer, Option, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import { databaseCreationStatements, databaseRevocationStatements, OpenBao } from "./OpenBao.ts";

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

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("no port"));
        return;
      }
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });

describe("writeKvKey against OpenBao", () => {
  const token = "test-root";
  let address = "";
  let child: ChildProcess | undefined;

  const layer = () =>
    Layer.fresh(OpenBao.layer).pipe(
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnvRecord({
            OPENBAO_ADDR: address,
            OPENBAO_TOKEN: token,
          }),
        ),
      ),
    );

  const run = <A, E>(effect: Effect.Effect<A, E, OpenBao>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer())));

  const softDelete = async (path: string) => {
    const response = await fetch(`${address}/v1/${path}`, {
      method: "DELETE",
      headers: { "X-Vault-Token": token },
    });
    assert.equal(response.status, 204, await response.text());
  };

  before(async () => {
    const port = await freePort();
    address = `http://127.0.0.1:${port}`;
    const server = spawn(
      "bao",
      ["server", "-dev", `-dev-root-token-id=${token}`, `-dev-listen-address=127.0.0.1:${port}`],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    child = server;
    const log: Array<string> = [];
    server.stdout.on("data", (chunk: Buffer) => log.push(chunk.toString()));
    server.stderr.on("data", (chunk: Buffer) => log.push(chunk.toString()));
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        const response = await fetch(`${address}/v1/sys/health`);
        if (response.ok || response.status === 429 || response.status === 472) return;
      } catch {
        // not listening yet
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    server.kill("SIGTERM");
    assert.fail(`bao -dev did not become ready:\n${log.join("")}`);
  });

  after(() => {
    child?.kill("SIGTERM");
  });

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
