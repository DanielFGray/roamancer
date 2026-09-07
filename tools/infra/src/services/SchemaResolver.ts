import { Effect, Schema as S, Stream } from "effect";
import * as Command from "@effect/platform/Command";
import * as FileSystem from "@effect/platform/FileSystem";
import * as Path from "@effect/platform/Path";
import { BunContext } from "@effect/platform-bun";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Service
//
// Resolves a varlock `.env.schema` source (static defaults, `randomHex()` /
// `randomString()` generation, `ref()` / `concat()` composition, `@required`
// / `@sensitive` validation) into a flat key/value record.
//
// `overrides` seeds the resolution as process-env values, which varlock
// treats as the highest-priority source: an overridden field keeps that
// value, and any `ref()`/`concat()` built from it picks up the override too.
// This is how an existing vault value survives re-resolution without us
// reimplementing composition ourselves.
// ---------------------------------------------------------------------------

export class SchemaResolveError extends S.TaggedError<SchemaResolveError>()("SchemaResolveError", {
  message: S.String,
}) {}

const readAll = (stream: Stream.Stream<Uint8Array, unknown>) =>
  Stream.decodeText(stream).pipe(
    Stream.runFold("", (acc, chunk) => acc + chunk),
    Effect.orElseSucceed(() => ""),
  );

// `varlock` is a regular dependency (resolved at runtime, not just for
// dev/test), but we still invoke its binary by absolute path rather than
// relying on PATH: the deployed infra-agent is started as
// `bun run <file>`, which -- unlike `bun run <script-name>` -- does not
// prepend node_modules/.bin. Derived from this file's own location
// (src/services/SchemaResolver.ts) rather than `import.meta.resolve`,
// which Vitest's SSR module runner doesn't implement.
const thisFile = fileURLToPath(import.meta.url);
const packageRoot = thisFile.split("/").slice(0, -3).join("/");
const varlockBin = `${packageRoot}/node_modules/.bin/varlock`;

const VarlockJsonFull = S.Struct({
  config: S.Record({ key: S.String, value: S.Struct({ value: S.optional(S.Unknown) }) }),
  errors: S.optional(
    S.Struct({
      root: S.optional(S.Array(S.String)),
      configItems: S.optional(S.Record({ key: S.String, value: S.String })),
    }),
  ),
});
const decodeVarlockOutput = S.decodeUnknown(S.parseJson(VarlockJsonFull));

const runVarlock = (schemaDir: string, overrides: Record<string, string>) =>
  Effect.gen(function* () {
    const process = yield* Command.start(
      Command.make(varlockBin, "load", "--format", "json-full", "-p", schemaDir).pipe(
        Command.env(overrides),
      ),
    );
    const stdout = yield* readAll(process.stdout);
    yield* process.exitCode;

    const parsed = yield* decodeVarlockOutput(stdout).pipe(
      Effect.mapError(
        () => new SchemaResolveError({ message: `Could not parse varlock output: ${stdout}` }),
      ),
    );

    if (parsed.errors) {
      const messages = [
        ...(parsed.errors.root ?? []),
        ...Object.entries(parsed.errors.configItems ?? {}).map(
          ([key, message]) => `${key}: ${message}`,
        ),
      ];
      return yield* new SchemaResolveError({ message: messages.join("; ") });
    }

    return Object.fromEntries(
      Object.entries(parsed.config).map(([key, field]) => [key, String(field.value ?? "")]),
    );
  }).pipe(Effect.scoped);

export class SchemaResolver extends Effect.Service<SchemaResolver>()("infra/SchemaResolver", {
  effect: Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    return {
      resolve: (
        schemaSource: string,
        overrides: Record<string, string> = {},
      ): Effect.Effect<Record<string, string>, SchemaResolveError> =>
        Effect.gen(function* () {
          const dir = yield* fs.makeTempDirectoryScoped();
          yield* fs.writeFileString(path.join(dir, ".env.schema"), schemaSource);
          return yield* runVarlock(dir, overrides);
        }).pipe(
          Effect.scoped,
          Effect.catchTags({
            SystemError: (error) => new SchemaResolveError({ message: error.message }),
            BadArgument: (error) => new SchemaResolveError({ message: error.message }),
          }),
          Effect.provide(BunContext.layer),
        ),
    };
  }),
  dependencies: [BunContext.layer],
}) {}
