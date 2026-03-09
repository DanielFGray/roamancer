import { readFileSync } from "node:fs"
import { execSync } from "node:child_process"

// ---------------------------------------------------------------------------
// Config file: ~/.config/infra/config.json
//
// Env vars always take precedence over file values.
// Any key ending in "_command" is executed as a shell command to get the value.
// e.g. "api_token_command": "pass infra/api-token"
// ---------------------------------------------------------------------------

const configFile = (() => {
  try {
    const home = process.env["HOME"] ?? "/root"
    const raw = readFileSync(`${home}/.config/infra/config.json`, "utf-8")
    return JSON.parse(raw) as Record<string, string>
  } catch {
    return {} as Record<string, string>
  }
})()

/** Resolve a config value: check for `key_command` first, then `key` */
const resolveConfig = (key: string): string | undefined => {
  const cmdKey = `${key}_command`
  if (configFile[cmdKey]) {
    try {
      return execSync(configFile[cmdKey], { encoding: "utf-8", stdio: ["inherit", "pipe", "pipe"] }).trim()
    } catch {
      return undefined
    }
  }
  return configFile[key]
}

const cfg = (envKey: string, fileKey: string, fallback: string) =>
  process.env[envKey] ?? resolveConfig(fileKey) ?? fallback

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

export const SVC_USER = cfg("INFRA_SVC_USER", "svc_user", "prod")
export const PROJECTS_DIR = cfg("INFRA_PROJECTS_DIR", "projects_dir", "/srv/projects")
export const OPENBAO_ADDR = cfg("OPENBAO_ADDR", "openbao_addr", "http://atheist.dlab:8200")
export const REPO_ROOT = new URL("../../../..", import.meta.url).pathname.replace(/\/$/, "")
export const GIT_HOST = cfg("INFRA_GIT_HOST", "git_host", "git@forgejo:dan")
export const CADDY_HOST = cfg("INFRA_CADDY_HOST", "caddy_host", "cynic.dlab")
export const CADDY_ADMIN_URL = cfg("CADDY_ADMIN_URL", "caddy_admin_url", "http://localhost:2019")
export const PORT_RANGE_START = 3001
export const RETIRE_GRACE_SECONDS = Number(process.env["RETIRE_GRACE_SECONDS"]) || 30
export const STATE_DB_PATH = cfg("STATE_DB_PATH", "state_db_path", "/opt/infra/state.db")

// ---------------------------------------------------------------------------
// Agent HTTP server
// ---------------------------------------------------------------------------

export const API_PORT = Number(process.env["INFRA_API_PORT"]) || 9000
export const API_TOKEN = process.env["INFRA_API_TOKEN"] ?? resolveConfig("api_token")
export const WEBHOOK_SECRET = process.env["INFRA_WEBHOOK_SECRET"]

// ---------------------------------------------------------------------------
// Remote client (thin CLI mode)
// ---------------------------------------------------------------------------

export const INFRA_SERVER_URL = cfg("INFRA_SERVER_URL", "server_url", "http://localhost:9000")

// ---------------------------------------------------------------------------
// Backup schedules (cron expressions)
// ---------------------------------------------------------------------------

export const BACKUP_POSTGRES_CRON = process.env["BACKUP_POSTGRES_CRON"] ?? "0 2 * * *"
export const BACKUP_VAULT_CRON = process.env["BACKUP_VAULT_CRON"] ?? "0 3 * * *"
