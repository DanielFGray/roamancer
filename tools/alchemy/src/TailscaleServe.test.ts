import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as Option from "effect/Option";
import * as S from "effect/Schema";
import {
  leasePort,
  planServe,
  ServeStatus,
  TailscaleStatus,
  servedTarget,
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

  it("decodes a raw TCP forward beside the HTTPS routes", () => {
    const status = S.decodeUnknownSync(ServeStatus)({
      TCP: { "5432": { TCPForward: "10.13.37.196:5432" }, "9000": { HTTPS: true } },
    });
    assert.deepEqual(Object.keys(status.TCP), ["5432", "9000"]);
  });

  it("decodes an empty Serve config, which Tailscale prints as {}", () => {
    assert.deepEqual(S.decodeUnknownSync(ServeStatus)({}), { TCP: {}, Web: {} });
  });
});

describe("Tailscale Serve target", () => {
  const target = "http://10.13.37.83:18081/_tailnet/openobserve/";
  const web = { "cynic.tail.example:9000": { Handlers: { "/": { Proxy: target } } } };

  it("reads the target that the leased port proxies to", () => {
    assert.deepEqual(servedTarget(web, 9000), Option.some(target));
  });

  it("reads none for a port that serves nothing", () => {
    assert.deepEqual(servedTarget({}, 9000), Option.none());
    assert.deepEqual(servedTarget(web, 9001), Option.none());
  });
});

describe("Tailscale Serve plan", () => {
  const target = "http://10.13.37.83:18081/_tailnet/openobserve/";
  const serving = (port: number, proxy: string) => ({
    TCP: { [port]: { HTTPS: true } },
    Web: { [`cynic.tail.example:${port}`]: { Handlers: { "/": { Proxy: proxy } } } },
  });

  it("leases the lowest free port for a new resource and serves it", () => {
    const status = serving(9000, "http://other/");
    assert.deepEqual(
      planServe(status, Option.none(), target),
      Option.some({ port: 9001, serve: true }),
    );
  });

  it("keeps the recorded port and serves it again when it proxies an old target", () => {
    const status = serving(9000, "http://127.0.0.1:10000");
    assert.deepEqual(
      planServe(status, Option.some(9000), target),
      Option.some({ port: 9000, serve: true }),
    );
  });

  it("leaves Serve alone when the recorded port already proxies the target", () => {
    assert.deepEqual(
      planServe(serving(9000, target), Option.some(9000), target),
      Option.some({ port: 9000, serve: false }),
    );
  });
});
