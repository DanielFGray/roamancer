/**
 * Deploy keeps requiring `image` via AppCartridge decode. `ops dev db` decodes only the
 * postgres/secrets slice, so an image-less cartridge works there.
 */
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as S from "effect/Schema";
import { AppCartridge } from "./Cartridge.ts";
import { DevDbCartridge } from "./devdb/DevDbCartridge.ts";
import { managedEnvKeys, managedEnvValues } from "./devdb/Declaration.ts";

const postgres = [
  {
    database: "effect_test",
    extensions: ["uuid-ossp", "citext", "btree_gin", "pgcrypto", "pg_trgm", "fuzzystrmatch"],
  },
];

const secrets = [
  {
    _tag: "PostgresCredentials" as const,
    database: "effect_test",
    login: "migration" as const,
    urlEnv: "DATABASE_URL",
  },
  {
    _tag: "PostgresCredentials" as const,
    database: "effect_test",
    login: "api" as const,
    urlEnv: "AUTH_DATABASE_URL",
  },
];

const noImageJson = {
  apiVersion: "server-ansible/v2",
  name: "effect-test",
  postgres,
  services: [
    {
      name: "effect-test-api",
      hostPort: "dynamic",
      containerPort: 3000,
      cpu: 100,
      memoryMB: 128,
      networkMode: "bridge",
      environment: [],
      connections: [],
      routes: [],
      secrets,
    },
  ],
};

const withImageJson = {
  ...noImageJson,
  services: [{ ...noImageJson.services[0]!, image: "registry.cluster:5000/effect-test:dev" }],
};

describe("image-less cartridge boundary", () => {
  it("AppCartridge decode rejects a service with no image (deploy path)", () => {
    assert.throws(() => S.decodeUnknownSync(AppCartridge)(noImageJson));
  });

  it("DevDbCartridge decodes an image-less cartridge and maps env keys to its dev databases", () => {
    const cartridge = S.decodeUnknownSync(DevDbCartridge)(noImageJson);
    assert.equal(cartridge.postgres[0]?.database, "effect_test");
    const keys = managedEnvKeys(cartridge);
    assert.deepEqual(keys.map((key) => key.env).sort(), [
      "AUTH_DATABASE_URL",
      "DATABASE_URL",
      "ROOT_DATABASE_URL",
      "SHADOW_DATABASE_URL",
      "TEST_DATABASE_URL",
    ]);
    const values = managedEnvValues(keys, (role) => `pw-${role}`);
    assert.match(values.DATABASE_URL!, /alchemy_effect_test_dev_migration/);
    assert.match(values.AUTH_DATABASE_URL!, /alchemy_effect_test_dev_api/);
    assert.match(values.SHADOW_DATABASE_URL!, /\/effect_test_dev_shadow\b/);
    assert.match(values.TEST_DATABASE_URL!, /\/effect_test_dev_test\b/);
  });

  it("DevDbCartridge also decodes a full deployable cartridge", () => {
    const cartridge = S.decodeUnknownSync(DevDbCartridge)(withImageJson);
    assert.equal(cartridge.services.length, 1);
    assert.deepEqual(
      managedEnvKeys(cartridge)
        .map((key) => key.env)
        .sort(),
      [
        "AUTH_DATABASE_URL",
        "DATABASE_URL",
        "ROOT_DATABASE_URL",
        "SHADOW_DATABASE_URL",
        "TEST_DATABASE_URL",
      ],
    );
  });

  it("DevDbCartridge rejects PostgresCredentials for an undeclared database", () => {
    assert.throws(() =>
      S.decodeUnknownSync(DevDbCartridge)({
        postgres: [{ database: "effect_test" }],
        services: [
          {
            secrets: [
              {
                _tag: "PostgresCredentials",
                database: "other_db",
                login: "migration",
                urlEnv: "DATABASE_URL",
              },
            ],
          },
        ],
      }),
    );
  });
});
