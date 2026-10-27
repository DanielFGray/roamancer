import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as Option from "effect/Option";
import * as S from "effect/Schema";
import {
  AllocationChecksSchema,
  AllocationSnapshotSchema,
  JobListItemSchema,
  ServiceLocationSchema,
} from "./Nomad.ts";
import { ReleaseSetProps, toJobSpec } from "./ReleaseJob.ts";
import { adoptionAttributes, serviceIsReady, validate } from "./ReleaseDecisions.ts";

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
const props = S.decodeUnknownSync(ReleaseSetProps)(input);

const ownedJob = (release: string) =>
  S.decodeUnknownSync(JobListItemSchema)({
    ID: `probe-${release}`,
    Type: "service",
    Status: "running",
    JobModifyIndex: 1,
    Meta: {
      "alchemy.owner": "StagedReleases/probe",
      "alchemy.provider": "Nomad.ReleaseSet",
      "alchemy.release": release,
    },
  });

const service = S.decodeUnknownSync(ServiceLocationSchema)({
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
const allocation = S.decodeUnknownSync(AllocationSnapshotSchema)(allocationInput);
const checks = S.decodeUnknownSync(AllocationChecksSchema)({
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
        // Nomad omits Meta for a job without metadata, such as one run by hand.
        S.decodeUnknownSync(JobListItemSchema)({
          ID: "hand-run",
          Type: "service",
          Status: "running",
          JobModifyIndex: 3,
        }),
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
    const foreign = S.decodeUnknownSync(JobListItemSchema)({
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

  it("routes the stable host to the selected release and the preview host to the candidate", () => {
    // The Host rules Traefik reads from each release's Nomad service.
    const tags = (set: ReleaseSetProps, release: (typeof props.releases)[number]) =>
      toJobSpec(set, release, "StagedReleases/probe").TaskGroups[0].Services[0].Tags;
    const hosts = (set: ReleaseSetProps, release: (typeof props.releases)[number]) =>
      tags(set, release).flatMap((tag) => tag.match(/\.rule=Host\(`(.+)`\)$/)?.[1] ?? []);
    const [v1, v2] = props.releases;
    assert.deepEqual(hosts(props, v1), ["probe.example.test"]);
    assert.deepEqual(hosts(props, v2), ["v2.probe.example.test"]);

    const promoted = { ...props, selectedRelease: "v2", candidateRelease: Option.none<string>() };
    assert.deepEqual(hosts(promoted, v2), ["probe.example.test"]);
    // A release kept only for rollback is invisible to Traefik.
    assert.deepEqual(tags(promoted, v1), []);
  });

  it("requires the routed allocation and all healthiness checks to match the deployed job", () => {
    assert.equal(readiness(), true);
    assert.equal(
      readiness(
        Option.some(
          S.decodeUnknownSync(AllocationSnapshotSchema)({
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
          S.decodeUnknownSync(AllocationChecksSchema)({
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
    const changed = S.decodeUnknownSync(ReleaseSetProps)({
      ...input,
      releases: [
        { ...input.releases[0], image: `registry.example.test/probe@sha256:${"c".repeat(64)}` },
        input.releases[1],
      ],
    });
    assert.equal(Option.isSome(validate(changed, props)), true);
  });
});
