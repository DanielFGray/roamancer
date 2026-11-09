/**
 * The cluster image registry, as the runner asks it. The runner never trusts a digest that a
 * build job printed: it records one only after the registry answers for it.
 */
import { Context, Effect, Layer, Schema as S } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

export class RegistryError extends S.TaggedError<RegistryError>()("RegistryError", {
  detail: S.String,
}) {
  override get message() {
    return `registry check failed: ${this.detail}`;
  }
}

export class Registry extends Context.Service<
  Registry,
  {
    /** Whether the registry holds a manifest for `repository@digest`. */
    readonly has: (repository: string, digest: string) => Effect.Effect<boolean, RegistryError>;
  }
>()("ops/Registry") {}

// Both image formats and both index formats: a build may push either.
const accept = [
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
].join(", ");

/**
 * Asks over HTTPS. The host's registry certificate comes from the cluster CA, which the
 * runner's unit trusts through NODE_EXTRA_CA_CERTS.
 */
export const layer = Layer.effect(
  Registry,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    return Registry.of({
      has: (repository, digest) => {
        const slash = repository.indexOf("/");
        const host = repository.slice(0, slash);
        const name = repository.slice(slash + 1);
        return http
          .execute(
            HttpClientRequest.head(`https://${host}/v2/${name}/manifests/${digest}`).pipe(
              HttpClientRequest.setHeader("Accept", accept),
            ),
          )
          .pipe(
            Effect.mapError((cause) => new RegistryError({ detail: cause.message })),
            Effect.flatMap((response) =>
              response.status === 200
                ? Effect.succeed(true)
                : response.status === 404
                  ? Effect.succeed(false)
                  : Effect.fail(new RegistryError({ detail: `answered ${response.status}` })),
            ),
          );
      },
    });
  }),
);
