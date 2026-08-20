import { Effect, Schema as S } from "effect"
import { SshClient } from "./SshClient.ts"
import { OpenBaoClient } from "./OpenBaoClient.ts"
import { formatTimestamp, formatBytes } from "../lib/format.ts"
import { OPENBAO_TOKEN, SVC_USER } from "../lib/config.ts"

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class BackupError extends S.TaggedError<BackupError>()("BackupError", {
  target: S.String,
  message: S.String,
}) {}

export class MissingCredentialsError extends S.TaggedError<MissingCredentialsError>()(
  "MissingCredentialsError",
  { path: S.String, keys: S.Array(S.String) },
) {
  override get message() {
    return `Missing credentials in vault (${this.path}/${this.keys.join(", ")})`
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const POSTGRES_HOST = "cynic.dlab"
export const VAULT_HOST = "atheist.dlab"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const parseFileList = (output: string): ReadonlyArray<string> =>
  output
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)

const cleanupOldFiles = (
  ssh: SshClient,
  host: string,
  dir: string,
  keep: number,
) =>
  Effect.gen(function* () {
    const output = yield* ssh.exec(host, `ls -1t ${dir} 2>/dev/null || echo ""`, SVC_USER)
    const files = parseFileList(output)

    yield* Effect.forEach(
      files.slice(keep),
      (file) => ssh.exec(host, `rm -f ${dir}/${file}`, SVC_USER),
    )
  })

const fileSize = (ssh: SshClient, host: string, path: string) =>
  Effect.gen(function* () {
    const output = yield* ssh.exec(host, `stat -c %s "${path}" 2>/dev/null || echo "0"`, SVC_USER)
    return formatBytes(parseInt(output.trim(), 10))
  })

// ---------------------------------------------------------------------------
// Backup result type
// ---------------------------------------------------------------------------

export interface BackupResult {
  readonly file: string
  readonly size: string
}

// ---------------------------------------------------------------------------
// Core backup logic
// ---------------------------------------------------------------------------

export const backupPostgres = Effect.gen(function* () {
  const bao = yield* OpenBaoClient
  const ssh = yield* SshClient

  const timestamp = formatTimestamp()
  const backupFile = `/opt/backups/postgres/all-${timestamp}.sql.gz`

  yield* Effect.log("Fetching Postgres credentials from vault...")
  const creds = yield* bao.kvGet("infra")
  const pgUser = creds["POSTGRES_USER"]
  const pgPassword = creds["POSTGRES_PASSWORD"]

  if (!pgUser || !pgPassword) {
    return yield* new MissingCredentialsError({ path: "infra", keys: ["POSTGRES_USER", "POSTGRES_PASSWORD"] })
  }

  yield* Effect.log("Preparing backup directory...")
  yield* ssh.exec(POSTGRES_HOST, `mkdir -p /opt/backups/postgres`, SVC_USER)

  yield* Effect.log("Dumping all Postgres databases...")
  // Base64-encode credentials to avoid shell injection
  const b64Pass = Buffer.from(pgPassword).toString("base64")
  const b64User = Buffer.from(pgUser).toString("base64")
  yield* ssh.exec(
    POSTGRES_HOST,
    `export PGPASSWORD="$(echo '${b64Pass}' | base64 -d)" && pg_dumpall -h localhost -U "$(echo '${b64User}' | base64 -d)" | gzip > "${backupFile}"`,
    SVC_USER,
  )

  const size = yield* fileSize(ssh, POSTGRES_HOST, backupFile)

  yield* Effect.log("Cleaning up old backups...")
  yield* cleanupOldFiles(ssh, POSTGRES_HOST, "/opt/backups/postgres", 7)

  yield* Effect.log(`Postgres backup complete: ${backupFile} (${size})`)

  return { file: backupFile, size } satisfies BackupResult
})

export const backupVault = Effect.gen(function* () {
  const ssh = yield* SshClient

  const timestamp = formatTimestamp()
  const backupFile = `/opt/backups/vault/vault-${timestamp}.snap`

  // vault token comes from env -- same token used by the OpenBaoClient
  const vaultToken = OPENBAO_TOKEN
  if (!vaultToken) {
    return yield* new BackupError({
      target: "vault",
      message: "OpenBao token not configured -- cannot create vault snapshot",
    })
  }

  yield* Effect.log("Preparing backup directory...")
  yield* ssh.exec(VAULT_HOST, `mkdir -p /opt/backups/vault`, SVC_USER)

  yield* Effect.log("Creating Vault snapshot...")
  const b64Token = Buffer.from(vaultToken).toString("base64")
  yield* ssh.exec(
    VAULT_HOST,
    `curl -s -H "X-Vault-Token: $(echo '${b64Token}' | base64 -d)" http://127.0.0.1:8200/v1/sys/storage/raft/snapshot > "${backupFile}"`,
    SVC_USER,
  )

  const size = yield* fileSize(ssh, VAULT_HOST, backupFile)

  yield* Effect.log("Cleaning up old snapshots...")
  yield* cleanupOldFiles(ssh, VAULT_HOST, "/opt/backups/vault", 7)

  yield* Effect.log(`Vault backup complete: ${backupFile} (${size})`)

  return { file: backupFile, size } satisfies BackupResult
})

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

export const listBackups = (host: string, dir: string) =>
  Effect.gen(function* () {
    const ssh = yield* SshClient
    const output = yield* ssh.exec(host, `ls -1t ${dir} 2>/dev/null || echo ""`, SVC_USER)
    const files = parseFileList(output)
    return yield* Effect.forEach(files, (file) =>
      fileSize(ssh, host, `${dir}/${file}`).pipe(
        Effect.map((size) => ({ file, size })),
      ),
    )
  })
