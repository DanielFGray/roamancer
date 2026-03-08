export const SVC_USER = process.env["INFRA_SVC_USER"] ?? "prod"
export const PROJECTS_DIR = process.env["INFRA_PROJECTS_DIR"] ?? "/srv/projects"
export const OPENBAO_ADDR = process.env["OPENBAO_ADDR"] ?? "http://atheist.dlab:8200"
export const REPO_ROOT = new URL("../../../..", import.meta.url).pathname.replace(/\/$/, "")
export const GIT_HOST = process.env["INFRA_GIT_HOST"] ?? "git@forgejo:dan"
export const PREVIEW_DOMAIN = process.env["INFRA_PREVIEW_DOMAIN"] ?? "cynic.dlab"
export const CADDY_HOST = process.env["INFRA_CADDY_HOST"] ?? "cynic.dlab"
export const CADDY_ADMIN_URL = process.env["CADDY_ADMIN_URL"] ?? "http://localhost:2019"
export const PORT_RANGE_START = 3001
export const RETIRE_GRACE_SECONDS = Number(process.env["RETIRE_GRACE_SECONDS"]) || 30
export const STATE_DB_PATH = process.env["STATE_DB_PATH"] ?? "/opt/infra/state.db"

// ---------------------------------------------------------------------------
// Agent HTTP server
// ---------------------------------------------------------------------------

export const API_PORT = Number(process.env["INFRA_API_PORT"]) || 9000
export const API_TOKEN = process.env["INFRA_API_TOKEN"]
export const WEBHOOK_SECRET = process.env["INFRA_WEBHOOK_SECRET"]

// ---------------------------------------------------------------------------
// Remote client (thin CLI mode)
// ---------------------------------------------------------------------------

export const INFRA_SERVER_URL = process.env["INFRA_SERVER_URL"] ?? "http://localhost:9000"

// ---------------------------------------------------------------------------
// Backup schedules (cron expressions)
// ---------------------------------------------------------------------------

export const BACKUP_POSTGRES_CRON = process.env["BACKUP_POSTGRES_CRON"] ?? "0 2 * * *"
export const BACKUP_VAULT_CRON = process.env["BACKUP_VAULT_CRON"] ?? "0 3 * * *"
