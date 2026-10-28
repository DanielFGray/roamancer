import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as Redacted from "effect/Redacted";
import * as S from "effect/Schema";
import {
  connectionUrl,
  databaseDeclarations,
  declarationsForDatabase,
  managedEnvKeys,
  managedEnvValues,
  resolveDatabaseTarget,
} from "./Declaration.ts";
import { DevDbCartridge } from "./DevDbCartridge.ts";

const cartridge = S.decodeUnknownSync(DevDbCartridge)({
  postgres: [{ database: "giglist", extensions: ["citext", "pgcrypto"] }],
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
          usernameEnv: "AUTH_DATABASE_USER",
        },
      ],
    },
  ],
});

describe("managedEnvKeys", () => {
  it("collects url/username/password env names plus SHADOW and TEST URLs once", () => {
    assert.deepEqual(managedEnvKeys(cartridge), [
      {
        kind: "url",
        env: "DATABASE_URL",
        database: "giglist",
        login: "migration",
      },
      {
        kind: "url",
        env: "AUTH_DATABASE_URL",
        database: "giglist",
        login: "api",
      },
      {
        kind: "username",
        env: "AUTH_DATABASE_USER",
        database: "giglist",
        login: "api",
      },
      {
        kind: "shadowUrl",
        env: "SHADOW_DATABASE_URL",
        database: "giglist",
        login: "migration",
      },
      {
        kind: "testUrl",
        env: "TEST_DATABASE_URL",
        database: "giglist",
        login: "migration",
      },
    ]);
  });
});

describe("databaseDeclarations", () => {
  it("provisions live, shadow, and test with the same roles", () => {
    const password = Redacted.make("secret");
    const declarations = databaseDeclarations(cartridge, () => password);
    assert.deepEqual(
      declarations.map((declaration) => declaration.name),
      ["giglist", "giglist_shadow", "giglist_test"],
    );
    const [declaration] = declarations;
    assert.equal(declaration?.ownerRole, "giglist_owner");
    assert.equal(declaration?.visitorRole, "giglist_visitor");
    assert.deepEqual(declaration?.extensions, ["citext", "pgcrypto"]);
    assert.deepEqual(
      declaration?.logins.map((login) => ({
        name: login.name,
        memberOf: login.memberOf,
        inherit: login.inherit,
      })),
      [
        {
          name: "alchemy_giglist_api",
          memberOf: "giglist_visitor",
          inherit: false,
        },
        {
          name: "alchemy_giglist_migration",
          memberOf: "giglist_owner",
          inherit: true,
        },
      ],
    );
    assert.deepEqual(
      declarations[2]?.logins.map((login) => login.name),
      ["alchemy_giglist_api", "alchemy_giglist_migration"],
    );
  });
});

describe("resolveDatabaseTarget / declarationsForDatabase", () => {
  it("resets only the test DB when asked for <db>_test", () => {
    const password = Redacted.make("secret");
    assert.deepEqual(resolveDatabaseTarget(cartridge, "giglist_test")?.targets, ["test"]);
    assert.deepEqual(
      declarationsForDatabase(cartridge, "giglist_test", () => password).map((d) => d.name),
      ["giglist_test"],
    );
  });

  it("resets live+shadow+test when asked for the live name", () => {
    const password = Redacted.make("secret");
    assert.deepEqual(
      declarationsForDatabase(cartridge, "giglist", () => password).map((d) => d.name),
      ["giglist", "giglist_shadow", "giglist_test"],
    );
  });
});

describe("managedEnvValues", () => {
  it("builds host URLs on 127.0.0.1:5417 for url, shadow, and test env keys", () => {
    const values = managedEnvValues(managedEnvKeys(cartridge), (role) => `pw-for-${role}`);
    assert.equal(
      values.DATABASE_URL,
      connectionUrl({
        username: "alchemy_giglist_migration",
        password: "pw-for-alchemy_giglist_migration",
        database: "giglist",
      }),
    );
    assert.equal(values.AUTH_DATABASE_USER, "alchemy_giglist_api");
    assert.match(values.AUTH_DATABASE_URL!, /127\.0\.0\.1:5417\/giglist/);
    assert.equal(
      values.SHADOW_DATABASE_URL,
      connectionUrl({
        username: "alchemy_giglist_migration",
        password: "pw-for-alchemy_giglist_migration",
        database: "giglist_shadow",
      }),
    );
    assert.equal(
      values.TEST_DATABASE_URL,
      connectionUrl({
        username: "alchemy_giglist_migration",
        password: "pw-for-alchemy_giglist_migration",
        database: "giglist_test",
      }),
    );
  });
});
