import { Effect } from "effect";
import { SshClient } from "./SshClient.ts";
import { SVC_USER } from "../lib/config.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface UnitConfig {
  readonly description: string;
  readonly workingDirectory: string;
  readonly execStart: string;
  readonly environment?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UNIT_DIR = `/home/${SVC_USER}/.config/systemd/user`;

/** Prefix required for systemctl --user to work over SSH */
const SYSTEMCTL = "XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user";

const renderUnit = (config: UnitConfig): string => {
  const envLines = config.environment
    ? Object.entries(config.environment)
        .map(([k, v]) => `Environment="${k}=${v}"`)
        .join("\n")
    : "";

  return [
    "[Unit]",
    `Description=${config.description}`,
    "After=network.target",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${config.workingDirectory}`,
    `ExecStart=${config.execStart}`,
    "Restart=always",
    "RestartSec=5",
    `EnvironmentFile=${config.workingDirectory}/.env`,
    ...(envLines ? [envLines] : []),
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class SystemdManager extends Effect.Service<SystemdManager>()("infra/SystemdManager", {
  effect: Effect.gen(function* () {
    const ssh = yield* SshClient;

    return {
      install: Effect.fnUntraced(function* (host: string, unitName: string, config: UnitConfig) {
        const unitPath = `${UNIT_DIR}/${unitName}.service`;
        const content = renderUnit(config);

        yield* ssh.exec(host, `mkdir -p ${UNIT_DIR}`, SVC_USER);
        yield* ssh.writeFile(host, unitPath, content, { user: SVC_USER });
        yield* ssh.exec(host, `${SYSTEMCTL} daemon-reload`, SVC_USER);
        yield* ssh.exec(host, `${SYSTEMCTL} enable ${unitName}`, SVC_USER);
      }),

      start: (host: string, unitName: string) =>
        ssh.exec(host, `${SYSTEMCTL} restart ${unitName}`, SVC_USER).pipe(Effect.asVoid),

      stop: (host: string, unitName: string) =>
        ssh.exec(host, `${SYSTEMCTL} stop ${unitName}`, SVC_USER).pipe(Effect.asVoid),

      remove: Effect.fnUntraced(function* (host: string, unitName: string) {
        yield* ssh.exec(
          host,
          `${SYSTEMCTL} stop ${unitName} 2>/dev/null; ${SYSTEMCTL} disable ${unitName} 2>/dev/null; true`,
          SVC_USER,
        );
        yield* ssh.exec(host, `rm -f ${UNIT_DIR}/${unitName}.service`, SVC_USER);
        yield* ssh.exec(host, `${SYSTEMCTL} daemon-reload`, SVC_USER);
      }),

      status: (host: string, unitName: string) =>
        ssh.exec(host, `${SYSTEMCTL} status ${unitName}`, SVC_USER),
    };
  }),
}) {}
