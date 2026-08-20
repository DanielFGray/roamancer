import { expect, it } from "@effect/vitest";
import { Effect, Schema as S } from "effect";
import { deploymentNames, deploymentPaths } from "../lib/deployment.ts";
import {
  makeOperationalReport,
  OperationalReportSchema,
  type OperationalReport,
  worstState,
} from "./OperationalReport.ts";
import { deploymentComponentsFromTestLayers } from "../test/deploy-runner-harness.ts";
import { makeTestServices, seedProject } from "../test/layers.ts";
import { HealthCheckError } from "./HealthCheck.ts";

const serviceMeta = (project = "demo") => ({
  repo: "repo",
  promoted: null,
  promoted_previous: null,
  stages: {
    main: {
      type: "service" as const,
      ref: "main",
      hash: "abc",
      port: 3001,
      host: "test-host",
      domain: `${project}.example`,
      deployed_at: "2026-01-01T00:00:00Z",
    },
  },
});

const staticMeta = (project = "demo") => ({
  repo: "repo",
  promoted: null,
  promoted_previous: null,
  stages: {
    main: {
      type: "static" as const,
      ref: "main",
      hash: "abc",
      port: null,
      host: "test-host",
      domain: `${project}.example`,
      deployed_at: "2026-01-01T00:00:00Z",
    },
  },
});

const reportFor = (state: ReturnType<typeof makeTestServices>) =>
  Effect.gen(function* () {
    const makeReport = yield* makeOperationalReport;
    return yield* makeReport();
  }).pipe(Effect.provide(deploymentComponentsFromTestLayers(state)));

const checks = (report: OperationalReport, stage = report.projects[0]?.stages[0]) =>
  new Map(stage?.checks.map((item) => [item.name, item]) ?? []);

it("orders every operational state from healthy to probe-error", () => {
  expect(worstState(["healthy"])).toBe("healthy");
  expect(worstState(["healthy", "missing"])).toBe("missing");
  expect(worstState(["missing", "unhealthy"])).toBe("unhealthy");
  expect(worstState(["unhealthy", "orphaned"])).toBe("unhealthy");
  expect(worstState(["orphaned", "probe-error"])).toBe("probe-error");
});

it.effect("reports healthy service state and uses project identity for worktrees", () => {
  const state = makeTestServices();
  seedProject(state, "demo", serviceMeta());
  state.files.set(deploymentPaths("demo", "main").worktree, "present");
  state.caddyRoutes = [{ file: deploymentNames("demo", "main").stageSnippet, content: "" }];

  return reportFor(state).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        const stage = result.projects[0]!.stages[0]!;
        expect(stage.status).toBe("healthy");
        expect(stage.checks.find((item) => item.name === "worktree")?.message).toContain(
          "/srv/projects/demo/",
        );
      }),
    ),
  );
});

it.effect("distinguishes missing, inactive, and mismatched serving identities", () => {
  const state = makeTestServices();
  seedProject(state, "demo", serviceMeta());
  state.files.set(deploymentPaths("demo", "main").worktree, "present");
  state.finalArtifact = true;
  state.finalPort = 3999;
  state.finalUnit = true;
  state.finalActive = false;
  state.finalWorkingDirectory = "/srv/projects/wrong/stages/main";

  return reportFor(state).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        const stageChecks = checks(result);
        expect(stageChecks.get("artifact-identity")?.status).toBe("unhealthy");
        expect(stageChecks.get("systemd-activity")?.status).toBe("unhealthy");
        expect(stageChecks.get("systemd-identity")?.status).toBe("unhealthy");
      }),
    ),
  );
});

it.effect("does not report activity for an absent unit", () => {
  const state = makeTestServices();
  seedProject(state, "demo", serviceMeta());
  state.files.set(deploymentPaths("demo", "main").worktree, "present");
  state.finalUnit = false;
  state.finalArtifact = true;

  return reportFor(state).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        const stageChecks = checks(result);
        expect(stageChecks.get("systemd-unit")?.status).toBe("missing");
        expect(stageChecks.has("systemd-activity")).toBe(false);
      }),
    ),
  );
});

it.effect("keeps known candidate drift when the other inspection fails", () => {
  const state = makeTestServices();
  seedProject(state, "demo", serviceMeta());
  state.files.set(deploymentPaths("demo", "main").worktree, "present");
  state.candidateArtifact = true;
  state.failSshCommand = "candidateWorking";

  return reportFor(state).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        const stageChecks = checks(result);
        expect(stageChecks.get("candidate")?.status).toBe("orphaned");
        expect(stageChecks.get("systemd")?.status).toBe("probe-error");
      }),
    ),
  );
});

it.effect("keeps Caddy unknown and independent probe results separate", () => {
  const state = makeTestServices();
  seedProject(state, "demo", serviceMeta());
  state.files.set(deploymentPaths("demo", "main").worktree, "present");
  state.failCaddyRoutes = true;
  state.failSshCommand = "candidatePort";

  return reportFor(state).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        const stageChecks = checks(result);
        expect(stageChecks.get("caddy-stage-snippet")?.status).toBe("probe-error");
        expect(stageChecks.get("artifact")?.status).toBe("probe-error");
        expect(stageChecks.get("systemd-unit")?.status).toBe("healthy");
      }),
    ),
  );
});

it.effect("reports empty project rows", () => {
  const state = makeTestServices();
  seedProject(state, "empty");

  return reportFor(state).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        expect(result.projects[0]?.status).toBe("orphaned");
        expect(result.projects[0]?.checks[0]?.name).toBe("project-row");
      }),
    ),
  );
});

it.effect("classifies a typed health failure as unhealthy", () => {
  const state = makeTestServices();
  seedProject(state, "demo", serviceMeta());
  state.files.set(deploymentPaths("demo", "main").worktree, "present");
  state.healthError = new HealthCheckError({ stage: "main", reason: "HTTP 503" });

  return reportFor(state).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        expect(checks(result).get("service-health")?.status).toBe("unhealthy");
      }),
    ),
  );
});

it.effect("reports static artifacts and abandoned static candidates", () => {
  const state = makeTestServices();
  seedProject(state, "demo", staticMeta());
  state.files.set(deploymentPaths("demo", "main").worktree, "present");
  state.finalArtifact = true;
  state.candidateArtifact = true;

  return reportFor(state).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        const stageChecks = checks(result);
        expect(stageChecks.get("artifact")?.status).toBe("healthy");
        expect(stageChecks.get("candidate")?.status).toBe("orphaned");
      }),
    ),
  );
});

it.effect("reports a missing static final artifact", () => {
  const state = makeTestServices();
  seedProject(state, "demo", staticMeta());
  state.files.set(deploymentPaths("demo", "main").worktree, "present");
  state.candidateArtifact = true;

  return reportFor(state).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        const stageChecks = checks(result);
        expect(stageChecks.get("artifact")?.status).toBe("missing");
        expect(stageChecks.get("candidate")?.status).toBe("orphaned");
      }),
    ),
  );
});

it.effect("reports global managed Caddy orphans", () => {
  const state = makeTestServices();
  state.caddyRoutes = [{ file: "infra--old--stage--main.caddyfile", content: "" }];

  return reportFor(state).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        expect(result.checks).toContainEqual(
          expect.objectContaining({ name: "caddy-orphans", status: "orphaned" }),
        );
      }),
    ),
  );
});

it("keeps the API/client contract valid for every state class", () => {
  const report = {
    status: "probe-error",
    projects: [
      {
        project: "demo",
        status: "orphaned",
        stages: [
          {
            project: "demo",
            stage: "main",
            type: "static",
            status: "missing",
            checks: [
              { name: "worktree", status: "healthy", message: "present" },
              { name: "artifact", status: "unhealthy", message: "failed" },
              { name: "candidate", status: "orphaned", message: "left behind" },
              { name: "routes", status: "probe-error", message: "unavailable" },
            ],
          },
        ],
        checks: [],
      },
    ],
    checks: [],
  };

  expect(S.decodeUnknownSync(OperationalReportSchema)(report)).toEqual(report);
});
