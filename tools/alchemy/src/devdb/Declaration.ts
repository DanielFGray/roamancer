/**
 * Cartridge → provisioning declarations and the .env keys PostgresCredentials name.
 */
import type { Cartridge } from "../Cartridge.ts";
import { postgresLoginRole } from "../Cartridge.ts";
import { postgresRoles } from "../PostgresDatabase.ts";
import type {
  PostgresDatabaseDeclaration,
  PostgresLoginDeclaration,
} from "../PostgresProvisioning.ts";
import type * as Redacted from "effect/Redacted";
import { HOST, PORT } from "./Cluster.ts";

export type ManagedEnvKey = {
  readonly kind: "url" | "username" | "password";
  readonly env: string;
  readonly database: string;
  readonly login: "api" | "migration";
};

/** Every PostgresCredentials env binding across services and migrate tasks, unique by env name. */
export const managedEnvKeys = (cartridge: Cartridge): ReadonlyArray<ManagedEnvKey> => {
  const byEnv = new Map<string, ManagedEnvKey>();
  const consider = (secret: {
    readonly _tag: string;
    readonly database?: string;
    readonly login?: "api" | "migration";
    readonly usernameEnv?: string;
    readonly passwordEnv?: string;
    readonly urlEnv?: string;
  }) => {
    if (secret._tag !== "PostgresCredentials") return;
    const database = secret.database!;
    const login = secret.login!;
    if (secret.urlEnv !== undefined) {
      byEnv.set(secret.urlEnv, { kind: "url", env: secret.urlEnv, database, login });
    }
    if (secret.usernameEnv !== undefined) {
      byEnv.set(secret.usernameEnv, {
        kind: "username",
        env: secret.usernameEnv,
        database,
        login,
      });
    }
    if (secret.passwordEnv !== undefined) {
      byEnv.set(secret.passwordEnv, {
        kind: "password",
        env: secret.passwordEnv,
        database,
        login,
      });
    }
  };

  for (const service of cartridge.services) {
    for (const secret of service.secrets) consider(secret);
    for (const secret of service.migrate?.secrets ?? []) consider(secret);
  }
  return [...byEnv.values()];
};

export const loginDeclarations = (
  database: string,
  passwordFor: (role: string) => Redacted.Redacted<string>,
): ReadonlyArray<PostgresLoginDeclaration> => {
  const roles = postgresRoles(database);
  return [
    {
      name: postgresLoginRole(database, "api"),
      memberOf: roles.visitor,
      inherit: false,
      password: passwordFor(postgresLoginRole(database, "api")),
    },
    {
      name: postgresLoginRole(database, "migration"),
      memberOf: roles.owner,
      inherit: true,
      password: passwordFor(postgresLoginRole(database, "migration")),
    },
  ];
};

/** One provisioning declaration per cartridge postgres entry. */
export const databaseDeclarations = (
  cartridge: Cartridge,
  passwordFor: (role: string) => Redacted.Redacted<string>,
): ReadonlyArray<PostgresDatabaseDeclaration> =>
  cartridge.postgres.map((entry) => {
    const roles = postgresRoles(entry.database);
    return {
      name: entry.database,
      ownerRole: roles.owner,
      visitorRole: roles.visitor,
      extensions: entry.extensions,
      logins: loginDeclarations(entry.database, passwordFor),
    };
  });

export const connectionUrl = (input: {
  readonly username: string;
  readonly password: string;
  readonly database: string;
  readonly host?: string;
  readonly port?: number;
}) =>
  `postgresql://${encodeURIComponent(input.username)}:${encodeURIComponent(input.password)}@${input.host ?? HOST}:${input.port ?? PORT}/${input.database}?sslmode=disable`;

/** Values to write for the managed keys, from login role names and passwords. */
export const managedEnvValues = (
  keys: ReadonlyArray<ManagedEnvKey>,
  passwordFor: (role: string) => string,
): Record<string, string> => {
  const values: Record<string, string> = {};
  for (const key of keys) {
    const role = postgresLoginRole(key.database, key.login);
    if (key.kind === "username") values[key.env] = role;
    else if (key.kind === "password") values[key.env] = passwordFor(role);
    else
      values[key.env] = connectionUrl({
        username: role,
        password: passwordFor(role),
        database: key.database,
      });
  }
  return values;
};
