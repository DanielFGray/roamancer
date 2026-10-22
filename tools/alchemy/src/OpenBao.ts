import { Config, Context, Effect, Layer, Option, Redacted, Schema as S } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

const KvValue = S.Struct({
  data: S.Struct({ data: S.Record(S.String, S.String) }),
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
// and {{expiration}}.
export const databaseCreationStatements = (
  role: Pick<DatabaseRole, "database" | "memberOf" | "inherit">,
): string => {
  const user = '"{{name}}"';
  const options = role.inherit ? "LOGIN" : "LOGIN NOINHERIT";
  return [
    `CREATE ROLE ${user} WITH ${options} PASSWORD '{{password}}' VALID UNTIL '{{expiration}}';`,
    `GRANT "${role.memberOf}" TO ${user};`,
    `GRANT CONNECT ON DATABASE "${role.database}" TO ${user};`,
    // Each release gets a new migration login. Tables owned by an earlier login would refuse
    // ALTER from the next one, so the login creates them as the owner role instead.
    ...(role.inherit ? [`ALTER ROLE ${user} SET role = "${role.memberOf}";`] : []),
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
  | { readonly data: typeof ValkeyCredentials.Type }
  | { readonly data: typeof AdminCredential.Type }
  | {
      readonly role_type: "jwt";
      readonly bound_audiences: ReadonlyArray<string>;
      readonly bound_claims: { readonly nomad_namespace: string; readonly nomad_job_id: string };
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
    readonly readValkeyCredentials: (
      path: string,
    ) => Effect.Effect<
      Option.Option<{ readonly username: string; readonly password: Redacted.Redacted<string> }>,
      OpenBaoError
    >;
    readonly readAdminCredential: (
      path: string,
    ) => Effect.Effect<Option.Option<Redacted.Redacted<string>>, OpenBaoError>;
    readonly writeAdminCredential: (
      path: string,
      password: Redacted.Redacted<string>,
    ) => Effect.Effect<void, OpenBaoError>;
    readonly writeValkeyCredentials: (
      path: string,
      credentials: typeof ValkeyCredentials.Type,
    ) => Effect.Effect<void, OpenBaoError>;
    readonly configurePostgres: (
      connection: DatabaseConnection,
      roles: ReadonlyArray<DatabaseRole>,
    ) => Effect.Effect<void, OpenBaoError>;
    readonly configureWorkloadRole: (role: WorkloadRole) => Effect.Effect<void, OpenBaoError>;
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

      const readValkeyCredentials = Effect.fn("OpenBao.readValkeyCredentials")(function* (
        path: string,
      ) {
        const baseAddress = yield* Option.match(address, {
          onNone: () =>
            Effect.fail(new OpenBaoError({ operation: "read credentials", target: path })),
          onSome: Effect.succeed,
        });
        const authToken = yield* Option.match(token, {
          onNone: () =>
            Effect.fail(new OpenBaoError({ operation: "read credentials", target: path })),
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
          .pipe(
            Effect.mapError(
              () => new OpenBaoError({ operation: "read credentials", target: path }),
            ),
          );
        if (response.status === 404) {
          return yield* response.text.pipe(
            Effect.as(Option.none()),
            Effect.mapError(
              () => new OpenBaoError({ operation: "read credentials", target: path }),
            ),
          );
        }
        const ok = yield* HttpClientResponse.filterStatusOk(response).pipe(
          Effect.mapError(() => new OpenBaoError({ operation: "read credentials", target: path })),
        );
        const value = yield* HttpClientResponse.schemaBodyJson(KvValue)(ok).pipe(
          Effect.mapError(
            () => new OpenBaoError({ operation: "decode credentials", target: path }),
          ),
        );
        const credentials = yield* S.decodeUnknownEffect(ValkeyCredentials)(value.data.data).pipe(
          Effect.mapError(
            () => new OpenBaoError({ operation: "decode credentials", target: path }),
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
        yield* request("write credentials", path, "PUT", path, { data: credentials });
      });

      const readAdminCredential = Effect.fn("OpenBao.readAdminCredential")(function* (
        path: string,
      ) {
        const baseAddress = yield* Option.match(address, {
          onNone: () =>
            Effect.fail(new OpenBaoError({ operation: "read admin credential", target: path })),
          onSome: Effect.succeed,
        });
        const authToken = yield* Option.match(token, {
          onNone: () =>
            Effect.fail(new OpenBaoError({ operation: "read admin credential", target: path })),
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
          .pipe(
            Effect.mapError(
              () => new OpenBaoError({ operation: "read admin credential", target: path }),
            ),
          );
        if (response.status === 404) {
          return yield* response.text.pipe(
            Effect.as(Option.none()),
            Effect.mapError(
              () => new OpenBaoError({ operation: "read admin credential", target: path }),
            ),
          );
        }
        const ok = yield* HttpClientResponse.filterStatusOk(response).pipe(
          Effect.mapError(
            () => new OpenBaoError({ operation: "read admin credential", target: path }),
          ),
        );
        const value = yield* HttpClientResponse.schemaBodyJson(KvValue)(ok).pipe(
          Effect.mapError(
            () => new OpenBaoError({ operation: "decode admin credential", target: path }),
          ),
        );
        const credential = yield* S.decodeUnknownEffect(AdminCredential)(value.data.data).pipe(
          Effect.mapError(
            () => new OpenBaoError({ operation: "decode admin credential", target: path }),
          ),
        );
        return Option.some(Redacted.make(credential.password));
      });

      const writeAdminCredential = Effect.fn("OpenBao.writeAdminCredential")(function* (
        path: string,
        password: Redacted.Redacted<string>,
      ) {
        yield* request("write admin credential", path, "PUT", path, {
          data: { password: Redacted.value(password) },
        });
      });

      const readKv = Effect.fn("OpenBao.readKv")(function* (path: string, key: string) {
        const response = yield* request("read secret", path, "GET", path);
        const decoded = yield* HttpClientResponse.schemaBodyJson(KvValue)(response).pipe(
          Effect.mapError(() => new OpenBaoError({ operation: "read secret", target: path })),
        );
        const value = decoded.data.data[key];
        if (value === undefined) {
          return yield* new OpenBaoError({ operation: "read secret key", target: path });
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
            bound_claims: { nomad_namespace: "default", nomad_job_id: role.job },
            user_claim: "/nomad_job_id",
            user_claim_json_pointer: true,
            token_policies: [role.name],
            token_type: "service",
            token_period: "1h",
          },
        );
      });

      return OpenBao.of({
        readKv,
        readValkeyCredentials,
        writeValkeyCredentials,
        readAdminCredential,
        writeAdminCredential,
        configurePostgres,
        configureWorkloadRole,
      });
    }),
  );
}
