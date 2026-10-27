/*
 * Workstation-side release commands, run from an app's repository. Build and push happen
 * once here; the control host receives the cartridge with its images pinned, runs Alchemy
 * against its own state, and records what it deployed.
 */
import { Array as Arr, Console, Effect, FileSystem, Option } from "effect";
import { Schema as S } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import * as Cartridge from "./Cartridge.ts";
import { OpsError, output, run } from "./Exec.ts";
import { Remote } from "./Remote.ts";
import { imageDigest, sameImageDigest } from "./ReleaseImage.ts";

const folder = Argument.String("folder").pipe(
  Argument.withDescription("The app's repository, a clean git checkout with cartridge.json"),
  Argument.withDefault("."),
);
const yes = Flag.Boolean("yes").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Deploy without Alchemy's approval prompt, as when no terminal is attached"),
);

const release = Command.make(
  "release",
  { folder, yes },
  Effect.fn(function* ({ folder, yes }) {
    const image = yield* buildAndPush(folder);
    yield* deployPinned(folder, image, yes);
    yield* Console.log(`Released ${image.pinned}`);
    yield* printTailnetUrls(image.name);
  }),
).pipe(Command.withDescription("Build, push and deploy an app's current commit"));

const stage = Command.make(
  "stage",
  { folder },
  Effect.fn(function* ({ folder }) {
    const image = yield* buildAndPush(folder);
    const stageName = `${image.name}-staged`;
    yield* (yield* Remote).run(["deploy", "--stage", stageName], {
      cartridge: cartridgePath(folder),
      stagedImage: image.tagged,
    });
    yield* Console.log(`Staged ${image.tagged}`);
    yield* printTailnetUrls(stageName);
  }),
).pipe(Command.withDescription("Build and deploy a tailnet-only staged instance"));

const promote = Command.make(
  "promote",
  { folder, yes },
  Effect.fn(function* ({ folder, yes }) {
    const image = yield* buildAndPush(folder);
    const remote = yield* Remote;
    const staged = (yield* remote.output(["stage-image", "--stable", image.name])).trim();
    if (!sameImageDigest(image.tagged, staged)) {
      return yield* new OpsError({
        message: `refusing promotion: staged image ${staged} does not match ${image.tagged}`,
      });
    }
    yield* deployPinned(folder, image, yes);
    yield* remote.run(["destroy", "--stage", `${image.name}-staged`]);
    yield* Console.log(`Promoted ${image.pinned} and discarded ${image.name}-staged`);
  }),
).pipe(Command.withDescription("Release the staged commit live, then discard its stage"));

const discard = Command.make(
  "discard",
  { name: Argument.String("name").pipe(Argument.withDescription("The app's name")) },
  Effect.fn(function* ({ name }) {
    yield* (yield* Remote).run(["destroy", "--stage", `${name}-staged`]);
    yield* Console.log(`Discarded ${name}-staged`);
  }),
).pipe(Command.withDescription("Destroy a staged instance"));

/** The release commands, to register under `ops`. */
export const commands = [release, stage, promote, discard];

const cartridgePath = (folder: string) => `${folder}/cartridge.json`;

/** Build one commit, push it, and retain both the mutable tag and pushed digest. */
const buildAndPush = Effect.fn("buildAndPush")(function* (folder: string) {
  const cartridge = yield* Cartridge.decodeFile(cartridgePath(folder), Cartridge.AppCartridge);
  const repository = yield* oneRepository(cartridge, cartridgePath(folder));
  const changes = yield* output("git", ["-C", folder, "status", "--porcelain"]);
  if (changes.trim() !== "") {
    return yield* new OpsError({
      message: `${folder} has uncommitted changes; commit them first.`,
    });
  }
  yield* (yield* Remote).run(["check-login"]);
  const commit = (yield* output("git", ["-C", folder, "rev-parse", "--short", "HEAD"])).trim();
  const tagged = `${repository}:${commit}`;
  yield* run("docker", ["build", "-t", tagged, folder]);
  yield* run("docker", ["push", tagged]);
  const digests = yield* output("docker", [
    "inspect",
    "--format",
    "{{range .RepoDigests}}{{println .}}{{end}}",
    tagged,
  ]);
  const pinned = yield* Arr.findFirst(digests.split("\n"), (digest) =>
    digest.startsWith(`${repository}@`),
  ).pipe(
    Option.match({
      onNone: () =>
        Effect.fail(new OpsError({ message: `docker records no digest for ${tagged}` })),
      onSome: Effect.succeed,
    }),
  );
  const digest = yield* Option.match(imageDigest(pinned), {
    onNone: () =>
      Effect.fail(new OpsError({ message: `docker records an invalid digest for ${tagged}` })),
    onSome: Effect.succeed,
  });
  return { name: cartridge.name, commit, pinned, tagged: `${tagged}@${digest}` };
});

/**
 * Deploy the folder's cartridge with every service image replaced by the pushed digest. The
 * pinned copy goes to the control host, which records it with the repository and commit;
 * the app's repository keeps naming its image without a digest.
 */
const deployPinned = Effect.fn("deployPinned")(function* (
  folder: string,
  image: { readonly name: string; readonly commit: string; readonly pinned: string },
  yes: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const cartridge = yield* Cartridge.decodeFile(cartridgePath(folder), Cartridge.AppCartridge);
  const text = yield* fs.readFileString(cartridgePath(folder));
  const pinnedText = [...new Set(images(cartridge))].reduce(
    (contents, reference) => contents.replaceAll(`"${reference}"`, `"${image.pinned}"`),
    text,
  );
  // The repository's root commit names it whatever its remotes are called.
  const roots = yield* output("git", ["-C", folder, "rev-list", "--max-parents=0", "HEAD"]);
  const origin = roots.trim().split("\n").sort()[0];
  yield* Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fs.makeTempFileScoped({ suffix: ".json" });
      yield* fs.writeFileString(file, pinnedText);
      yield* (yield* Remote).run(["deploy", "--stage", image.name, ...(yes ? ["--yes"] : [])], {
        cartridge: file,
        origin,
        revision: image.commit,
      });
    }),
  );
});

/**
 * Print the tailnet URLs a stage's last deploy published, one per line. A stage with no
 * tailnet route prints nothing. Alchemy keeps the URLs in the stack output, so a failed
 * read is an error rather than an empty list.
 */
const printTailnetUrls = Effect.fn("printTailnetUrls")(function* (stageName: string) {
  const state = yield* (yield* Remote).output(["state", "read", `cartridge/${stageName}/output`]);
  const deployed = yield* S.decodeUnknownEffect(
    S.fromJsonString(S.Struct({ tailnetUrls: S.Array(S.String) })),
  )(state).pipe(
    Effect.mapError((cause) => new OpsError({ message: `could not read tailnet URLs: ${cause}` })),
  );
  yield* Effect.forEach(deployed.tailnetUrls, (url) => Console.log(url));
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
