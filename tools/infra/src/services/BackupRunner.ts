import { Effect, Schema as S } from "effect";
import { SshClient } from "./SshClient.ts";
import { OpenBaoClient } from "./OpenBaoClient.ts";
import { ConsulClient } from "./ConsulClient.ts";
import { formatTimestamp, formatBytes } from "../lib/format.ts";
import { OPENBAO_TOKEN, SVC_USER } from "../lib/config.ts";

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
  const bao = yield* OpenBaoClient;
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
  // Base64-encode credentials to avoid shell injection
  const b64Pass = Buffer.from(pgPassword).toString("base64");
  const b64User = Buffer.from(pgUser).toString("base64");
  yield* ssh.exec(
    host,
    `export PGPASSWORD="$(echo '${b64Pass}' | base64 -d)" && pg_dumpall -h localhost -U "$(echo '${b64User}' | base64 -d)" | gzip > "${backupFile}"`,
    SVC_USER,
  );

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

  // vault token comes from env -- same token used by the OpenBaoClient
  const vaultToken = OPENBAO_TOKEN;
  if (!vaultToken) {
    return yield* new BackupError({
      target: "vault",
      message: "OpenBao token not configured -- cannot create vault snapshot",
    });
  }

  yield* Effect.log("Preparing backup directory...");
  yield* ssh.exec(host, `mkdir -p /opt/backups/vault`, SVC_USER);

  yield* Effect.log("Creating Vault snapshot...");
  const b64Token = Buffer.from(vaultToken).toString("base64");
  yield* ssh.exec(
    host,
    `curl -s -H "X-Vault-Token: $(echo '${b64Token}' | base64 -d)" http://127.0.0.1:8200/v1/sys/storage/raft/snapshot > "${backupFile}"`,
    SVC_USER,
  );

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
  yield* ssh.exec(
    host,
    "podman exec valkey_valkey_1 valkey-cli BGSAVE && until [ \"$(podman exec valkey_valkey_1 valkey-cli INFO persistence | awk -F: '/rdb_bgsave_in_progress/{print $2}' | tr -d '\\r')\" = \"0\" ]; do sleep 1; done",
    SVC_USER,
  );

  yield* Effect.log("Copying Valkey snapshot...");
  // /srv/data/valkey is owned inside SVC_USER's rootless podman user
  // namespace (see roles/compose's "podman unshare chown" tasks), so a
  // plain cp as SVC_USER can't read it -- podman unshare re-maps the view.
  yield* ssh.exec(host, `podman unshare cp /srv/data/valkey/dump.rdb "${backupFile}"`, SVC_USER);

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

const normalizeBackupError = <R>(service: string, job: Effect.Effect<BackupResult, unknown, R>) =>
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
    SshClient | OpenBaoClient | ConsulClient
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
