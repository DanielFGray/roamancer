/*
 * Workstation-side release commands, run from an app's repository. Build and push happen
 * once here; the control host receives the cartridge with its images pinned, runs Alchemy
 * against its own state, and records what it deployed.
 */
import { Console, Effect, FileSystem, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { Builder } from "./Builder.ts";
import * as Cartridge from "./Cartridge.ts";
import { OpsError, output } from "./Exec.ts";
import * as Git from "./Git.ts";
import { deployStage, destroyStage } from "./Jobs.ts";
import { Remote } from "./Remote.ts";
import { imageDigest } from "./ReleaseImage.ts";

const folder = Argument.String("folder").pipe(
  Argument.withDescription(
    "The app's git repository with cartridge.json; its committed HEAD is used",
  ),
  Argument.withDefault("."),
);
const yes = Flag.Boolean("yes").pipe(
  Flag.withDefault(false),
  Flag.withDescription(
    "Do not ask before a deploy or destroy, as a script without a terminal must",
  ),
);

const release = Command.make(
  "release",
  { folder, yes },
  Effect.fn(function* ({ folder, yes }) {
    const tree = yield* committedTree(folder);
    const image = yield* buildAndPush(folder, tree);
    yield* deployPinned(folder, tree, image, yes);
    yield* Console.log(`Released ${image.pinned}`);
  }, Effect.scoped),
).pipe(Command.withDescription("Build, push and deploy an app's current commit"));

const stage = Command.make(
  "stage",
  { folder, yes },
  Effect.fn(function* ({ folder, yes }) {
    const tree = yield* committedTree(folder);
    const image = yield* buildAndPush(folder, tree);
    const stageName = `${image.name}-staged`;
    const cartridge = yield* (yield* FileSystem.FileSystem).readFileString(cartridgePath(tree));
    // A staged deploy is not a release: it sends no origin, so the host records nothing. Its
    // revision still reaches the tasks as GIT_COMMIT.
    yield* deployStage(
      stageName,
      { cartridge, origin: "", revision: image.commit, stagedImage: image.tagged },
      yes,
    );
    yield* Console.log(`Staged ${image.tagged}`);
  }, Effect.scoped),
).pipe(Command.withDescription("Build and deploy a tailnet-only staged instance"));

const promote = Command.make(
  "promote",
  { folder, yes },
  Effect.fn(function* ({ folder, yes }) {
    const tree = yield* committedTree(folder);
    const image = yield* buildAndPush(folder, tree);
    // The host fails this job unless every staged job is stable and runs this digest.
    yield* (yield* Remote).run({
      command: "stage-image",
      name: image.name,
      stable: true,
      expect: image.tagged,
    });
    yield* deployPinned(folder, tree, image, yes);
    yield* destroyStage(`${image.name}-staged`, yes);
    yield* Console.log(`Promoted ${image.pinned} and discarded ${image.name}-staged`);
  }, Effect.scoped),
).pipe(Command.withDescription("Release the staged commit live, then discard its stage"));

const discard = Command.make(
  "discard",
  { name: Argument.String("name").pipe(Argument.withDescription("The app's name")), yes },
  Effect.fn(function* ({ name, yes }) {
    yield* destroyStage(`${name}-staged`, yes);
    yield* Console.log(`Discarded ${name}-staged`);
  }),
).pipe(Command.withDescription("Destroy a staged instance"));

/** The release commands, to register under `ops`. */
export const commands = [release, stage, promote, discard];

const cartridgePath = (folder: string) => `${folder}/cartridge.json`;

/** The committed HEAD of `folder` exported to a temporary folder, so a dirty working tree is never built. */
const committedTree = Effect.fn("committedTree")(function* (folder: string) {
  const tree = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
  yield* Git.exportTree(folder, "HEAD", tree);
  return tree;
});

/** Build the exported commit, push it, and retain both the mutable tag and pushed digest. */
const buildAndPush = Effect.fn("buildAndPush")(function* (folder: string, tree: string) {
  const cartridge = yield* Cartridge.decodeFile(cartridgePath(tree), Cartridge.AppCartridge);
  const repository = yield* oneRepository(cartridge, cartridgePath(tree));
  const commit = (yield* output("git", ["-C", folder, "rev-parse", "--short", "HEAD"])).trim();
  const pinnedRef = yield* (yield* Builder).build(tree, { repository, commit });
  const digest = yield* Option.match(imageDigest(pinnedRef), {
    onNone: () =>
      Effect.fail(
        new OpsError({
          message: `builder returned an invalid digest for ${repository}:${commit}`,
        }),
      ),
    onSome: Effect.succeed,
  });
  return { name: cartridge.name, commit, pinned: `${repository}@${digest}`, tagged: pinnedRef };
});

/**
 * Deploy the folder's cartridge with every service image replaced by the pushed digest. The
 * pinned copy goes to the control host, which records it with the repository and commit;
 * the app's repository keeps naming its image without a digest.
 */
const deployPinned = Effect.fn("deployPinned")(function* (
  folder: string,
  tree: string,
  image: { readonly name: string; readonly commit: string; readonly pinned: string },
  yes: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const cartridge = yield* Cartridge.decodeFile(cartridgePath(tree), Cartridge.AppCartridge);
  const text = yield* fs.readFileString(cartridgePath(tree));
  const pinnedText = [...new Set(images(cartridge))].reduce(
    (contents, reference) => contents.replaceAll(`"${reference}"`, `"${image.pinned}"`),
    text,
  );
  // The repository's root commit names it whatever its remotes are called.
  const roots = yield* output("git", ["-C", folder, "rev-list", "--max-parents=0", "HEAD"]);
  const origin = roots.trim().split("\n").sort()[0];
  yield* deployStage(
    image.name,
    { cartridge: pinnedText, origin, revision: image.commit, stagedImage: null },
    yes,
  );
});

/** Every image reference in the cartridge's services. */
const images = (cartridge: Cartridge.Cartridge) =>
  cartridge.services.map((service) => service.image);

/** The one registry repository the cartridge's images come from, without tag or digest. */
const oneRepository = (cartridge: Cartridge.Cartridge, path: string) => {
  const repositories = [
    ...new Set(images(cartridge).map((image) => image.replace(/@.*$/, "").replace(/:[^/:]+$/, ""))),
  ];
  return repositories.length === 1
    ? Effect.succeed(repositories[0])
    : Effect.fail(
        new OpsError({
          message: `${path} must name one image to release; it names ${repositories.join(", ")}`,
        }),
      );
};
