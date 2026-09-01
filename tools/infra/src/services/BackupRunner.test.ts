import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { ConsulClient } from "./ConsulClient.ts";
import { SshError } from "./SshClient.ts";
import {
  backupPostgres,
  backupValkey,
  openBaoSnapshotCommand,
  postgresBackupCommand,
  valkeyCopyCommand,
  valkeySnapshotCommand,
} from "./BackupRunner.ts";
import { makeTestServices, testLayers } from "../test/layers.ts";

const backupLayers = (state: ReturnType<typeof makeTestServices>) =>
  Layer.mergeAll(
    testLayers(state),
    Layer.succeed(ConsulClient, {
      registerService: () => Effect.void,
      deregisterService: () => Effect.void,
      catalogService: () => Effect.succeed([]),
      resolveServiceHost: () => Effect.succeed("test-host"),
      serviceIsPassing: () => Effect.succeed(true),
    }),
  );

it("builds the OpenBao snapshot request from the configured address", () => {
  const command = openBaoSnapshotCommand(
    "/opt/backups/vault/test.snap",
    "test-token",
    "https://openbao.example:8443/",
  );

  expect(command).toContain("--fail");
  expect(command).not.toContain("--location");
  expect(command).toContain("--max-time 120");
  expect(command).toContain("vault/test.snap.partial");
  expect(command).toContain('test -s "/opt/backups/vault/test.snap.partial"');
  expect(command).toContain('gzip -t "/opt/backups/vault/test.snap.partial"');
  expect(command).toContain(
    'mv -f "/opt/backups/vault/test.snap.partial" "/opt/backups/vault/test.snap"',
  );
  expect(command).toContain("trap 'rm -f \"/opt/backups/vault/test.snap.partial\"' EXIT");
  expect(command).toContain(Buffer.from("https://openbao.example:8443").toString("base64"));
});

it("validates the Postgres partial before activation", () => {
  const command = postgresBackupCommand(
    "/opt/backups/postgres/all-test.sql.gz",
    "postgres",
    "secret",
  );

  expect(command).toContain("set -o pipefail");
  expect(command).toContain("timeout 15m pg_dumpall");
  expect(command).toContain('gzip > "/opt/backups/postgres/all-test.sql.gz.partial"');
  expect(command).toContain('gzip -t "/opt/backups/postgres/all-test.sql.gz.partial"');
  expect(command).toContain(
    'mv -f "/opt/backups/postgres/all-test.sql.gz.partial" "/opt/backups/postgres/all-test.sql.gz"',
  );
  expect(command.indexOf("gzip -t")).toBeLessThan(command.indexOf("mv -f"));
  expect(command).toContain("trap 'rm -f \"/opt/backups/postgres/all-test.sql.gz.partial\"' EXIT");
});

it("requires a fresh successful Valkey snapshot", () => {
  const command = valkeySnapshotCommand();

  expect(command).toContain("timeout 15m");
  expect(command).toContain("rdb_saves");
  expect(command).toContain("valkey-cli BGSAVE");
  expect(command).toContain("rdb_last_bgsave_status");
  expect(command).toContain('[ "$status" = "ok" ]');
  expect(command).toContain('[ "$saves" -gt "$before" ]');
  expect(command.indexOf("before_info=")).toBeLessThan(command.indexOf("BGSAVE"));
  expect(command).not.toContain("LASTSAVE");
});

it("activates a Valkey copy only after it matches the fresh snapshot", () => {
  const command = valkeyCopyCommand("/opt/backups/valkey/valkey-test.rdb");

  expect(command).toContain("valkey-test.rdb.partial");
  expect(command).toContain('podman unshare test -s "/opt/backups/valkey/valkey-test.rdb.partial"');
  expect(command).toContain(
    'podman unshare cmp -s /srv/data/valkey/dump.rdb "/opt/backups/valkey/valkey-test.rdb.partial"',
  );
  expect(command.indexOf("cmp -s")).toBeLessThan(command.indexOf("mv -f"));
  expect(command).toContain(
    'mv -f "/opt/backups/valkey/valkey-test.rdb.partial" "/opt/backups/valkey/valkey-test.rdb"',
  );
});

it.effect("does not let a Postgres dump failure pass through gzip", () => {
  const state = makeTestServices();
  state.openBao.set("infra", { POSTGRES_USER: "postgres", POSTGRES_PASSWORD: "secret" });
  state.failSshCommand = "pg_dumpall";

  return Effect.gen(function* () {
    const result = yield* Effect.either(backupPostgres);
    expect(result._tag).toBe("Left");
    expect(result._tag === "Left" && result.left).toBeInstanceOf(SshError);
    expect(state.calls.ssh.at(-1)?.command).toContain("set -o pipefail");
    expect(state.calls.ssh.at(-1)?.command).toContain("timeout 15m pg_dumpall");
  }).pipe(Effect.provide(backupLayers(state)));
});

it.effect("bounds the Valkey background-save wait", () => {
  const state = makeTestServices();
  state.failSshCommand = "valkey-cli BGSAVE";

  return Effect.gen(function* () {
    const result = yield* Effect.either(backupValkey);
    expect(result._tag).toBe("Left");
    expect(result._tag === "Left" && result.left).toBeInstanceOf(SshError);
    expect(state.calls.ssh.at(-1)?.command).toContain("timeout 15m bash -c");
    expect(state.calls.ssh.at(-1)?.command).toContain("rdb_bgsave_in_progress");
  }).pipe(Effect.provide(backupLayers(state)));
});
