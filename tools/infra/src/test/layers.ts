import { Effect, Layer } from "effect";
import * as FileSystem from "@effect/platform/FileSystem";
import * as Path from "@effect/platform/Path";
import * as PlatformError from "@effect/platform/Error";
import * as HttpClientError from "@effect/platform/HttpClientError";
import * as HttpClientRequest from "@effect/platform/HttpClientRequest";
import { CaddyError, CaddyManager } from "../services/CaddyManager.ts";
import { DeployMeta, DeployMetaError, type ProjectMeta } from "../services/DeployMeta.ts";
import { GitManager } from "../services/GitManager.ts";
import { HealthCheck } from "../services/HealthCheck.ts";
import { HealthCheckError } from "../services/HealthCheck.ts";
import {
  OpenBaoClient,
  BackupsOpenBaoClient,
  type OpenBaoClientShape,
} from "../services/OpenBaoClient.ts";
import { SshClient, SshError } from "../services/SshClient.ts";
import { SystemdManager } from "../services/SystemdManager.ts";
import { deploymentPaths } from "../lib/deployment.ts";

export interface TestCalls {
  readonly ssh: Array<{ host: string; command: string }>;
  readonly git: Array<string>;
  readonly systemd: Array<{ action: string; host: string; unit: string }>;
  readonly events: Array<string>;
  readonly allocations: Array<number>;
  readonly trace: Array<string>;
}

export interface TestServices {
  readonly calls: TestCalls;
  readonly projects: Map<string, ProjectMeta>;
  readonly files: Map<string, string>;
  readonly fileModes: Map<string, number>;
  readonly openBao: Map<string, Record<string, string>>;
  healthError?: HealthCheckError;
  failSshCommand?: string;
  failSystemdAction?: string;
  failCaddySync?: boolean;
  failCaddyRoutes?: boolean;
  caddyRoutes?: ReadonlyArray<{ file: string; content: string }>;
  failOpenBaoPut?: boolean;
  failMetaSave?: boolean;
  failMetaDelete?: boolean;
  failBuild?: string;
  failSystemdInstallUnit?: string;
  failSystemdRemoveUnit?: string;
  failSystemdStartUnit?: string;
  candidateArtifact?: boolean;
  candidatePort?: number;
  finalArtifact?: boolean;
  finalPort?: number;
  candidateUnit?: boolean;
  candidateWorkingDirectory?: string;
  candidateActive?: boolean;
  finalUnit?: boolean;
  finalWorkingDirectory?: string;
  finalActive?: boolean;
  staticCandidateArtifact?: boolean;
  staticFinalArtifact?: boolean;
  staticHadPrevious?: boolean;
  nextPort?: number;
}

const emptyMeta = (name: string): ProjectMeta => ({
  repo: name,
  promoted: null,
  promoted_previous: null,
  stages: {},
});

/** Test replacements for every external deployment boundary. */
export const testLayers = (
  state: TestServices = makeTestServices(),
  caddyOverride?: Layer.Layer<CaddyManager>,
) => {
  const ssh = Layer.succeed(SshClient, {
    _tag: "infra/SshClient",
    exec: (host, command) => {
      state.calls.ssh.push({ host, command });
      if (command.includes("candidatePort")) state.calls.trace.push("artifact.inspect");
      if (command.includes("if [ -e '/srv/projects/demo/stages/main.new'")) {
        state.calls.trace.push("artifact.finalize");
      }
      if (command === "rm -rf /srv/projects/demo/stages/main.new") {
        state.calls.trace.push("artifact.remove.candidate");
      }
      if (state.failSshCommand && command.includes(state.failSshCommand)) {
        return Effect.fail(new SshError({ code: 1, signal: null, message: `failed: ${command}` }));
      }
      if (command.includes("mkdir -p /srv/projects/demo/stages/main.new"))
        state.candidateArtifact = true;
      if (command.includes("mkdir -p /srv/www/demo/stages/main.new"))
        state.staticCandidateArtifact = true;
      if (command === "rm -rf /srv/projects/demo/stages/main.new") state.candidateArtifact = false;
      if (command === "rm -rf '/srv/www/demo/stages/main.new'")
        state.staticCandidateArtifact = false;
      if (
        command.includes("mv '/srv/projects/demo/stages/main.new' '/srv/projects/demo/stages/main'")
      ) {
        state.candidateArtifact = false;
        state.finalArtifact = true;
        if (state.candidatePort !== undefined) state.finalPort = state.candidatePort;
      }
      if (command === "rm -rf /srv/projects/demo/stages/main") state.finalArtifact = false;
      if (command === "rm -rf '/srv/www/demo/stages/main'") state.staticFinalArtifact = false;
      if (
        command.includes("/srv/www/demo/stages/main.new") &&
        command.includes("/srv/www/demo/stages/main")
      ) {
        state.staticCandidateArtifact = false;
        state.staticFinalArtifact = true;
      }
      if (
        command.includes("mv '/srv/www/demo/stages/main' '/srv/www/demo/stages/main.previous'") &&
        !command.includes("main.new")
      )
        state.staticFinalArtifact = false;
      if (command.includes("candidateWorking")) {
        return Effect.succeed(
          `candidate=${state.candidateUnit ? 1 : 0}\nfinal=${state.finalUnit ? 1 : 0}\n` +
            `candidateWorking=${state.candidateWorkingDirectory ?? ""}\n` +
            `finalWorking=${state.finalWorkingDirectory ?? ""}\n` +
            `candidateActive=${state.candidateActive ? "active" : "inactive"}\n` +
            `finalActive=${state.finalActive ? "active" : "inactive"}`,
        );
      }
      if (command.includes("printf 'candidate=%s")) {
        const units = command.includes(".config/systemd/user");
        const candidate = units
          ? (state.candidateUnit ?? false)
          : (state.candidateArtifact ?? false);
        const final = units ? (state.finalUnit ?? false) : (state.finalArtifact ?? false);
        if (command.includes("candidatePort")) {
          return Effect.succeed(
            `candidate=${candidate ? 1 : 0}\nfinal=${final ? 1 : 0}\n` +
              `candidatePort=${state.candidatePort ?? ""}\nfinalPort=${state.finalPort ?? ""}`,
          );
        }
        if (command.includes("/srv/www/demo/stages/main.new")) {
          return Effect.succeed(
            `candidate=${state.staticCandidateArtifact ? 1 : 0}\nfinal=${state.staticFinalArtifact ? 1 : 0}`,
          );
        }
        return Effect.succeed(`candidate=${candidate ? 1 : 0}\nfinal=${final ? 1 : 0}`);
      }
      return command.includes("printf '%s'")
        ? Effect.succeed(state.staticHadPrevious ? "1" : "0")
        : Effect.succeed("");
    },
    writeFile: (host, remotePath, content) => {
      state.calls.ssh.push({ host, command: `write ${remotePath}` });
      state.files.set(remotePath, content);
      if (remotePath === "/srv/www/demo/stages/main.new") state.staticCandidateArtifact = true;
      if (remotePath === "/srv/www/demo/stages/main") state.staticFinalArtifact = true;
      const port = content.match(/^PORT=(\d+)$/m)?.[1];
      if (remotePath.endsWith("/main.new/.env") && port) state.candidatePort = Number(port);
      if (remotePath.endsWith("/main/.env") && port) state.finalPort = Number(port);
      return Effect.as(Effect.void, undefined);
    },
    execInteractive: (host, command) => {
      state.calls.ssh.push({ host, command });
      return Effect.as(Effect.void, undefined);
    },
    rsync: (source, destination, host) => {
      state.calls.ssh.push({ host, command: `rsync ${source} ${destination}` });
      if (destination === "/srv/www/demo/stages/main.new") state.staticCandidateArtifact = true;
      if (destination === "/srv/www/demo/stages/main") state.staticFinalArtifact = true;
      return state.failSshCommand && `rsync ${source} ${destination}`.includes(state.failSshCommand)
        ? Effect.fail(new SshError({ code: 1, signal: null, message: "rsync failed" }))
        : Effect.as(Effect.void, undefined);
    },
  });

  const git = Layer.succeed(GitManager, {
    _tag: "infra/GitManager",
    repository: {
      ensure: (name) =>
        Effect.sync(() => {
          state.calls.git.push(`ensureRepo ${name}`);
        }),
      fetch: (name) =>
        Effect.sync(() => {
          state.calls.git.push(`fetch ${name}`);
        }),
      resolveRef: (_name, ref) => Effect.succeed(`hash-${ref}`),
      defaultBranch: () => Effect.succeed("main"),
    },
    worktrees: {
      add: (name, stage) =>
        Effect.sync(() => {
          state.calls.git.push(`addWorktree ${name} ${stage}`);
          return `/test/worktrees/${name}/${stage}`;
        }),
      remove: (name, stage) =>
        Effect.sync(() => {
          state.calls.git.push(`removeWorktree ${name} ${stage}`);
        }),
    },
  });

  const meta = Layer.succeed(DeployMeta, {
    _tag: "infra/DeployMeta",
    getProject: (name) => Effect.succeed(state.projects.get(name) ?? null),
    saveProject: (name, project) =>
      state.failMetaSave
        ? Effect.fail(new DeployMetaError({ message: "metadata save failed" }))
        : Effect.sync(() => {
            state.calls.events.push("metadata.save");
            state.projects.set(name, project);
          }),
    listProjects: () => Effect.succeed([...state.projects.keys()]),
    deleteProject: (name) =>
      state.failMetaDelete
        ? Effect.fail(new DeployMetaError({ message: "metadata delete failed" }))
        : Effect.sync(() => {
            state.projects.delete(name);
          }),
    allocatePort: () =>
      Effect.sync(() => {
        const port = state.nextPort ?? 3001;
        state.calls.allocations.push(port);
        return port;
      }),
  });

  const systemd = Layer.succeed(SystemdManager, {
    _tag: "infra/SystemdManager",
    install: (host, unit) =>
      Effect.gen(function* () {
        state.calls.systemd.push({ action: "install", host, unit });
        state.calls.trace.push(`systemd.install.${unit}`);
        if (state.failSystemdAction === "install" || state.failSystemdInstallUnit === unit) {
          return yield* new SshError({ code: 1, signal: null, message: "install failed" });
        }
        if (unit === "infra-demo-main-new") state.candidateUnit = true;
        if (unit === "infra-demo-main-new") {
          state.candidateWorkingDirectory = "/srv/projects/demo/stages/main.new";
        }
        if (unit === "infra-demo-main") {
          state.finalUnit = true;
          state.finalWorkingDirectory = "/srv/projects/demo/stages/main";
        }
      }),
    start: (host, unit) =>
      Effect.sync(() => {
        state.calls.systemd.push({ action: "start", host, unit });
        state.calls.trace.push(`systemd.start.${unit}`);
      }).pipe(
        Effect.flatMap(() =>
          state.failSystemdAction === "start" || state.failSystemdStartUnit === unit
            ? Effect.fail(new SshError({ code: 1, signal: null, message: "start failed" }))
            : Effect.sync(() => {
                if (unit === "infra-demo-main-new") state.candidateActive = true;
                if (unit === "infra-demo-main") state.finalActive = true;
              }),
        ),
      ),
    stop: (host, unit) =>
      Effect.sync(() => {
        state.calls.systemd.push({ action: "stop", host, unit });
        state.calls.trace.push(`systemd.stop.${unit}`);
        if (unit === "infra-demo-main-new") state.candidateActive = false;
        if (unit === "infra-demo-main") state.finalActive = false;
      }),
    remove: (host, unit) =>
      Effect.gen(function* () {
        state.calls.systemd.push({ action: "remove", host, unit });
        state.calls.trace.push(`systemd.remove.${unit}`);
        if (state.failSystemdRemoveUnit === unit) {
          return yield* new SshError({ code: 1, signal: null, message: "remove failed" });
        }
        if (unit === "infra-demo-main-new") state.candidateUnit = false;
        if (unit === "infra-demo-main") state.finalUnit = false;
      }),
    status: (host, unit) =>
      Effect.sync(() => {
        state.calls.systemd.push({ action: "status", host, unit });
        return "inactive";
      }),
  });

  const health = Layer.succeed(HealthCheck, {
    _tag: "infra/HealthCheck",
    check: (_info, stage) => {
      state.calls.events.push(`health.check:${stage}`);
      state.calls.trace.push(`health.check:${stage}`);
      return state.healthError ? Effect.fail(state.healthError) : Effect.void;
    },
  });
  const caddy = Layer.succeed(CaddyManager, {
    _tag: "infra/CaddyManager",
    listRoutes: () =>
      state.failCaddyRoutes
        ? Effect.fail(new CaddyError({ message: "route inspection failed" }))
        : Effect.succeed([...(state.caddyRoutes ?? [])]),
    sync: () => {
      state.calls.events.push("caddy.sync");
      state.calls.trace.push("caddy.sync");
      return state.failCaddySync
        ? Effect.fail(new CaddyError({ message: "caddy sync failed" }))
        : Effect.void;
    },
  });
  const openBao: OpenBaoClientShape = {
    init: () => Effect.succeed({ unsealKeys: ["test-key"], rootToken: "test-token" }),
    unseal: () => Effect.void,
    enableSecretsEngine: () => Effect.void,
    kvPut: (path, data) =>
      state.failOpenBaoPut
        ? Effect.fail(
            new HttpClientError.RequestError({
              request: HttpClientRequest.put(`https://openbao.test/v1/secret/data/${path}`),
              reason: "Transport",
              description: "OpenBao seed failed",
            }),
          )
        : Effect.sync(() => {
            state.openBao.set(path, data);
          }),
    kvGet: (path) => Effect.succeed(state.openBao.get(path) ?? {}),
    kvList: () => Effect.succeed([]),
    createPolicy: () => Effect.void,
    write: (_path, data) => Effect.succeed(data),
    sealStatus: () => Effect.succeed({ sealed: false, initialized: true }),
    renewSelf: () => Effect.succeed({ leaseDurationSeconds: 3600 }),
  };

  const fs = FileSystem.layerNoop({
    exists: (path) => Effect.succeed(state.files.has(path)),
    readFileString: (path) => Effect.succeed(state.files.get(path) ?? ""),
    writeFileString: (path, content) =>
      Effect.sync(() => {
        state.files.set(path, content);
        state.fileModes.set(path, 0o600);
      }),
    chmod: (path, mode) =>
      state.files.has(path)
        ? Effect.sync(() => {
            state.fileModes.set(path, mode);
          })
        : Effect.fail(
            new PlatformError.SystemError({
              module: "FileSystem",
              method: "chmod",
              reason: "NotFound",
              pathOrDescriptor: path,
            }),
          ),
    readDirectory: (directory) =>
      Effect.succeed(
        [...state.files.keys()]
          .filter((path) => path.startsWith(`${directory}/`))
          .map((path) => path.slice(directory.length + 1)),
      ),
    remove: (path) =>
      Effect.sync(() => {
        state.files.delete(path);
        state.fileModes.delete(path);
      }),
  });

  return Layer.mergeAll(
    ssh,
    git,
    meta,
    systemd,
    health,
    caddyOverride ?? caddy,
    Layer.succeed(OpenBaoClient, openBao),
    Layer.succeed(BackupsOpenBaoClient, openBao),
    fs,
    Path.layer,
  );
};

export const makeTestServices = (): TestServices => ({
  calls: { ssh: [], git: [], systemd: [], events: [], allocations: [], trace: [] },
  projects: new Map(),
  files: new Map(),
  fileModes: new Map(),
  openBao: new Map(),
});

export const seedProject = (state: TestServices, name: string, project?: Partial<ProjectMeta>) => {
  const value = { ...emptyMeta(name), ...project };
  state.projects.set(name, value);
  if (value.stages.main?.type === "service") {
    state.finalArtifact = true;
    if (value.stages.main.port !== null) state.finalPort = value.stages.main.port;
    state.finalUnit = true;
    state.finalWorkingDirectory = deploymentPaths(name, "main").service;
    state.finalActive = true;
  }
  return state;
};
