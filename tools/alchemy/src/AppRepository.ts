/**
 * Workstation `ops repo create`: put an app on push-to-deploy. It makes the app's bare
 * repository on the control host (src/Repositories.ts), adds a remote named after the host
 * that points at it, and installs the signoff pre-push hook unless another tool owns that
 * hook. Reconcile watches every repository there, so no host rebuild is needed; the next
 * signed-off push to `main` releases.
 */
import { Console, Effect, Option } from "effect";
import { Argument, Command } from "effect/cli";
import * as Cartridge from "./Cartridge.ts";
import { OpsError, output, run } from "./Exec.ts";
import { Remote } from "./Remote.ts";
import { installHook } from "./Signoff.ts";
import { Site } from "./Site.ts";

const folder = Argument.String("folder").pipe(
  Argument.withDescription("The app's git checkout, with cartridge.json"),
  Argument.withDefault("."),
);

const create = Command.make(
  "create",
  { folder },
  Effect.fn(function* ({ folder }) {
    const cartridge = yield* Cartridge.decodeFile(
      `${folder}/cartridge.json`,
      Cartridge.AppCartridge,
    );
    const remoteName = yield* (yield* Site).host;
    const repository = yield* (yield* Remote).createRepository(cartridge.name);
    yield* addRemote(folder, remoteName, repository.url);
    // The repository and remote are made either way: the hook only refuses an unsigned push
    // early, and reconcile waits for a signoff without it.
    const refused = yield* installHook(folder);
    if (Option.isSome(refused)) yield* Console.error(refused.value);
    yield* Console.log(
      `${cartridge.name}: ${repository.created ? "made" : "already had"} ${repository.url}. ` +
        `Run \`ops signoff\`, then \`git push ${remoteName} main\` releases it.`,
    );
  }),
).pipe(
  Command.withDescription(
    "Make this app's repository on the control host, add it as a remote, and install the signoff hook",
  ),
);

/** Add `name` pointing at `url`; keep it when it already does, and refuse another URL. */
const addRemote = Effect.fn("AppRepository.addRemote")(function* (
  folder: string,
  name: string,
  url: string,
) {
  const remotes = (yield* output("git", ["-C", folder, "remote"])).split("\n");
  if (!remotes.includes(name)) return yield* run("git", ["-C", folder, "remote", "add", name, url]);
  const current = (yield* output("git", ["-C", folder, "remote", "get-url", name])).trim();
  if (current !== url) {
    return yield* new OpsError({
      message: `the remote '${name}' points at ${current}, not ${url}; change it with \`git remote set-url ${name} ${url}\``,
    });
  }
});

const repo = Command.make("repo").pipe(
  Command.withDescription("App repositories on the control host, whose pushes to main release"),
  Command.withSubcommands([create]),
);

export const commands = [repo];
