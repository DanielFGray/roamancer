import { Command } from "@effect/cli";
import { Console, Effect } from "effect";
import { backupPostgres, backupVault, listBackups } from "../services/BackupRunner.ts";
import { ConsulClient } from "../services/ConsulClient.ts";

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

const backupPostgresCmd = Command.make("postgres").pipe(
  Command.withHandler(() =>
    backupPostgres.pipe(
      Effect.flatMap((r) =>
        Console.log(
          `\nSuccessfully backed up Postgres database\n  File: ${r.file}\n  Size: ${r.size}`,
        ),
      ),
    ),
  ),
  Command.withDescription("Backup all Postgres databases"),
);

const backupVaultCmd = Command.make("vault").pipe(
  Command.withHandler(() =>
    backupVault.pipe(
      Effect.flatMap((r) =>
        Console.log(`\nSuccessfully backed up Vault\n  File: ${r.file}\n  Size: ${r.size}`),
      ),
    ),
  ),
  Command.withDescription("Snapshot OpenBao/Vault"),
);

const backupListCmd = Command.make("list").pipe(
  Command.withHandler(
    Effect.fnUntraced(function* () {
      const consul = yield* ConsulClient;
      const postgresHost = yield* consul.resolveServiceHost("postgres");
      const vaultHost = yield* consul.resolveServiceHost("vault");

      yield* Console.log("Postgres backups:");
      const pgFiles = yield* listBackups(postgresHost, "/opt/backups/postgres");
      if (pgFiles.length === 0) {
        yield* Console.log("  (none)");
      } else {
        yield* Effect.forEach(pgFiles, (f) => Console.log(`  ${f.file} (${f.size})`));
      }

      yield* Console.log("");

      yield* Console.log("Vault backups:");
      const vaultFiles = yield* listBackups(vaultHost, "/opt/backups/vault");
      if (vaultFiles.length === 0) {
        yield* Console.log("  (none)");
      } else {
        yield* Effect.forEach(vaultFiles, (f) => Console.log(`  ${f.file} (${f.size})`));
      }
    }),
  ),
  Command.withDescription("List existing backups"),
);

// ---------------------------------------------------------------------------
// Group command
// ---------------------------------------------------------------------------

export const backupCommand = Command.make("backup").pipe(
  Command.withHandler(() => Effect.void),
  Command.withSubcommands([backupPostgresCmd, backupVaultCmd, backupListCmd]),
  Command.withDescription("Manage backups (postgres, vault, list)"),
);
