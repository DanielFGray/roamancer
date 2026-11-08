import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { GeneratedSecret, GeneratedSecretProvider } from "./GeneratedSecret.ts";
import { OpenBao, OpenBaoError } from "./OpenBao.ts";
import { OperationJournal } from "./OperationJournal.ts";

describe("Generated.Secret", () => {
  it("writes only the keys the path lacks, as hex text of the declared size", async () => {
    const writes: Array<{ path: string; key: string; value: string }> = [];
    const unused = () => Effect.fail(new OpenBaoError({ operation: "unused", target: "test" }));
    const openBao = Layer.succeed(
      OpenBao,
      OpenBao.of({
        readKvKeys: (path) =>
          Effect.succeed(Option.some(path === "secret/data/rfchat/generated" ? ["kept"] : [])),
        writeKvKey: (path, key, value) =>
          Effect.sync(() => {
            writes.push({ path, key, value: Redacted.value(value) });
          }),
        readKv: unused,
        readKvData: unused,
        writeKvData: unused,
        readValkeyCredentials: unused,
        writeValkeyCredentials: unused,
        readAdminCredential: unused,
        readPostgresConnectionUrl: unused,
        configurePostgres: unused,
        configureWorkloadRole: unused,
        checkToken: unused,
        createToken: unused,
      }),
    );
    const journal = Layer.succeed(
      OperationJournal,
      OperationJournal.of({
        run: (_operation, action) => action,
        history: Effect.succeed([]),
        hasPending: () => Effect.succeed(false),
      }),
    );
    const props = {
      path: "secret/data/rfchat/generated",
      keys: [
        { key: "kept", bytes: 32 },
        { key: "secret_key_base", bytes: 64 },
      ],
    };

    const output = await Effect.gen(function* () {
      const provider = yield* GeneratedSecret.Provider;
      return yield* provider.reconcile({
        id: "generated-secret-rfchat",
        fqn: "generated-secret-rfchat",
        instanceId: "1",
        news: props,
        olds: undefined,
        output: undefined,
        session: undefined as never,
        bindings: undefined as never,
      });
    }).pipe(
      Effect.provide(
        GeneratedSecretProvider().pipe(
          Layer.provide(Layer.mergeAll(openBao, journal, NodeCrypto.layer)),
        ),
      ),
      Effect.runPromise,
    );

    assert.deepEqual(
      writes.map(({ path, key }) => [path, key]),
      [["secret/data/rfchat/generated", "secret_key_base"]],
    );
    assert.match(writes[0].value, /^[0-9a-f]{128}$/);
    assert.equal(output.path, "secret/data/rfchat/generated");
  });
});
