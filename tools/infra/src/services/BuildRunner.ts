import { Effect, Schema as S } from "effect";
import { spawn } from "bun";
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

export const makeBuildRunner = (createProcess: typeof spawn = spawn): BuildRunnerShape => ({
  _tag: "infra/BuildRunner",
  run: (cwd, command, args, env) => {
    const process = Effect.try({
      try: () =>
        createProcess({
          cmd: [command, ...args],
          cwd,
          stdout: "inherit",
          stderr: "inherit",
          env: { ...ENVIRONMENT, PATH: `${BUN_PATH}:${ENVIRONMENT.PATH ?? ""}`, ...env },
        }),
      catch: (error) =>
        new BuildError({
          command: `${command} ${args.join(" ")}`,
          message: `Failed to start process: ${String(error)}`,
        }),
    });
    return process.pipe(
      Effect.flatMap((proc) => Effect.promise(() => proc.exited)),
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
    );
  },
});

export class BuildRunner extends Effect.Service<BuildRunner>()("infra/BuildRunner", {
  effect: Effect.succeed(makeBuildRunner()),
  dependencies: [BunContext.layer],
}) {}
