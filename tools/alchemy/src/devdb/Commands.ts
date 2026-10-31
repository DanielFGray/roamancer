/**
 * `ops dev db` subcommands: up, reset, list and psql, on the dev instances of the cartridge in
 * the current directory. The databases live on the app's Postgres server; a host job
 * provisions them (Host.ts) and an SSH tunnel brings them to 127.0.0.1:5417 (Tunnel.ts).
 */
import { Console, Effect, FileSystem, Option } from "effect";
import { Argument, Command } from "effect/cli";
import * as Arr from "effect/Array";
import * as Redacted from "effect/Redacted";
import { postgresLoginRole } from "../Cartridge.ts";
import { OpsError } from "../Exec.ts";
import * as Exec from "../Exec.ts";
import { Remote } from "../Remote.ts";
import {
  type DevDbAction,
  type DevDbRequest,
  devDatabaseNames,
  devLoginRoles,
  managedEnvKeys,
  managedEnvValues,
  ownedDatabases,
  tunnelHost,
  tunnelPort,
} from "./Declaration.ts";
import { type DevDbCartridge, decodeDevDbFile } from "./DevDbCartridge.ts";
import { applyManagedKeys } from "./EnvFile.ts";
import { ensurePasswords, type PasswordStore } from "./Passwords.ts";
import { scramVerifier } from "./Scram.ts";
import { ensureTunnel } from "./Tunnel.ts";

const cwd = ".";

const up = Command.make(
  "up",
  {},
  Effect.fn(function* () {
    yield* runAction({ _tag: "Up" });
  }),
).pipe(
  Command.withDescription(
    "Provision this app's dev databases (with shadow and test) on the server, start the tunnel, and write .env",
  ),
);

const reset = Command.make(
  "reset",
  {
    database: Argument.String("database").pipe(
      Argument.withDescription(
        "Dev database to drop and provision again: <app>_dev (with shadow and test) or a _shadow or _test name",
      ),
    ),
  },
  Effect.fn(function* ({ database }) {
    yield* runAction({ _tag: "Reset", database });
  }),
).pipe(Command.withDescription("Drop and provision again one of this app's dev databases"));

const list = Command.make(
  "list",
  {},
  Effect.fn(function* () {
    yield* runAction({ _tag: "List" });
  }),
).pipe(Command.withDescription("List this app's dev databases on the server"));

const psql = Command.make(
  "psql",
  {
    database: Argument.String("database").pipe(
      Argument.withDescription("Dev database to open; defaults to the first one"),
      Argument.optional,
    ),
  },
  Effect.fn(function* ({ database }) {
    const cartridge = yield* readCartridge();
    const devDatabases = cartridge.postgres.map((entry) =>
      devDatabaseNames(cartridge.name, entry.database),
    );
    const name = yield* Option.match(
      Option.orElse(database, () => Option.map(Arr.head(devDatabases), (names) => names.live)),
      {
        onNone: () =>
          Effect.fail(new OpsError({ message: "no postgres database in cartridge.json" })),
        onSome: Effect.succeed,
      },
    );
    // A shadow or test database uses the logins of the dev database it belongs to.
    const owner = yield* Option.match(
      Arr.findFirst(devDatabases, (names) => Object.values(names).includes(name)),
      {
        onNone: () =>
          Effect.fail(
            new OpsError({ message: `'${name}' is not a dev database of '${cartridge.name}'` }),
          ),
        onSome: Effect.succeed,
      },
    );
    const role = postgresLoginRole(owner.live, "migration");
    const passwords = yield* ensurePasswords([role]);
    yield* ensureTunnel();
    yield* Exec.run("psql", ["-h", tunnelHost, "-p", String(tunnelPort), "-U", role, "-d", name], {
      PGPASSWORD: Redacted.value(passwords.forRole(role)),
    });
  }),
).pipe(Command.withDescription("psql as the migration login, through the tunnel"));

/** The `db` command under `ops dev`. */
export const db = Command.make("db").pipe(
  Command.withDescription("Dev databases for cartridge apps on the server's Postgres"),
  Command.withSubcommands([up, reset, list, psql]),
);

/** The `dev` command under `ops`. */
export const commands = [
  Command.make("dev").pipe(
    Command.withDescription("Workstation developer helpers"),
    Command.withSubcommands([db]),
  ),
];

/**
 * Sends `action` to the host as a dev-db job. An action that provisions also starts the
 * tunnel and writes the managed .env keys, because only then do the logins exist.
 */
const runAction = Effect.fn("devdb.runAction")(function* (action: DevDbAction) {
  const cartridge = yield* readCartridge();
  const passwords = yield* ensurePasswords(
    cartridge.postgres.flatMap((entry) =>
      devLoginRoles(devDatabaseNames(cartridge.name, entry.database).live),
    ),
  );
  const request = yield* devDbRequest(cartridge, passwords);
  const remote = yield* Remote;
  yield* remote.run({ command: "dev-db", request, action });
  if (action._tag === "List") return;
  yield* ensureTunnel();
  yield* writeEnv(
    managedEnvValues(managedEnvKeys(cartridge), (role) => Redacted.value(passwords.forRole(role))),
  );
  yield* Console.log(
    `${ownedDatabases(request).join(", ")} on ${tunnelHost}:${tunnelPort}; .env updated`,
  );
});

const readCartridge = Effect.fn("devdb.readCartridge")(function* () {
  const cartridge = yield* decodeDevDbFile(`${cwd}/cartridge.json`);
  // The tunnel reaches the platform Postgres server only.
  const elsewhere = cartridge.postgres.filter((entry) => entry.server !== undefined);
  if (elsewhere.length > 0) {
    return yield* new OpsError({
      message: `ops dev db serves the platform Postgres server only; ${elsewhere.map((entry) => entry.database).join(", ")} name another server`,
    });
  }
  return cartridge;
});

/** The request for the cartridge, with a fresh SCRAM verifier of each login's password. */
const devDbRequest = Effect.fn("devdb.devDbRequest")(function* (
  cartridge: DevDbCartridge,
  passwords: PasswordStore,
) {
  const verifier = (devDatabase: string, login: "api" | "migration") =>
    scramVerifier(passwords.forRole(postgresLoginRole(devDatabase, login)));
  const postgres = yield* Effect.forEach(cartridge.postgres, (entry) =>
    Effect.gen(function* () {
      const live = devDatabaseNames(cartridge.name, entry.database).live;
      return {
        database: entry.database,
        extensions: entry.extensions,
        logins: {
          api: yield* verifier(live, "api"),
          migration: yield* verifier(live, "migration"),
        },
      };
    }),
  );
  return { app: cartridge.name, postgres } satisfies DevDbRequest;
});

const writeEnv = Effect.fn("devdb.writeEnv")(function* (values: Readonly<Record<string, string>>) {
  const fs = yield* FileSystem.FileSystem;
  const file = `${cwd}/.env`;
  const exists = yield* fs.exists(file);
  const previous = exists ? yield* fs.readFileString(file) : "";
  const next = applyManagedKeys(previous, values);
  if (next === previous) return;
  yield* fs.writeFileString(file, next);
});
