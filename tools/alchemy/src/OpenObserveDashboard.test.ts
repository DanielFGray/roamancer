import { afterEach, beforeEach, describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Effect, Option, Redacted } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import {
  dashboardClient,
  isUnchanged,
  saveDashboard,
  type DashboardAttributes,
  type DashboardDocument,
} from "./OpenObserveDashboard.ts";

const username = "automation.default@sa.internal";
const token = "token-1";

const document = (title: string): DashboardDocument => ({
  version: 8,
  title,
  description: "",
  tabs: [],
});

/**
 * The dashboard API as OpenObserve 1.1.2 answers it: the server assigns IDs, every save
 * changes the hash, and an update must name the current hash.
 */
const fakeOpenObserve = async () => {
  const saved = new Map<string, { hash: string; document: Record<string, unknown> }>();
  let next = 0;
  const answer = (
    method: string,
    url: URL,
    authorization: string | undefined,
    body: string,
  ): readonly [number, unknown] => {
    const reply = (id: string): readonly [number, unknown] => {
      const entry = saved.get(id)!;
      return [200, { hash: entry.hash, v8: { ...entry.document, dashboardId: id } }];
    };
    if (authorization !== `Basic ${btoa(`${username}:${token}`)}`) return [401, { code: 401 }];
    const id = url.pathname.match(/^\/api\/default\/dashboards\/(.+)$/)?.[1];
    if (method === "POST" && url.pathname === "/api/default/dashboards") {
      const created = `${++next}`;
      saved.set(created, { hash: `h${next}`, document: JSON.parse(body) });
      return reply(created);
    }
    if (id === undefined || !saved.has(id)) return [404, { message: "Dashboard not found" }];
    if (method === "GET") return reply(id);
    if (method === "DELETE") {
      saved.delete(id);
      return [200, { message: "Dashboard deleted" }];
    }
    if (method === "PUT") {
      if (url.searchParams.get("hash") !== saved.get(id)!.hash) return [409, { code: 409 }];
      saved.set(id, { hash: `h${++next}`, document: JSON.parse(body) });
      return reply(id);
    }
    return [405, {}];
  };
  const server = createServer(async (request, response) => {
    const chunks: Array<Buffer> = [];
    for await (const chunk of request) chunks.push(chunk);
    const [status, body] = answer(
      request.method ?? "GET",
      new URL(request.url ?? "/", "http://fake"),
      request.headers.authorization,
      Buffer.concat(chunks).toString(),
    );
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as AddressInfo).port, server, saved };
};

let fake: Awaited<ReturnType<typeof fakeOpenObserve>>;
beforeEach(async () => {
  fake = await fakeOpenObserve();
});
afterEach(() => {
  if (fake.server.listening) fake.server.close();
});

const run = <A, E>(
  use: (client: ReturnType<typeof dashboardClient>) => Effect.Effect<A, E, never>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient;
      return yield* use(
        dashboardClient(http, {
          baseUrl: `http://127.0.0.1:${fake.port}`,
          username,
          token: Redacted.make(token),
        }),
      );
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );

const titleOf = (id: string) => fake.saved.get(id)?.document.title;

describe("OpenObserve dashboards", () => {
  it("creates the dashboard on the first deploy", async () => {
    const saved = await run((client) => saveDashboard(client, Option.none(), document("Services")));
    assert.deepEqual(saved, { dashboardId: "1", hash: "h1" });
    assert.equal(titleOf("1"), "Services");
  });

  it("writes over a dashboard that was edited by hand since the last deploy", async () => {
    const first = await run((client) => saveDashboard(client, Option.none(), document("Services")));
    // A save in the UI changes the hash that the deploy stored.
    fake.saved.set("1", { hash: "edited", document: { title: "Edited" } });

    const saved = await run((client) =>
      saveDashboard(client, Option.some(first), document("Services v2")),
    );
    assert.equal(saved.dashboardId, "1");
    assert.equal(titleOf("1"), "Services v2");
    assert.equal(fake.saved.size, 1);
  });

  it("creates the dashboard again when OpenObserve lost it", async () => {
    const lost: DashboardAttributes = { dashboardId: "41", hash: "h41" };
    const saved = await run((client) =>
      saveDashboard(client, Option.some(lost), document("Services")),
    );
    assert.equal(saved.dashboardId, "1");
    assert.equal(titleOf("1"), "Services");
  });

  it("reads the hash of a saved dashboard, and none for a missing one", async () => {
    await run((client) => client.create(document("Services")));
    assert.deepEqual(
      await run((client) => client.get("1")),
      Option.some({ dashboardId: "1", hash: "h1" }),
    );
    assert.deepEqual(await run((client) => client.get("2")), Option.none());
  });

  it("fails an update that names a hash OpenObserve no longer holds", async () => {
    await run((client) => client.create(document("Services")));
    await assert.rejects(
      run((client) => client.update({ dashboardId: "1", hash: "stale" }, document("Other"))),
      { message: /OpenObserve update dashboard failed for Other/ },
    );
    assert.equal(titleOf("1"), "Services");
  });

  it("deletes a dashboard, and counts one already gone as deleted", async () => {
    await run((client) => client.create(document("Services")));
    await run((client) => client.remove("1"));
    assert.equal(fake.saved.size, 0);
    await run((client) => client.remove("1"));
  });
});

describe("OpenObserve dashboard plan", () => {
  it("shows no change while the dashboard keeps the hash the deploy stored", async () => {
    const stored = await run((client) => client.create(document("Services")));
    assert.equal(await run((client) => isUnchanged(client, stored)), true);
  });

  it("shows a change once the dashboard was saved by hand", async () => {
    const stored = await run((client) => client.create(document("Services")));
    fake.saved.set("1", { hash: "edited", document: { title: "Edited" } });
    assert.equal(await run((client) => isUnchanged(client, stored)), false);
  });

  it("shows a change when OpenObserve lost the dashboard", async () => {
    const lost: DashboardAttributes = { dashboardId: "41", hash: "h41" };
    assert.equal(await run((client) => isUnchanged(client, lost)), false);
  });

  it("shows a change when OpenObserve does not answer", async () => {
    const stored = await run((client) => client.create(document("Services")));
    await new Promise((resolve) => fake.server.close(resolve));
    assert.equal(await run((client) => isUnchanged(client, stored)), false);
  });
});
