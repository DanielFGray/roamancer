import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as S from "effect/Schema";
import { NodeFileSystem } from "@effect/platform-node";
import { fileURLToPath } from "node:url";
import { AppCartridge, Cartridge, decodeFile, expand } from "./Cartridge.ts";
import { ImagesNotShared, WritableStorage, baseName, staged } from "./StagedCartridge.ts";

const candidate = "registry.cluster:5000/candidate:abc123@sha256:staged";

const load = (relative: string) =>
  Effect.runPromise(
    decodeFile(fileURLToPath(new URL(relative, import.meta.url)), AppCartridge).pipe(
      Effect.provide(NodeFileSystem.layer),
    ),
  );

const stage = (cartridge: Cartridge, released = true) =>
  Effect.runPromise(staged(cartridge, candidate, { released }));

const refusal = (cartridge: Cartridge) =>
  Effect.runPromise(Effect.flip(staged(cartridge, candidate, { released: true })));

const serviceNames = (cartridge: Cartridge) => cartridge.services.map((service) => service.name);

describe("staged cartridge", () => {
  it("suffixes giglist's names, database and credentials, and runs the candidate image", async () => {
    const live = await load("../examples/apps/giglist/cartridge.json");
    const copy = await stage(live);

    assert.equal(copy.name, "giglist-staged");
    assert.deepEqual(serviceNames(copy), ["giglist-api-staged", "giglist-worker-staged"]);
    assert.deepEqual([...new Set(copy.services.map((service) => service.image))], [candidate]);
    assert.deepEqual(
      copy.postgres.map((entry) => entry.database),
      ["giglist_staged"],
    );

    const secrets = copy.services.flatMap((service) => service.secrets);
    assert.deepEqual(
      secrets
        .filter((secret) => secret._tag === "PostgresCredentials")
        .map((secret) => secret.database),
      ["giglist_staged", "giglist_staged", "giglist_staged"],
    );
    assert.deepEqual(
      secrets.filter((secret) => secret._tag === "KvSecret").map((secret) => secret.path),
      ["secret/data/giglist", "secret/data/giglist", "secret/data/giglist"],
    );
    assert.deepEqual(
      secrets
        .filter((secret) => secret._tag === "ValkeyCredentials")
        .map((secret) => secret.urlEnv),
      ["VALKEY_URL", "VALKEY_URL"],
    );
    assert.doesNotThrow(() => S.decodeUnknownSync(Cartridge, { onExcessProperty: "error" })(copy));
  });

  it("maps each live route to a tailnet-only staged host", async () => {
    const live = await load("../examples/apps/giglist/cartridge.json");
    assert.ok(live.services[0].routes.length > 0);
    const copy = await stage(live);
    assert.deepEqual(
      copy.services.flatMap((service) => service.routes),
      [{ access: "tailnet" }],
    );
  });

  it("rewrites live route root URLs to the staged service reference", async () => {
    const live = await load("../examples/apps/giglist/cartridge.json");
    const withRoot: Cartridge = {
      ...live,
      services: live.services.map((service) => ({
        ...service,
        environment: [
          ...service.environment,
          { name: "ROOT_URL", value: "https://giglist.example.test/" },
        ],
      })),
    };
    const copy = await stage(withRoot);
    assert.ok(
      copy.services[0].environment.some(
        (entry) =>
          "route" in entry && entry.name === "ROOT_URL" && entry.route === "giglist-api-staged",
      ),
    );
    assert.equal(copy.services[0].image, candidate);
  });

  it("retargets route entries for its own services and preserves external route names", async () => {
    const live = await load("../examples/apps/giglist/cartridge.json");
    const withRoutes: Cartridge = {
      ...live,
      services: live.services.map((service) =>
        service.name === "giglist-api"
          ? {
              ...service,
              environment: [
                ...service.environment,
                { name: "OWN_ROUTE", route: "giglist-api" },
                { name: "EXTERNAL_ROUTE", route: "platform-openobserve" },
              ],
            }
          : service,
      ),
    };
    const copy = await stage(withRoutes);
    const environment = copy.services.find(
      (service) => service.name === "giglist-api-staged",
    )?.environment;
    assert.ok(
      environment?.some(
        (entry) =>
          "route" in entry && entry.name === "OWN_ROUTE" && entry.route === "giglist-api-staged",
      ),
    );
    assert.ok(
      environment?.some(
        (entry) =>
          "route" in entry &&
          entry.name === "EXTERNAL_ROUTE" &&
          entry.route === "platform-openobserve",
      ),
    );
  });

  it("gives a never-released app an empty staged database instead of a copy", async () => {
    const copy = await stage(await load("../examples/apps/giglist/cartridge.json"), false);

    assert.deepEqual(
      copy.postgres.map((entry) => [entry.database, entry.copyFrom]),
      [["giglist_staged", undefined]],
    );
  });

  it("expands the staged copy with expand unchanged", async () => {
    const copy = await stage(await load("../examples/apps/giglist/cartridge.json"));

    const resources = expand(copy);
    const database = resources.find((resource) => resource._tag === "PostgresDatabase");
    assert.ok(database);
    assert.equal(database.database.name, "giglist_staged");
    assert.equal(database.database.credentialRole, "alchemy_giglist_staged_api");
    // The staged database is a copy of the live one but carries its own roles, so the copy's
    // services never name a role of the live instance.
    assert.equal(database.database.ownerRole, "giglist_staged_owner");
    assert.equal(database.database.visitorRole, "giglist_staged_visitor");
    assert.equal(database.database.copyFrom, "giglist");
    const service = resources.find((resource) => resource._tag === "NomadService");
    assert.ok(service);
    assert.deepEqual(
      service.service.environment.filter((entry) => entry.name.startsWith("DATABASE_")),
      [
        { name: "DATABASE_NAME", value: "giglist_staged" },
        { name: "DATABASE_OWNER", value: "giglist_staged_owner" },
        { name: "DATABASE_VISITOR", value: "giglist_staged_visitor" },
      ],
    );
    const access = resources.find((resource) => resource._tag === "ValkeyAccess");
    assert.ok(access);
    assert.equal(access.access.resourceName, "giglist_staged");
    assert.equal(access.access.keyPrefix, "giglist-staged");
    assert.deepEqual(
      resources
        .filter((resource) => resource._tag === "NomadService")
        .map((resource) => resource.service.name),
      ["giglist-api-staged", "giglist-worker-staged"],
    );
  });

  it("gives live and staged services the key prefix their own Valkey user may use", async () => {
    const live = await load("../examples/apps/giglist/cartridge.json");
    const withPrefix: Cartridge = {
      ...live,
      services: live.services.map((service) => ({
        ...service,
        environment: [...service.environment, { name: "VALKEY_KEY_PREFIX", valkey: "keyPrefix" }],
      })),
    };
    const prefixes = (cartridge: Cartridge) =>
      expand(cartridge).flatMap((resource) =>
        resource._tag === "NomadService"
          ? resource.service.environment.filter((entry) => entry.name === "VALKEY_KEY_PREFIX")
          : [],
      );

    assert.deepEqual(
      prefixes(withPrefix).map((entry) => ("value" in entry ? entry.value : undefined)),
      ["giglist:", "giglist:"],
    );
    assert.deepEqual(
      prefixes(await stage(withPrefix)).map((entry) =>
        "value" in entry ? entry.value : undefined,
      ),
      ["giglist-staged:", "giglist-staged:"],
    );
  });

  it("gives the staged copy its own object store key on the live bucket", async () => {
    const live: Cartridge = {
      ...(await load("../examples/apps/giglist/cartridge.json")),
      objectStore: {},
    };
    const buckets = (cartridge: Cartridge) =>
      expand(cartridge).flatMap((resource) =>
        resource._tag === "GarageBucket" ? [resource.bucket] : [],
      );

    assert.deepEqual(buckets(live), [{ server: "garage", bucket: "giglist", key: "giglist" }]);
    assert.deepEqual(buckets(await stage(live)), [
      { server: "garage", bucket: "giglist", key: "giglist-staged" },
    ]);
  });

  it("stages postgres-garden's database, names and image", async () => {
    const live = await load("../examples/apps/postgres-garden/cartridge.json");
    const copy = await stage(live);

    assert.equal(copy.name, "postgres-garden-staged");
    assert.deepEqual(serviceNames(copy), [
      "postgres-garden-server-staged",
      "postgres-garden-worker-staged",
    ]);
    assert.deepEqual(
      copy.postgres.map((entry) => entry.database),
      ["postgres_garden_staged"],
    );
    assert.deepEqual(
      copy.services.flatMap((service) =>
        service.secrets
          .filter((secret) => secret._tag === "PostgresCredentials")
          .map((secret) => secret.database),
      ),
      ["postgres_garden_staged", "postgres_garden_staged", "postgres_garden_staged"],
    );
    assert.deepEqual([...new Set(copy.services.map((service) => service.image))], [candidate]);
    assert.ok(
      copy.services
        .flatMap((service) => service.routes)
        .every((route) => route.access === "tailnet"),
    );
    assert.doesNotThrow(() => S.decodeUnknownSync(Cartridge, { onExcessProperty: "error" })(copy));
  });

  it("renames a database role entry and replaces an environment value that names a database", async () => {
    const live = await load("../examples/apps/giglist/cartridge.json");
    const copy = await stage(live);

    // The live file names its roles through the database they belong to; only a literal value
    // that equals a database name is rewritten by the value rule, and the role entries follow
    // their database's rename.
    assert.deepEqual(
      live.services[0].environment.filter((entry) => entry.name.startsWith("DATABASE_")),
      [
        { name: "DATABASE_NAME", value: "giglist" },
        { name: "DATABASE_OWNER", database: "giglist", role: "owner" },
        { name: "DATABASE_VISITOR", database: "giglist", role: "visitor" },
      ],
    );
    assert.deepEqual(
      copy.services[0].environment.filter((entry) => entry.name.startsWith("DATABASE_")),
      [
        { name: "DATABASE_NAME", value: "giglist_staged" },
        { name: "DATABASE_OWNER", database: "giglist_staged", role: "owner" },
        { name: "DATABASE_VISITOR", database: "giglist_staged", role: "visitor" },
      ],
    );
  });

  it("stages a second database under the staged app identifier", async () => {
    // A database that extends the live app identifier must land under the staged one, or
    // the staged copy would fail Cartridge's own prefix check.
    const cartridge = S.decodeUnknownSync(Cartridge)({
      apiVersion: "server-ansible/v2",
      name: "giglist",
      postgres: [{ database: "giglist" }, { database: "giglist_reports" }],
      services: [
        {
          name: "giglist-api",
          image: "img",
          hostPort: "dynamic",
          containerPort: 3000,
          cpu: 100,
          memoryMB: 128,
          networkMode: "bridge",
          environment: [{ name: "REPORTS_DB", value: "giglist_reports" }],
          connections: [],
          secrets: [
            {
              _tag: "PostgresCredentials",
              database: "giglist_reports",
              login: "api",
              urlEnv: "REPORTS_URL",
            },
          ],
        },
      ],
    });

    const copy = await stage(cartridge);

    assert.deepEqual(
      copy.postgres.map((entry) => entry.database),
      ["giglist_staged", "giglist_staged_reports"],
    );
    assert.deepEqual(copy.services[0].environment, [
      { name: "REPORTS_DB", value: "giglist_staged_reports" },
    ]);
    assert.deepEqual(
      copy.services[0].secrets
        .filter((secret) => secret._tag === "PostgresCredentials")
        .map((secret) => secret.database),
      ["giglist_staged_reports"],
    );
    assert.doesNotThrow(() => S.decodeUnknownSync(Cartridge, { onExcessProperty: "error" })(copy));
  });

  it("retargets a connection to a service of the same cartridge", async () => {
    const cartridge = S.decodeUnknownSync(Cartridge)({
      apiVersion: "server-ansible/v2",
      name: "app-needs",
      postgres: [{ database: "app_needs" }],
      services: [
        {
          name: "web",
          image: "img",
          hostPort: "dynamic",
          containerPort: 80,
          cpu: 100,
          memoryMB: 128,
          networkMode: "bridge",
          environment: [],
          connections: [{ service: "api", hostEnv: "API_HOST", portEnv: "API_PORT" }],
          secrets: [],
        },
        {
          name: "api",
          image: "img",
          hostPort: "dynamic",
          containerPort: 8080,
          cpu: 100,
          memoryMB: 128,
          networkMode: "bridge",
          environment: [],
          connections: [],
          secrets: [],
        },
      ],
    });

    const copy = await stage(cartridge);

    assert.deepEqual(
      copy.services[0].connections.map((connection) => connection.service),
      ["api-staged"],
    );
    assert.doesNotThrow(() => S.decodeUnknownSync(Cartridge, { onExcessProperty: "error" })(copy));
  });

  it("keeps a connection to a service of another cartridge", async () => {
    // The cartridge schema rejects a connection to an undeclared service, so this value is
    // built rather than decoded: the transform still has to leave such a name alone.
    const live = await load("../examples/apps/giglist/cartridge.json");
    const withPlatformConnection: Cartridge = {
      ...live,
      services: live.services.map((service) =>
        service.name === "giglist-api"
          ? {
              ...service,
              connections: [{ service: "postgres", hostEnv: "PG_HOST", portEnv: "PG_PORT" }],
            }
          : service,
      ),
    };

    const copy = await stage(withPlatformConnection);

    assert.deepEqual(
      copy.services[0].connections.map((connection) => connection.service),
      ["postgres"],
    );
  });

  it("refuses a cartridge whose services name more than one image", async () => {
    const live = await load("../examples/apps/giglist/cartridge.json");
    const twoImages: Cartridge = {
      ...live,
      services: live.services.map((service, index) => ({ ...service, image: `img-${index}` })),
    };

    const error = await refusal(twoImages);

    assert.ok(error instanceof ImagesNotShared);
    assert.equal(error.cartridge, "giglist");
    assert.deepEqual(error.images, ["img-0", "img-1"]);
  });

  it("refuses a service that writes a host volume", async () => {
    const error = await refusal(await load("../examples/apps/noneuclid/cartridge.json"));

    assert.ok(error instanceof WritableStorage);
    assert.equal(error.cartridge, "noneuclid");
    assert.equal(error.service, "noneuclid");
    assert.equal(error.volume, "noneuclid-data");
  });

  it("reads a stage name back to its base cartridge", () => {
    assert.deepEqual(baseName("giglist-staged"), Option.some("giglist"));
    assert.deepEqual(baseName("giglist"), Option.none());
    assert.deepEqual(baseName("-staged"), Option.none());
    assert.deepEqual(baseName("staged"), Option.none());
  });
});
