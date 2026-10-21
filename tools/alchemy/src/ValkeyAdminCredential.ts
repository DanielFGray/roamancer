import * as Alchemy from "alchemy";
import * as Provider from "alchemy/Provider";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { OpenBao } from "./OpenBao.ts";
import { OperationJournal } from "./OperationJournal.ts";

const ServerName = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/));

export const ValkeyAdminCredentialProps = Schema.Struct({ server: ServerName });
export type ValkeyAdminCredentialProps = typeof ValkeyAdminCredentialProps.Type;

export interface ValkeyAdminCredential extends Alchemy.Resource<
  "Valkey.AdminCredential",
  ValkeyAdminCredentialProps,
  { id: string; path: string }
> {}

export const ValkeyAdminCredential =
  Alchemy.Resource<ValkeyAdminCredential>("Valkey.AdminCredential");

const secretPath = (server: string) => `secret/data/valkey/servers/${server}`;

const provision = Effect.fn("ValkeyAdminCredential.provision")(function* (input: {
  readonly id: string;
  readonly props: ValkeyAdminCredentialProps;
  readonly openBao: typeof OpenBao.Service;
  readonly crypto: Crypto.Crypto;
}) {
  const path = secretPath(input.props.server);
  const stored = yield* input.openBao.readValkeyAdminCredential(path);
  yield* Option.match(stored, {
    onSome: () => Effect.void,
    onNone: () =>
      Effect.gen(function* () {
        const password = Redacted.make(Hex.encode(yield* input.crypto.randomBytes(32)));
        yield* input.openBao.writeValkeyAdminCredential(path, password);
      }),
  });
  return { id: input.id, path };
});

export const ValkeyAdminCredentialProvider = () =>
  Provider.effect(
    ValkeyAdminCredential,
    Effect.gen(function* () {
      const openBao = yield* OpenBao;
      const crypto = yield* Crypto.Crypto;
      const journal = yield* OperationJournal;

      return ValkeyAdminCredential.Provider.of({
        list: () => Effect.succeed([]),
        stables: ["id"],
        reconcile: Effect.fn(function* ({ news, fqn }) {
          return yield* journal.run(
            {
              resourceId: fqn,
              provider: "Valkey.AdminCredential",
              target: news.server,
              action: "reconcile",
            },
            provision({ id: fqn, props: news, openBao, crypto }),
          );
        }),
        delete: Effect.fn(function* ({ fqn, olds }) {
          // Keep the OpenBao value so removing and recreating a service preserves its identity.
          yield* journal.run(
            {
              resourceId: fqn,
              provider: "Valkey.AdminCredential",
              target: olds.server,
              action: "delete",
            },
            Effect.void,
          );
        }),
      });
    }),
  );
