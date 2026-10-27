/**
 * systemd template units for queued jobs, via ChildProcessSpawner.
 * Exclusion of concurrent jobs is the Store reservation — these helpers only start units.
 */
import { Context, Effect, Layer } from "effect";
import { ChildProcess } from "effect/process";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import { UnitsError } from "./Errors.ts";
import { unitName } from "./Schema.ts";

const asUnitsError = (error: unknown) =>
  new UnitsError({
    message: error instanceof Error ? error.message : String(error),
  });

export class Units extends Context.Service<Units>()("alchemy/queue/Units", {
  make: Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner;

    const run = (args: ReadonlyArray<string>) =>
      spawner
        .exitCode(ChildProcess.make("systemctl", args, { stdout: "ignore", stderr: "ignore" }))
        .pipe(Effect.mapError(asUnitsError));

    const start = (id: number) =>
      run(["start", "--no-block", unitName(id)]).pipe(
        Effect.flatMap((code) =>
          code === 0
            ? Effect.void
            : Effect.fail(
                new UnitsError({ message: `systemctl start ${unitName(id)} exited ${code}` }),
              ),
        ),
      );

    const isActive = (id: number) =>
      run(["is-active", "--quiet", unitName(id)]).pipe(Effect.map((code) => code === 0));

    return { start, isActive } as const;
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}

/** Alias so existing imports of `layer` keep working. */
export const layer = Units.layer;
