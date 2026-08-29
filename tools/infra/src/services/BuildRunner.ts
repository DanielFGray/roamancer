import { Effect, Schema as S } from "effect";
import * as Command from "@effect/platform/Command";
import { BunContext } from "@effect/platform-bun";
import { ENVIRONMENT, HOME_DIR } from "../lib/config.ts";

export class BuildError extends S.TaggedError<BuildError>()("BuildError", {
  command: S.String,
  message: S.String,
}) {}

export interface BuildRunnerShape {
  readonly _tag: "infra/BuildRunner";
  readonly run: (
    cwd: string,
    command: string,
    args: ReadonlyArray<string>,
    env?: Readonly<Record<string, string>>,
  ) => Effect.Effect<void, BuildError>;
}

const BUN_PATH = `${HOME_DIR}/.bun/bin`;

export const makeBuildRunner = (): BuildRunnerShape => ({
  _tag: "infra/BuildRunner",
  run: (cwd, command, args, env) =>
    Command.make(command, ...args).pipe(
      Command.workingDirectory(cwd),
      Command.env({ ...ENVIRONMENT, PATH: `${BUN_PATH}:${ENVIRONMENT.PATH ?? ""}`, ...env }),
      Command.stdout("inherit"),
      Command.stderr("inherit"),
      Command.exitCode,
      Effect.scoped,
      Effect.provide(BunContext.layer),
      Effect.mapError(
        (error) =>
          new BuildError({
            command: `${command} ${args.join(" ")}`,
            message: `Failed to start process: ${error.message}`,
          }),
      ),
      Effect.flatMap((exitCode) =>
        exitCode === 0
          ? Effect.void
          : Effect.fail(
              new BuildError({
                command: `${command} ${args.join(" ")}`,
                message: `Exit code: ${exitCode}`,
              }),
            ),
      ),
    ),
});

export class BuildRunner extends Effect.Service<BuildRunner>()("infra/BuildRunner", {
  effect: Effect.succeed(makeBuildRunner()),
}) {}
