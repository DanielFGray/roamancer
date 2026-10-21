import * as Alchemy from "alchemy";
import * as Provider from "alchemy/Provider";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as S from "effect/Schema";
import { OpenBao } from "./OpenBao.ts";
import { OperationJournal } from "./OperationJournal.ts";

const ServerName = S.String.check(S.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/));

export const AdminEngine = S.Literals(["postgres", "valkey"]);
export type AdminEngine = typeof AdminEngine.Type;

export const AdminCredentialProps = S.Struct({
  engine: AdminEngine,
  server: ServerName,
});
export type AdminCredentialProps = typeof AdminCredentialProps.Type;

export interface AdminCredential extends Alchemy.Resource<
  "Admin.Credential",
  AdminCredentialProps,
  { id: string; path: string }
> {}

export const AdminCredential = Alchemy.Resource<AdminCredential>("Admin.Credential");

export const adminCredentialPath = (engine: AdminEngine, server: string) =>
  `secret/data/${engine}/servers/${server}`;

const provision = Effect.fn("AdminCredential.provision")(function* (input: {
  readonly id: string;
  readonly props: AdminCredentialProps;
  readonly openBao: typeof OpenBao.Service;
  readonly crypto: Crypto.Crypto;
}) {
  const path = adminCredentialPath(input.props.engine, input.props.server);
  const stored = yield* input.openBao.readAdminCredential(path);
  yield* Option.match(stored, {
    onSome: () => Effect.void,
    onNone: () =>
      Effect.gen(function* () {
        const password = Redacted.make(Hex.encode(yield* input.crypto.randomBytes(32)));
        yield* input.openBao.writeAdminCredential(path, password);
      }),
  });
  return { id: input.id, path };
});

export const AdminCredentialProvider = () =>
  Provider.effect(
    AdminCredential,
    Effect.gen(function* () {
      const openBao = yield* OpenBao;
      const crypto = yield* Crypto.Crypto;
      const journal = yield* OperationJournal;

      return AdminCredential.Provider.of({
        list: () => Effect.succeed([]),
        stables: ["id"],
        reconcile: Effect.fn(function* ({ news, fqn }) {
          return yield* journal.run(
            {
              resourceId: fqn,
              provider: "Admin.Credential",
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
              provider: "Admin.Credential",
              target: olds.server,
              action: "delete",
            },
            Effect.void,
          );
        }),
      });
    }),
  );
