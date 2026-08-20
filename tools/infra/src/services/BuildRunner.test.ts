import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { BuildError, makeBuildRunner } from "./BuildRunner.ts";

it.effect("maps process launch failures to BuildError", () =>
  Effect.gen(function* () {
    const runner = makeBuildRunner(() => {
      throw new Error("spawn failed");
    });
    const result = yield* Effect.either(runner.run("/tmp/project", "bun", ["run", "build"]));

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(BuildError);
      expect(result.left).toMatchObject({
        command: "bun run build",
        message: "Failed to start process: Error: spawn failed",
      });
    }
  }),
);
