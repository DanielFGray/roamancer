import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as S from "effect/Schema";
import { blockedBy, health, nodeStatus } from "./FleetStatus.ts";
import { NodeSchema, NodeStatsSchema, PlacedAllocationSchema } from "./Nomad.ts";

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

// Trimmed from the responses of a Nomad 2.0.7 dev agent.
const node = S.decodeUnknownSync(NodeSchema)({
  ID: "87a88833-64e1-a151-895b-cf41a568565e",
  Name: "dev",
  Status: "ready",
  SchedulingEligibility: "eligible",
  NodeResources: {
    Cpu: { CpuShares: 15200, ReservableCpuCores: [0, 1], TotalCpuCores: 8 },
    Memory: { MemoryMB: 15762 },
  },
  ReservedResources: { Cpu: { CpuShares: 200, ReservedCpuCores: null }, Memory: { MemoryMB: 256 } },
});
const stats = S.decodeUnknownSync(NodeStatsSchema)({
  Uptime: 1561100,
  CPU: [
    { CPU: "cpu0", Idle: 60, System: 4, TotalPercent: 40, User: 36 },
    { CPU: "cpu1", Idle: 80, System: 4, TotalPercent: 20, User: 16 },
  ],
  Memory: { Available: 5828149248, Free: 1044185088, Total: 16528658432, Used: 10271100928 },
  DiskStats: [
    {
      Available: 10657800192,
      Device: "/dev/sda5",
      Mountpoint: "/",
      Size: 58190864384,
      Used: 44543946752,
      UsedPercent: 80.69,
    },
  ],
});
const allocation = (NodeName: string, ClientStatus: string, MemoryMB: number) =>
  S.decodeUnknownSync(PlacedAllocationSchema)({
    ID: "a",
    JobID: "postgres",
    NodeName,
    ClientStatus,
    AllocatedResources: {
      Shared: {},
      Tasks: { server: { Cpu: { CpuShares: 500 }, Memory: { MemoryMB, MemoryMaxMB: 0 } } },
    },
  });

describe("nodeStatus", () => {
  it("sums reservations of running allocations on the node, against capacity less the node's own reserve", () => {
    const status = nodeStatus(
      node,
      [
        allocation("dev", "running", 512),
        allocation("dev", "complete", 768),
        allocation("other", "running", 64),
      ],
      stats,
    );
    assert.deepEqual(status.reservedMemoryMB, { used: 512, total: 15506 });
    assert.deepEqual(status.reservedCpuShares, { used: 500, total: 15000 });
    assert.equal(status.cpuPercent, 30);
    assert.deepEqual(status.disks, [
      { mount: "/", bytes: { used: 44543946752, total: 58190864384 } },
    ]);
  });

  it("shows no measurements for a node that did not answer", () => {
    const status = nodeStatus(node, [], null);
    assert.equal(status.cpuPercent, null);
    assert.equal(status.memoryBytes, null);
    assert.deepEqual(status.disks, []);
  });
});
