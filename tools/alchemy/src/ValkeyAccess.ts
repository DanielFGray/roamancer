import * as Alchemy from "alchemy";
import * as Provider from "alchemy/Provider";
import { createClient } from "@redis/client";
import * as Arr from "effect/Array";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as S from "effect/Schema";
import { adminCredentialPath } from "./AdminCredential.ts";
import { Nomad } from "./Nomad.ts";
import { OpenBao } from "./OpenBao.ts";
import { OperationJournal } from "./OperationJournal.ts";
import { dependencyRegistrationRetry, firstServiceLocation } from "./ServiceRegistration.ts";

const ResourceName = S.String.check(S.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/));
const ValkeyUsername = S.String.check(S.isPattern(/^(?!default$)[a-z][a-z0-9_]{0,39}$/));
const AdminUsername = S.String.check(S.isPattern(/^[a-z][a-z0-9_]{0,39}$/));
const KeyPrefix = S.String.check(S.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/));
export const ValkeyAccessConfig = S.Struct({
  resourceName: ValkeyUsername,
  server: ResourceName,
  adminUsername: AdminUsername,
  keyPrefix: KeyPrefix,
  access: S.Literals(["read-only", "read-write"]),
});
export type ValkeyAccessConfig = typeof ValkeyAccessConfig.Type;

export const ValkeyAccessProps = ValkeyAccessConfig;
export type ValkeyAccessProps = typeof ValkeyAccessProps.Type;

export interface ValkeyAccess extends Alchemy.Resource<
  "Valkey.Access",
  ValkeyAccessProps,
  {
    id: string;
    server: string;
    username: string;
    keyPrefix: string;
    credentialPath: string;
  }
> {}

export const ValkeyAccess = Alchemy.Resource<ValkeyAccess>("Valkey.Access");

export class ValkeyAccessError extends S.TaggedError<ValkeyAccessError>()("ValkeyAccessError", {
  operation: S.String,
  target: S.String,
}) {
  override get message() {
    return `${this.operation}: ${this.target}`;
  }
}

const attributes = (id: string, props: ValkeyAccessProps) => ({
  id,
  server: props.server,
  username: props.resourceName,
  keyPrefix: props.keyPrefix,
  credentialPath: `secret/data/valkey/${props.resourceName}`,
});

const runClient = Effect.fn("ValkeyAccess.runClient")(function* (
  input: {
    readonly host: string;
    readonly port: number;
    readonly username: string;
    readonly password: Redacted.Redacted<string>;
  },
  command: ReadonlyArray<string>,
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const client = yield* Effect.try({
        try: () =>
          createClient({
            socket: { host: input.host, port: input.port, connectTimeout: 5_000 },
            username: input.username,
            password: Redacted.value(input.password),
            disableOfflineQueue: true,
          }),
        catch: () => new ValkeyAccessError({ operation: "create client", target: input.host }),
      });
      // Each command awaits the client promise and maps its rejection into ValkeyAccessError.
      client.on("error", () => {});
      const connected = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => client.connect(),
          catch: () => new ValkeyAccessError({ operation: "connect", target: input.host }),
        }).pipe(Effect.as(client)),
        (ready) => Effect.sync(() => ready.destroy()),
      );
      return yield* Effect.tryPromise({
        try: () => connected.sendCommand(command),
        catch: () => new ValkeyAccessError({ operation: "send command", target: input.host }),
      });
    }),
  );
});

const aclCommand = (props: ValkeyAccessProps, password: Redacted.Redacted<string>) => [
  "ACL",
  "SETUSER",
  props.resourceName,
  "reset",
  "on",
  `>${Redacted.value(password)}`,
  `~${props.keyPrefix}:*`,
  "+auth",
  "+hello",
  "+ping",
  "+quit",
  "+select",
  "+client|setinfo",
  "+@read",
  ...(props.access === "read-write" ? ["+@write", "+@transaction"] : []),
  "-@dangerous",
];

const reconcile = Effect.fn("ValkeyAccess.reconcile")(function* (input: {
  readonly id: string;
  readonly news: ValkeyAccessProps;
  readonly nomad: typeof Nomad.Service;
  readonly openBao: typeof OpenBao.Service;
  readonly crypto: Crypto.Crypto;
}) {
  const endpoint = yield* firstServiceLocation(
    input.news.server,
    input.nomad.service(input.news.server),
    dependencyRegistrationRetry,
  ).pipe(
    Effect.catchTag("ServiceNotRegistered", () =>
      Effect.fail(
        new ValkeyAccessError({
          operation: "find Valkey service",
          target: input.news.server,
        }),
      ),
    ),
  );
  const storedRootPassword = yield* input.openBao.readAdminCredential(
    adminCredentialPath("valkey", input.news.server),
  );
  const rootPassword = yield* Option.match(storedRootPassword, {
    onNone: () =>
      Effect.fail(
        new ValkeyAccessError({ operation: "read admin credential", target: input.news.server }),
      ),
    onSome: Effect.succeed,
  });
  const credentialPath = `secret/data/valkey/${input.news.resourceName}`;
  const existing = yield* input.openBao.readValkeyCredentials(credentialPath);
  const credentials = yield* Option.match(existing, {
    onSome: Effect.succeed,
    onNone: () =>
      Effect.gen(function* () {
        const password = Redacted.make(Hex.encode(yield* input.crypto.randomBytes(32)));
        const value = { username: input.news.resourceName, password };
        yield* input.openBao.writeValkeyCredentials(credentialPath, {
          username: value.username,
          password: Redacted.value(value.password),
        });
        return value;
      }),
  });
  if (credentials.username !== input.news.resourceName) {
    return yield* new ValkeyAccessError({
      operation: "validate stored username",
      target: credentialPath,
    });
  }
  yield* runClient(
    {
      host: endpoint.Address,
      port: endpoint.Port,
      username: input.news.adminUsername,
      password: rootPassword,
    },
    aclCommand(input.news, credentials.password),
  ).pipe(
    Effect.mapError(
      () =>
        new ValkeyAccessError({
          operation: "configure ACL user",
          target: input.news.resourceName,
        }),
    ),
  );
  yield* runClient(
    {
      host: endpoint.Address,
      port: endpoint.Port,
      username: input.news.adminUsername,
      password: rootPassword,
    },
    ["ACL", "SAVE"],
  ).pipe(
    Effect.mapError(
      () =>
        new ValkeyAccessError({
          operation: "persist ACL user",
          target: input.news.resourceName,
        }),
    ),
  );
  return attributes(input.id, input.news);
});

export const ValkeyAccessProvider = () =>
  Provider.effect(
    ValkeyAccess,
    Effect.gen(function* () {
      const nomad = yield* Nomad;
      const openBao = yield* OpenBao;
      const crypto = yield* Crypto.Crypto;
      const journal = yield* OperationJournal;

      return ValkeyAccess.Provider.of({
        list: () => Effect.succeed([]),
        stables: ["id"],
        reconcile: Effect.fn(function* ({ news, fqn }) {
          return yield* journal.run(
            {
              resourceId: fqn,
              provider: "Valkey.Access",
              target: `${news.server}/${news.resourceName}`,
              action: "reconcile",
            },
            reconcile({ id: fqn, news, nomad, openBao, crypto }),
          );
        }),
        delete: Effect.fn(function* ({ fqn, olds }) {
          yield* journal.run(
            {
              resourceId: fqn,
              provider: "Valkey.Access",
              target: `${olds.server}/${olds.resourceName}`,
              action: "delete",
            },
            Effect.gen(function* () {
              const locations = yield* nomad.service(olds.server);
              const endpoint = yield* Option.match(Arr.head(locations), {
                onNone: () =>
                  Effect.fail(
                    new ValkeyAccessError({
                      operation: "find Valkey service for revocation",
                      target: olds.server,
                    }),
                  ),
                onSome: Effect.succeed,
              });
              const storedRootPassword = yield* openBao.readAdminCredential(
                adminCredentialPath("valkey", olds.server),
              );
              const rootPassword = yield* Option.match(storedRootPassword, {
                onNone: () =>
                  Effect.fail(
                    new ValkeyAccessError({
                      operation: "read admin credential",
                      target: olds.server,
                    }),
                  ),
                onSome: Effect.succeed,
              });
              yield* runClient(
                {
                  host: endpoint.Address,
                  port: endpoint.Port,
                  username: olds.adminUsername,
                  password: rootPassword,
                },
                ["ACL", "DELUSER", olds.resourceName],
              ).pipe(
                Effect.mapError(
                  () =>
                    new ValkeyAccessError({
                      operation: "revoke ACL user",
                      target: olds.resourceName,
                    }),
                ),
              );
              yield* runClient(
                {
                  host: endpoint.Address,
                  port: endpoint.Port,
                  username: olds.adminUsername,
                  password: rootPassword,
                },
                ["ACL", "SAVE"],
              ).pipe(
                Effect.mapError(
                  () =>
                    new ValkeyAccessError({
                      operation: "persist ACL revocation",
                      target: olds.resourceName,
                    }),
                ),
              );
            }),
          );
        }),
      });
    }),
  );
