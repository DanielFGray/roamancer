/**
 * `ops release <name> [folder]`: ships an app's current commit. It builds the image from a
 * clean git checkout, pushes it to the cluster registry, pins the pushed digest in the
 * cartridge, deploys the cartridge through `scripts/ops`, and commits the pin.
 *
 * It runs on the workstation, not the control host: the workstation's Docker holds the
 * registry's client certificate (nixos/cynic/cluster-tls-operations.md).
 */
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Array as Arr, Console, Effect, FileSystem, Option, Runtime, Stream } from "effect";
import { Schema as S } from "effect";
import { Argument, Command } from "effect/cli";
import { ChildProcess } from "effect/process";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import * as Cartridge from "./Cartridge.ts";

/** A failure the operator can act on: printed as its message alone, without a stack trace. */
export class ReleaseError extends S.TaggedError<ReleaseError>()("ReleaseError", {
  message: S.String,
}) {
  readonly [Runtime.errorReported] = false;
}

// The script's folder's parent, so the command works from any current folder.
const root = new URL("..", import.meta.url).pathname;

const release = Command.make(
  "release",
  {
    name: Argument.String("name").pipe(Argument.withDescription("The cartridge's name")),
    folder: Argument.String("folder").pipe(
      Argument.withDescription("The app's build folder, a clean git checkout"),
      Argument.withDefault("."),
    ),
  },
  Effect.fn(function* ({ name, folder }) {
    const { path, cartridge } = yield* Cartridge.find(root, name);
    const repository = yield* oneRepository(cartridge, path);

    // The image is tagged with the commit, so uncommitted changes would ship under a
    // commit that does not contain them.
    const changes = yield* output("git", ["-C", folder, "status", "--porcelain"]);
    if (changes.trim() !== "") {
      return yield* new ReleaseError({
        message: `${folder} has uncommitted changes; commit them first.`,
      });
    }
    // Fails on an expired OpenBao token now, not after the build.
    yield* run(`${root}/scripts/ops`, ["check-login"]);

    const commit = (yield* output("git", ["-C", folder, "rev-parse", "--short", "HEAD"])).trim();
    const image = `${repository}:${commit}`;
    yield* run("docker", ["build", "-t", image, folder]);
    yield* run("docker", ["push", image]);
    // The registry compresses the layers again, so only the pushed digest names what
    // Nomad pulls.
    const digests = yield* output("docker", [
      "inspect",
      "--format",
      "{{range .RepoDigests}}{{println .}}{{end}}",
      image,
    ]);
    const pinned = yield* Arr.findFirst(digests.split("\n"), (d) =>
      d.startsWith(`${repository}@`),
    ).pipe(
      Option.match({
        onNone: () =>
          Effect.fail(new ReleaseError({ message: `docker records no digest for ${image}` })),
        onSome: Effect.succeed,
      }),
    );

    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(path);
    const pins = new Set(images(cartridge));
    yield* fs.writeFileString(
      path,
      [...pins].reduce((t, pin) => t.replaceAll(pin, pinned), text),
    );

    yield* run(`${root}/scripts/ops`, ["deploy", "--stage", name]);
    yield* pins.has(pinned)
      ? Console.log(`${name} was already pinned to ${pinned}`)
      : run("git", [
          "-C",
          root,
          "commit",
          "-q",
          "-m",
          `chore(${name}): release ${commit}`,
          "--",
          path,
        ]);
    yield* Console.log(`Released ${pinned}`);
  }),
).pipe(Command.withDescription("Build, push, pin and deploy an app's current commit"));

/** Every image reference in the cartridge's services. */
const images = (cartridge: Cartridge.Cartridge) =>
  cartridge.services.map((service) => service.image);

/** The one registry repository the cartridge's images come from, without tag or digest. */
const oneRepository = (cartridge: Cartridge.Cartridge, path: string) => {
  const repositories = [
    ...new Set(images(cartridge).map((image) => image.replace(/[@:][^/]*$/, ""))),
  ];
  return repositories.length === 1
    ? Effect.succeed(repositories[0])
    : Effect.fail(
        new ReleaseError({
          message: `${path} must name one image to release; it names ${repositories.join(", ")}`,
        }),
      );
};

/** Runs a command with the terminal attached, and fails when it exits non-zero. */
const run = Effect.fn("run")(function* (command: string, args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner;
  const code = yield* spawner.exitCode(
    ChildProcess.make(command, args, { stdin: "inherit", stdout: "inherit", stderr: "inherit" }),
  );
  if (code !== 0) {
    return yield* new ReleaseError({ message: `${command} ${args.join(" ")} exited ${code}` });
  }
});

/** Runs a command and returns its output, failing when it exits non-zero. */
const output = Effect.fn("output")(function* (command: string, args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner;
  const handle = yield* spawner.spawn(ChildProcess.make(command, args, { stderr: "inherit" }));
  const text = yield* Stream.mkString(Stream.decodeText(handle.stdout));
  const code = yield* handle.exitCode;
  if (code !== 0) {
    return yield* new ReleaseError({ message: `${command} ${args.join(" ")} exited ${code}` });
  }
  return text;
}, Effect.scoped);

release.pipe(
  Command.run({ version: "1" }),
  Effect.tapErrorTag("ReleaseError", (error) => Console.error(error.message)),
  Effect.provide(BunServices.layer),
  BunRuntime.runMain,
);
