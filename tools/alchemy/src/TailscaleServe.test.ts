import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as Option from "effect/Option";
import * as S from "effect/Schema";
import {
  backendPort,
  leasePort,
  ServeStatus,
  TailscaleStatus,
  serveOwnership,
} from "./TailscaleServe.ts";

describe("Tailscale Serve port lease", () => {
  it("chooses the lowest unused port in the lease range", () => {
    assert.deepEqual(leasePort([9000, 9002]), Option.some(9001));
  });

  it("returns none when every port is occupied", () => {
    assert.deepEqual(
      leasePort(Array.from({ length: 100 }, (_, index) => 9000 + index)),
      Option.none(),
    );
  });

  it("derives the backend port from the Serve port", () => {
    assert.equal(backendPort(9000), 10000);
  });
});

describe("Tailscale JSON schemas", () => {
  it("decodes the local MagicDNS name and removes no data at the boundary", () => {
    assert.deepEqual(
      S.decodeUnknownSync(TailscaleStatus)({ Self: { DNSName: "cynic.tail.example." } }),
      { Self: { DNSName: "cynic.tail.example." } },
    );
  });

  it("decodes the TCP and Web routes from Serve status", () => {
    assert.deepEqual(
      S.decodeUnknownSync(ServeStatus)({
        TCP: { "443": { HTTPS: true } },
        Web: {
          "cynic.tail.example:443": {
            Handlers: { "/": { Proxy: "http://127.0.0.1:80" } },
          },
        },
      }),
      {
        TCP: { "443": { HTTPS: true } },
        Web: {
          "cynic.tail.example:443": {
            Handlers: { "/": { Proxy: "http://127.0.0.1:80" } },
          },
        },
      },
    );
  });
});

describe("Tailscale Serve ownership", () => {
  const expected = "http://127.0.0.1:10000";
  const web = (target: string) => ({
    "cynic.tail.example:9000": { Handlers: { "/": { Proxy: target } } },
  });

  it("identifies a missing, owned, or foreign proxy at the leased port", () => {
    assert.deepEqual(serveOwnership({}, 9000, expected), { _tag: "Missing" });
    assert.deepEqual(serveOwnership(web(expected), 9000, expected), { _tag: "Owned" });
    assert.deepEqual(serveOwnership(web("http://127.0.0.1:8080"), 9000, expected), {
      _tag: "Conflict",
      target: "http://127.0.0.1:8080",
    });
  });

  it("does not claim a proxy on a different Serve port", () => {
    assert.deepEqual(serveOwnership(web(expected), 9001, expected), { _tag: "Missing" });
  });
});
