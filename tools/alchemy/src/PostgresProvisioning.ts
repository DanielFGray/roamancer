/**
 * Shared Postgres provisioning: roles, database, extensions and optional login
 * passwords. Imports nothing from Alchemy, Nomad, OpenBao or OperationJournal.
 * The Alchemy provider and `ops dev db` both call this.
 */
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import type * as Scope from "effect/Scope";
import * as S from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

export class PostgresProvisioningError extends S.TaggedError<PostgresProvisioningError>()(
  "PostgresProvisioningError",
  {
    operation: S.String,
    target: S.String,
    detail: S.optional(S.String),
  },
) {
  override get message() {
    return `${this.operation}: ${this.target}${Option.match(Option.fromNullishOr(this.detail), {
      onNone: () => "",
      onSome: (detail) => `: ${detail}`,
    })}`;
  }
}

/**
 * A login the cluster should hold with a static password (ops). The Alchemy
 * provider leaves this list empty so OpenBao can issue dynamic credentials.
 */
export type PostgresLoginDeclaration = {
  readonly name: string;
  readonly memberOf: string;
  readonly inherit: boolean;
  readonly password: Redacted.Redacted<string>;
};

export type PostgresDatabaseDeclaration = {
  readonly name: string;
  readonly ownerRole: string;
  readonly visitorRole: string;
  readonly extensions: ReadonlyArray<string>;
  readonly logins: ReadonlyArray<PostgresLoginDeclaration>;
};

export type PostgresAdminLayer<E = never, R = never> = (
  database: string,
) => Layer.Layer<SqlClient.SqlClient, E, R>;

/**
 * One place for LOGIN / NOINHERIT and the session-role statement. OpenBao builds
 * creation_statements from this; ensureLoginRole applies the same rules in SQL.
 */
export const loginRolePolicy = (inherit: boolean) => ({
  /** CREATE ROLE ... WITH <options> */
  options: (inherit ? "LOGIN" : "LOGIN NOINHERIT") as "LOGIN" | "LOGIN NOINHERIT",
  /**
   * Session-role SQL for identifiers already quoted for the statement dialect
   * (OpenBao templates use `"{{name}}"`; live SQL uses format %I).
   */
  sessionRoleStatement: (roleSql: string, memberOfSql: string): string =>
    inherit
      ? `ALTER ROLE ${roleSql} SET role = ${memberOfSql}`
      : `ALTER ROLE ${roleSql} RESET role`,
});

/**
 * Makes one database on the cluster match `declaration`: group roles, database
 * with owner, extensions on every run, and login roles that carry a password.
 * `adminLayer` opens an admin SqlClient for the named database (`postgres` for
 * cluster work, the target name for extensions).
 */
export const provisionPostgresDatabase = <E, R>(
  declaration: PostgresDatabaseDeclaration,
  adminLayer: PostgresAdminLayer<E, R>,
): Effect.Effect<
  { readonly created: boolean },
  E | PostgresProvisioningError | SqlError,
  Exclude<R, Scope.Scope>
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const lockPool = yield* Layer.build(adminLayer("postgres"));
      yield* lockDatabase(declaration.name).pipe(Effect.provideContext(lockPool));
      yield* ensureDatabaseRoles({
        name: declaration.name,
        ownerRole: declaration.ownerRole,
        visitorRole: declaration.visitorRole,
      }).pipe(Effect.provide(adminLayer("postgres")));
      const created = yield* createDatabase({
        name: declaration.name,
        ownerRole: declaration.ownerRole,
      }).pipe(Effect.provide(adminLayer("postgres")));
      yield* ensureExtensions({
        database: declaration.name,
        extensions: declaration.extensions,
      }).pipe(Effect.provide(adminLayer(declaration.name)));
      yield* ensureLoginRoles(declaration).pipe(Effect.provide(adminLayer("postgres")));
      return { created };
    }),
  );

// --- helpers ----------------------------------------------------------------

// Creates a group role that cannot log in, or fails when the name already belongs to a login role.
// Logins join group roles, so a group that someone can log in as would hand out its rights directly.
const ensureGroupRole = (sql: SqlClient.SqlClient, role: string, target: string) =>
  Effect.gen(function* () {
    const roles = yield* sql<{ readonly rolcanlogin: boolean }>`
      SELECT rolcanlogin FROM pg_roles WHERE rolname = ${role}
    `.pipe(
      Effect.mapError(
        () => new PostgresProvisioningError({ operation: "read group role", target }),
      ),
    );
    const existing = Option.map(Arr.head(roles), (row) => row.rolcanlogin);
    yield* Option.match(existing, {
      onNone: () =>
        sql`CREATE ROLE ${sql(role)} NOLOGIN`.pipe(
          Effect.asVoid,
          Effect.mapError(
            () =>
              new PostgresProvisioningError({
                operation: "create group role",
                target,
              }),
          ),
        ),
      onSome: (canLogin) =>
        canLogin
          ? Effect.fail(
              new PostgresProvisioningError({
                operation: "validate group role",
                target: role,
              }),
            )
          : Effect.void,
    });
  });

/**
 * Takes the advisory lock of one database on a reserved connection and holds it until the
 * enclosing scope closes. A session lock belongs to its connection, and a pooled query may run
 * on any connection, so the lock needs a connection that no other query uses.
 */
export const lockDatabase = Effect.fn("PostgresProvisioning.lockDatabase")(function* (
  name: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const connection = yield* sql.reserve;
  const key = [`alchemy:${name}`];
  const lockError = () =>
    new PostgresProvisioningError({ operation: "lock database", target: name });
  yield* Effect.acquireRelease(
    connection
      .execute("SELECT pg_advisory_lock(hashtextextended($1, 0))", key, undefined)
      .pipe(Effect.mapError(lockError)),
    () =>
      connection
        .execute("SELECT pg_advisory_unlock(hashtextextended($1, 0))", key, undefined)
        .pipe(Effect.ignore),
  );
});

/** Group roles and the grant that lets the admin create a database owned by the owner role. */
export const ensureDatabaseRoles = Effect.fn("PostgresProvisioning.ensureDatabaseRoles")(
  function* (input: {
    readonly name: string;
    readonly ownerRole: string;
    readonly visitorRole: string;
  }) {
    const sql = yield* SqlClient.SqlClient;
    yield* ensureGroupRole(sql, input.ownerRole, input.name);
    yield* ensureGroupRole(sql, input.visitorRole, input.name);
    // CREATE DATABASE ... OWNER requires the creator to be a member of the owner role, and a role
    // that creates another role does not become its member on PostgreSQL 17.
    yield* sql`GRANT ${sql(input.ownerRole)} TO CURRENT_USER`.pipe(
      Effect.asVoid,
      Effect.mapError(
        () =>
          new PostgresProvisioningError({
            operation: "grant owner role",
            target: input.name,
          }),
      ),
    );
  },
);

export const readDatabaseOwner = Effect.fn("PostgresProvisioning.readDatabaseOwner")(function* (
  name: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const databases = yield* sql<{ readonly owner: string }>`
      SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = ${name}
    `.pipe(
    Effect.mapError(
      () =>
        new PostgresProvisioningError({
          operation: "read database",
          target: name,
        }),
    ),
  );
  return Option.map(Arr.head(databases), (database) => database.owner);
});

/** Creates the database when missing; fails when it exists under a different owner. */
export const createDatabase = Effect.fn("PostgresProvisioning.createDatabase")(function* (input: {
  readonly name: string;
  readonly ownerRole: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const databaseOwner = yield* readDatabaseOwner(input.name);
  const created = yield* Option.match(databaseOwner, {
    onNone: () =>
      sql`CREATE DATABASE ${sql(input.name)} OWNER ${sql(input.ownerRole)}`.pipe(
        Effect.as(true),
        Effect.mapError(
          () =>
            new PostgresProvisioningError({
              operation: "create database",
              target: input.name,
            }),
        ),
      ),
    onSome: (owner) =>
      owner === input.ownerRole
        ? Effect.succeed(false)
        : Effect.fail(
            new PostgresProvisioningError({
              operation: "validate database owner",
              target: input.name,
            }),
          ),
  });
  return created;
});

/**
 * Runs as the admin, a superuser, so untrusted extensions work too. It checks every name before
 * it creates any, so an extension missing from the server image changes nothing. Ensured on every
 * run so a failed earlier install is repaired.
 */
export const ensureExtensions = Effect.fn("PostgresProvisioning.ensureExtensions")(
  function* (input: { readonly database: string; readonly extensions: ReadonlyArray<string> }) {
    if (input.extensions.length === 0) return;
    const sql = yield* SqlClient.SqlClient;
    const available = yield* sql<{ readonly name: string }>`
      SELECT name FROM pg_available_extensions WHERE name IN ${sql.in(input.extensions)}
    `.pipe(
      Effect.mapError(
        () =>
          new PostgresProvisioningError({
            operation: "read extensions",
            target: input.database,
          }),
      ),
    );
    const missing = input.extensions.filter(
      (extension) => !available.some((row) => row.name === extension),
    );
    if (missing.length > 0) {
      return yield* new PostgresProvisioningError({
        operation: "find extensions in the server image",
        target: missing.join(", "),
      });
    }
    yield* Effect.forEach(
      input.extensions,
      (extension) =>
        sql`CREATE EXTENSION IF NOT EXISTS ${sql(extension)}`.pipe(
          Effect.mapError(
            () =>
              new PostgresProvisioningError({
                operation: "create extension",
                target: extension,
              }),
          ),
        ),
      { discard: true },
    );
  },
);

/**
 * CREATE/ALTER ROLE password and SET/RESET role clauses reject bound parameters, so
 * format() builds a literal statement and unsafe runs it.
 */
const runFormatted = (
  sql: SqlClient.SqlClient,
  template: string,
  args: ReadonlyArray<string>,
  operation: string,
  target: string,
) =>
  Effect.gen(function* () {
    const rows = yield* (
      args.length === 1
        ? sql<{ readonly stmt: string }>`
          SELECT format(${template}::text, ${args[0]!}::text) AS stmt
        `
        : sql<{ readonly stmt: string }>`
          SELECT format(${template}::text, ${args[0]!}::text, ${args[1]!}::text) AS stmt
        `
    ).pipe(
      Effect.mapError(
        () => new PostgresProvisioningError({ operation: `format ${operation}`, target }),
      ),
    );
    const stmt = yield* Option.match(Arr.head(rows), {
      onNone: () =>
        Effect.fail(new PostgresProvisioningError({ operation: `format ${operation}`, target })),
      onSome: (row) => Effect.succeed(row.stmt),
    });
    yield* sql.unsafe(stmt).pipe(
      Effect.asVoid,
      Effect.mapError(() => new PostgresProvisioningError({ operation, target })),
    );
  });

const otherGroupRole = (
  declaration: Pick<PostgresDatabaseDeclaration, "ownerRole" | "visitorRole">,
  memberOf: string,
): Option.Option<string> => {
  if (memberOf === declaration.ownerRole) return Option.some(declaration.visitorRole);
  if (memberOf === declaration.visitorRole) return Option.some(declaration.ownerRole);
  return Option.none();
};

const ensureLoginRole = (
  sql: SqlClient.SqlClient,
  declaration: PostgresDatabaseDeclaration,
  login: PostgresLoginDeclaration,
) =>
  Effect.gen(function* () {
    const policy = loginRolePolicy(login.inherit);
    const secret = Redacted.value(login.password);
    const roles = yield* sql<{
      readonly rolcanlogin: boolean;
      readonly rolinherit: boolean;
    }>`
      SELECT rolcanlogin, rolinherit FROM pg_roles WHERE rolname = ${login.name}
    `.pipe(
      Effect.mapError(
        () =>
          new PostgresProvisioningError({
            operation: "read login role",
            target: login.name,
          }),
      ),
    );
    const existing = Arr.head(roles);
    yield* Option.match(existing, {
      onNone: () =>
        runFormatted(
          sql,
          `CREATE ROLE %I WITH ${policy.options} PASSWORD %L`,
          [login.name, secret],
          "create login role",
          login.name,
        ),
      onSome: (row) =>
        Effect.gen(function* () {
          if (!row.rolcanlogin) {
            return yield* new PostgresProvisioningError({
              operation: "validate login role",
              target: login.name,
            });
          }
          if (row.rolinherit !== login.inherit) {
            yield* (
              login.inherit
                ? sql`ALTER ROLE ${sql(login.name)} INHERIT`
                : sql`ALTER ROLE ${sql(login.name)} NOINHERIT`
            ).pipe(
              Effect.asVoid,
              Effect.mapError(
                () =>
                  new PostgresProvisioningError({
                    operation: "set login inherit",
                    target: login.name,
                  }),
              ),
            );
          }
          // Password is set only at create; rotation is `ops dev db reset`.
        }),
    });
    yield* sql`GRANT ${sql(login.memberOf)} TO ${sql(login.name)}`.pipe(
      Effect.asVoid,
      Effect.mapError(
        () =>
          new PostgresProvisioningError({
            operation: "grant login membership",
            target: login.name,
          }),
      ),
    );
    yield* Option.match(otherGroupRole(declaration, login.memberOf), {
      onNone: () => Effect.void,
      onSome: (other) =>
        sql`REVOKE ${sql(other)} FROM ${sql(login.name)}`.pipe(
          Effect.asVoid,
          Effect.mapError(
            () =>
              new PostgresProvisioningError({
                operation: "revoke other group membership",
                target: login.name,
              }),
          ),
        ),
    });
    yield* sql`GRANT CONNECT ON DATABASE ${sql(declaration.name)} TO ${sql(login.name)}`.pipe(
      Effect.asVoid,
      Effect.mapError(
        () =>
          new PostgresProvisioningError({
            operation: "grant login connect",
            target: login.name,
          }),
      ),
    );
    const quoted = yield* sql<{ readonly role: string; readonly member: string }>`
      SELECT quote_ident(${login.name}::text) AS role, quote_ident(${login.memberOf}::text) AS member
    `.pipe(
      Effect.mapError(
        () =>
          new PostgresProvisioningError({
            operation: "quote login identifiers",
            target: login.name,
          }),
      ),
    );
    const idents = yield* Option.match(Arr.head(quoted), {
      onNone: () =>
        Effect.fail(
          new PostgresProvisioningError({
            operation: "quote login identifiers",
            target: login.name,
          }),
        ),
      onSome: (row) => Effect.succeed(row),
    });
    yield* sql.unsafe(policy.sessionRoleStatement(idents.role, idents.member)).pipe(
      Effect.asVoid,
      Effect.mapError(
        () =>
          new PostgresProvisioningError({
            operation: "set login session role",
            target: login.name,
          }),
      ),
    );
  });

const ensureLoginRoles = Effect.fn("PostgresProvisioning.ensureLoginRoles")(function* (
  declaration: PostgresDatabaseDeclaration,
) {
  if (declaration.logins.length === 0) return;
  const sql = yield* SqlClient.SqlClient;
  yield* Effect.forEach(declaration.logins, (login) => ensureLoginRole(sql, declaration, login), {
    discard: true,
  });
});
