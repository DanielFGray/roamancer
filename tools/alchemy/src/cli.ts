/**
 * The commands Alchemy has no place for: OpenBao login, a cartridge's secrets,
 * and its Nomad allocation status. Deploys, plans and logs are Alchemy's own
 * commands. `scripts/ops` runs both kinds from the laptop over SSH, through
 * `scripts/ops-on-host.sh`.
 */
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import {
  Config,
  ConfigProvider,
  Console,
  Effect,
  FileSystem,
  Layer,
  Option,
  Redacted,
  Runtime,
} from "effect";
import { Schema as S } from "effect";
import { Argument, Command, Prompt } from "effect/cli";
import { FetchHttpClient } from "effect/http";
import * as Cartridge from "./Cartridge.ts";
import * as NomadLive from "./Nomad.ts";
import { Nomad } from "./Nomad.ts";
import { OpenBao } from "./OpenBao.ts";

/** A failure the operator can act on: printed as its message alone, without a stack trace. */
export class CliError extends S.TaggedError<CliError>()("CliError", { message: S.String }) {
  readonly [Runtime.errorReported] = false;
}

const root = ".";
const name = Argument.String("name").pipe(Argument.withDescription("The cartridge's name"));

const login = Command.make(
  "login",
  {},
  Effect.fn(function* () {
    const tokenFile = yield* Config.String("OPENBAO_TOKEN_FILE");
    const rootToken = yield* Prompt.run(Prompt.Password({ message: "OpenBao root token" }));
    const token = yield* Effect.gen(function* () {
      const bao = yield* OpenBao;
      return yield* bao.createToken("2h");
    }).pipe(
      // fresh: the program already shares an OpenBao built without a token; this one
      // must read the root token from the prompt instead.
      Effect.provide(
        Layer.fresh(OpenBao.layer).pipe(
          Layer.provide(
            ConfigProvider.layerAdd(
              ConfigProvider.fromEnvRecord({ OPENBAO_TOKEN: Redacted.value(rootToken) }),
              { asPrimary: true },
            ),
          ),
        ),
      ),
    );
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(tokenFile, Redacted.value(token), { mode: 0o600 });
    yield* Console.log(`OpenBao token for 2 hours written to ${tokenFile}.`);
  }),
).pipe(Command.withDescription("Mint a 2-hour OpenBao token from the root token"));

const checkLogin = Command.make("check-login", {}, () => requireLogin).pipe(
  Command.withDescription("Fail unless the OpenBao token from `login` is still valid"),
);

const secretSet = Command.make(
  "set",
  { name, key: Argument.String("key").pipe(Argument.withDescription("The secret's key")) },
  Effect.fn(function* ({ name, key }) {
    const { cartridge } = yield* Cartridge.find(root, name);
    const paths = [...Cartridge.kvKeys(cartridge)]
      .filter(([, keys]) => keys.includes(key))
      .map(([path]) => path);
    const path = yield* referencedPath(name, key, paths, cartridge);
    yield* requireLogin;
    const value = yield* Prompt.run(Prompt.Password({ message: `${path} ${key}` }));
    const bao = yield* OpenBao;
    yield* bao.writeKvKey(path, key, value);
    yield* Console.log(`Set ${key} at ${path}. Running tasks restart with the new value.`);
  }),
).pipe(Command.withDescription("Store one secret a cartridge references; prompts for the value"));

const secretList = Command.make(
  "list",
  { name },
  Effect.fn(function* ({ name }) {
    const { cartridge } = yield* Cartridge.find(root, name);
    yield* requireLogin;
    const bao = yield* OpenBao;
    yield* Effect.forEach(Cartridge.kvKeys(cartridge), ([path, keys]) =>
      bao.readKvKeys(path).pipe(
        Effect.map(Option.getOrElse((): ReadonlyArray<string> => [])),
        Effect.flatMap((stored) =>
          Console.log(
            [
              path,
              ...keys.map((key) => `  ${stored.includes(key) ? "set    " : "MISSING"} ${key}`),
              ...stored.filter((key) => !keys.includes(key)).map((key) => `  unused  ${key}`),
            ].join("\n"),
          ),
        ),
      ),
    );
  }),
).pipe(Command.withDescription("Show which referenced secrets are set; never prints values"));

const secret = Command.make("secret").pipe(
  Command.withDescription("Manage a cartridge's OpenBao secrets"),
  Command.withSubcommands([secretSet, secretList]),
);

const status = Command.make(
  "status",
  { name },
  Effect.fn(function* ({ name }) {
    const { cartridge } = yield* Cartridge.find(root, name);
    const nomad = yield* Nomad;
    yield* Effect.forEach(cartridge.services, (service) =>
      nomad.allocations(service.name).pipe(
        Effect.flatMap((allocations) =>
          Console.log(
            [
              service.name,
              ...(allocations.length === 0 ? ["  no allocations"] : []),
              ...newestFirst(allocations)
                .slice(0, 3)
                .map((allocation) => {
                  const tasks = Object.entries(allocation.TaskStates ?? {})
                    .map(
                      ([task, state]) =>
                        `${task}=${state.State}${state.Failed ? " (failed)" : ""}` +
                        (state.Restarts > 0 ? ` restarts=${state.Restarts}` : ""),
                    )
                    .join(" ");
                  return `  ${allocation.ID.slice(0, 8)} v${allocation.JobVersion} ${allocation.ClientStatus} ${tasks}`;
                }),
            ].join("\n"),
          ),
        ),
      ),
    );
  }),
).pipe(Command.withDescription("Show each service's newest allocations"));

/** OpenBao commands need the 2-hour token that `login` writes. */
const requireLogin = Effect.gen(function* () {
  const bao = yield* OpenBao;
  yield* bao.checkToken().pipe(
    Effect.mapError(
      () =>
        new CliError({
          message: "The OpenBao token is missing or expired. Run `ops login` first.",
        }),
    ),
  );
});

const referencedPath = (
  name: string,
  key: string,
  paths: ReadonlyArray<string>,
  cartridge: Cartridge.Cartridge,
) => {
  const [path, ...others] = paths;
  if (path === undefined) {
    const known = [...Cartridge.kvKeys(cartridge).values()].flat().join(", ");
    return Effect.fail(
      new CliError({
        message: `${name} references no secret key '${key}'. Referenced: ${known || "none"}`,
      }),
    );
  }
  if (others.length > 0) {
    return Effect.fail(
      new CliError({ message: `${name} reads '${key}' from several paths: ${paths.join(", ")}` }),
    );
  }
  return Effect.succeed(path);
};

const newestFirst = (allocations: ReadonlyArray<NomadLive.AllocationSummary>) =>
  [...allocations].sort((a, b) => b.CreateTime - a.CreateTime);

const cli = Command.make("ops").pipe(
  Command.withDescription("OpenBao login, secrets and Nomad status for Alchemy cartridges"),
  Command.withSubcommands([login, checkLogin, secret, status]),
);

cli.pipe(
  Command.run({ version: "1" }),
  Effect.tapErrorTag("CliError", (error) => Console.error(error.message)),
  Effect.provide(
    Layer.mergeAll(OpenBao.layer, NomadLive.layer()).pipe(
      Layer.provideMerge(Layer.mergeAll(FetchHttpClient.layer, BunServices.layer)),
    ),
  ),
  BunRuntime.runMain,
);
