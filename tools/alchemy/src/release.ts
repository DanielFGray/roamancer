/*
 * Workstation-side commands, run from an app's repository: releases here, and secrets from
 * src/secrets.ts. Build and push happen once here; the control host receives the cartridge
 * with its images pinned, runs Alchemy against its own state, and records what it deployed.
 */
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Array as Arr, Console, Effect, FileSystem, Option, Runtime, Stream } from "effect";
import { Schema as S } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { ChildProcess } from "effect/process";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import * as Cartridge from "./Cartridge.ts";
import { imageDigest, sameImageDigest } from "./ReleaseImage.ts";
import { secret } from "./secrets.ts";

/** A failure the operator can act on, printed without a stack trace. */
export class ReleaseError extends S.TaggedError<ReleaseError>()("ReleaseError", {
  message: S.String,
}) {
  readonly [Runtime.errorReported] = false;
}

const root = new URL("..", import.meta.url).pathname;
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
  }),
).pipe(Command.withDescription("Build, push and deploy an app's current commit"));

const stage = Command.make(
  "stage",
  { folder },
  Effect.fn(function* ({ folder }) {
    const image = yield* buildAndPush(folder);
    const stageName = `${image.name}-staged`;
    yield* run(`${root}/scripts/ops`, ["deploy", "--stage", stageName], {
      CARTRIDGE: cartridgePath(folder),
      STAGED_IMAGE: image.tagged,
    });
    const state = yield* output(`${root}/scripts/ops`, [
      "state",
      "read",
      `cartridge/${stageName}/output`,
    ]);
    const deployed = yield* S.decodeUnknownEffect(
      S.fromJsonString(S.Struct({ tailnetUrls: S.Array(S.String) })),
    )(state).pipe(
      Effect.mapError(
        (cause) => new ReleaseError({ message: `could not read staged URLs: ${cause}` }),
      ),
    );
    yield* Console.log(`Staged ${image.tagged}`);
    yield* Effect.forEach(deployed.tailnetUrls, (url) => Console.log(url));
  }),
).pipe(Command.withDescription("Build and deploy a tailnet-only staged instance"));

const promote = Command.make(
  "promote",
  { folder, yes },
  Effect.fn(function* ({ folder, yes }) {
    const image = yield* buildAndPush(folder);
    const staged = (yield* output(`${root}/scripts/ops`, [
      "stage-image",
      "--stable",
      image.name,
    ])).trim();
    if (!sameImageDigest(image.tagged, staged)) {
      return yield* new ReleaseError({
        message: `refusing promotion: staged image ${staged} does not match ${image.tagged}`,
      });
    }
    yield* deployPinned(folder, image, yes);
    yield* run(`${root}/scripts/ops`, ["destroy", "--stage", `${image.name}-staged`]);
    yield* Console.log(`Promoted ${image.pinned} and discarded ${image.name}-staged`);
  }),
).pipe(Command.withDescription("Release the staged commit live, then discard its stage"));

const discard = Command.make(
  "discard",
  { name: Argument.String("name").pipe(Argument.withDescription("The app's name")) },
  Effect.fn(function* ({ name }) {
    yield* run(`${root}/scripts/ops`, ["destroy", "--stage", `${name}-staged`]);
    yield* Console.log(`Discarded ${name}-staged`);
  }),
).pipe(Command.withDescription("Destroy a staged instance"));

const commands = Command.make("ops-image").pipe(
  Command.withDescription("Workstation commands: release images, manage stages, set secrets"),
  Command.withSubcommands([release, stage, promote, discard, secret]),
);

const cartridgePath = (folder: string) => `${folder}/cartridge.json`;

/** Build one commit, push it, and retain both the mutable tag and pushed digest. */
const buildAndPush = Effect.fn("buildAndPush")(function* (folder: string) {
  const cartridge = yield* Cartridge.decodeFile(cartridgePath(folder), Cartridge.AppCartridge);
  const repository = yield* oneRepository(cartridge, cartridgePath(folder));
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
      yield* run(
        `${root}/scripts/ops`,
        ["deploy", "--stage", image.name, ...(yes ? ["--yes"] : [])],
        {
          CARTRIDGE: file,
          ORIGIN: origin,
          REVISION: image.commit,
        },
      );
    }),
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
  Effect.tapErrorTag("HostSecretsError", (error) => Console.error(error.message)),
  Effect.provide(BunServices.layer),
  BunRuntime.runMain,
);
