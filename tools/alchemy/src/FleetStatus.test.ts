import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { blockedBy, health } from "./FleetStatus.ts";

const job = { status: "running", type: "service", running: 1, starting: 0, queued: 0, checks: [] };

describe("health", () => {
  it("calls a registered job with nothing placed down, though Nomad calls it running", () => {
    assert.equal(health({ ...job, running: 0, queued: 1 }), "down");
  });

  it("calls a job degraded while an allocation waits or a check fails", () => {
    assert.equal(health({ ...job, queued: 1 }), "degraded");
    assert.equal(health({ ...job, checks: [{ status: "failure" }] }), "degraded");
    assert.equal(health({ ...job, checks: [{ status: "success" }] }), "healthy");
  });

  it("calls a stopped job stopped, not down", () => {
    assert.equal(health({ ...job, status: "dead", running: 0 }), "stopped");
  });
});

describe("blockedBy", () => {
  it("lists the newest failed placement's reasons once each", () => {
    const failed = {
      Status: "blocked",
      FailedTGAllocs: {
        service: {
          ConstraintFiltered: { "missing compatible host volumes": 1 },
          DimensionExhausted: { memory: 1 },
        },
      },
    };
    assert.deepEqual(blockedBy([{ Status: "complete", FailedTGAllocs: null }, failed, failed]), [
      "missing compatible host volumes (1 node)",
      "memory exhausted (1 node)",
    ]);
  });

  it("is empty when no evaluation failed to place", () => {
    assert.deepEqual(blockedBy([{ Status: "complete", FailedTGAllocs: null }]), []);
  });
});
