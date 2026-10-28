/**
 * Static local login passwords in ~/.local/state/server-ansible/dev-db.json (0600).
 * Concurrent runs share one lock directory; a stale lock whose owner PID is dead
 * is taken over.
 */
import * as path from "node:path";
import * as Config from "effect/Config";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as S from "effect/Schema";
import { OpsError } from "../Exec.ts";

const StateFile = S.Struct({
  admin: S.String,
  logins: S.Record(S.String, S.String),
});
type StateFile = typeof StateFile.Type;

export type PasswordStore = {
  readonly admin: Redacted.Redacted<string>;
  readonly forRole: (role: string) => Redacted.Redacted<string>;
};

const stateDir = (home: string) => path.join(home, ".local/state/server-ansible");

export const statePathFor = (home: string) => path.join(stateDir(home), "dev-db.json");
const lockPathFor = (home: string) => path.join(stateDir(home), "dev-db.lock");
const lockPidPath = (lock: string) => path.join(lock, "pid");

const generatePassword = Effect.fn("devdb.generatePassword")(function* () {
  const crypto = yield* Crypto.Crypto;
  return Hex.encode(yield* crypto.randomBytes(32));
});

const pidIsAlive = Effect.fn("devdb.pidIsAlive")(function* (pid: number) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.exists(`/proc/${pid}`);
});

const tryAcquireLock = Effect.fn("devdb.tryAcquireLock")(function* (lock: string) {
  const fs = yield* FileSystem.FileSystem;
  const created = yield* fs.makeDirectory(lock).pipe(
    Effect.as(true),
    Effect.catchTag("PlatformError", (error) =>
      error.reason._tag === "AlreadyExists" ? Effect.succeed(false) : Effect.fail(error),
    ),
  );
  if (created) {
    yield* fs.writeFileString(lockPidPath(lock), `${process.pid}\n`);
    return true;
  }
  const ownerText = yield* fs
    .readFileString(lockPidPath(lock))
    .pipe(Effect.catchTag("PlatformError", () => Effect.succeed("")));
  const owner = Number.parseInt(ownerText.trim(), 10);
  if (!Number.isFinite(owner) || !(yield* pidIsAlive(owner))) {
    yield* fs.remove(lock, { recursive: true }).pipe(Effect.ignore);
    return false;
  }
  return false;
});

const withLock = <A, E, R>(home: string, body: Effect.Effect<A, E, R>) =>
  Effect.fn("devdb.withLock")(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(stateDir(home), { recursive: true });
    const lock = lockPathFor(home);
    for (let attempt = 0; attempt < 200; attempt++) {
      if (yield* tryAcquireLock(lock)) {
        yield* Effect.addFinalizer(() => fs.remove(lock, { recursive: true }).pipe(Effect.ignore));
        return yield* body;
      }
      yield* Effect.sleep("25 millis");
    }
    return yield* new OpsError({
      message: `could not lock ${lock}; another ops dev db may be stuck`,
    });
  }, Effect.scoped)();

const readState = Effect.fn("devdb.readState")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const exists = yield* fs.exists(file);
  if (!exists) return Option.none<StateFile>();
  const text = yield* fs.readFileString(file);
  return yield* S.decodeUnknownEffect(S.fromJsonString(StateFile))(text).pipe(
    Effect.map(Option.some),
    Effect.mapError(
      () => new OpsError({ message: `${file} is not valid JSON for ops dev db passwords` }),
    ),
  );
});

const writeState = Effect.fn("devdb.writeState")(function* (file: string, state: StateFile) {
  const fs = yield* FileSystem.FileSystem;
  const tmp = `${file}.${process.pid}.tmp`;
  yield* fs.writeFileString(tmp, `${JSON.stringify(state, null, 2)}\n`);
  yield* fs.chmod(tmp, 0o600);
  yield* fs.rename(tmp, file);
  yield* fs.chmod(file, 0o600);
});

const toStore = (state: StateFile): PasswordStore => ({
  admin: Redacted.make(state.admin),
  forRole: (role: string) => Redacted.make(state.logins[role]!),
});

const loadOrCreatePasswords = Effect.fn("devdb.loadOrCreatePasswords")(function* (
  file: string,
  loginRoles: ReadonlyArray<string>,
) {
  const current = yield* readState(file);
  const logins: Record<string, string> = {
    ...current.pipe(
      Option.map((state) => state.logins),
      Option.getOrElse(() => ({})),
    ),
  };
  let adminValue = current.pipe(
    Option.map((state) => state.admin),
    Option.getOrElse(() => ""),
  );
  let changed = Option.isNone(current);
  if (adminValue.length === 0) {
    adminValue = yield* generatePassword();
    changed = true;
  }
  for (const role of loginRoles) {
    if (logins[role] === undefined) {
      logins[role] = yield* generatePassword();
      changed = true;
    }
  }
  const state: StateFile = { admin: adminValue, logins };
  if (changed) yield* writeState(file, state);
  return toStore(state);
});

/**
 * Ensures an admin password and one password per login role exist. Returns
 * redacted values; never logs them.
 */
export const ensurePasswords = Effect.fn("devdb.ensurePasswords")(function* (
  loginRoles: ReadonlyArray<string>,
) {
  const home = yield* Config.String("HOME");
  const file = statePathFor(home);
  return yield* withLock(home, loadOrCreatePasswords(file, loginRoles));
});

/**
 * Read the existing password store without creating anything. Fails when the
 * cluster has never been brought up on this workstation.
 */
export const readPasswords = Effect.fn("devdb.readPasswords")(function* () {
  const home = yield* Config.String("HOME");
  const file = statePathFor(home);
  const current = yield* readState(file);
  return yield* Option.match(current, {
    onNone: () =>
      Effect.fail(
        new OpsError({
          message: `no ops dev db passwords at ${file}; run ops dev db up first`,
        }),
      ),
    onSome: (state) => Effect.succeed(toStore(state)),
  });
});
