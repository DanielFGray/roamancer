import { Effect, Schema as S, Schedule } from "effect";
import { SshClient } from "./SshClient.ts";
import type { StageInfo } from "./DeployMeta.ts";
import { DEPLOYMENT_ROOTS, SVC_USER } from "../lib/config.ts";
import { deploymentPaths } from "../lib/deployment.ts";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class HealthCheckError extends S.TaggedError<HealthCheckError>()("HealthCheckError", {
  stage: S.String,
  reason: S.String,
}) {
  override get message() {
    return `Health check failed for stage "${this.stage}": ${this.reason}`;
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const DEFAULT_PATH = "/health";
const MAX_RETRIES = 2; // 3 attempts total (1 + 2 retries)
const RETRY_DELAY_MS = 1000;

/**
 * Health check via SSH + curl on the remote host.
 * This works even when the service binds to 127.0.0.1 and the port
 * is not exposed through the firewall.
 */
const httpCheck = (ssh: SshClient, info: StageInfo, stage: string) => {
  const path = info.healthcheck_path ?? DEFAULT_PATH;
  const url = `http://localhost:${info.port}${path}`;

  return ssh.exec(info.host, `curl -sf --max-time 5 ${url}`, SVC_USER).pipe(
    Effect.asVoid,
    Effect.mapError(
      (err) =>
        new HealthCheckError({
          stage,
          reason: `GET ${url} on ${info.host} failed: ${err instanceof Error ? err.message : String(err)}`,
        }),
    ),
    Effect.retry(Schedule.addDelay(Schedule.recurs(MAX_RETRIES), () => `${RETRY_DELAY_MS} millis`)),
  );
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class HealthCheck extends Effect.Service<HealthCheck>()("infra/HealthCheck", {
  effect: Effect.gen(function* () {
    // Pre-resolve SshClient so staticCheck can use it
    const ssh = yield* SshClient;

    return {
      check: (info: StageInfo, stage: string) => {
        if (info.type === "service") {
          if (info.port === null) {
            return Effect.fail(
              new HealthCheckError({
                stage,
                reason: "Service stage has no port assigned",
              }),
            );
          }
          return httpCheck(ssh, info, stage);
        }

        // Static: use pre-resolved ssh
        const dir = deploymentPaths(info.domain, stage, DEPLOYMENT_ROOTS).staticFiles;
        const cmd = `test -d ${dir} && test "$(ls -A ${dir})"`;

        return ssh.exec(info.host, cmd, SVC_USER).pipe(
          Effect.mapError(
            () =>
              new HealthCheckError({
                stage,
                reason: `Stage directory missing or empty: ${dir}`,
              }),
          ),
          Effect.asVoid,
        );
      },
    };
  }),
  dependencies: [SshClient.Default],
}) {}
