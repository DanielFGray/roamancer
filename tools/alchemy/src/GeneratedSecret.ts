/**
 * Random values the platform makes once and keeps in OpenBao: each server's admin password, and
 * the secrets an app cartridge asks for with `GeneratedSecret` references. One resource owns one
 * KV v2 path. A reconcile writes each listed key the path lacks, as the hex text of `bytes`
 * random bytes, and never rewrites a stored key. So a value survives every deploy, a change of
 * `bytes`, and the removal of the resource.
 */
import * as Alchemy from "alchemy";
import * as Provider from "alchemy/Provider";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as S from "effect/Schema";
import { GeneratedBytes, SecretKey, SecretPath } from "./Job.ts";
import { OpenBao } from "./OpenBao.ts";
import { OperationJournal } from "./OperationJournal.ts";

export const GeneratedSecretProps = S.Struct({
  path: SecretPath,
  keys: S.Array(S.Struct({ key: SecretKey, bytes: GeneratedBytes })),
});
export type GeneratedSecretProps = typeof GeneratedSecretProps.Type;

export interface GeneratedSecret extends Alchemy.Resource<
  "Generated.Secret",
  GeneratedSecretProps,
  { id: string; path: string }
> {}

export const GeneratedSecret = Alchemy.Resource<GeneratedSecret>("Generated.Secret");

/** Where a server keeps its admin password, under the key `password`. */
export const adminCredentialPath = (engine: "postgres" | "valkey" | "garage", server: string) =>
  `secret/data/${engine}/servers/${server}`;

/** The size of a server's admin password. */
export const adminPasswordBytes = 32;

/** Where an app's generated secrets live, apart from the keys an operator sets at `secret/data/<app>`. */
export const generatedSecretPath = (app: string) => `secret/data/${app}/generated`;

const provision = Effect.fn("GeneratedSecret.provision")(function* (input: {
  readonly id: string;
  readonly props: GeneratedSecretProps;
  readonly openBao: typeof OpenBao.Service;
  readonly crypto: Crypto.Crypto;
}) {
  const { path, keys } = input.props;
  const stored = Option.getOrElse(
    yield* input.openBao.readKvKeys(path),
    (): ReadonlyArray<string> => [],
  );
  // One key at a time: each write checks the version it read, so a concurrent write fails
  // this reconcile instead of being overwritten.
  yield* Effect.forEach(
    keys.filter(({ key }) => !stored.includes(key)),
    ({ key, bytes }) =>
      Effect.gen(function* () {
        const value = Redacted.make(Hex.encode(yield* input.crypto.randomBytes(bytes)));
        yield* input.openBao.writeKvKey(path, key, value);
      }),
    { discard: true },
  );
  return { id: input.id, path };
});

export const GeneratedSecretProvider = () =>
  Provider.effect(
    GeneratedSecret,
    Effect.gen(function* () {
      const openBao = yield* OpenBao;
      const crypto = yield* Crypto.Crypto;
      const journal = yield* OperationJournal;

      return GeneratedSecret.Provider.of({
        list: () => Effect.succeed([]),
        stables: ["id"],
        reconcile: Effect.fn(function* ({ news, fqn }) {
          return yield* journal.run(
            {
              resourceId: fqn,
              provider: "Generated.Secret",
              target: news.path,
              action: "reconcile",
            },
            provision({ id: fqn, props: news, openBao, crypto }),
          );
        }),
        delete: Effect.fn(function* ({ fqn, olds }) {
          // Keep the OpenBao values: a server's data and an app's stored data were made with
          // them, so a removed and recreated resource must find the same values.
          yield* journal.run(
            {
              resourceId: fqn,
              provider: "Generated.Secret",
              target: olds.path,
              action: "delete",
            },
            Effect.void,
          );
        }),
      });
    }),
  );
