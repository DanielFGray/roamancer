import { Effect, Schema as S } from "effect";
import { SshClient } from "./SshClient.ts";
import { BackupsOpenBaoClient } from "./OpenBaoClient.ts";
import { ConsulClient } from "./ConsulClient.ts";
import { formatTimestamp, formatBytes } from "../lib/format.ts";
import { OPENBAO_ADDR, OPENBAO_BACKUPS_TOKEN, SVC_USER } from "../lib/config.ts";

const POSTGRES_BACKUP_TIMEOUT = "15m";
const OPENBAO_BACKUP_TIMEOUT_SECONDS = 120;
const VALKEY_BACKUP_TIMEOUT = "15m";

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
    return `Missing credentials in vault (${this.path}/${this.keys.join(", ")})`;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const parseFileList = (output: string): ReadonlyArray<string> =>
  output
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

const cleanupOldFiles = Effect.fnUntraced(function* (
  ssh: SshClient,
  host: string,
  dir: string,
  keep: number,
) {
  const output = yield* ssh.exec(host, `ls -1t ${dir} 2>/dev/null || echo ""`, SVC_USER);
  const files = parseFileList(output);

  yield* Effect.forEach(files.slice(keep), (file) =>
    ssh.exec(host, `rm -f ${dir}/${file}`, SVC_USER),
  );
});

const fileSize = Effect.fnUntraced(function* (ssh: SshClient, host: string, path: string) {
  const output = yield* ssh.exec(host, `stat -c %s "${path}" 2>/dev/null || echo "0"`, SVC_USER);
  return formatBytes(parseInt(output.trim(), 10));
});

const skipIfMoveInProgress = (ssh: SshClient, host: string, service: string) =>
  Effect.gen(function* () {
    const output = yield* ssh.exec(
      host,
      `podman unshare test -f /srv/data/${service}/.move-in-progress && echo present || echo absent`,
      SVC_USER,
    );
    if (output.trim() === "present") {
      yield* Effect.log(`Skipping ${service} backup because a service move is in progress`);
      return true;
    }
    return false;
  });

const skippedBackup = (service: string): BackupResult => ({
  file: `${service} backup skipped while service move is in progress`,
  size: "0 B",
});

export const openBaoSnapshotCommand = (
  backupFile: string,
  token: string,
  address: string = OPENBAO_ADDR,
): string => {
  const b64Token = Buffer.from(token).toString("base64");
  const b64Address = Buffer.from(address.replace(/\/+$/, "")).toString("base64");
  const partialFile = `${backupFile}.partial`;
  return `trap 'rm -f "${partialFile}"' EXIT && curl --fail --silent --show-error --connect-timeout 10 --max-time ${OPENBAO_BACKUP_TIMEOUT_SECONDS} -H "X-Vault-Token: $(echo '${b64Token}' | base64 -d)" "$(echo '${b64Address}' | base64 -d)/v1/sys/storage/raft/snapshot" > "${partialFile}" && test -s "${partialFile}" && gzip -t "${partialFile}" && mv -f "${partialFile}" "${backupFile}"`;
};

export const postgresBackupCommand = (
  backupFile: string,
  user: string,
  password: string,
): string => {
  const partialFile = `${backupFile}.partial`;
  const b64Pass = Buffer.from(password).toString("base64");
  const b64User = Buffer.from(user).toString("base64");
  return `trap 'rm -f "${partialFile}"' EXIT && set -o pipefail && export PGPASSWORD="$(echo '${b64Pass}' | base64 -d)" && timeout ${POSTGRES_BACKUP_TIMEOUT} pg_dumpall -h localhost -U "$(echo '${b64User}' | base64 -d)" | gzip > "${partialFile}" && gzip -t "${partialFile}" && mv -f "${partialFile}" "${backupFile}"`;
};

export const valkeySnapshotCommand = (): string =>
  `timeout ${VALKEY_BACKUP_TIMEOUT} bash -c 'before_info=$(podman exec valkey_valkey_1 valkey-cli INFO persistence) || exit 1; before=$(printf "%s\\n" "$before_info" | awk -F: "/^rdb_saves:/{print \\$2}" | tr -d "\\r"); [ -n "$before" ] || exit 1; podman exec valkey_valkey_1 valkey-cli BGSAVE && while :; do info=$(podman exec valkey_valkey_1 valkey-cli INFO persistence) || exit 1; in_progress=$(printf "%s\\n" "$info" | awk -F: "/^rdb_bgsave_in_progress:/{print \\$2}" | tr -d "\\r"); if [ "$in_progress" = "0" ]; then status=$(printf "%s\\n" "$info" | awk -F: "/^rdb_last_bgsave_status:/{print \\$2}" | tr -d "\\r") && saves=$(printf "%s\\n" "$info" | awk -F: "/^rdb_saves:/{print \\$2}" | tr -d "\\r") || exit 1; [ "$status" = "ok" ] && [ "$saves" -gt "$before" ] || exit 1; break; fi; sleep 1; done'`;

export const valkeyCopyCommand = (backupFile: string): string => {
  const partialFile = `${backupFile}.partial`;
  return `trap 'rm -f "${partialFile}"' EXIT && podman unshare cp /srv/data/valkey/dump.rdb "${partialFile}" && podman unshare test -s "${partialFile}" && podman unshare cmp -s /srv/data/valkey/dump.rdb "${partialFile}" && mv -f "${partialFile}" "${backupFile}"`;
};

// ---------------------------------------------------------------------------
// Backup result type
// ---------------------------------------------------------------------------

export interface BackupResult {
  readonly file: string;
  readonly size: string;
}

// ---------------------------------------------------------------------------
// Core backup logic
// ---------------------------------------------------------------------------

export const backupPostgres = Effect.gen(function* () {
  const bao = yield* BackupsOpenBaoClient;
  const ssh = yield* SshClient;
  const consul = yield* ConsulClient;
  const host = yield* consul.resolveServiceHost("postgres");

  if (yield* skipIfMoveInProgress(ssh, host, "postgres")) {
    return skippedBackup("postgres");
  }

  const timestamp = formatTimestamp();
  const backupFile = `/opt/backups/postgres/all-${timestamp}.sql.gz`;

  yield* Effect.log("Fetching Postgres credentials from vault...");
  const creds = yield* bao.kvGet("infra");
  const pgUser = creds["POSTGRES_USER"];
  const pgPassword = creds["POSTGRES_PASSWORD"];

  if (!pgUser || !pgPassword) {
    return yield* new MissingCredentialsError({
      path: "infra",
      keys: ["POSTGRES_USER", "POSTGRES_PASSWORD"],
    });
  }

  yield* Effect.log("Preparing backup directory...");
  yield* ssh.exec(host, `mkdir -p /opt/backups/postgres`, SVC_USER);

  yield* Effect.log("Dumping all Postgres databases...");
  yield* ssh.exec(host, postgresBackupCommand(backupFile, pgUser, pgPassword), SVC_USER);

  const size = yield* fileSize(ssh, host, backupFile);

  yield* Effect.log("Cleaning up old backups...");
  yield* cleanupOldFiles(ssh, host, "/opt/backups/postgres", 7);

  yield* Effect.log(`Postgres backup complete: ${backupFile} (${size})`);

  return { file: backupFile, size } satisfies BackupResult;
});

export const backupVault = Effect.gen(function* () {
  const ssh = yield* SshClient;
  const consul = yield* ConsulClient;
  const host = yield* consul.resolveServiceHost("vault");

  if (yield* skipIfMoveInProgress(ssh, host, "vault")) {
    return skippedBackup("vault");
  }

  const timestamp = formatTimestamp();
  const backupFile = `/opt/backups/vault/vault-${timestamp}.snap`;

  // vault token comes from env -- same token used by BackupsOpenBaoClient
  const vaultToken = OPENBAO_BACKUPS_TOKEN;
  if (!vaultToken) {
    return yield* new BackupError({
      target: "vault",
      message: "OpenBao backups token not configured -- cannot create vault snapshot",
    });
  }

  yield* Effect.log("Preparing backup directory...");
  yield* ssh.exec(host, `mkdir -p /opt/backups/vault`, SVC_USER);

  yield* Effect.log("Creating Vault snapshot...");
  yield* ssh.exec(host, openBaoSnapshotCommand(backupFile, vaultToken), SVC_USER);

  const size = yield* fileSize(ssh, host, backupFile);

  yield* Effect.log("Cleaning up old snapshots...");
  yield* cleanupOldFiles(ssh, host, "/opt/backups/vault", 7);

  yield* Effect.log(`Vault backup complete: ${backupFile} (${size})`);

  return { file: backupFile, size } satisfies BackupResult;
});

export const backupClickhouse = Effect.gen(function* () {
  const ssh = yield* SshClient;
  const consul = yield* ConsulClient;
  const host = yield* consul.resolveServiceHost("clickhouse");

  if (yield* skipIfMoveInProgress(ssh, host, "clickhouse")) {
    return skippedBackup("clickhouse");
  }

  const timestamp = formatTimestamp();
  const backupFile = `/opt/backups/clickhouse/${timestamp}.zip`;

  yield* Effect.log("Preparing ClickHouse backup directory...");
  yield* ssh.exec(host, "mkdir -p /opt/backups/clickhouse", SVC_USER);

  yield* Effect.log("Creating ClickHouse backup...");
  yield* ssh.exec(
    host,
    `podman exec clickhouse_clickhouse_1 clickhouse-client --query "BACKUP DATABASE default TO Disk('backups', '${timestamp}.zip')"`,
    SVC_USER,
  );

  const size = yield* fileSize(ssh, host, backupFile);
  yield* Effect.log("Cleaning up old ClickHouse backups...");
  yield* cleanupOldFiles(ssh, host, "/opt/backups/clickhouse", 7);
  yield* Effect.log(`ClickHouse backup complete: ${backupFile} (${size})`);

  return { file: backupFile, size } satisfies BackupResult;
});

export const backupValkey = Effect.gen(function* () {
  const ssh = yield* SshClient;
  const consul = yield* ConsulClient;
  const host = yield* consul.resolveServiceHost("valkey");

  if (yield* skipIfMoveInProgress(ssh, host, "valkey")) {
    return skippedBackup("valkey");
  }

  const timestamp = formatTimestamp();
  const backupFile = `/opt/backups/valkey/valkey-${timestamp}.rdb`;

  yield* Effect.log("Preparing Valkey backup directory...");
  yield* ssh.exec(host, "mkdir -p /opt/backups/valkey", SVC_USER);

  yield* Effect.log("Starting Valkey background save...");
  yield* ssh.exec(host, valkeySnapshotCommand(), SVC_USER);

  yield* Effect.log("Copying Valkey snapshot...");
  // /srv/data/valkey is owned inside SVC_USER's rootless podman user
  // namespace (see roles/compose's "podman unshare chown" tasks), so a
  // plain cp as SVC_USER can't read it -- podman unshare re-maps the view.
  yield* ssh.exec(host, valkeyCopyCommand(backupFile), SVC_USER);

  const size = yield* fileSize(ssh, host, backupFile);
  yield* Effect.log("Cleaning up old Valkey backups...");
  yield* cleanupOldFiles(ssh, host, "/opt/backups/valkey", 7);
  yield* Effect.log(`Valkey backup complete: ${backupFile} (${size})`);

  return { file: backupFile, size } satisfies BackupResult;
});

export const backupZookeeper = Effect.gen(function* () {
  const ssh = yield* SshClient;
  const consul = yield* ConsulClient;
  const host = yield* consul.resolveServiceHost("zookeeper");

  if (yield* skipIfMoveInProgress(ssh, host, "zookeeper")) {
    return skippedBackup("zookeeper");
  }

  const timestamp = formatTimestamp();
  const backupFile = `/opt/backups/zookeeper/zookeeper-${timestamp}.tar.gz`;

  yield* Effect.log("Preparing ZooKeeper backup directory...");
  yield* ssh.exec(host, "mkdir -p /opt/backups/zookeeper", SVC_USER);
  yield* Effect.log("Creating ZooKeeper live tar backup...");
  // See backupValkey's comment: /srv/data/zookeeper is owned inside
  // SVC_USER's rootless podman user namespace.
  yield* ssh.exec(
    host,
    `podman unshare tar czf "${backupFile}" -C /srv/data/zookeeper .`,
    SVC_USER,
  );

  const size = yield* fileSize(ssh, host, backupFile);
  yield* Effect.log("Cleaning up old ZooKeeper backups...");
  yield* cleanupOldFiles(ssh, host, "/opt/backups/zookeeper", 7);
  yield* Effect.log(`ZooKeeper backup complete: ${backupFile} (${size})`);

  return { file: backupFile, size } satisfies BackupResult;
});

export const backupSignoz = Effect.gen(function* () {
  const ssh = yield* SshClient;
  const consul = yield* ConsulClient;
  const host = yield* consul.resolveServiceHost("signoz");

  if (yield* skipIfMoveInProgress(ssh, host, "signoz")) {
    return skippedBackup("signoz");
  }

  const timestamp = formatTimestamp();
  const backupFile = `/opt/backups/signoz/signoz-${timestamp}.db`;

  yield* Effect.log("Preparing SigNoz backup directory...");
  yield* ssh.exec(host, "mkdir -p /opt/backups/signoz", SVC_USER);
  yield* Effect.log("Creating SigNoz SQLite online backup...");
  // See backupValkey's comment: /srv/data/signoz is owned inside SVC_USER's
  // rootless podman user namespace.
  yield* ssh.exec(
    host,
    `podman unshare sqlite3 /srv/data/signoz/signoz.db ".backup '${backupFile}'"`,
    SVC_USER,
  );

  const size = yield* fileSize(ssh, host, backupFile);
  yield* Effect.log("Cleaning up old SigNoz backups...");
  yield* cleanupOldFiles(ssh, host, "/opt/backups/signoz", 7);
  yield* Effect.log(`SigNoz backup complete: ${backupFile} (${size})`);

  return { file: backupFile, size } satisfies BackupResult;
});

const normalizeBackupError = <E, R>(service: string, job: Effect.Effect<BackupResult, E, R>) =>
  job.pipe(
    Effect.mapError((error) =>
      S.is(MissingCredentialsError)(error)
        ? error
        : new BackupError({ target: service, message: String(error) }),
    ),
  );

export const backupByService: Record<
  string,
  Effect.Effect<
    BackupResult,
    BackupError | MissingCredentialsError,
    SshClient | BackupsOpenBaoClient | ConsulClient
  >
> = {
  postgres: normalizeBackupError("postgres", backupPostgres),
  vault: normalizeBackupError("vault", backupVault),
  clickhouse: normalizeBackupError("clickhouse", backupClickhouse),
  valkey: normalizeBackupError("valkey", backupValkey),
  zookeeper: normalizeBackupError("zookeeper", backupZookeeper),
  signoz: normalizeBackupError("signoz", backupSignoz),
};

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

export const listBackups = Effect.fnUntraced(function* (host: string, dir: string) {
  const ssh = yield* SshClient;
  const output = yield* ssh.exec(host, `ls -1t ${dir} 2>/dev/null || echo ""`, SVC_USER);
  const files = parseFileList(output);
  return yield* Effect.forEach(files, (file) =>
    fileSize(ssh, host, `${dir}/${file}`).pipe(Effect.map((size) => ({ file, size }))),
  );
});
