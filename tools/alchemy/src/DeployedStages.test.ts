import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as Struct from "effect/Struct";
import {
  type CreatedResourceState,
  type CreatingResourceState,
  InMemoryService,
  type ResourceState,
} from "alchemy/State";
import { dashboardResourceId, serveResourceId } from "./Compose.ts";
import { dashboards, endpoints, readStages } from "./DeployedStages.ts";
import { viewUrl } from "./OpenObserveDashboard.ts";
import * as Package from "./Package.ts";
import { type AppRelease, appRows, type Endpoint } from "./fleet/Snapshot.ts";

// Records shaped as Alchemy stores them after a deploy.
const created = (
  fqn: string,
  resourceType: string,
  props: object,
  attr: object,
): CreatedResourceState => ({
  status: "created",
  namespace: undefined,
  fqn,
  logicalId: fqn,
  instanceId: "0",
  resourceType,
  props,
  attr,
  bindings: [],
  providerVersion: 0,
  downstream: [],
  removalPolicy: "destroy",
});
// A record that a deploy is still creating has no attributes yet.
const creating = (record: CreatedResourceState): CreatingResourceState => ({
  ...Struct.omit(record, ["attr"]),
  status: "creating",
});

const job = (name: string, routes: ReadonlyArray<object>, commit?: string) =>
  created(
    name,
    "Nomad.Job",
    {
      name,
      image: "registry.cluster:5000/app@sha256:0",
      routes,
      environment: [
        ...(commit === undefined ? [] : [{ name: "GIT_COMMIT", value: commit }]),
        { name: "NODE_ENV", value: "production" },
      ],
    },
    { id: name },
  );
const serve = (jobName: string, port: number) =>
  created(
    serveResourceId(jobName),
    "Tailscale.Serve",
    { path: `/_tailnet/${jobName}/` },
    { id: serveResourceId(jobName), port, url: `https://cynic.tail.example:${port}` },
  );
const dashboard = (name: string, title: string, dashboardId: string) =>
  created(
    dashboardResourceId(name),
    "OpenObserve.Dashboard",
    { server: "openobserve", username: "automation", token: "key", dashboard: { title } },
    { dashboardId, hash: "h" },
  );

const read = <A, E>(
  stages: Record<string, ReadonlyArray<ResourceState>>,
  section: (stages: Effect.Success<ReturnType<typeof readStages>>) => Effect.Effect<A, E>,
) =>
  Effect.runPromise(
    InMemoryService({
      [Package.stack]: Object.fromEntries(
        Object.entries(stages).map(([stage, records]) => [
          stage,
          Object.fromEntries(records.map((record) => [record.fqn, record])),
        ]),
      ),
    }).pipe(Effect.flatMap(readStages), Effect.flatMap(section)),
  );

describe("endpoints", () => {
  const publicRoute = (host: string) => ({ access: "public", host, pathPrefixes: ["/api"] });
  const tailnet = { access: "tailnet" };

  it("gives each public host and each tailnet Serve URL, live and staged", async () => {
    const found = await read(
      {
        giglist: [
          job("giglist-api", [publicRoute("giglist.example")], "aaa"),
          job("giglist-web", [publicRoute("giglist.example")], "aaa"),
        ],
        "giglist-staged": [
          job("giglist-api-staged", [tailnet], "bbb"),
          serve("giglist-api-staged", 9002),
        ],
      },
      endpoints,
    );
    assert.deepEqual(
      [...found].sort((a, b) => a.job.localeCompare(b.job)),
      [
        {
          app: "giglist",
          stage: "giglist",
          job: "giglist-api",
          revision: "aaa",
          access: "public",
          url: "https://giglist.example/",
        },
        {
          app: "giglist",
          stage: "giglist-staged",
          job: "giglist-api-staged",
          revision: "bbb",
          access: "tailnet",
          url: "https://cynic.tail.example:9002",
        },
        {
          app: "giglist",
          stage: "giglist",
          job: "giglist-web",
          revision: "aaa",
          access: "public",
          url: "https://giglist.example/",
        },
      ] satisfies ReadonlyArray<Endpoint>,
    );
  });

  it("links nothing that a deploy is still creating", async () => {
    const found = await read(
      {
        "platform-observability": [
          job("openobserve", [tailnet]),
          creating(serve("openobserve", 9000)),
          creating(job("otel-collector", [publicRoute("otel.example")])),
        ],
      },
      endpoints,
    );
    assert.deepEqual(found, []);
  });

  it("fails, naming the lease, when a finished tailnet job has no Serve record", async () => {
    await assert.rejects(
      read({ "twitter-bookmarks": [job("twitter-bookmarks", [tailnet])] }, endpoints),
      {
        message: /no tailscale-serve-twitter-bookmarks in stage twitter-bookmarks/,
      },
    );
  });

  it("fails on a finished job record it cannot read, so the page says why", async () => {
    const broken = created("giglist-api", "Nomad.Job", { name: "giglist-api" }, {});
    await assert.rejects(read({ giglist: [broken] }, endpoints));
  });
});

describe("dashboards", () => {
  it("opens each deployed dashboard through the Serve URL of the job that serves it", async () => {
    const links = await read(
      {
        "platform-observability": [
          serve("openobserve", 9000),
          dashboard("services", "Services", "41"),
          dashboard("nomad", "Nomad cluster", "42"),
        ],
      },
      dashboards,
    );
    assert.deepEqual(
      [...links].sort((a, b) => a.name.localeCompare(b.name)),
      [
        {
          name: "nomad",
          title: "Nomad cluster",
          url: viewUrl("https://cynic.tail.example:9000", "42"),
        },
        {
          name: "services",
          title: "Services",
          url: viewUrl("https://cynic.tail.example:9000", "41"),
        },
      ],
    );
  });

  it("fails, naming the lease, when the stage has no Serve record for its server", async () => {
    await assert.rejects(
      read({ "platform-observability": [dashboard("nomad", "Nomad cluster", "42")] }, dashboards),
      { message: /no tailscale-serve-openobserve in stage platform-observability/ },
    );
  });

  it("gives no link while the Serve lease of its server is being created", async () => {
    const links = await read(
      {
        "platform-observability": [
          creating(serve("openobserve", 9000)),
          dashboard("nomad", "Nomad cluster", "42"),
        ],
      },
      dashboards,
    );
    assert.deepEqual(links, []);
  });
});

describe("appRows", () => {
  const endpoint = (
    app: string,
    stage: string,
    url: string,
    revision: string | null,
  ): Endpoint => ({
    app,
    stage,
    job: `${stage}-api`,
    access: "public",
    url,
    revision,
  });
  const release: AppRelease = {
    name: "giglist",
    deployment: 3,
    revision: "aaa",
    deployedAt: "2026-11-01T00:00:00Z",
    jobs: ["giglist-api"],
  };

  it("lists each live address once, then each staged copy with its commit", () => {
    const rows = appRows(
      [release],
      [
        endpoint("giglist", "giglist", "https://giglist.example/", "aaa"),
        endpoint("giglist", "giglist", "https://giglist.example/", "aaa"),
        endpoint("giglist", "giglist-staged", "https://cynic.tail.example:9002", null),
        endpoint("giglist", "giglist-staged", "https://cynic.tail.example:9003", "bbb"),
      ],
    );
    assert.deepEqual(rows, [
      {
        name: "giglist",
        release,
        live: { stage: "giglist", urls: ["https://giglist.example/"], revision: "aaa" },
        previews: [
          {
            stage: "giglist-staged",
            urls: ["https://cynic.tail.example:9002", "https://cynic.tail.example:9003"],
            revision: "bbb",
          },
        ],
      },
    ]);
  });

  it("gives an app that runs only as a staged copy its own row, and no row to other stages", () => {
    const rows = appRows(
      [],
      [
        endpoint("rfchat", "rfchat-staged", "https://cynic.tail.example:9004", "ccc"),
        endpoint("noneuclid", "noneuclid", "https://noneuclid.example/", null),
      ],
    );
    assert.deepEqual(rows, [
      {
        name: "rfchat",
        release: null,
        live: { stage: "rfchat", urls: [], revision: null },
        previews: [
          { stage: "rfchat-staged", urls: ["https://cynic.tail.example:9004"], revision: "ccc" },
        ],
      },
    ]);
  });
});
