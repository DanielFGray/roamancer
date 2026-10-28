/**
 * `ops dev db` subcommands: up, psql, list, reset, down. Always use the cwd.
 */
import { Console, Effect, FileSystem, Option } from "effect";
import { Argument, Command } from "effect/cli";
import * as Redacted from "effect/Redacted";
import { postgresLoginRole } from "../Cartridge.ts";
import { OpsError } from "../Exec.ts";
import {
  databaseDeclarations,
  loginDeclarations,
  managedEnvKeys,
  managedEnvValues,
} from "./Declaration.ts";
import { decodeDevDbFile } from "./DevDbCartridge.ts";
import { applyManagedKeys } from "./EnvFile.ts";
import {
  CONTAINER,
  ensureContainer,
  HOST,
  listDatabases,
  PORT,
  provisionAll,
  requireManagedContainer,
  resetDatabase,
  runPsql,
  stopContainer,
} from "./Cluster.ts";
import { ensurePasswords, readPasswords } from "./Passwords.ts";

const cwd = ".";

const readCartridge = Effect.fn("devdb.readCartridge")(function* () {
  return yield* decodeDevDbFile(`${cwd}/cartridge.json`);
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

const up = Command.make(
  "up",
  {},
  Effect.fn(function* () {
    const cartridge = yield* readCartridge();
    const roles = cartridge.postgres.flatMap((entry) => [
      postgresLoginRole(entry.database, "api"),
      postgresLoginRole(entry.database, "migration"),
    ]);
    const passwords = yield* ensurePasswords(roles);
    yield* ensureContainer(passwords.admin);
    const declarations = databaseDeclarations(cartridge, passwords.forRole);
    yield* provisionAll(declarations, passwords.admin);
    const values = managedEnvValues(managedEnvKeys(cartridge), (role) =>
      Redacted.value(passwords.forRole(role)),
    );
    yield* writeEnv(values);
    yield* Console.log(
      `${CONTAINER} ready on ${HOST}:${PORT}; provisioned ${declarations.map((d) => d.name).join(", ") || "(no databases)"}`,
    );
  }),
).pipe(
  Command.withDescription(
    "Start the shared Postgres 17 cluster and provision this app's databases into .env",
  ),
);

const list = Command.make(
  "list",
  {},
  Effect.fn(function* () {
    const passwords = yield* readPasswords();
    const rows = yield* listDatabases(passwords.admin);
    for (const row of rows) {
      yield* Console.log(`${row.name}\t${row.owner}`);
    }
  }),
).pipe(Command.withDescription("List databases on the managed cluster"));

const down = Command.make(
  "down",
  {},
  Effect.fn(function* () {
    yield* stopContainer();
    yield* Console.log(`stopped ${CONTAINER} (volume kept)`);
  }),
).pipe(Command.withDescription("Stop the shared cluster; never deletes the volume"));

const reset = Command.make(
  "reset",
  {
    database: Argument.String("database").pipe(
      Argument.withDescription("Database name to drop and re-provision"),
    ),
  },
  Effect.fn(function* ({ database }) {
    yield* requireManagedContainer();
    const cartridge = yield* readCartridge();
    const roles = [postgresLoginRole(database, "api"), postgresLoginRole(database, "migration")];
    const passwords = yield* ensurePasswords(roles);
    const declaration = databaseDeclarations(cartridge, passwords.forRole).find(
      (entry) => entry.name === database,
    );
    if (declaration === undefined) {
      return yield* new OpsError({
        message: `database '${database}' is not declared in cartridge.json`,
      });
    }
    yield* resetDatabase(declaration, passwords.admin);
    const values = managedEnvValues(
      managedEnvKeys(cartridge).filter((key) => key.database === database),
      (role) => Redacted.value(passwords.forRole(role)),
    );
    yield* writeEnv(values);
    yield* Console.log(`reset ${database}`);
  }),
).pipe(Command.withDescription("Drop and re-provision one database on the managed cluster"));

const psql = Command.make(
  "psql",
  {
    database: Argument.String("database").pipe(
      Argument.withDescription(
        "Database to open; defaults to the cartridge's first postgres entry",
      ),
      Argument.optional,
    ),
  },
  Effect.fn(function* ({ database }) {
    const cartridge = yield* readCartridge();
    const name = Option.match(database, {
      onNone: () => cartridge.postgres[0]?.database,
      onSome: (value) => value,
    });
    if (name === undefined) {
      return yield* new OpsError({ message: "no postgres database in cartridge.json" });
    }
    const roleNames = loginDeclarations(name, () => Redacted.make("")).map((login) => login.name);
    const passwords = yield* ensurePasswords(roleNames);
    const migration = loginDeclarations(name, passwords.forRole).find((login) => login.inherit);
    if (migration === undefined) {
      return yield* new OpsError({ message: `no migration login for ${name}` });
    }
    yield* runPsql({
      database: name,
      username: migration.name,
      password: migration.password,
    });
  }),
).pipe(Command.withDescription("psql as the migration login inside the managed container"));

/** The `db` command under `ops dev`. */
export const db = Command.make("db").pipe(
  Command.withDescription("Local shared Postgres 17 for cartridge apps"),
  Command.withSubcommands([up, psql, list, reset, down]),
);

/** The `dev` command under `ops`. */
export const commands = [
  Command.make("dev").pipe(
    Command.withDescription("Workstation developer helpers"),
    Command.withSubcommands([db]),
  ),
];
