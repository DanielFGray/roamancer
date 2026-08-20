import { configPaths } from "./config-values.ts";
import { deploymentRoots } from "./deployment.ts";
export { configPaths } from "./config-values.ts";

// ---------------------------------------------------------------------------
// Config file: ~/.config/infra/config.json
//
// Env vars always take precedence over file values.
// Shell-command config resolution is disabled by default and must be explicitly
// enabled with INFRA_ENABLE_CONFIG_COMMANDS=true.
// ---------------------------------------------------------------------------

export const ENVIRONMENT: Record<string, string | undefined> =
  typeof Bun === "undefined"
    ? ((Reflect.get(Reflect.get(globalThis, "process") ?? {}, "env") as Record<
        string,
        string | undefined
      >) ?? {})
    : Bun.env;
const CONFIG_COMMANDS_ENABLED = ENVIRONMENT.INFRA_ENABLE_CONFIG_COMMANDS === "true";
const ALLOW_INSECURE_HTTP = ENVIRONMENT.INFRA_ALLOW_INSECURE_HTTP === "true";
export const HOME_DIR = ENVIRONMENT.HOME ?? ENVIRONMENT.USERPROFILE ?? "/root";
const CONFIG_PATHS = configPaths(HOME_DIR);
const CONFIG_HOME = CONFIG_PATHS.configHome;

export const INFRA_CONFIG_DIR = CONFIG_PATHS.configHome;
export const API_TOKEN_FILE = CONFIG_PATHS.apiTokenFile;
export const WEBHOOK_SECRET_FILE = CONFIG_PATHS.webhookSecretFile;

const isLoopbackHost = (hostname: string) =>
  hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";

const requireSafeUrl = (name: string, value: string): string => {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" || isLoopbackHost(url.hostname) || ALLOW_INSECURE_HTTP) {
      return value;
    }

    throw new Error(
      `${name} must use https for non-local addresses (set INFRA_ALLOW_INSECURE_HTTP=true to override)`,
    );
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`Invalid URL for ${name}: ${value}`);
  }
};

const readFile = (path: string): Promise<string> =>
  typeof Bun === "undefined"
    ? Promise.reject(new Error(`Cannot read ${path}`))
    : Bun.file(path).text();

const configFile = await readFile(`${CONFIG_HOME}/config.json`)
  .then((raw) => {
    return JSON.parse(raw) as Record<string, string>;
  })
  .catch(() => {
    return {} as Record<string, string>;
  });

const readTextFile = (path: string): Promise<string | undefined> =>
  readFile(path)
    .then((raw) => {
      const value = raw.trim();
      return value === "" ? undefined : value;
    })
    .catch(() => undefined);

const readInitToken = (): Promise<string | undefined> =>
  readFile(`${CONFIG_HOME}/vault-init.json`)
    .then((raw) => {
      const parsed = JSON.parse(raw) as { root_token?: string };
      return parsed.root_token?.trim() || undefined;
    })
    .catch(() => undefined);

/** Resolve a config value: check for `key_command` first, then `key` */
const resolveConfig = (key: string): Promise<string | undefined> => {
  const cmdKey = `${key}_command`;
  if (configFile[cmdKey]) {
    if (!CONFIG_COMMANDS_ENABLED) {
      return Promise.resolve(undefined);
    }
    try {
      if (typeof Bun === "undefined") return Promise.resolve(undefined);
      const proc = Bun.spawnSync(["sh", "-c", configFile[cmdKey]], {
        stdout: "pipe",
        stderr: "pipe",
      });
      return Promise.resolve(new TextDecoder().decode(proc.stdout).trim());
    } catch {
      return Promise.resolve(undefined);
    }
  }
  return Promise.resolve(configFile[key]);
};

const cfg = (envKey: string, fileKey: string, fallback: string): Promise<string> =>
  ENVIRONMENT[envKey] !== undefined
    ? Promise.resolve(ENVIRONMENT[envKey]!)
    : resolveConfig(fileKey).then((value) => value ?? fallback);

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

export const SVC_USER = await cfg("INFRA_SVC_USER", "svc_user", "prod");
export const PROJECTS_DIR = await cfg("INFRA_PROJECTS_DIR", "projects_dir", "/srv/projects");
export const STATIC_ARTIFACTS_DIR = await cfg(
  "INFRA_STATIC_ARTIFACTS_DIR",
  "static_artifacts_dir",
  "/srv/www",
);
export const DEPLOYMENT_ROOTS = deploymentRoots({
  projects: PROJECTS_DIR,
  staticFiles: STATIC_ARTIFACTS_DIR,
});
export const OPENBAO_ADDR = requireSafeUrl(
  "OPENBAO_ADDR",
  await cfg("OPENBAO_ADDR", "openbao_addr", "https://atheist.dlab:8200"),
);
export const REPO_ROOT = new URL("../../../..", import.meta.url).pathname.replace(/\/$/, "");
export const GIT_HOST = await cfg("INFRA_GIT_HOST", "git_host", "git@forgejo:dan");
export const CADDY_HOST = await cfg("INFRA_CADDY_HOST", "caddy_host", "cynic.dlab");
export const CADDY_SITES_DIR = await cfg(
  "CADDY_SITES_DIR",
  "caddy_sites_dir",
  "/etc/caddy/sites-enabled",
);
export const PORT_RANGE_START = 3001;
export const RETIRE_GRACE_SECONDS = Number(ENVIRONMENT.RETIRE_GRACE_SECONDS) || 30;
export const STATE_DB_PATH = await cfg("STATE_DB_PATH", "state_db_path", "/opt/infra/state.db");

// ---------------------------------------------------------------------------
// Agent HTTP server
// ---------------------------------------------------------------------------

export const API_PORT = Number(ENVIRONMENT.INFRA_API_PORT) || 9000;
export const WEBHOOK_AUTO_PROMOTE = ENVIRONMENT.INFRA_WEBHOOK_AUTO_PROMOTE === "true";
export const OPENBAO_TOKEN_FILE =
  ENVIRONMENT.OPENBAO_TOKEN_FILE ??
  (await resolveConfig("openbao_token_file")) ??
  CONFIG_PATHS.openBaoTokenFile;
export const OPENBAO_TOKEN =
  ENVIRONMENT.OPENBAO_TOKEN ??
  (await resolveConfig("openbao_token")) ??
  (await readTextFile(OPENBAO_TOKEN_FILE)) ??
  (await readInitToken());
export const INFRA_AGENT_SECRET_PATH = await cfg(
  "INFRA_AGENT_SECRET_PATH",
  "infra_agent_secret_path",
  "infra-agent",
);
export const INFRA_AGENT_API_TOKEN_KEY = await cfg(
  "INFRA_AGENT_API_TOKEN_KEY",
  "infra_agent_api_token_key",
  "api_token",
);
export const INFRA_AGENT_WEBHOOK_SECRET_KEY = await cfg(
  "INFRA_AGENT_WEBHOOK_SECRET_KEY",
  "infra_agent_webhook_secret_key",
  "webhook_secret",
);
export const API_TOKEN =
  ENVIRONMENT.INFRA_API_TOKEN ??
  (await resolveConfig("api_token")) ??
  (await readTextFile(API_TOKEN_FILE)) ??
  undefined;
export const WEBHOOK_SECRET =
  ENVIRONMENT.INFRA_WEBHOOK_SECRET ??
  (await resolveConfig("webhook_secret")) ??
  (await readTextFile(WEBHOOK_SECRET_FILE)) ??
  undefined;

// ---------------------------------------------------------------------------
// Remote client (thin CLI mode)
// ---------------------------------------------------------------------------

export const INFRA_SERVER_URL = requireSafeUrl(
  "INFRA_SERVER_URL",
  await cfg("INFRA_SERVER_URL", "server_url", "http://localhost:9000"),
);

// ---------------------------------------------------------------------------
// Backup schedules (cron expressions)
// ---------------------------------------------------------------------------

export const BACKUP_POSTGRES_CRON = ENVIRONMENT.BACKUP_POSTGRES_CRON ?? "0 2 * * *";
export const BACKUP_VAULT_CRON = ENVIRONMENT.BACKUP_VAULT_CRON ?? "0 3 * * *";
