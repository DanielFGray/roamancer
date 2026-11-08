import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as S from "effect/Schema";
import { NodeFileSystem } from "@effect/platform-node";
import { fileURLToPath } from "node:url";
import { Cartridge, expand, decodeFile, kvKeys, loadDashboards } from "./Cartridge.ts";
import * as Package from "./Package.ts";
import { tailnetEntrypoint } from "./Job.ts";
import { ingressService } from "./TailscaleServe.ts";
import { jobDashboard } from "./fleet/Snapshot.ts";

const observability = () =>
  Effect.runPromise(
    decodeFile(
      fileURLToPath(new URL("../platform/observability/cartridge.json", import.meta.url)),
      Cartridge,
    ).pipe(Effect.provide(NodeFileSystem.layer)),
  );

describe("platform observability cartridge", () => {
  it("loads, and declares OpenObserve before the collector that sends to it", async () => {
    const resources = expand(await observability());
    assert.deepEqual(
      resources.map((resource) => ("service" in resource ? resource.service.name : resource._tag)),
      ["TailscaleServe", "openobserve", "otel-collector"],
    );
  });

  it("reads each dashboard file as an OpenObserve dashboard", async () => {
    const cartridge = await observability();
    const dashboards = await Effect.runPromise(
      loadDashboards(Package.root, cartridge).pipe(Effect.provide(NodeFileSystem.layer)),
    );
    assert.deepEqual(
      dashboards.map((resource) =>
        resource._tag === "OpenObserveDashboard"
          ? [resource.name, resource.dashboard.dashboard.title, resource.dashboard.server]
          : resource._tag,
      ),
      [
        ["services", "Services", "openobserve"],
        ["nomad", "Nomad cluster", "openobserve"],
      ],
    );
  });

  it("has the job tab and variable that the fleet page's job links set", async () => {
    const cartridge = await observability();
    const dashboards = await Effect.runPromise(
      loadDashboards(Package.root, cartridge).pipe(Effect.provide(NodeFileSystem.layer)),
    );
    const nomad = dashboards.find(
      (resource) => resource._tag === "OpenObserveDashboard" && resource.name === jobDashboard.name,
    );
    assert.ok(nomad && nomad._tag === "OpenObserveDashboard");
    const document = S.decodeUnknownSync(
      S.Struct({
        variables: S.Struct({ list: S.Array(S.Struct({ name: S.String, value: S.String })) }),
        tabs: S.Array(
          S.Struct({
            tabId: S.String,
            panels: S.Array(S.Struct({ queries: S.Array(S.Struct({ query: S.String })) })),
          }),
        ),
      }),
    )(nomad.dashboard.dashboard);
    // Without a variable in the link, the default matches every job.
    assert.deepEqual(
      document.variables.list.filter((variable) => variable.name === jobDashboard.variable),
      [{ name: jobDashboard.variable, value: ".*" }],
    );
    const jobTab = document.tabs.find((tab) => tab.tabId === jobDashboard.tab);
    assert.ok(jobTab);
    for (const query of jobTab.panels.flatMap((panel) => panel.queries)) {
      assert.match(query.query, new RegExp(`\\{exported_job=~"\\$${jobDashboard.variable}"\\}`));
    }
  });

  it("lists the dashboard token among the keys `ops secret set` accepts", async () => {
    const keys = kvKeys(await observability()).get("secret/data/platform/openobserve");
    assert.deepEqual(keys, ["root_password", "automation_token"]);
  });
});

describe("platform ingress cartridge", () => {
  it("runs the Traefik service and tailnet entrypoint that Tailscale Serve forwards to", async () => {
    const cartridge = await Effect.runPromise(
      decodeFile(
        fileURLToPath(new URL("../platform/ingress/cartridge.json", import.meta.url)),
        Cartridge,
      ).pipe(Effect.provide(NodeFileSystem.layer)),
    );
    const traefik = cartridge.services.find((service) => service.name === ingressService);
    assert.ok(traefik);
    const args = traefik.args ?? [];
    assert.ok(
      args.includes(`--entrypoints.${tailnetEntrypoint.name}.address=:${tailnetEntrypoint.port}`),
    );
    // Routers that name no entrypoint, such as release routes, must stay off the tailnet one.
    assert.ok(args.includes("--entrypoints.web.asDefault=true"));
  });
});
