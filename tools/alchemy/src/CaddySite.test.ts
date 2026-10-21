import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { siteRoute } from "./CaddySite.ts";

// The route is plain JSON. This type reads it by shape, so the tests do not depend on the inferred union.
type Node = {
  handler?: string;
  match?: { path?: string[] }[];
  handle?: Node[];
  routes?: Node[];
  [key: string]: unknown;
};

const route = siteRoute({
  id: "setlist",
  host: "setlist.example.test",
  root: "/srv/setlist/dist",
  apiUpstream: "127.0.0.1:3000",
  headers: { "Content-Security-Policy": "default-src 'self'" },
}) as Node;

// The top-level subroute: [0] is the API route, [1] is the static route.
const siteRoutes = route.handle?.[0]?.routes ?? [];
const staticHandlers = siteRoutes[1]?.handle ?? [];
const staticRoutes = staticHandlers[2]?.routes ?? [];

describe("site route", () => {
  it("sends /api to the API before any static file handler", () => {
    const api = siteRoutes[0];

    assert.deepEqual(api?.match, [{ path: ["/api", "/api/*"] }]);
    assert.equal(api?.handle?.[0]?.handler, "reverse_proxy");
    assert.deepEqual(api?.handle?.[0]?.upstreams, [{ dial: "127.0.0.1:3000" }]);
  });

  it("sets the configured headers on every static response", () => {
    assert.deepEqual(staticHandlers[1], {
      handler: "headers",
      response: { set: { "Content-Security-Policy": ["default-src 'self'"] } },
    });
  });

  it("applies no-cache after the client-route rewrite, so index.html is not cached", () => {
    const rewriteAt = staticRoutes.findIndex((item) => item.handle?.[0]?.handler === "rewrite");
    const noCacheAt = staticRoutes.findIndex(
      (item) => item.handle?.[0]?.handler === "headers" && item.match?.[0]?.path?.[0] === "/index.html",
    );

    assert.ok(rewriteAt >= 0, "a rewrite route exists");
    assert.ok(noCacheAt > rewriteAt, "the no-cache rule comes after the rewrite");
  });
});
