import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as S from "effect/Schema";
import { ServiceNotRegistered, firstServiceLocation } from "./ServiceRegistration.ts";

const fast = { times: 5, spacing: "1 millis" } as const;

class LookupFailed extends S.TaggedError<LookupFailed>()("LookupFailed", {}) {}

describe("firstServiceLocation", () => {
  it("returns the first location once Nomad lists the service", async () => {
    let calls = 0;
    const lookup = Effect.sync(() => {
      calls += 1;
      return calls < 3 ? [] : [{ Address: "10.0.0.2", Port: 6379 }];
    });

    const location = await Effect.runPromise(firstServiceLocation("shared-valkey", lookup, fast));

    assert.deepEqual(location, { Address: "10.0.0.2", Port: 6379 });
    assert.equal(calls, 3);
  });

  it("fails with ServiceNotRegistered after the retry budget is spent", async () => {
    let calls = 0;
    const lookup = Effect.sync(() => {
      calls += 1;
      return [];
    });

    const exit = await Effect.runPromiseExit(firstServiceLocation("shared-valkey", lookup, fast));

    assert.ok(Exit.isFailure(exit));
    const error = exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error;
    assert.ok(error instanceof ServiceNotRegistered);
    assert.equal(error.service, "shared-valkey");
    assert.equal(calls, fast.times + 1);
  });

  it("does not retry a lookup failure", async () => {
    let calls = 0;
    const lookup = Effect.suspend(() => {
      calls += 1;
      return Effect.fail(new LookupFailed({}));
    });

    const exit = await Effect.runPromiseExit(firstServiceLocation("shared-valkey", lookup, fast));

    assert.ok(Exit.isFailure(exit));
    assert.equal(calls, 1);
  });
});
