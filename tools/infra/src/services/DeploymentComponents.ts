import { Console, Effect } from "effect";
import * as FileSystem from "@effect/platform/FileSystem";
import * as Path from "@effect/platform/Path";
import { BunContext } from "@effect/platform-bun";
import { OpenBaoClient } from "./OpenBaoClient.ts";
import { SecretResolver } from "./SecretResolver.ts";
import { SshClient } from "./SshClient.ts";
import { SystemdManager } from "./SystemdManager.ts";
import { formatEnv, parseEnvExample } from "../lib/env-parser.ts";
import { DEPLOYMENT_ROOTS, HOME_DIR, SVC_USER } from "../lib/config.ts";
import { deploymentNames, deploymentPaths } from "../lib/deployment.ts";

export type ServiceTarget = "final" | "candidate";
export type StaticTarget = "final" | "candidate";

const servicePath = (name: string, stage: string, target: ServiceTarget) => {
  const paths = deploymentPaths(name, stage, DEPLOYMENT_ROOTS);
  return target === "final" ? paths.service : paths.serviceCandidate;
};

const serviceUnit = (name: string, stage: string, target: ServiceTarget) => {
  const names = deploymentNames(name, stage);
  return target === "final" ? names.serviceUnit : names.candidateUnit;
};

const shellPath = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const marker = (output: string, name: string) =>
  output.match(new RegExp(`(?:^|\\n)${name}=([^\\n]*)`))?.[1] ?? "";

const markerNumber = (output: string, name: string) => {
  const value = marker(output, name);
  return value === "" ? null : Number(value);
};

export const makeDeploymentComponents = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const bao = yield* OpenBaoClient;
  const resolver = yield* SecretResolver;
  const ssh = yield* SshClient;
  const systemd = yield* SystemdManager;

  return {
    secrets: {
      resolve: Effect.fnUntraced(function* (name: string, worktreePath: string) {
        const envPath = path.join(worktreePath, ".env.example");
        if (!(yield* fs.exists(envPath))) return {} as Record<string, string>;

        const fields = parseEnvExample(yield* fs.readFileString(envPath));
        if (fields.length === 0) return {} as Record<string, string>;

        const existing = yield* bao.kvGet(name).pipe(Effect.orElseSucceed(() => null));
        if (existing && Object.keys(existing).length > 0) {
          yield* Console.log("  secrets: using vault values");
          return existing;
        }

        yield* Console.log("  secrets: seeding to vault...");
        const resolved = yield* resolver.resolve(fields);
        yield* bao.kvPut(name, resolved);
        return resolved;
      }),
    },

    staticArtifacts: {
      inspect: Effect.fnUntraced(function* (input: {
        stage: string;
        domain: string;
        host: string;
      }) {
        const paths = deploymentPaths(input.domain, input.stage, DEPLOYMENT_ROOTS);
        const result = yield* ssh.exec(
          input.host,
          `printf 'candidate=%s\\n' $(test -e ${shellPath(paths.staticFilesCandidate)} && printf 1 || printf 0); ` +
            `printf 'final=%s\\n' $(test -e ${shellPath(paths.staticFiles)} && printf 1 || printf 0)`,
          SVC_USER,
        );
        return {
          candidate: result.includes("candidate=1"),
          final: result.includes("final=1"),
        };
      }),
      publish: Effect.fnUntraced(function* (input: {
        stage: string;
        domain: string;
        host: string;
        worktreePath: string;
        dist: string;
        target: StaticTarget;
      }) {
        const paths = deploymentPaths(input.domain, input.stage, DEPLOYMENT_ROOTS);
        const remotePath =
          input.target === "final" ? paths.staticFiles : paths.staticFilesCandidate;
        yield* ssh.exec(input.host, `mkdir -p ${shellPath(remotePath)}`, SVC_USER);
        // Build output is created locally under the agent's own UMask=0077,
        // so rsync -a would faithfully preserve owner-only permissions all
        // the way to the served directory -- override them explicitly, since
        // these files must stay world-readable for Caddy's file_server.
        yield* ssh.rsync(
          `${input.worktreePath}/${input.dist}/`,
          remotePath,
          input.host,
          SVC_USER,
          "D755,F644",
        );
      }),

      remove: Effect.fnUntraced(function* (input: {
        stage: string;
        domain: string;
        host: string;
        target: StaticTarget;
      }) {
        const paths = deploymentPaths(input.domain, input.stage, DEPLOYMENT_ROOTS);
        const remotePath =
          input.target === "final" ? paths.staticFiles : paths.staticFilesCandidate;
        yield* ssh.exec(input.host, `rm -rf ${shellPath(remotePath)}`, SVC_USER);
      }),

      activate: Effect.fnUntraced(function* (input: {
        stage: string;
        domain: string;
        host: string;
      }) {
        const paths = deploymentPaths(input.domain, input.stage, DEPLOYMENT_ROOTS);
        const result = yield* ssh.exec(
          input.host,
          `rm -rf ${shellPath(paths.staticFilesBackup)} && ` +
            `if [ -e ${shellPath(paths.staticFiles)} ]; then ` +
            `mv ${shellPath(paths.staticFiles)} ${shellPath(paths.staticFilesBackup)} && ` +
            `previous=1; else previous=0; fi && ` +
            `if mv ${shellPath(paths.staticFilesCandidate)} ${shellPath(paths.staticFiles)}; then ` +
            `printf '%s' "$previous"; else ` +
            `if [ "$previous" = 1 ]; then ` +
            `rm -rf ${shellPath(paths.staticFiles)} && ` +
            `mv ${shellPath(paths.staticFilesBackup)} ${shellPath(paths.staticFiles)}; fi; ` +
            `exit 1; fi`,
          SVC_USER,
        );
        return result.trim() === "1";
      }),

      rollback: Effect.fnUntraced(function* (input: {
        stage: string;
        domain: string;
        host: string;
        hadPrevious: boolean;
      }) {
        const paths = deploymentPaths(input.domain, input.stage, DEPLOYMENT_ROOTS);
        const restore = input.hadPrevious
          ? `if [ -e ${shellPath(paths.staticFilesBackup)} ]; then ` +
            `rm -rf ${shellPath(paths.staticFiles)} && ` +
            `mv ${shellPath(paths.staticFilesBackup)} ${shellPath(paths.staticFiles)}; fi`
          : `rm -rf ${shellPath(paths.staticFiles)}`;
        yield* ssh.exec(
          input.host,
          `${restore} && rm -rf ${shellPath(paths.staticFilesCandidate)} ` +
            `&& rm -rf ${shellPath(paths.staticFilesBackup)}`,
          SVC_USER,
        );
      }),

      complete: Effect.fnUntraced(function* (input: {
        stage: string;
        domain: string;
        host: string;
      }) {
        const paths = deploymentPaths(input.domain, input.stage, DEPLOYMENT_ROOTS);
        yield* ssh.exec(input.host, `rm -rf ${shellPath(paths.staticFilesBackup)}`, SVC_USER);
      }),

      removeBackup: Effect.fnUntraced(function* (input: {
        stage: string;
        domain: string;
        host: string;
      }) {
        const paths = deploymentPaths(input.domain, input.stage, DEPLOYMENT_ROOTS);
        yield* ssh.exec(input.host, `rm -rf ${shellPath(paths.staticFilesBackup)}`, SVC_USER);
      }),
    },

    serviceArtifacts: {
      inspect: Effect.fnUntraced(function* (input: { name: string; stage: string; host: string }) {
        const candidate = servicePath(input.name, input.stage, "candidate");
        const final = servicePath(input.name, input.stage, "final");
        const result = yield* ssh.exec(
          input.host,
          `printf 'candidate=%s\\n' $(test -e ${shellPath(candidate)} && printf 1 || printf 0); ` +
            `printf 'final=%s\\n' $(test -e ${shellPath(final)} && printf 1 || printf 0); ` +
            `printf 'candidatePort=%s\\n' "$(test -e ${shellPath(`${candidate}/.env`)} && sed -n 's/^PORT=//p' ${shellPath(`${candidate}/.env`)} || true)"; ` +
            `printf 'finalPort=%s\\n' "$(test -e ${shellPath(`${final}/.env`)} && sed -n 's/^PORT=//p' ${shellPath(`${final}/.env`)} || true)"`,
          SVC_USER,
        );
        return {
          candidate: result.includes("candidate=1"),
          final: result.includes("final=1"),
          candidatePort: markerNumber(result, "candidatePort"),
          finalPort: markerNumber(result, "finalPort"),
        };
      }),

      publish: Effect.fnUntraced(function* (input: {
        name: string;
        stage: string;
        host: string;
        worktreePath: string;
        target: ServiceTarget;
        secrets: Readonly<Record<string, string>>;
        port: number;
      }) {
        const remotePath = servicePath(input.name, input.stage, input.target);
        yield* ssh.exec(input.host, `mkdir -p ${remotePath}`, SVC_USER);
        yield* ssh.rsync(`${input.worktreePath}/`, remotePath, input.host, SVC_USER);
        yield* ssh.writeFile(
          input.host,
          `${remotePath}/.env`,
          formatEnv({
            ...input.secrets,
            PORT: String(input.port),
          }),
          { mode: "600", user: SVC_USER },
        );
        yield* ssh.exec(input.host, `cd ${remotePath} && bun install --frozen-lockfile`, SVC_USER);
      }),

      remove: Effect.fnUntraced(function* (input: {
        name: string;
        stage: string;
        host: string;
        target: ServiceTarget;
      }) {
        yield* ssh.exec(
          input.host,
          `rm -rf ${servicePath(input.name, input.stage, input.target)}`,
          SVC_USER,
        );
      }),

      finalize: Effect.fnUntraced(function* (input: { name: string; stage: string; host: string }) {
        const candidate = servicePath(input.name, input.stage, "candidate");
        const final = servicePath(input.name, input.stage, "final");
        yield* ssh.exec(
          input.host,
          `if [ -e ${shellPath(candidate)} ]; then rm -rf ${shellPath(final)} && mv ${shellPath(candidate)} ${shellPath(final)}; fi`,
          SVC_USER,
        );
      }),
    },

    serviceInstances: {
      inspect: Effect.fnUntraced(function* (input: { name: string; stage: string; host: string }) {
        const names = deploymentNames(input.name, input.stage);
        const unitDir = `/home/${SVC_USER}/.config/systemd/user`;
        const candidateUnitFile = `${unitDir}/${names.candidateUnit}.service`;
        const finalUnitFile = `${unitDir}/${names.serviceUnit}.service`;
        const result = yield* ssh.exec(
          input.host,
          `printf 'candidate=%s\\n' $(test -f ${shellPath(candidateUnitFile)} && printf 1 || printf 0); ` +
            `printf 'final=%s\\n' $(test -f ${shellPath(finalUnitFile)} && printf 1 || printf 0); ` +
            `printf 'candidateWorking=%s\\n' "$(sed -n 's/^WorkingDirectory=//p' ${shellPath(candidateUnitFile)} 2>/dev/null || true)"; ` +
            `printf 'finalWorking=%s\\n' "$(sed -n 's/^WorkingDirectory=//p' ${shellPath(finalUnitFile)} 2>/dev/null || true)"; ` +
            `printf 'candidateActive=%s\\n' "$(XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user is-active ${shellPath(names.candidateUnit)} 2>/dev/null || true)"; ` +
            `printf 'finalActive=%s\\n' "$(XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user is-active ${shellPath(names.serviceUnit)} 2>/dev/null || true)"`,
          SVC_USER,
        );
        return {
          candidate: result.includes("candidate=1"),
          final: result.includes("final=1"),
          candidateWorkingDirectory: marker(result, "candidateWorking") || null,
          finalWorkingDirectory: marker(result, "finalWorking") || null,
          candidateActive: marker(result, "candidateActive") === "active",
          finalActive: marker(result, "finalActive") === "active",
        };
      }),

      install: Effect.fnUntraced(function* (input: {
        name: string;
        stage: string;
        host: string;
        target: ServiceTarget;
      }) {
        const unit = serviceUnit(input.name, input.stage, input.target);
        const workingDirectory = servicePath(input.name, input.stage, input.target);
        yield* systemd.install(input.host, unit, {
          description: `${input.name} (${input.stage})${input.target === "candidate" ? " [new]" : ""}`,
          workingDirectory,
          // systemd --user units get a minimal PATH with no ~/.bun/bin --
          // there's no environment.d entry for it, so "env bun" can't resolve.
          execStart: `${HOME_DIR}/.bun/bin/bun run start`,
        });
      }),

      start: (input: { name: string; stage: string; host: string; target: ServiceTarget }) =>
        systemd.start(input.host, serviceUnit(input.name, input.stage, input.target)),

      stop: (input: { name: string; stage: string; host: string; target: ServiceTarget }) =>
        systemd.stop(input.host, serviceUnit(input.name, input.stage, input.target)),

      remove: (input: { name: string; stage: string; host: string; target: ServiceTarget }) =>
        systemd.remove(input.host, serviceUnit(input.name, input.stage, input.target)),
    },
  };
});

export class DeploymentComponents extends Effect.Service<DeploymentComponents>()(
  "infra/DeploymentComponents",
  {
    effect: makeDeploymentComponents,
    dependencies: [
      SecretResolver.Default,
      SshClient.Default,
      SystemdManager.Default,
      BunContext.layer,
      Path.layer,
    ],
  },
) {}
