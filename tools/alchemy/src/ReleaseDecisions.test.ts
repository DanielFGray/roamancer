import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  AllocationChecksSchema,
  AllocationSnapshotSchema,
  JobListItemSchema,
  ServiceLocationSchema,
} from "./Nomad.ts";
import { ReleaseSetProps } from "./ReleaseJob.ts";
import {
  adoptionAttributes,
  previewRouteId,
  routeDecision,
  serviceIsReady,
  stableRouteId,
  validate,
} from "./ReleaseDecisions.ts";

const input = {
  name: "probe",
  scheme: "https",
  domain: "probe.example.test",
  containerPort: 8080,
  healthPath: "/health",
  cpu: 100,
  memoryMB: 128,
  releases: [
    { id: "v1", image: `registry.example.test/probe@sha256:${"a".repeat(64)}` },
    { id: "v2", image: `registry.example.test/probe@sha256:${"b".repeat(64)}` },
  ],
  selectedRelease: "v1",
  candidateRelease: "v2",
};
const props = Schema.decodeUnknownSync(ReleaseSetProps)(input);

const ownedJob = (release: string) =>
  Schema.decodeUnknownSync(JobListItemSchema)({
    ID: `probe-${release}`,
    JobModifyIndex: 1,
    Meta: {
      "alchemy.owner": "StagedReleases/probe",
      "alchemy.provider": "Nomad.ReleaseSet",
      "alchemy.release": release,
    },
  });

const service = Schema.decodeUnknownSync(ServiceLocationSchema)({
  ServiceName: "probe-v1",
  AllocID: "allocation-1",
  Address: "10.0.0.2",
  Port: 20000,
});
const allocationInput = {
  ID: "allocation-1",
  JobID: "probe-v1",
  DesiredStatus: "run",
  ClientStatus: "running",
  DeploymentStatus: { Healthy: true },
  Job: { ID: "probe-v1", Version: 4, JobModifyIndex: 12 },
};
const allocation = Schema.decodeUnknownSync(AllocationSnapshotSchema)(allocationInput);
const checks = Schema.decodeUnknownSync(AllocationChecksSchema)({
  "check-1": { Mode: "healthiness", Service: "probe-v1", Status: "success" },
  "check-2": { Mode: "readiness", Service: "probe-v1", Status: "success" },
});
const readiness = (
  nextAllocation: Option.Option<typeof allocation> = Option.some(allocation),
  nextChecks: Option.Option<typeof checks> = Option.some(checks),
) =>
  serviceIsReady({
    service,
    jobName: "probe-v1",
    jobVersion: 4,
    jobModifyIndex: 12,
    allocation: nextAllocation,
    checks: nextChecks,
  });

describe("ReleaseSet recovery and diff decisions", () => {
  it("adopts when every declared release has one owned job", () => {
    assert.deepEqual(
      adoptionAttributes(props, "StagedReleases/probe", [ownedJob("v1"), ownedJob("v2")]),
      {
        id: "probe",
        selectedRelease: "v1",
        candidateRelease: "v2",
        previewUrl: "https://v2.probe.example.test",
        releases: ["v1", "v2"],
      },
    );
  });

  it("adopts matching releases with an extra owned job so reconcile can clean it up", () => {
    assert.ok(
      adoptionAttributes(props, "StagedReleases/probe", [
        ownedJob("v1"),
        ownedJob("v2"),
        ownedJob("abandoned"),
      ]),
    );
  });

  it("does not adopt when a declared release is missing, duplicated, or owned elsewhere", () => {
    assert.equal(adoptionAttributes(props, "StagedReleases/probe", [ownedJob("v1")]), undefined);
    assert.equal(
      adoptionAttributes(props, "StagedReleases/probe", [
        ownedJob("v1"),
        ownedJob("v1"),
        ownedJob("v2"),
      ]),
      undefined,
    );
    const foreign = Schema.decodeUnknownSync(JobListItemSchema)({
      ...ownedJob("v2"),
      Meta: {
        "alchemy.owner": "AnotherStack/probe",
        "alchemy.provider": "Nomad.ReleaseSet",
        "alchemy.release": "v2",
      },
    });
    assert.equal(
      adoptionAttributes(props, "StagedReleases/probe", [ownedJob("v1"), foreign]),
      undefined,
    );
  });

  it("plans an update for route drift but not for matching routes", () => {
    assert.equal(
      routeDecision({ stableMatches: true, candidateMatches: true, stalePreview: false }),
      undefined,
    );
    assert.deepEqual(
      routeDecision({ stableMatches: true, candidateMatches: true, stalePreview: true }),
      { action: "update" },
    );
    assert.deepEqual(
      routeDecision({ stableMatches: false, candidateMatches: true, stalePreview: false }),
      { action: "update" },
    );
  });

  it("keeps route identity stable across Alchemy state recreation", () => {
    assert.equal(
      stableRouteId("StagedReleases/probe", props.domain),
      "alchemy-StagedReleases/probe-probe.example.test-stable",
    );
    assert.equal(
      previewRouteId("StagedReleases/probe", props.domain, "v2"),
      "alchemy-StagedReleases/probe-probe.example.test-preview-v2",
    );
  });

  it("requires the routed allocation and all healthiness checks to match the deployed job", () => {
    assert.equal(readiness(), true);
    assert.equal(
      readiness(
        Option.some(
          Schema.decodeUnknownSync(AllocationSnapshotSchema)({
            ...allocationInput,
            Job: { ...allocationInput.Job, JobModifyIndex: 13 },
          }),
        ),
      ),
      false,
    );
    assert.equal(
      readiness(
        Option.some(allocation),
        Option.some(
          Schema.decodeUnknownSync(AllocationChecksSchema)({
            ...checks,
            "check-1": { Mode: "healthiness", Service: "probe-v1", Status: "warning" },
          }),
        ),
      ),
      false,
    );
    assert.equal(readiness(Option.none(), Option.some(checks)), false);
    assert.equal(readiness(Option.some(allocation), Option.none()), false);
  });

  it("rejects a release ID whose immutable image changes", () => {
    const changed = Schema.decodeUnknownSync(ReleaseSetProps)({
      ...input,
      releases: [
        { ...input.releases[0], image: `registry.example.test/probe@sha256:${"c".repeat(64)}` },
        input.releases[1],
      ],
    });
    assert.equal(Option.isSome(validate(changed, props)), true);
  });
});
