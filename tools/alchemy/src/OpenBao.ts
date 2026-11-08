import { Config, Context, Effect, Layer, Option, Redacted, Schema as S } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { loginRolePolicy } from "./PostgresProvisioning.ts";

const KvValue = S.Struct({
  data: S.Struct({
    data: S.Record(S.String, S.String),
    metadata: S.Struct({ version: S.Number }),
  }),
});
const CreatedToken = S.Struct({ auth: S.Struct({ client_token: S.String }) });
const DatabaseConfig = S.Struct({
  data: S.Struct({
    connection_details: S.Struct({ connection_url: S.String }),
  }),
});
const ValkeyCredentials = S.Struct({
  username: S.String,
  password: S.String,
});
const AdminCredential = S.Struct({ password: S.String });

export class OpenBaoError extends S.TaggedError<OpenBaoError>()("OpenBaoError", {
  operation: S.String,
  target: S.String,
}) {
  override get message() {
    return `${this.operation}: ${this.target}`;
  }
}

type DatabaseConnection = {
  readonly name: string;
  readonly allowedRoles: ReadonlyArray<string>;
  readonly connectionUrl: string;
  readonly username: string;
  readonly password: Redacted.Redacted<string>;
};

type DatabaseRole = {
  readonly name: string;
  readonly databaseConfig: string;
  readonly database: string;
  readonly ownerRole: string;
  // The group role that each dynamic login joins.
  readonly memberOf: string;
  // A login that does not inherit must switch to the group role with SET ROLE before it reads
  // or writes tables. Row-level security then applies to every request. A login that inherits
  // starts each session as the group role, so the objects it creates belong to that role.
  readonly inherit: boolean;
  readonly defaultTtl: string;
  readonly maxTtl: string;
};

// The SQL that OpenBao runs for each new login. OpenBao substitutes {{name}}, {{password}}
// and {{expiration}}. LOGIN / NOINHERIT and the session-role statement come from
// loginRolePolicy so they cannot drift from ensureLoginRole.
export const databaseCreationStatements = (
  role: Pick<DatabaseRole, "database" | "memberOf" | "inherit">,
): string => {
  const user = '"{{name}}"';
  const member = `"${role.memberOf}"`;
  const policy = loginRolePolicy(role.inherit);
  return [
    `CREATE ROLE ${user} WITH ${policy.options} PASSWORD '{{password}}' VALID UNTIL '{{expiration}}';`,
    `GRANT ${member} TO ${user};`,
    `GRANT CONNECT ON DATABASE "${role.database}" TO ${user};`,
    // Each release gets a new migration login. Tables owned by an earlier login would refuse
    // ALTER from the next one, so the login creates them as the owner role instead.
    // A NOINHERIT login clears any leftover session role so SET ROLE stays explicit.
    `${policy.sessionRoleStatement(user, member)};`,
  ].join(" ");
};

// A login that created tables owns them, and DROP ROLE refuses while a role owns objects.
// Hand the objects to the owner role first, so a revoked lease never leaves a role behind.
// REASSIGN OWNED and DROP OWNED need the privileges of the login, so OpenBao's own role joins it
// for the duration of the revocation.
export const databaseRevocationStatements = (role: Pick<DatabaseRole, "ownerRole">): string =>
  [
    `GRANT "{{name}}" TO CURRENT_USER;`,
    `REASSIGN OWNED BY "{{name}}" TO "${role.ownerRole}";`,
    `DROP OWNED BY "{{name}}";`,
    `DROP ROLE IF EXISTS "{{name}}";`,
  ].join(" ");

type WorkloadRole = {
  readonly name: string;
  readonly job: string;
  readonly secretPaths: ReadonlyArray<string>;
};

type WriteBody =
  | {
      readonly plugin_name: "postgresql-database-plugin";
      readonly allowed_roles: string;
      readonly connection_url: string;
      readonly username: string;
      readonly password: string;
      readonly password_authentication: "scram-sha-256";
    }
  | {
      readonly db_name: string;
      readonly creation_statements: string;
      readonly revocation_statements: string;
      readonly default_ttl: string;
      readonly max_ttl: string;
    }
  | { readonly policy: string }
  | { readonly data: Readonly<Record<string, string>> }
  // A KV v2 write that fails unless the secret is still at version `cas` (0: not yet written).
  | { readonly options: { readonly cas: number }; readonly data: Readonly<Record<string, string>> }
  | { readonly ttl: string }
  | {
      readonly role_type: "jwt";
      readonly bound_audiences: ReadonlyArray<string>;
      readonly bound_claims: {
        readonly nomad_namespace: string;
        readonly nomad_job_id: string;
      };
      readonly user_claim: string;
      readonly user_claim_json_pointer: boolean;
      readonly token_policies: ReadonlyArray<string>;
      readonly token_type: "service";
      readonly token_period: string;
    };

export class OpenBao extends Context.Service<
  OpenBao,
  {
    readonly readKv: (
      path: string,
      key: string,
    ) => Effect.Effect<Redacted.Redacted<string>, OpenBaoError>;
    readonly readValkeyCredentials: (path: string) => Effect.Effect<
      Option.Option<{
        readonly username: string;
        readonly password: Redacted.Redacted<string>;
      }>,
      OpenBaoError
    >;
    readonly readAdminCredential: (
      path: string,
    ) => Effect.Effect<Option.Option<Redacted.Redacted<string>>, OpenBaoError>;
    readonly writeValkeyCredentials: (
      path: string,
      credentials: typeof ValkeyCredentials.Type,
    ) => Effect.Effect<void, OpenBaoError>;
    readonly readPostgresConnectionUrl: (
      name: string,
    ) => Effect.Effect<Option.Option<string>, OpenBaoError>;
    readonly configurePostgres: (
      connection: DatabaseConnection,
      roles: ReadonlyArray<DatabaseRole>,
    ) => Effect.Effect<void, OpenBaoError>;
    readonly configureWorkloadRole: (role: WorkloadRole) => Effect.Effect<void, OpenBaoError>;
    /** Every key and value stored at a KV v2 path; None when nothing is stored there. */
    readonly readKvData: (
      path: string,
    ) => Effect.Effect<Option.Option<Readonly<Record<string, string>>>, OpenBaoError>;
    /** Replaces every key at a KV v2 path with `data`, in one write. */
    readonly writeKvData: (
      path: string,
      data: Readonly<Record<string, string>>,
    ) => Effect.Effect<void, OpenBaoError>;
    /** The key names stored at a KV v2 path; None when nothing is stored there. */
    readonly readKvKeys: (
      path: string,
    ) => Effect.Effect<Option.Option<ReadonlyArray<string>>, OpenBaoError>;
    /** Sets one key at a KV v2 path and keeps the others. Fails if another write landed in between. */
    readonly writeKvKey: (
      path: string,
      key: string,
      value: Redacted.Redacted<string>,
    ) => Effect.Effect<void, OpenBaoError>;
    /** Succeeds while the configured token is valid. */
    readonly checkToken: () => Effect.Effect<void, OpenBaoError>;
    /** A child of the configured token that expires after `ttl` (for example "2h"). */
    readonly createToken: (ttl: string) => Effect.Effect<Redacted.Redacted<string>, OpenBaoError>;
  }
>()("alchemy/OpenBao") {
  static readonly layer = Layer.effect(
    OpenBao,
    Effect.gen(function* () {
      const address = yield* Config.option(Config.String("OPENBAO_ADDR"));
      const token = yield* Config.option(Config.Redacted("OPENBAO_TOKEN"));
      const http = yield* HttpClient.HttpClient;

      const request = Effect.fn("OpenBao.request")(function* (
        operation: string,
        target: string,
        method: "GET" | "POST" | "PUT",
        path: string,
        body?: WriteBody,
      ) {
        const baseAddress = yield* Option.match(address, {
          onNone: () => Effect.fail(new OpenBaoError({ operation, target })),
          onSome: Effect.succeed,
        });
        const authToken = yield* Option.match(token, {
          onNone: () => Effect.fail(new OpenBaoError({ operation, target })),
          onSome: Effect.succeed,
        });
        const client = http.pipe(
          HttpClient.mapRequest((request) =>
            HttpClientRequest.setHeader("X-Vault-Token", Redacted.value(authToken))(request),
          ),
          HttpClient.mapRequest(HttpClientRequest.prependUrl(baseAddress)),
        );
        const req =
          body === undefined
            ? Effect.succeed(HttpClientRequest.make(method)(`/v1/${path}`))
            : HttpClientRequest.make(method)(`/v1/${path}`).pipe(
                HttpClientRequest.bodyJson(body),
                Effect.mapError(() => new OpenBaoError({ operation, target })),
              );
        const response = yield* req.pipe(
          Effect.flatMap(client.execute),
          Effect.mapError(() => new OpenBaoError({ operation, target })),
          Effect.flatMap((response) =>
            HttpClientResponse.filterStatusOk(response).pipe(
              Effect.mapError(() => new OpenBaoError({ operation, target })),
            ),
          ),
        );
        return response;
      });

      // Reads a path that may not exist yet: OpenBao answers 404 for it, which becomes None.
      const getOptional = Effect.fn("OpenBao.getOptional")(function* (
        operation: string,
        path: string,
      ) {
        const baseAddress = yield* Option.match(address, {
          onNone: () => Effect.fail(new OpenBaoError({ operation, target: path })),
          onSome: Effect.succeed,
        });
        const authToken = yield* Option.match(token, {
          onNone: () => Effect.fail(new OpenBaoError({ operation, target: path })),
          onSome: Effect.succeed,
        });
        const client = http.pipe(
          HttpClient.mapRequest((request) =>
            HttpClientRequest.setHeader("X-Vault-Token", Redacted.value(authToken))(request),
          ),
          HttpClient.mapRequest(HttpClientRequest.prependUrl(baseAddress)),
        );
        const response = yield* client
          .execute(HttpClientRequest.get(`/v1/${path}`))
          .pipe(Effect.mapError(() => new OpenBaoError({ operation, target: path })));
        if (response.status === 404) {
          return yield* response.text.pipe(
            Effect.as(Option.none()),
            Effect.mapError(() => new OpenBaoError({ operation, target: path })),
          );
        }
        const ok = yield* HttpClientResponse.filterStatusOk(response).pipe(
          Effect.mapError(() => new OpenBaoError({ operation, target: path })),
        );
        return Option.some(ok);
      });

      const readPostgresConnectionUrl = Effect.fn("OpenBao.readPostgresConnectionUrl")(function* (
        name: string,
      ) {
        const path = `database/config/${encodeURIComponent(name)}`;
        const found = yield* getOptional("read PostgreSQL connection", path);
        if (Option.isNone(found)) return Option.none();
        const value = yield* HttpClientResponse.schemaBodyJson(DatabaseConfig)(found.value).pipe(
          Effect.mapError(
            () =>
              new OpenBaoError({
                operation: "decode PostgreSQL connection",
                target: name,
              }),
          ),
        );
        return Option.some(value.data.connection_details.connection_url);
      });

      const readValkeyCredentials = Effect.fn("OpenBao.readValkeyCredentials")(function* (
        path: string,
      ) {
        const found = yield* getOptional("read credentials", path);
        if (Option.isNone(found)) return Option.none();
        const value = yield* HttpClientResponse.schemaBodyJson(KvValue)(found.value).pipe(
          Effect.mapError(
            () =>
              new OpenBaoError({
                operation: "decode credentials",
                target: path,
              }),
          ),
        );
        const credentials = yield* S.decodeUnknownEffect(ValkeyCredentials)(value.data.data).pipe(
          Effect.mapError(
            () =>
              new OpenBaoError({
                operation: "decode credentials",
                target: path,
              }),
          ),
        );
        return Option.some({
          username: credentials.username,
          password: Redacted.make(credentials.password),
        });
      });

      const writeValkeyCredentials = Effect.fn("OpenBao.writeValkeyCredentials")(function* (
        path: string,
        credentials: typeof ValkeyCredentials.Type,
      ) {
        yield* request("write credentials", path, "PUT", path, {
          data: credentials,
        });
      });

      const readAdminCredential = Effect.fn("OpenBao.readAdminCredential")(function* (
        path: string,
      ) {
        const found = yield* getOptional("read admin credential", path);
        if (Option.isNone(found)) return Option.none();
        const value = yield* HttpClientResponse.schemaBodyJson(KvValue)(found.value).pipe(
          Effect.mapError(
            () =>
              new OpenBaoError({
                operation: "decode admin credential",
                target: path,
              }),
          ),
        );
        const credential = yield* S.decodeUnknownEffect(AdminCredential)(value.data.data).pipe(
          Effect.mapError(
            () =>
              new OpenBaoError({
                operation: "decode admin credential",
                target: path,
              }),
          ),
        );
        return Option.some(Redacted.make(credential.password));
      });

      const readKv = Effect.fn("OpenBao.readKv")(function* (path: string, key: string) {
        const response = yield* request("read secret", path, "GET", path);
        const decoded = yield* HttpClientResponse.schemaBodyJson(KvValue)(response).pipe(
          Effect.mapError(() => new OpenBaoError({ operation: "read secret", target: path })),
        );
        const value = decoded.data.data[key];
        if (value === undefined) {
          return yield* new OpenBaoError({
            operation: "read secret key",
            target: path,
          });
        }
        return Redacted.make(value);
      });

      const configurePostgres = Effect.fn("OpenBao.configurePostgres")(function* (
        connection: DatabaseConnection,
        roles: ReadonlyArray<DatabaseRole>,
      ) {
        const encodedConnection = {
          plugin_name: "postgresql-database-plugin",
          allowed_roles: connection.allowedRoles.join(","),
          connection_url: connection.connectionUrl,
          username: connection.username,
          password: Redacted.value(connection.password),
          password_authentication: "scram-sha-256",
        } satisfies WriteBody;
        yield* request(
          "configure PostgreSQL connection",
          connection.name,
          "POST",
          `database/config/${encodeURIComponent(connection.name)}`,
          encodedConnection,
        );

        for (const role of roles) {
          yield* request(
            "configure PostgreSQL credential role",
            role.name,
            "POST",
            `database/roles/${encodeURIComponent(role.name)}`,
            {
              db_name: role.databaseConfig,
              creation_statements: databaseCreationStatements(role),
              revocation_statements: databaseRevocationStatements(role),
              default_ttl: role.defaultTtl,
              max_ttl: role.maxTtl,
            },
          );
        }
      });

      const configureWorkloadRole = Effect.fn("OpenBao.configureWorkloadRole")(function* (
        role: WorkloadRole,
      ) {
        const policy = role.secretPaths
          .map((path) => `path "${path}" { capabilities = ["read"] }`)
          .join("\n");
        yield* request(
          "configure workload policy",
          role.name,
          "PUT",
          `sys/policies/acl/${encodeURIComponent(role.name)}`,
          { policy },
        );
        yield* request(
          "configure workload identity",
          role.name,
          "POST",
          `auth/jwt-nomad/role/${encodeURIComponent(role.name)}`,
          {
            role_type: "jwt",
            bound_audiences: ["vault.io"],
            bound_claims: {
              nomad_namespace: "default",
              nomad_job_id: role.job,
            },
            user_claim: "/nomad_job_id",
            user_claim_json_pointer: true,
            token_policies: [role.name],
            token_type: "service",
            token_period: "1h",
          },
        );
      });

      const readKvEntry = Effect.fn("OpenBao.readKvEntry")(function* (path: string) {
        const found = yield* getOptional("read secret", path);
        if (Option.isNone(found)) return Option.none();
        const value = yield* HttpClientResponse.schemaBodyJson(KvValue)(found.value).pipe(
          Effect.mapError(() => new OpenBaoError({ operation: "decode secret", target: path })),
        );
        return Option.some(value.data);
      });

      const readKvData = Effect.fn("OpenBao.readKvData")(function* (path: string) {
        const entry = yield* readKvEntry(path);
        return Option.map(entry, (found) => found.data);
      });

      const writeKvData = Effect.fn("OpenBao.writeKvData")(function* (
        path: string,
        data: Readonly<Record<string, string>>,
      ) {
        yield* request("write secret", path, "PUT", path, { data });
      });

      const readKvKeys = Effect.fn("OpenBao.readKvKeys")(function* (path: string) {
        const entry = yield* readKvEntry(path);
        return Option.map(entry, (found) => Object.keys(found.data));
      });

      const writeKvKey = Effect.fn("OpenBao.writeKvKey")(function* (
        path: string,
        key: string,
        value: Redacted.Redacted<string>,
      ) {
        const entry = yield* readKvEntry(path);
        const current = Option.match(entry, {
          onNone: () => ({ data: {}, version: 0 }),
          onSome: (found) => ({ data: found.data, version: found.metadata.version }),
        });
        yield* request("write secret", path, "POST", path, {
          options: { cas: current.version },
          data: { ...current.data, [key]: Redacted.value(value) },
        });
      });

      const checkToken = Effect.fn("OpenBao.checkToken")(function* () {
        yield* request("check token", "auth/token/lookup-self", "GET", "auth/token/lookup-self");
      });

      const createToken = Effect.fn("OpenBao.createToken")(function* (ttl: string) {
        const target = "auth/token/create";
        const response = yield* request("create token", target, "POST", target, { ttl });
        const created = yield* HttpClientResponse.schemaBodyJson(CreatedToken)(response).pipe(
          Effect.mapError(() => new OpenBaoError({ operation: "decode token", target })),
        );
        return Redacted.make(created.auth.client_token);
      });

      return OpenBao.of({
        readKvData,
        writeKvData,
        readKvKeys,
        writeKvKey,
        checkToken,
        createToken,
        readKv,
        readValkeyCredentials,
        writeValkeyCredentials,
        readAdminCredential,
        readPostgresConnectionUrl,
        configurePostgres,
        configureWorkloadRole,
      });
    }),
  );
}
