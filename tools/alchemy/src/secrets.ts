/**
 * Workstation-side secret commands, run where the cartridge lives: an app's repository, or a
 * platform folder in this checkout. The cartridge is read here, so only the OpenBao call goes
 * to the control host (src/HostSecrets.ts).
 */
import * as path from "node:path";
import { Config, Console, Effect } from "effect";
import { Argument, Command, Prompt } from "effect/cli";
import * as Cartridge from "./Cartridge.ts";
import * as HostSecrets from "./HostSecrets.ts";

const root = new URL("..", import.meta.url).pathname;
const folder = Argument.String("folder").pipe(
  Argument.withDescription("The folder that holds cartridge.json"),
  Argument.withDefault("."),
);
const host = Config.String("OPS_HOST");

const set = Command.make(
  "set",
  { key: Argument.String("key").pipe(Argument.withDescription("The secret's key")), folder },
  Effect.fn(function* ({ key, folder }) {
    const cartridge = yield* readCartridge(folder);
    const kvPath = yield* referencedPath(cartridge, key);
    const value = yield* Prompt.run(Prompt.Password({ message: `${kvPath} ${key}` }));
    yield* HostSecrets.writeKey(yield* host, kvPath, key, value);
    yield* Console.log(`Set ${key} at ${kvPath}. Running tasks restart with the new value.`);
  }),
).pipe(Command.withDescription("Store one secret the cartridge references; prompts for the value"));

const list = Command.make(
  "list",
  { folder },
  Effect.fn(function* ({ folder }) {
    const cartridge = yield* readCartridge(folder);
    const referenced = Cartridge.kvKeys(cartridge);
    const stored = yield* HostSecrets.storedKeys(yield* host, [...referenced.keys()]);
    yield* Effect.forEach(referenced, ([kvPath, keys]) => {
      const present = stored.get(kvPath) ?? [];
      return Console.log(
        [
          kvPath,
          ...keys.map((key) => `  ${present.includes(key) ? "set    " : "MISSING"} ${key}`),
          ...present.filter((key) => !keys.includes(key)).map((key) => `  unused  ${key}`),
        ].join("\n"),
      );
    });
  }),
).pipe(Command.withDescription("Show which referenced secrets are set; never prints values"));

const check = Command.make(
  "check",
  { folder },
  Effect.fn(function* ({ folder }) {
    const cartridge = yield* readCartridge(folder);
    const stored = yield* HostSecrets.storedKeys(yield* host, [
      ...Cartridge.kvKeys(cartridge).keys(),
    ]);
    const missing = Cartridge.missingSecrets(cartridge, stored);
    if (missing.length > 0) {
      return yield* new HostSecrets.HostSecretsError({
        message: [
          `${cartridge.name} reads secrets that are not set, so its tasks would wait forever:`,
          ...missing.map(({ path: kvPath, key }) => `  ${kvPath} ${key}`),
          "Set each with `ops secret set <key>`.",
        ].join("\n"),
      });
    }
  }),
).pipe(Command.withDescription("Fail when a secret the cartridge references is not set"));

export const secret = Command.make("secret").pipe(
  Command.withDescription("Set and list the OpenBao secrets a cartridge references"),
  Command.withSubcommands([set, list, check]),
);

/**
 * The folder's cartridge. A platform folder of this checkout is trusted as it is; any other
 * folder is an app's, held to its app's namespace, so its KV paths stay under its own name.
 */
const readCartridge = (folder: string) => {
  const platform = path.relative(path.join(root, "platform"), path.resolve(folder));
  const trusted = platform !== "" && !platform.startsWith("..") && !path.isAbsolute(platform);
  return Cartridge.decodeFile(
    path.join(folder, "cartridge.json"),
    trusted ? Cartridge.Cartridge : Cartridge.AppCartridge,
  );
};

/** The one KV path at which the cartridge reads `key`. */
const referencedPath = (cartridge: Cartridge.Cartridge, key: string) => {
  const paths = [...Cartridge.kvKeys(cartridge)]
    .filter(([, keys]) => keys.includes(key))
    .map(([kvPath]) => kvPath);
  const [kvPath, ...others] = paths;
  if (kvPath === undefined) {
    const known = [...Cartridge.kvKeys(cartridge).values()].flat().join(", ");
    return Effect.fail(
      new HostSecrets.HostSecretsError({
        message: `${cartridge.name} references no secret key '${key}'. Referenced: ${known || "none"}`,
      }),
    );
  }
  if (others.length > 0) {
    return Effect.fail(
      new HostSecrets.HostSecretsError({
        message: `${cartridge.name} reads '${key}' from several paths: ${paths.join(", ")}`,
      }),
    );
  }
  return Effect.succeed(kvPath);
};
