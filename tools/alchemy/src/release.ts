/*
 * Workstation-side image commands. Build and push happen once here; the control host
 * receives only the immutable reference and runs Alchemy against its own state.
 */
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Array as Arr, Console, Effect, FileSystem, Option, Runtime, Stream } from "effect";
import { Schema as S } from "effect";
import { Argument, Command } from "effect/cli";
import { ChildProcess } from "effect/process";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import * as Cartridge from "./Cartridge.ts";
import { imageDigest, sameImageDigest } from "./ReleaseImage.ts";

/** A failure the operator can act on, printed without a stack trace. */
export class ReleaseError extends S.TaggedError<ReleaseError>()("ReleaseError", {
  message: S.String,
}) {
  readonly [Runtime.errorReported] = false;
}

const root = new URL("..", import.meta.url).pathname;
const args = {
  name: Argument.String("name").pipe(Argument.withDescription("The cartridge's name")),
  folder: Argument.String("folder").pipe(
    Argument.withDescription("The app's build folder, a clean git checkout"),
    Argument.withDefault("."),
  ),
};

const release = Command.make(
  "release",
  args,
  Effect.fn(function* ({ name, folder }) {
    const image = yield* buildAndPush(name, folder);
    yield* pinAndDeploy(name, image);
    yield* Console.log(`Released ${image.pinned}`);
  }),
).pipe(Command.withDescription("Build, push, pin and deploy an app's current commit"));

const stage = Command.make(
  "stage",
  args,
  Effect.fn(function* ({ name, folder }) {
    const image = yield* buildAndPush(name, folder);
    yield* run(`${root}/scripts/ops`, ["deploy", "--stage", `${name}-staged`], {
      STAGED_IMAGE: image.tagged,
    });
    yield* Console.log(`Staged ${image.tagged}`);
  }),
).pipe(Command.withDescription("Build and deploy a tailnet-only staged instance"));

const promote = Command.make(
  "promote",
  args,
  Effect.fn(function* ({ name, folder }) {
    const image = yield* buildAndPush(name, folder);
    const staged = (yield* output(`${root}/scripts/ops`, ["stage-image", "--stable", name])).trim();
    if (!sameImageDigest(image.tagged, staged)) {
      return yield* new ReleaseError({
        message: `refusing promotion: staged image ${staged} does not match ${image.tagged}`,
      });
    }
    yield* pinAndDeploy(name, image);
    yield* run(`${root}/scripts/ops`, ["destroy", "--stage", `${name}-staged`]);
    yield* Console.log(`Promoted ${image.pinned} and discarded ${name}-staged`);
  }),
).pipe(Command.withDescription("Release the staged commit live, then discard its stage"));

const discard = Command.make(
  "discard",
  { name: args.name },
  Effect.fn(function* ({ name }) {
    yield* run(`${root}/scripts/ops`, ["destroy", "--stage", `${name}-staged`]);
    yield* Console.log(`Discarded ${name}-staged`);
  }),
).pipe(Command.withDescription("Destroy a staged instance"));

const commands = Command.make("ops-image").pipe(
  Command.withDescription("Build and manage staged application images"),
  Command.withSubcommands([release, stage, promote, discard]),
);

/** Build one commit, push it, and retain both the mutable tag and pushed digest. */
const buildAndPush = Effect.fn("buildAndPush")(function* (name: string, folder: string) {
  const { path, cartridge } = yield* Cartridge.find(root, name);
  const repository = yield* oneRepository(cartridge, path);
  const changes = yield* output("git", ["-C", folder, "status", "--porcelain"]);
  if (changes.trim() !== "") {
    return yield* new ReleaseError({
      message: `${folder} has uncommitted changes; commit them first.`,
    });
  }
  yield* run(`${root}/scripts/ops`, ["check-login"]);
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
        Effect.fail(new ReleaseError({ message: `docker records no digest for ${tagged}` })),
      onSome: Effect.succeed,
    }),
  );
  const digest = yield* Option.match(imageDigest(pinned), {
    onNone: () =>
      Effect.fail(new ReleaseError({ message: `docker records an invalid digest for ${tagged}` })),
    onSome: Effect.succeed,
  });
  return { commit, pinned, tagged: `${tagged}@${digest}` };
});

const pinAndDeploy = Effect.fn("pinAndDeploy")(function* (
  name: string,
  image: { readonly commit: string; readonly pinned: string },
) {
  const { pinned } = image;
  const { path, cartridge } = yield* Cartridge.find(root, name);
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(path);
  const pins = new Set(images(cartridge));
  yield* fs.writeFileString(
    path,
    [...pins].reduce((contents, pin) => contents.replaceAll(pin, pinned), text),
  );
  yield* run(`${root}/scripts/ops`, ["deploy", "--stage", name]);
  if (pins.has(pinned)) {
    yield* Console.log(`${name} was already pinned to ${pinned}`);
  } else {
    yield* run("git", [
      "-C",
      root,
      "commit",
      "-q",
      "-m",
      `chore(${name}): release ${image.commit}`,
      "--",
      path,
    ]);
  }
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
        new ReleaseError({
          message: `${path} must name one image to release; it names ${repositories.join(", ")}`,
        }),
      );
};

const run = Effect.fn("run")(function* (
  command: string,
  commandArgs: ReadonlyArray<string>,
  env?: Record<string, string>,
) {
  const spawner = yield* ChildProcessSpawner;
  const code = yield* spawner.exitCode(
    ChildProcess.make(command, commandArgs, {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env,
      extendEnv: env !== undefined,
    }),
  );
  if (code !== 0)
    return yield* new ReleaseError({
      message: `${command} ${commandArgs.join(" ")} exited ${code}`,
    });
});

const output = Effect.fn("output")(function* (command: string, commandArgs: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner;
  const handle = yield* spawner.spawn(
    ChildProcess.make(command, commandArgs, { stderr: "inherit" }),
  );
  const text = yield* Stream.mkString(Stream.decodeText(handle.stdout));
  const code = yield* handle.exitCode;
  if (code !== 0)
    return yield* new ReleaseError({
      message: `${command} ${commandArgs.join(" ")} exited ${code}`,
    });
  return text;
}, Effect.scoped);

commands.pipe(
  Command.run({ version: "1" }),
  Effect.tapErrorTag("ReleaseError", (error) => Console.error(error.message)),
  Effect.provide(BunServices.layer),
  BunRuntime.runMain,
);
