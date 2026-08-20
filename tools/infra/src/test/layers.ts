import { Effect, Layer } from "effect";
import * as FileSystem from "@effect/platform/FileSystem";
import * as Path from "@effect/platform/Path";
import * as HttpClientError from "@effect/platform/HttpClientError";
import * as HttpClientRequest from "@effect/platform/HttpClientRequest";
import { CaddyError, CaddyManager } from "../services/CaddyManager.ts";
import { DeployMeta, DeployMetaError, type ProjectMeta } from "../services/DeployMeta.ts";
import { GitManager } from "../services/GitManager.ts";
import { HealthCheck } from "../services/HealthCheck.ts";
import { HealthCheckError } from "../services/HealthCheck.ts";
import { OpenBaoClient, type OpenBaoClientShape } from "../services/OpenBaoClient.ts";
import { SshClient, SshError } from "../services/SshClient.ts";
import { SystemdManager } from "../services/SystemdManager.ts";

export interface TestCalls {
  readonly ssh: Array<{ host: string; command: string }>;
  readonly git: Array<string>;
  readonly systemd: Array<{ action: string; host: string; unit: string }>;
  readonly events: Array<string>;
}

export interface TestServices {
  readonly calls: TestCalls;
  readonly projects: Map<string, ProjectMeta>;
  readonly files: Map<string, string>;
  readonly openBao: Map<string, Record<string, string>>;
  healthError?: HealthCheckError;
  failSshCommand?: string;
  failSystemdAction?: string;
  failCaddySync?: boolean;
  failOpenBaoPut?: boolean;
  failMetaSave?: boolean;
  failMetaDelete?: boolean;
  failBuild?: string;
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
export const testLayers = (state: TestServices = makeTestServices()) => {
  const ssh = Layer.succeed(SshClient, {
    _tag: "infra/SshClient",
    exec: (host, command) => {
      state.calls.ssh.push({ host, command });
      if (state.failSshCommand && command.includes(state.failSshCommand)) {
        return Effect.fail(new SshError({ code: 1, signal: null, message: `failed: ${command}` }));
      }
      return command.includes("printf '%s'")
        ? Effect.succeed(state.staticHadPrevious ? "1" : "0")
        : Effect.succeed("");
    },
    writeFile: (host, remotePath, content) => {
      state.calls.ssh.push({ host, command: `write ${remotePath}` });
      state.files.set(remotePath, content);
      return Effect.as(Effect.void, undefined);
    },
    execInteractive: (host, command) => {
      state.calls.ssh.push({ host, command });
      return Effect.as(Effect.void, undefined);
    },
    rsync: (source, destination, host) => {
      state.calls.ssh.push({ host, command: `rsync ${source} ${destination}` });
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
    allocatePort: () => Effect.succeed(state.nextPort ?? 3001),
  });

  const systemd = Layer.succeed(SystemdManager, {
    _tag: "infra/SystemdManager",
    install: (host, unit) =>
      Effect.sync(() => {
        state.calls.systemd.push({ action: "install", host, unit });
      }).pipe(
        Effect.flatMap(() =>
          state.failSystemdAction === "install"
            ? Effect.fail(new SshError({ code: 1, signal: null, message: "install failed" }))
            : Effect.void,
        ),
      ),
    start: (host, unit) =>
      Effect.sync(() => {
        state.calls.systemd.push({ action: "start", host, unit });
      }).pipe(
        Effect.flatMap(() =>
          state.failSystemdAction === "start"
            ? Effect.fail(new SshError({ code: 1, signal: null, message: "start failed" }))
            : Effect.void,
        ),
      ),
    stop: (host, unit) =>
      Effect.sync(() => {
        state.calls.systemd.push({ action: "stop", host, unit });
      }),
    remove: (host, unit) =>
      Effect.sync(() => {
        state.calls.systemd.push({ action: "remove", host, unit });
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
      return state.healthError ? Effect.fail(state.healthError) : Effect.void;
    },
  });
  const caddy = Layer.succeed(CaddyManager, {
    _tag: "infra/CaddyManager",
    listRoutes: () => Effect.succeed([]),
    sync: () => {
      state.calls.events.push("caddy.sync");
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
  };

  const fs = FileSystem.layerNoop({
    exists: (path) => Effect.succeed(state.files.has(path)),
    readFileString: (path) => Effect.succeed(state.files.get(path) ?? ""),
    writeFileString: (path, content) =>
      Effect.sync(() => {
        state.files.set(path, content);
      }),
    readDirectory: (directory) =>
      Effect.succeed(
        [...state.files.keys()]
          .filter((path) => path.startsWith(`${directory}/`))
          .map((path) => path.slice(directory.length + 1)),
      ),
    remove: (path) =>
      Effect.sync(() => {
        state.files.delete(path);
      }),
  });

  return Layer.mergeAll(
    ssh,
    git,
    meta,
    systemd,
    health,
    caddy,
    Layer.succeed(OpenBaoClient, openBao),
    fs,
    Path.layer,
  );
};

export const makeTestServices = (): TestServices => ({
  calls: { ssh: [], git: [], systemd: [], events: [] },
  projects: new Map(),
  files: new Map(),
  openBao: new Map(),
});

export const seedProject = (state: TestServices, name: string, project?: Partial<ProjectMeta>) => {
  state.projects.set(name, { ...emptyMeta(name), ...project });
  return state;
};
