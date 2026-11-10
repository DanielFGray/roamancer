/*
 * Workstation commands that stage and discard an app's tailnet-only staged instance, run from
 * the app's repository. A release is a signed-off push to the app's repository on the control
 * host (Reconcile.ts), never a command here.
 */
import { Console, Effect, FileSystem, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { Builder, type BuildImage } from "./Builder.ts";
import * as Cartridge from "./Cartridge.ts";
import { OpsError, output } from "./Exec.ts";
import * as Git from "./Git.ts";
import { deployStage, destroyStage } from "./Jobs.ts";
import { Remote } from "./Remote.ts";
import { imageDigest, repositoriesOf } from "./ReleaseImage.ts";
import { defaultBuildMemoryMB } from "./BuildLimits.ts";

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

const stage = Command.make(
  "stage",
  { folder, yes },
  Effect.fn(function* ({ folder, yes }) {
    const { tree, archive } = yield* committedTree(folder);
    const image = yield* buildAndPush(folder, tree, archive);
    const stageName = `${image.name}-staged`;
    const cartridge = yield* (yield* FileSystem.FileSystem).readFileString(cartridgePath(tree));
    // A staged deploy is not a release, so the host records nothing. Its revision still
    // reaches the tasks as GIT_COMMIT.
    yield* deployStage(
      stageName,
      { cartridge, revision: image.commit, stagedImage: image.pinned },
      yes,
    );
    yield* Console.log(`Staged ${image.pinned} (commit ${image.commit})`);
  }, Effect.scoped),
).pipe(Command.withDescription("Build and deploy a tailnet-only staged instance"));

const discard = Command.make(
  "discard",
  { name: Argument.String("name").pipe(Argument.withDescription("The app's name")), yes },
  Effect.fn(function* ({ name, yes }) {
    yield* destroyStage(`${name}-staged`, yes);
    yield* Console.log(`Discarded ${name}-staged`);
  }),
).pipe(Command.withDescription("Destroy a staged instance"));

/** The staged-instance commands, to register under `ops`. */
export const commands = [stage, discard];

const cartridgePath = (folder: string) => `${folder}/cartridge.json`;

/**
 * The committed HEAD of `folder`, so a dirty working tree is never built: git's archive of it,
 * which a build sends, and the archive unpacked in a temporary folder, which the commands read.
 */
const committedTree = Effect.fn("committedTree")(function* (folder: string) {
  const fs = yield* FileSystem.FileSystem;
  const archive = `${yield* fs.makeTempDirectoryScoped()}/tree.tar`;
  yield* Git.exportArchive(folder, "HEAD", archive);
  const tree = yield* fs.makeTempDirectoryScoped();
  yield* Git.unpack(archive, tree);
  return { tree, archive };
});

/**
 * The pushed image of HEAD's files, built only when the host has recorded no image for HEAD's
 * image key. The host's record decides, not the registry's tag: the registry takes pushes
 * from every node without credentials. Jobs name the image by digest alone: Nomad's Podman driver refuses a reference
 * that carries both a tag and a digest.
 */
const buildAndPush = Effect.fn("buildAndPush")(function* (
  folder: string,
  tree: string,
  archive: string,
) {
  const head = yield* headImage(folder, tree);
  const remote = yield* Remote;
  const found = yield* remote.findImage(head.image);
  if (Option.isSome(found)) {
    yield* Console.log(`Reusing the image of tree ${head.image.key.slice(0, 12)}`);
    return pinnedImage(head, found.value);
  }
  const pinnedRef = yield* (yield* Builder).build(archive, head.image, head.memoryMaxMB);
  const digest = yield* Option.match(imageDigest(pinnedRef), {
    onNone: () =>
      Effect.fail(
        new OpsError({
          message: `builder returned an invalid digest for ${head.image.repository}:${head.image.key}`,
        }),
      ),
    onSome: Effect.succeed,
  });
  return pinnedImage(head, digest);
});

/** HEAD's commit, the cartridge's name, and the image HEAD's files are keyed by. */
const headImage = Effect.fn("headImage")(function* (folder: string, tree: string) {
  const cartridge = yield* Cartridge.decodeFile(cartridgePath(tree), Cartridge.AppCartridge);
  const repository = yield* oneRepository(cartridge, cartridgePath(tree));
  const commit = (yield* output("git", ["-C", folder, "rev-parse", "--short", "HEAD"])).trim();
  const key = (yield* output("git", ["-C", folder, "rev-parse", "HEAD^{tree}"])).trim();
  const memoryMaxMB = cartridge.build?.memoryMB ?? defaultBuildMemoryMB;
  return { name: cartridge.name, commit, image: { repository, key }, memoryMaxMB };
});

const pinnedImage = (
  head: { readonly name: string; readonly commit: string; readonly image: BuildImage },
  digest: string,
) => ({ name: head.name, commit: head.commit, pinned: `${head.image.repository}@${digest}` });

/** The one registry repository the cartridge's images come from, without tag or digest. */
const oneRepository = (cartridge: Cartridge.Cartridge, path: string) => {
  const repositories = repositoriesOf(cartridge);
  return repositories.length === 1
    ? Effect.succeed(repositories[0])
    : Effect.fail(
        new OpsError({
          message: `${path} must name one image to release; it names ${repositories.join(", ")}`,
        }),
      );
};
