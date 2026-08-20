import { Effect, Schema as S } from "effect";
import * as FileSystem from "@effect/platform/FileSystem";
import { CaddyManager, isManagedSnippet } from "./CaddyManager.ts";
import { DeployMeta, type StageInfo } from "./DeployMeta.ts";
import { DeploymentComponents } from "./DeploymentComponents.ts";
import { HealthCheck } from "./HealthCheck.ts";
import { HealthCheckError } from "./HealthCheck.ts";
import { DEPLOYMENT_ROOTS } from "../lib/config.ts";
import { deploymentNames, deploymentPaths } from "../lib/deployment.ts";

export const OperationalState = S.Literal(
  "healthy",
  "missing",
  "unhealthy",
  "orphaned",
  "probe-error",
);
export type OperationalState = typeof OperationalState.Type;

export const OperationalCheck = S.Struct({
  name: S.String,
  status: OperationalState,
  message: S.String,
});
export type OperationalCheck = typeof OperationalCheck.Type;

export const StageOperationalReport = S.Struct({
  project: S.String,
  stage: S.String,
  type: S.Literal("static", "service"),
  status: OperationalState,
  checks: S.Array(OperationalCheck),
});
export type StageOperationalReport = typeof StageOperationalReport.Type;

export const ProjectOperationalReport = S.Struct({
  project: S.String,
  status: OperationalState,
  stages: S.Array(StageOperationalReport),
  checks: S.Array(OperationalCheck),
});
export type ProjectOperationalReport = typeof ProjectOperationalReport.Type;

export const OperationalReportSchema = S.Struct({
  status: OperationalState,
  projects: S.Array(ProjectOperationalReport),
  checks: S.Array(OperationalCheck),
});
export type OperationalReport = typeof OperationalReportSchema.Type;

const stateRank: Record<OperationalState, number> = {
  healthy: 0,
  orphaned: 1,
  missing: 2,
  unhealthy: 3,
  "probe-error": 4,
};

export const worstState = (states: ReadonlyArray<OperationalState>): OperationalState =>
  states.reduce<OperationalState>(
    (worst, state) => (stateRank[state] > stateRank[worst] ? state : worst),
    "healthy",
  );

export const aggregateReport = (
  projects: ReadonlyArray<ProjectOperationalReport>,
  checks: ReadonlyArray<OperationalCheck>,
): OperationalReport => ({
  status: worstState([
    ...checks.map((item) => item.status),
    ...projects.map((item) => item.status),
  ]),
  projects: [...projects],
  checks: [...checks],
});

const check = (name: string, status: OperationalState, message: string): OperationalCheck => ({
  name,
  status,
  message,
});

const probe = <A>(effect: Effect.Effect<A, unknown>) => effect.pipe(Effect.either);

const presence = (name: string, present: boolean, detail: string): OperationalCheck =>
  check(name, present ? "healthy" : "missing", present ? `${detail} present` : `${detail} missing`);

const healthFailureState = (error: unknown): OperationalState =>
  S.is(HealthCheckError)(error) ? "unhealthy" : "probe-error";

const stageReport = (
  project: string,
  stage: string,
  info: StageInfo,
  checks: ReadonlyArray<OperationalCheck>,
): StageOperationalReport => ({
  project,
  stage,
  type: info.type,
  status: worstState(checks.map((item) => item.status)),
  checks: [...checks],
});

export const makeOperationalReport = Effect.gen(function* () {
  const meta = yield* DeployMeta;
  const components = yield* DeploymentComponents;
  const health = yield* HealthCheck;
  const caddy = yield* CaddyManager;
  const fs = yield* FileSystem.FileSystem;

  return Effect.fnUntraced(function* () {
    const globalChecks: OperationalCheck[] = [];
    const expectedSnippets = new Set<string>();
    const routeResult = yield* probe(caddy.listRoutes());
    const routes = routeResult._tag === "Right" ? routeResult.right : [];
    if (routeResult._tag === "Left") {
      globalChecks.push(check("caddy-routes", "probe-error", String(routeResult.left)));
    }

    const projects: ProjectOperationalReport[] = [];
    const namesResult = yield* probe(meta.listProjects());
    if (namesResult._tag === "Left") {
      globalChecks.push(check("metadata-projects", "probe-error", String(namesResult.left)));
    } else {
      for (const project of namesResult.right) {
        const metaResult = yield* probe(meta.getProject(project));
        if (metaResult._tag === "Left") {
          projects.push({
            project,
            status: "probe-error",
            stages: [],
            checks: [check("metadata", "probe-error", String(metaResult.left))],
          });
          continue;
        }
        const value = metaResult.right;
        if (!value || Object.keys(value.stages).length === 0) {
          projects.push({
            project,
            status: "orphaned",
            stages: [],
            checks: [check("project-row", "orphaned", "metadata row has no stages")],
          });
          continue;
        }

        const stages: StageOperationalReport[] = [];
        for (const [stage, info] of Object.entries(value.stages)) {
          const projectPaths = deploymentPaths(project, stage, DEPLOYMENT_ROOTS);
          const artifactPaths = deploymentPaths(info.domain, stage, DEPLOYMENT_ROOTS);
          const names = deploymentNames(project, stage);
          expectedSnippets.add(names.stageSnippet);
          if (value.promoted === stage) expectedSnippets.add(names.productionSnippet);
          const checks: OperationalCheck[] = [];
          const worktree = yield* probe(fs.exists(projectPaths.worktree));
          checks.push(
            worktree._tag === "Left"
              ? check("worktree", "probe-error", String(worktree.left))
              : presence("worktree", worktree.right, projectPaths.worktree),
          );

          if (info.type === "static") {
            const artifact = yield* probe(
              components.staticArtifacts.inspect({
                stage,
                domain: info.domain,
                host: info.host,
              }),
            );
            if (artifact._tag === "Left")
              checks.push(check("artifact", "probe-error", String(artifact.left)));
            else {
              checks.push(presence("artifact", artifact.right.final, artifactPaths.staticFiles));
              if (artifact.right.candidate) {
                checks.push(check("candidate", "orphaned", "candidate artifact remains present"));
              }
            }
          } else {
            const artifact = yield* probe(
              components.serviceArtifacts.inspect({ name: project, stage, host: info.host }),
            );
            const instance = yield* probe(
              components.serviceInstances.inspect({ name: project, stage, host: info.host }),
            );
            if (artifact._tag === "Left") {
              checks.push(check("artifact", "probe-error", String(artifact.left)));
            } else {
              checks.push(presence("artifact", artifact.right.final, projectPaths.service));
              if (artifact.right.final && artifact.right.finalPort !== info.port) {
                checks.push(
                  check(
                    "artifact-identity",
                    "unhealthy",
                    `final artifact port ${artifact.right.finalPort ?? "unknown"} does not match persisted port ${info.port}`,
                  ),
                );
              }
            }
            if (instance._tag === "Left") {
              checks.push(check("systemd", "probe-error", String(instance.left)));
            } else {
              if (!instance.right.final) {
                checks.push(check("systemd-unit", "missing", `${names.serviceUnit} missing`));
              } else {
                checks.push(check("systemd-unit", "healthy", `${names.serviceUnit} present`));
                checks.push(
                  check(
                    "systemd-activity",
                    instance.right.finalActive ? "healthy" : "unhealthy",
                    instance.right.finalActive ? "unit is active" : "unit is not active",
                  ),
                );
                if (instance.right.finalWorkingDirectory !== projectPaths.service) {
                  checks.push(
                    check(
                      "systemd-identity",
                      "unhealthy",
                      `unit working directory ${instance.right.finalWorkingDirectory ?? "unknown"} does not match ${projectPaths.service}`,
                    ),
                  );
                }
              }
            }
            if (
              (artifact._tag === "Right" && artifact.right.candidate) ||
              (instance._tag === "Right" && instance.right.candidate)
            ) {
              checks.push(
                check("candidate", "orphaned", "candidate artifact or unit remains present"),
              );
            }
          }

          const healthResult = yield* probe(health.check(info, stage));
          checks.push(
            healthResult._tag === "Left"
              ? check(
                  "service-health",
                  healthFailureState(healthResult.left),
                  String(healthResult.left),
                )
              : check("service-health", "healthy", "health check passed"),
          );

          checks.push(
            routeResult._tag === "Left"
              ? check("caddy-stage-snippet", "probe-error", String(routeResult.left))
              : routes.some((item) => item.file === names.stageSnippet)
                ? check("caddy-stage-snippet", "healthy", `${names.stageSnippet} present`)
                : check("caddy-stage-snippet", "missing", `${names.stageSnippet} missing`),
          );
          if (value.promoted === stage) {
            checks.push(
              routeResult._tag === "Left"
                ? check("caddy-production-snippet", "probe-error", String(routeResult.left))
                : routes.some((item) => item.file === names.productionSnippet)
                  ? check(
                      "caddy-production-snippet",
                      "healthy",
                      `${names.productionSnippet} present`,
                    )
                  : check(
                      "caddy-production-snippet",
                      "missing",
                      `${names.productionSnippet} missing`,
                    ),
            );
          }
          stages.push(stageReport(project, stage, info, checks));
        }
        projects.push({
          project,
          status: worstState(stages.map((item) => item.status)),
          stages,
          checks: [],
        });
      }
    }

    const orphanedRoutes = routes.filter(
      (route) => isManagedSnippet(route.file) && !expectedSnippets.has(route.file),
    );
    if (orphanedRoutes.length > 0) {
      globalChecks.push(
        check(
          "caddy-orphans",
          "orphaned",
          `${orphanedRoutes.length} managed snippet(s) are orphaned`,
        ),
      );
    }

    return aggregateReport(projects, globalChecks);
  });
});

export class OperationalReportService extends Effect.Service<OperationalReportService>()(
  "infra/OperationalReport",
  {
    effect: makeOperationalReport,
    dependencies: [
      DeployMeta.Default,
      DeploymentComponents.Default,
      HealthCheck.Default,
      CaddyManager.Default,
    ],
  },
) {}
