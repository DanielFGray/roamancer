import { readFileSync } from "node:fs"
import { execSync } from "node:child_process"
import { configPaths } from "./config-values.ts"
import { deploymentRoots } from "./deployment.ts"
export { configPaths } from "./config-values.ts"

// ---------------------------------------------------------------------------
// Config file: ~/.config/infra/config.json
//
// Env vars always take precedence over file values.
// Shell-command config resolution is disabled by default and must be explicitly
// enabled with INFRA_ENABLE_CONFIG_COMMANDS=true.
// ---------------------------------------------------------------------------

const CONFIG_COMMANDS_ENABLED = process.env["INFRA_ENABLE_CONFIG_COMMANDS"] === "true"
const ALLOW_INSECURE_HTTP = process.env["INFRA_ALLOW_INSECURE_HTTP"] === "true"
const CONFIG_PATHS = configPaths(process.env["HOME"] ?? "/root")
const CONFIG_HOME = CONFIG_PATHS.configHome

export const INFRA_CONFIG_DIR = CONFIG_PATHS.configHome
export const API_TOKEN_FILE = CONFIG_PATHS.apiTokenFile
export const WEBHOOK_SECRET_FILE = CONFIG_PATHS.webhookSecretFile

const isLoopbackHost = (hostname: string) =>
  hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"

const requireSafeUrl = (name: string, value: string): string => {
  try {
    const url = new URL(value)
    if (url.protocol === "https:" || isLoopbackHost(url.hostname) || ALLOW_INSECURE_HTTP) {
      return value
    }

    throw new Error(
      `${name} must use https for non-local addresses (set INFRA_ALLOW_INSECURE_HTTP=true to override)`,
    )
  } catch (error) {
    if (error instanceof Error) {
      throw error
    }
    throw new Error(`Invalid URL for ${name}: ${value}`)
  }
}

const configFile = (() => {
  try {
    const raw = readFileSync(`${CONFIG_HOME}/config.json`, "utf-8")
    return JSON.parse(raw) as Record<string, string>
  } catch {
    return {} as Record<string, string>
  }
})()

const readTextFile = (path: string): string | undefined => {
  try {
    const value = readFileSync(path, "utf-8").trim()
    return value === "" ? undefined : value
  } catch {
    return undefined
  }
}

const readInitToken = (): string | undefined => {
  try {
    const raw = readFileSync(`${CONFIG_HOME}/vault-init.json`, "utf-8")
    const parsed = JSON.parse(raw) as { root_token?: string }
    return parsed.root_token?.trim() || undefined
  } catch {
    return undefined
  }
}

/** Resolve a config value: check for `key_command` first, then `key` */
const resolveConfig = (key: string): string | undefined => {
  const cmdKey = `${key}_command`
  if (configFile[cmdKey]) {
    if (!CONFIG_COMMANDS_ENABLED) {
      return undefined
    }
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
export const STATIC_ARTIFACTS_DIR = cfg("INFRA_STATIC_ARTIFACTS_DIR", "static_artifacts_dir", "/srv/www")
export const DEPLOYMENT_ROOTS = deploymentRoots({
  projects: PROJECTS_DIR,
  staticFiles: STATIC_ARTIFACTS_DIR,
})
export const OPENBAO_ADDR = requireSafeUrl(
  "OPENBAO_ADDR",
  cfg("OPENBAO_ADDR", "openbao_addr", "https://atheist.dlab:8200"),
)
export const REPO_ROOT = new URL("../../../..", import.meta.url).pathname.replace(/\/$/, "")
export const GIT_HOST = cfg("INFRA_GIT_HOST", "git_host", "git@forgejo:dan")
export const CADDY_HOST = cfg("INFRA_CADDY_HOST", "caddy_host", "cynic.dlab")
export const CADDY_SITES_DIR = cfg("CADDY_SITES_DIR", "caddy_sites_dir", "/etc/caddy/sites-enabled")
export const PORT_RANGE_START = 3001
export const RETIRE_GRACE_SECONDS = Number(process.env["RETIRE_GRACE_SECONDS"]) || 30
export const STATE_DB_PATH = cfg("STATE_DB_PATH", "state_db_path", "/opt/infra/state.db")

// ---------------------------------------------------------------------------
// Agent HTTP server
// ---------------------------------------------------------------------------

export const API_PORT = Number(process.env["INFRA_API_PORT"]) || 9000
export const WEBHOOK_AUTO_PROMOTE = process.env["INFRA_WEBHOOK_AUTO_PROMOTE"] === "true"
export const OPENBAO_TOKEN_FILE = process.env["OPENBAO_TOKEN_FILE"]
  ?? resolveConfig("openbao_token_file")
  ?? CONFIG_PATHS.openBaoTokenFile
export const OPENBAO_TOKEN = process.env["OPENBAO_TOKEN"]
  ?? resolveConfig("openbao_token")
  ?? readTextFile(OPENBAO_TOKEN_FILE)
  ?? readInitToken()
export const INFRA_AGENT_SECRET_PATH = cfg("INFRA_AGENT_SECRET_PATH", "infra_agent_secret_path", "infra-agent")
export const INFRA_AGENT_API_TOKEN_KEY = cfg("INFRA_AGENT_API_TOKEN_KEY", "infra_agent_api_token_key", "api_token")
export const INFRA_AGENT_WEBHOOK_SECRET_KEY = cfg("INFRA_AGENT_WEBHOOK_SECRET_KEY", "infra_agent_webhook_secret_key", "webhook_secret")
export const API_TOKEN = process.env["INFRA_API_TOKEN"]
  ?? resolveConfig("api_token")
  ?? (readTextFile(API_TOKEN_FILE) ?? undefined)
export const WEBHOOK_SECRET = process.env["INFRA_WEBHOOK_SECRET"]
  ?? resolveConfig("webhook_secret")
  ?? (readTextFile(WEBHOOK_SECRET_FILE) ?? undefined)

// ---------------------------------------------------------------------------
// Remote client (thin CLI mode)
// ---------------------------------------------------------------------------

export const INFRA_SERVER_URL = requireSafeUrl(
  "INFRA_SERVER_URL",
  cfg("INFRA_SERVER_URL", "server_url", "http://localhost:9000"),
)

// ---------------------------------------------------------------------------
// Backup schedules (cron expressions)
// ---------------------------------------------------------------------------

export const BACKUP_POSTGRES_CRON = process.env["BACKUP_POSTGRES_CRON"] ?? "0 2 * * *"
export const BACKUP_VAULT_CRON = process.env["BACKUP_VAULT_CRON"] ?? "0 3 * * *"
