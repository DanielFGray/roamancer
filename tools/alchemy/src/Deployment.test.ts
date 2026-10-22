import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { deploymentOutcome } from "./Deployment.ts";
import type { Deployment, JobSnapshot } from "./Nomad.ts";

const owner = "cartridge/platform-data/postgres";
const job: JobSnapshot = {
  ID: "postgres",
  Version: 3,
  Stable: false,
  JobModifyIndex: 41,
  Meta: { "alchemy.owner": owner, "alchemy.provider": "Nomad.Job" },
};
const deployment = (status: Deployment["Status"], description: string): Deployment => ({
  ID: "d1",
  JobVersion: 3,
  JobModifyIndex: 41,
  Status: status,
  StatusDescription: description,
});

const outcome = (current: Option.Option<JobSnapshot>, latest: Option.Option<Deployment>) =>
  Effect.runPromise(
    deploymentOutcome(
      { job: () => Effect.succeed(current), deployment: () => Effect.succeed(latest) },
      "postgres",
      (j: JobSnapshot) => (j.Meta?.["alchemy.owner"] as string | undefined) === owner,
      41,
    ),
  );

describe("deploymentOutcome", () => {
  it("waits while the deployment is running or not yet created", async () => {
    assert.ok(
      Option.isNone(await outcome(Option.some(job), Option.some(deployment("running", "")))),
    );
    assert.ok(Option.isNone(await outcome(Option.some(job), Option.none())));
    assert.ok(Option.isNone(await outcome(Option.none(), Option.none())));
  });

  it("reports a successful deployment of this version as healthy", async () => {
    const settled = await outcome(Option.some(job), Option.some(deployment("successful", "done")));
    assert.ok(Option.isSome(settled));
    assert.equal(settled.value._tag, "Healthy");
  });

  it("fails at once with Nomad's reason when the deployment fails", async () => {
    const settled = await outcome(
      Option.some(job),
      Option.some(deployment("failed", "Failed due to progress deadline")),
    );
    assert.deepEqual(
      settled,
      Option.some({
        _tag: "Failed",
        reason: "Nomad deployment failed: Failed due to progress deadline",
      }),
    );
  });

  it("fails when a newer registration replaced the job", async () => {
    const settled = await outcome(
      Option.some({ ...job, JobModifyIndex: 42 }),
      Option.some(deployment("running", "")),
    );
    assert.ok(Option.isSome(settled));
    assert.equal(settled.value._tag, "Failed");
  });
});
