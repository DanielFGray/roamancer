import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as Redacted from "effect/Redacted";
import * as S from "effect/Schema";
import {
  connectionUrl,
  databaseDeclarations,
  managedEnvKeys,
  managedEnvValues,
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
  it("collects url/username/password env names from PostgresCredentials once", () => {
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
    ]);
  });
});

describe("databaseDeclarations", () => {
  it("uses postgresRoles and postgresLoginRole with api NOINHERIT and migration inherit", () => {
    const password = Redacted.make("secret");
    const [declaration] = databaseDeclarations(cartridge, () => password);
    assert.equal(declaration?.name, "giglist");
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
  });
});

describe("managedEnvValues", () => {
  it("builds host URLs on 127.0.0.1:5417 for url env keys", () => {
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
  });
});
