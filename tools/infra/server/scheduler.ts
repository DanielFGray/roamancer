import { Context, DateTime, Effect, Layer, Ref, Schedule } from "effect";
import { backupPostgres, backupVault } from "../src/services/BackupRunner.ts";
import { BACKUP_POSTGRES_CRON, BACKUP_VAULT_CRON } from "../src/lib/config.ts";

// ---------------------------------------------------------------------------
// Backup status -- shared in-memory state
// ---------------------------------------------------------------------------

export interface BackupJobStatus {
  readonly lastRun: string | null;
  readonly lastResult: "success" | "failure";
  readonly lastError: string | null;
  readonly lastFile: string | null;
}

export interface BackupStatusState {
  readonly postgres: BackupJobStatus;
  readonly vault: BackupJobStatus;
}

const emptyJob: BackupJobStatus = {
  lastRun: null,
  lastResult: "success",
  lastError: null,
  lastFile: null,
};

const initialState: BackupStatusState = {
  postgres: emptyJob,
  vault: emptyJob,
};

export class BackupStatus extends Context.Tag("BackupStatus")<
  BackupStatus,
  Ref.Ref<BackupStatusState>
>() {}

export const BackupStatusLive = Layer.effect(BackupStatus, Ref.make(initialState));

// ---------------------------------------------------------------------------
// Scheduled job wrapper
// ---------------------------------------------------------------------------

const runJob = <E, R>(
  name: "postgres" | "vault",
  job: Effect.Effect<{ file: string; size: string }, E, R>,
  cron: string,
) =>
  Effect.gen(function* () {
    const statusRef = yield* BackupStatus;

    yield* Effect.log(`Backup scheduler: ${name} scheduled with cron "${cron}"`);

    const wrapped = Effect.gen(function* () {
      yield* Effect.log(`Backup scheduler: starting ${name} backup`);

      const result = yield* job.pipe(
        Effect.map((r) => ({
          lastRun: DateTime.formatIso(DateTime.unsafeNow()),
          lastResult: "success" as const,
          lastError: null,
          lastFile: r.file,
        })),
        Effect.catchAllCause((cause) =>
          Effect.succeed({
            lastRun: DateTime.formatIso(DateTime.unsafeNow()),
            lastResult: "failure" as const,
            lastError: String(cause),
            lastFile: null,
          }),
        ),
      );

      yield* Ref.update(statusRef, (s) => ({ ...s, [name]: result }));

      if (result.lastResult === "failure") {
        yield* Effect.logError(`Backup scheduler: ${name} backup failed: ${result.lastError}`);
      } else {
        yield* Effect.log(`Backup scheduler: ${name} backup succeeded`);
      }
    });

    // Boot grace period: don't fire backups immediately on server restart.
    // After the delay, run once then follow the cron schedule.
    yield* Effect.sleep("60 seconds").pipe(
      Effect.andThen(wrapped.pipe(Effect.repeat(Schedule.cron(cron)))),
      Effect.catchAllCause((cause) =>
        Effect.logError(`Backup scheduler: ${name} schedule crashed: ${cause}`),
      ),
      Effect.forkScoped,
    );
  });

// ---------------------------------------------------------------------------
// Scheduler layer -- starts backup fibers on boot
// ---------------------------------------------------------------------------

export const SchedulerLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    yield* Effect.log("Backup scheduler: starting");
    yield* runJob("postgres", backupPostgres, BACKUP_POSTGRES_CRON);
    yield* runJob("vault", backupVault, BACKUP_VAULT_CRON);
    yield* Effect.log("Backup scheduler: all jobs registered");
  }),
);
