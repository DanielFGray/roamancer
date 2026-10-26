import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import { NodeFileSystem } from "@effect/platform-node";
import { fileURLToPath } from "node:url";
import { Cartridge, expand, decodeFile } from "./Cartridge.ts";

describe("platform observability cartridge", () => {
  it("loads, and declares OpenObserve before the collector that sends to it", async () => {
    const cartridge = await Effect.runPromise(
      decodeFile(
        fileURLToPath(new URL("../platform/observability/cartridge.json", import.meta.url)),
        Cartridge,
      ).pipe(Effect.provide(NodeFileSystem.layer)),
    );

    const resources = expand(cartridge);
    assert.deepEqual(
      resources.map((resource) => ("service" in resource ? resource.service.name : resource._tag)),
      ["TailscaleServe", "openobserve", "otel-collector"],
    );
  });
});
