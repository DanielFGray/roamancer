import { Effect } from "effect"
import { SshClient } from "./SshClient.ts"

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface UnitConfig {
  readonly description: string
  readonly workingDirectory: string
  readonly execStart: string
  readonly environment?: Record<string, string>
  readonly user?: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UNIT_DIR = "/etc/systemd/system"

const renderUnit = (config: UnitConfig): string => {
  const user = config.user ?? "prod"
  const envLines = config.environment
    ? Object.entries(config.environment)
        .map(([k, v]) => `Environment="${k}=${v}"`)
        .join("\n")
    : ""

  return [
    "[Unit]",
    `Description=${config.description}`,
    "After=network.target",
    "",
    "[Service]",
    "Type=simple",
    `User=${user}`,
    `WorkingDirectory=${config.workingDirectory}`,
    `ExecStart=${config.execStart}`,
    "Restart=always",
    "RestartSec=5",
    `EnvironmentFile=${config.workingDirectory}/.env`,
    ...(envLines ? [envLines] : []),
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n")
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class SystemdManager extends Effect.Service<SystemdManager>()(
  "infra/SystemdManager",
  {
    effect: Effect.gen(function* () {
      const ssh = yield* SshClient

      return {
        install: (host: string, unitName: string, config: UnitConfig) =>
          Effect.gen(function* () {
            const unitPath = `${UNIT_DIR}/${unitName}.service`
            const content = renderUnit(config)

            // Write unit file via sudo (needs root for /etc/systemd/system)
            yield* ssh.writeFile(host, unitPath, content, { sudo: true })

            yield* ssh.exec(host, "sudo systemctl daemon-reload")
            yield* ssh.exec(host, `sudo systemctl enable ${unitName}`)
          }),

        start: (host: string, unitName: string) =>
          ssh.exec(host, `sudo systemctl restart ${unitName}`).pipe(
            Effect.asVoid,
          ),

        stop: (host: string, unitName: string) =>
          ssh.exec(host, `sudo systemctl stop ${unitName}`).pipe(
            Effect.asVoid,
          ),

        remove: (host: string, unitName: string) =>
          Effect.gen(function* () {
            yield* ssh.exec(
              host,
              `sudo systemctl stop ${unitName} 2>/dev/null; sudo systemctl disable ${unitName} 2>/dev/null; true`,
            )
            yield* ssh.exec(
              host,
              `sudo rm -f ${UNIT_DIR}/${unitName}.service`,
            )
            yield* ssh.exec(host, "sudo systemctl daemon-reload")
          }),

        status: (host: string, unitName: string) =>
          ssh.exec(host, `sudo systemctl status ${unitName}`),
      }
    }),
  },
) {}
