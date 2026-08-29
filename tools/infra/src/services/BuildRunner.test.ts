import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { BuildError, makeBuildRunner } from "./BuildRunner.ts";

it.effect("maps process launch failures to BuildError", () =>
  Effect.gen(function* () {
    const runner = makeBuildRunner();
    const result = yield* Effect.either(
      runner.run("/tmp/project", "infra-buildrunner-test-nonexistent-binary", ["run", "build"]),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(BuildError);
      expect(result.left.command).toBe("infra-buildrunner-test-nonexistent-binary run build");
      expect(result.left.message).toContain("Failed to start process");
    }
  }),
);

it.effect("maps a non-zero exit code to BuildError", () =>
  Effect.gen(function* () {
    const runner = makeBuildRunner();
    const result = yield* Effect.either(runner.run("/tmp", "sh", ["-c", "exit 3"]));

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(BuildError);
      expect(result.left.message).toBe("Exit code: 3");
    }
  }),
);
