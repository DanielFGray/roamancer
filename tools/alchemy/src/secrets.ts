/**
 * Workstation-side secret commands, run where the cartridge lives: an app's repository, or a
 * platform folder in this checkout. The cartridge is read and checked here; `alchemy-runner
 * secret` on the control host talks to OpenBao. Only KV paths and key names cross ssh as
 * arguments. `list` and `check` take the root token, typed or piped. `set` uses the `ops login`
 * token, and its value is typed at the host's prompt or piped through ssh's stdin.
 */
import * as path from "node:path";
import { Console, Effect } from "effect";
import { Argument, Command } from "effect/cli";
import * as Cartridge from "./Cartridge.ts";
import { OpsError } from "./Exec.ts";
import { Remote } from "./Remote.ts";

const root = new URL("..", import.meta.url).pathname;
const folder = Argument.String("folder").pipe(
  Argument.withDescription("The folder that holds cartridge.json"),
  Argument.withDefault("."),
);

const set = Command.make(
  "set",
  { key: Argument.String("key").pipe(Argument.withDescription("The secret's key")), folder },
  Effect.fn(function* ({ key, folder }) {
    const remote = yield* Remote;
    const cartridge = yield* readCartridge(folder);
    const kvPath = yield* referencedPath(cartridge, key);
    yield* remote.direct(["secret", "set", kvPath, key]);
  }),
).pipe(
  Command.withDescription(
    "Store one secret the cartridge references with the ops login token; the value is typed, or piped on stdin",
  ),
);

const list = Command.make(
  "list",
  { folder },
  Effect.fn(function* ({ folder }) {
    const remote = yield* Remote;
    const cartridge = yield* readCartridge(folder);
    const references = Cartridge.kvKeys(cartridge);
    if (references.size === 0) {
      return yield* Console.log(`${cartridge.name} references no secrets.`);
    }
    yield* remote.direct(["secret", "list", referencesJson(references)]);
  }),
).pipe(
  Command.withDescription(
    "Show which referenced secrets are set; never prints values. Takes the root token, typed or piped",
  ),
);

const check = Command.make(
  "check",
  { folder },
  Effect.fn(function* ({ folder }) {
    const remote = yield* Remote;
    const cartridge = yield* readCartridge(folder);
    const references = Cartridge.kvKeys(cartridge);
    if (references.size === 0) return;
    yield* remote.direct(["secret", "check", cartridge.name, referencesJson(references)]);
  }),
).pipe(
  Command.withDescription(
    "Fail when a secret the cartridge references is not set. Takes the root token, typed or piped",
  ),
);

export const secret = Command.make("secret").pipe(
  Command.withDescription("Set and list the OpenBao secrets a cartridge references"),
  Command.withSubcommands([set, list, check]),
);

/** KV references as the one JSON argument `alchemy-runner secret list` and `check` take. */
const referencesJson = (references: Cartridge.KvReferences) =>
  JSON.stringify(Object.fromEntries(references));

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
      new OpsError({
        message: `${cartridge.name} references no secret key '${key}'. Referenced: ${known || "none"}`,
      }),
    );
  }
  if (others.length > 0) {
    return Effect.fail(
      new OpsError({
        message: `${cartridge.name} reads '${key}' from several paths: ${paths.join(", ")}`,
      }),
    );
  }
  return Effect.succeed(kvPath);
};
