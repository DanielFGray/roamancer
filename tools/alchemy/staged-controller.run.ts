import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as S from "effect/Schema";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/http";
import { Nomad, layer as nomadLayer } from "./src/Nomad.ts";

class DeployCommandFailed extends S.TaggedError<DeployCommandFailed>()("DeployCommandFailed", {
  exitCode: S.Number,
}) {}

const retrySchedule = Schedule.min([
  Schedule.exponential("1 second"),
  Schedule.spaced("30 seconds"),
]);

const reconcileAttempt = (runner: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const process = yield* spawner
        .spawn(ChildProcess.make(runner, ["reconcile"], { cwd: ".", extendEnv: true }))
        .pipe(Effect.tapError((cause) => Effect.logError("Could not start Alchemy deploy", cause)));
      yield* process.all.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.filter((line) => line.length > 0),
        Stream.runForEach((line) => Effect.logInfo(line)),
      );
      const exitCode = yield* process.exitCode;
      if (exitCode !== 0) return yield* new DeployCommandFailed({ exitCode });
      yield* Effect.logInfo("Alchemy staged state reconciled");
    }),
  );

const watch = Effect.gen(function* () {
  const nomad = yield* Nomad;
  // Missing host-runner configuration is a startup error, not a reconnect condition.
  const runner = yield* Config.String("ALCHEMY_HOST_RUNNER");
  // Scope each retry separately so a failed child process releases its resources before retry.
  const reconcile = reconcileAttempt(runner).pipe(
    Effect.tapError((cause) => Effect.logError("Alchemy staged reconcile failed", cause)),
    Effect.retry(retrySchedule),
  );

  yield* Effect.forever(
    Effect.gen(function* () {
      // Reconcile after every stream reconnect so event history gaps cannot leave stale routes.
      yield* reconcile;
      yield* nomad.allocationChanges.pipe(
        Stream.groupedWithin(64, "300 millis"),
        Stream.map((batches) => Array.from(new Set(batches.flat()))),
        Stream.filter((jobNames) => jobNames.length > 0),
        Stream.runForEach((changedJobNames) =>
          nomad.jobs().pipe(
            Effect.flatMap((jobs) => {
              const releaseSetChanged = changedJobNames.some((name) =>
                jobs.some(
                  (job) => job.ID === name && job.Meta?.["alchemy.provider"] === "Nomad.ReleaseSet",
                ),
              );
              return releaseSetChanged ? reconcile : Effect.void;
            }),
          ),
        ),
      );
    }).pipe(
      Effect.tapError((cause) =>
        Effect.logError("Nomad allocation watch failed; reconnecting", cause),
      ),
      Effect.catchTag("NomadError", () => Effect.void),
      Effect.delay("3 seconds"),
    ),
  );
});

const services = Layer.mergeAll(
  BunServices.layer,
  ConfigProvider.layer(ConfigProvider.fromEnv()),
  Layer.provide(nomadLayer(), FetchHttpClient.layer),
);

Effect.scoped(watch).pipe(Effect.provide(services), BunRuntime.runMain);
