/**
 * The `builds` bucket in Garage, as the runner uses it: it uploads an exported tree, makes a
 * short-lived URL that the Nomad client fetches the tree from, and deletes the tree after the
 * build. Only the runner holds the bucket's key (OpenBao `secret/data/garage/builds`, written
 * by the `builds` platform cartridge), so a build job never sees a credential.
 */
import { Context, Effect, FileSystem, Layer, Option, Schema as S } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { StoredKey, objectStoreCredentialPath } from "./GarageBucket.ts";
import { Nomad } from "./Nomad.ts";
import { OpenBao } from "./OpenBao.ts";
import { presign } from "./Presign.ts";

/** The bucket, and the cartridge name whose key writes it. */
export const buildsBucket = "builds";

/** The Nomad service of Garage's S3 API (`GarageServer` in platform/data). */
const garageService = "garage";

export class BuildStoreError extends S.TaggedError<BuildStoreError>()("BuildStoreError", {
  operation: S.String,
  detail: S.String,
}) {
  override get message() {
    return `builds bucket ${this.operation} failed: ${this.detail}`;
  }
}

export class BuildStore extends Context.Service<
  BuildStore,
  {
    /** Upload the file at `file` as `object`. */
    readonly put: (object: string, file: string) => Effect.Effect<void, BuildStoreError>;
    /** A URL that fetches `object` until `expiresSeconds` pass. */
    readonly getUrl: (
      object: string,
      expiresSeconds: number,
    ) => Effect.Effect<string, BuildStoreError>;
    /** Delete `object`; an object that is already gone is not an error. */
    readonly remove: (object: string) => Effect.Effect<void, BuildStoreError>;
  }
>()("ops/BuildStore") {}

export const layer = Layer.effect(
  BuildStore,
  Effect.gen(function* () {
    const openBao = yield* OpenBao;
    const nomad = yield* Nomad;
    const http = yield* HttpClient.HttpClient;
    const fs = yield* FileSystem.FileSystem;

    /** The key and S3 address as they are now: Garage's port is dynamic, so each use looks it up. */
    const connect = Effect.gen(function* () {
      const fail = (operation: string) => (cause: { readonly message: string }) =>
        new BuildStoreError({ operation, detail: cause.message });
      const stored = yield* openBao
        .readKvData(objectStoreCredentialPath(buildsBucket))
        .pipe(Effect.mapError(fail("read key")));
      const key = yield* Option.match(Option.flatMap(stored, S.decodeUnknownOption(StoredKey)), {
        onNone: () =>
          Effect.fail(
            new BuildStoreError({
              operation: "read key",
              detail: `OpenBao has no key at ${objectStoreCredentialPath(buildsBucket)}; deploy the platform-builds cartridge`,
            }),
          ),
        onSome: Effect.succeed,
      });
      const [location] = yield* nomad.service(garageService).pipe(Effect.mapError(fail("find S3")));
      if (location === undefined) {
        return yield* new BuildStoreError({
          operation: "find S3",
          detail: `Nomad lists no ${garageService} service`,
        });
      }
      return { key, endpoint: `http://${location.Address}:${location.Port}` };
    });

    const sign = (method: "GET" | "PUT" | "DELETE", object: string, expiresSeconds: number) =>
      Effect.map(connect, ({ key, endpoint }) =>
        presign({
          method,
          endpoint,
          region: key.region,
          bucket: key.bucket,
          object,
          accessKeyId: key.accessKeyId,
          secretAccessKey: key.secretAccessKey,
          expiresSeconds,
          now: new Date(),
        }),
      );

    /** Run a signed request and fail unless the store answers with an accepted status. */
    const send = <E extends { readonly message: string }, R>(
      operation: string,
      request: Effect.Effect<HttpClientRequest.HttpClientRequest, E, R>,
      okStatus: (status: number) => boolean,
    ) =>
      Effect.gen(function* () {
        const response = yield* Effect.flatMap(request, http.execute);
        if (!okStatus(response.status)) {
          return yield* new BuildStoreError({
            operation,
            detail: `Garage answered ${response.status}`,
          });
        }
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof BuildStoreError
            ? cause
            : new BuildStoreError({ operation, detail: cause.message }),
        ),
      );

    return BuildStore.of({
      put: (object, file) =>
        sign("PUT", object, 600).pipe(
          Effect.flatMap((url) =>
            send(
              "upload",
              HttpClientRequest.bodyFile(file)(HttpClientRequest.put(url)).pipe(
                Effect.provideService(FileSystem.FileSystem, fs),
              ),
              (status) => status >= 200 && status < 300,
            ),
          ),
        ),
      getUrl: (object, expiresSeconds) => sign("GET", object, expiresSeconds),
      remove: (object) =>
        sign("DELETE", object, 60).pipe(
          Effect.flatMap((url) =>
            send(
              "delete",
              Effect.succeed(HttpClientRequest.make("DELETE")(url)),
              (status) => (status >= 200 && status < 300) || status === 404,
            ),
          ),
        ),
    });
  }),
);
