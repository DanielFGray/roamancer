import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as S from "effect/Schema";
import {
  connectionUrl,
  declarationsForDatabase,
  DevDbRequest,
  managedEnvKeys,
  managedEnvValues,
} from "./Declaration.ts";
import * as Option from "effect/Option";
import { DevDbCartridge } from "./DevDbCartridge.ts";

const cartridge = S.decodeUnknownSync(DevDbCartridge)({
  name: "giglist",
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
  it("points every env name, plus the SHADOW, TEST and ROOT URLs, at the dev database", () => {
    assert.deepEqual(managedEnvKeys(cartridge), [
      {
        kind: "url",
        env: "DATABASE_URL",
        database: "giglist_dev",
        login: "migration",
      },
      {
        kind: "url",
        env: "AUTH_DATABASE_URL",
        database: "giglist_dev",
        login: "api",
      },
      {
        kind: "username",
        env: "AUTH_DATABASE_USER",
        database: "giglist_dev",
        login: "api",
      },
      {
        kind: "shadowUrl",
        env: "SHADOW_DATABASE_URL",
        database: "giglist_dev",
        login: "migration",
      },
      {
        kind: "testUrl",
        env: "TEST_DATABASE_URL",
        database: "giglist_dev",
        login: "migration",
      },
      {
        kind: "rootUrl",
        env: "ROOT_DATABASE_URL",
        database: "giglist_dev",
        login: "migration",
      },
    ]);
  });
});

describe("declarationsForDatabase", () => {
  const verifier = "SCRAM-SHA-256$4096:c2FsdA==$c3RvcmVk:c2VydmVy";
  const request = S.decodeUnknownSync(DevDbRequest)({
    app: "giglist",
    postgres: [
      { database: "giglist", extensions: [], logins: { api: verifier, migration: verifier } },
    ],
  });
  const names = (database: string) =>
    Option.map(declarationsForDatabase(request, database), (declarations) =>
      declarations.map((declaration) => declaration.name),
    );

  it("provisions a dev database again with its shadow and test databases", () => {
    assert.deepEqual(
      names("giglist_dev"),
      Option.some(["giglist_dev", "giglist_dev_shadow", "giglist_dev_test"]),
    );
  });

  it("provisions a shadow or test database alone", () => {
    assert.deepEqual(names("giglist_dev_test"), Option.some(["giglist_dev_test"]));
  });

  it("owns no live database", () => {
    assert.deepEqual(names("giglist"), Option.none());
  });
});

describe("managedEnvValues", () => {
  it("builds host URLs on 127.0.0.1:5417 for url, shadow, test, and root env keys", () => {
    const values = managedEnvValues(managedEnvKeys(cartridge), (role) => `pw-for-${role}`);
    assert.equal(
      values.DATABASE_URL,
      connectionUrl({
        username: "alchemy_giglist_dev_migration",
        password: "pw-for-alchemy_giglist_dev_migration",
        database: "giglist_dev",
      }),
    );
    assert.equal(values.AUTH_DATABASE_USER, "alchemy_giglist_dev_api");
    assert.match(values.AUTH_DATABASE_URL!, /127\.0\.0\.1:5417\/giglist_dev/);
    assert.equal(
      values.SHADOW_DATABASE_URL,
      connectionUrl({
        username: "alchemy_giglist_dev_migration",
        password: "pw-for-alchemy_giglist_dev_migration",
        database: "giglist_dev_shadow",
      }),
    );
    assert.equal(
      values.TEST_DATABASE_URL,
      connectionUrl({
        username: "alchemy_giglist_dev_migration",
        password: "pw-for-alchemy_giglist_dev_migration",
        database: "giglist_dev_test",
      }),
    );
    assert.equal(
      values.ROOT_DATABASE_URL,
      "postgresql://alchemy_giglist_dev_migration:pw-for-alchemy_giglist_dev_migration@127.0.0.1:5417/postgres?sslmode=disable&options=-c%20role%3Dnone",
    );
  });
});

describe("database environment entries", () => {
  it("name the dev database and its roles, and leave every other entry to the app", () => {
    const withEnvironment = S.decodeUnknownSync(DevDbCartridge)({
      name: "giglist",
      postgres: [{ database: "giglist" }],
      services: [
        {
          environment: [
            { name: "NODE_ENV", value: "production" },
            { name: "DATABASE_NAME", value: "giglist" },
            { name: "DATABASE_OWNER", database: "giglist", role: "owner" },
            { name: "DATABASE_VISITOR", database: "giglist", role: "visitor" },
          ],
        },
      ],
    });
    const values = managedEnvValues(managedEnvKeys(withEnvironment), () => "pw");
    assert.deepEqual(
      [values.NODE_ENV, values.DATABASE_NAME, values.DATABASE_OWNER, values.DATABASE_VISITOR],
      [undefined, "giglist_dev", "giglist_dev_owner", "giglist_dev_visitor"],
    );
  });
});
