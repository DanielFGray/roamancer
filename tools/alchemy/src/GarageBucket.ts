import * as Alchemy from "alchemy";
import * as Provider from "alchemy/Provider";
import { Effect, Option, Redacted, Schema as S } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { adminCredentialPath } from "./AdminCredential.ts";
import { portServiceName, ResourceName } from "./Job.ts";
import { Nomad } from "./Nomad.ts";
import { OpenBao } from "./OpenBao.ts";
import { OperationJournal } from "./OperationJournal.ts";
import { dependencyRegistrationRetry, firstServiceLocation } from "./ServiceRegistration.ts";

/**
 * The region Garage accepts. nixos/cynic/garage-image.nix writes the same value as `s3_region`,
 * and Garage refuses a request signed for any other region.
 */
export const garageRegion = "garage";

/** The named port of a Garage job that serves the admin API (docs/design/object-store.md). */
export const garageAdminPort = "admin";

/** Where a key's id and secret live, with the bucket and region a task needs beside them. */
export const objectStoreCredentialPath = (key: string) => `secret/data/garage/${key}`;

// S3 bucket names: 3 to 63 lowercase letters, digits and hyphens.
const BucketName = S.String.check(S.isPattern(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/));

/**
 * One app's key on one bucket. `key` names the key and its OpenBao path; `bucket` is the bucket
 * it may read and write. They differ only for a staged copy, whose key uses the live bucket.
 */
export const GarageBucketProps = S.Struct({
  server: ResourceName,
  bucket: BucketName,
  key: ResourceName,
});
export type GarageBucketProps = typeof GarageBucketProps.Type;

export interface GarageBucket extends Alchemy.Resource<
  "Garage.Bucket",
  GarageBucketProps,
  {
    id: string;
    server: string;
    bucket: string;
    credentialPath: string;
  }
> {}

export const GarageBucket = Alchemy.Resource<GarageBucket>("Garage.Bucket");

export class GarageError extends S.TaggedError<GarageError>()("GarageError", {
  operation: S.String,
  target: S.String,
}) {
  override get message() {
    return `Garage ${this.operation} failed for ${this.target}`;
  }
}

/** What OpenBao keeps at `objectStoreCredentialPath`; Job.ts renders these keys into a task. */
const StoredKey = S.Struct({
  accessKeyId: S.String,
  secretAccessKey: S.String,
  bucket: S.String,
  region: S.String,
});
type StoredKey = typeof StoredKey.Type;

const sameKey = (a: StoredKey, b: StoredKey) =>
  a.accessKeyId === b.accessKeyId &&
  a.secretAccessKey === b.secretAccessKey &&
  a.bucket === b.bucket &&
  a.region === b.region;

export const GarageBucketProvider = () =>
  Provider.effect(
    GarageBucket,
    Effect.gen(function* () {
      const nomad = yield* Nomad;
      const openBao = yield* OpenBao;
      const http = yield* HttpClient.HttpClient;
      const journal = yield* OperationJournal;

      const connect = Effect.fn("GarageBucket.connect")(function* (server: string) {
        const service = portServiceName(server, garageAdminPort);
        const location = yield* firstServiceLocation(
          service,
          nomad.service(service),
          dependencyRegistrationRetry,
        ).pipe(
          Effect.mapError(() => new GarageError({ operation: "find service", target: service })),
        );
        const token = yield* openBao.readAdminCredential(adminCredentialPath("garage", server));
        const adminToken = yield* Option.match(token, {
          onNone: () =>
            Effect.fail(new GarageError({ operation: "read admin token", target: server })),
          onSome: Effect.succeed,
        });
        return garageClient(http, {
          baseUrl: `http://${location.Address}:${location.Port}`,
          token: adminToken,
        });
      });

      const readStored = (path: string) =>
        openBao.readKvData(path).pipe(Effect.map(Option.flatMap(S.decodeUnknownOption(StoredKey))));

      return GarageBucket.Provider.of({
        list: () => Effect.succeed([]),
        stables: ["id"],
        reconcile: Effect.fn(function* ({ news, fqn }) {
          return yield* journal.run(
            {
              resourceId: fqn,
              provider: "Garage.Bucket",
              target: `${news.server}/${news.bucket}/${news.key}`,
              action: "reconcile",
            },
            Effect.gen(function* () {
              const client = yield* connect(news.server);
              yield* client.ensureLayout;
              const bucketId = yield* client.ensureBucket(news.bucket);
              const path = objectStoreCredentialPath(news.key);
              const stored = yield* readStored(path);
              const key = yield* ensureKey(client, stored, news);
              // An unchanged value is not written again, so no task re-renders its secrets.
              if (!Option.exists(stored, (value) => sameKey(value, key))) {
                yield* openBao.writeKvData(path, key);
              }
              yield* client.allow(bucketId, key.accessKeyId);
              return { id: fqn, server: news.server, bucket: news.bucket, credentialPath: path };
            }),
          );
        }),
        // Keeps the bucket and its objects: a staged copy's key uses the live bucket, so only
        // the key is the resource's own. A later reconcile makes a new key.
        delete: Effect.fn(function* ({ fqn, olds }) {
          yield* journal.run(
            {
              resourceId: fqn,
              provider: "Garage.Bucket",
              target: `${olds.server}/${olds.bucket}/${olds.key}`,
              action: "delete",
            },
            Effect.gen(function* () {
              const stored = yield* readStored(objectStoreCredentialPath(olds.key));
              if (Option.isNone(stored)) return;
              const client = yield* connect(olds.server);
              yield* client.deleteKey(stored.value.accessKeyId);
            }),
          );
        }),
      });
    }),
  );

/**
 * The stored key when Garage still has it, with the bucket and region brought up to date;
 * otherwise a new key. Garage shows a secret key only when it creates the key, so OpenBao holds
 * the only copy, and a key that Garage lost cannot be recovered.
 */
const ensureKey = Effect.fn("GarageBucket.ensureKey")(function* (
  client: GarageClient,
  stored: Option.Option<StoredKey>,
  props: GarageBucketProps,
) {
  const live = yield* Option.match(stored, {
    onNone: () => Effect.succeed(Option.none<StoredKey>()),
    onSome: (key) =>
      client
        .keyExists(key.accessKeyId)
        .pipe(Effect.map((exists) => (exists ? Option.some(key) : Option.none()))),
  });
  const key = yield* Option.match(live, {
    onSome: Effect.succeed,
    onNone: () => client.createKey(props.key),
  });
  return { ...key, bucket: props.bucket, region: garageRegion };
});

// One node holds every partition, so its capacity only has to be above zero; it does not
// limit what the node stores.
const nodeCapacityBytes = 50_000_000_000;

const ClusterLayout = S.Struct({ version: S.Number, roles: S.Array(S.Unknown) });
const ClusterStatus = S.Struct({ nodes: S.Array(S.Struct({ id: S.String })) });
const BucketInfo = S.Struct({ id: S.String });
const CreatedKey = S.Struct({ accessKeyId: S.String, secretAccessKey: S.String });

export type GarageClient = ReturnType<typeof garageClient>;

/** The admin API (version 2) of one Garage server, with its admin token. */
export const garageClient = (
  http: HttpClient.HttpClient,
  server: { readonly baseUrl: string; readonly token: Redacted.Redacted<string> },
) => {
  const client = http.pipe(
    HttpClient.mapRequest(HttpClientRequest.prependUrl(server.baseUrl)),
    HttpClient.mapRequest(HttpClientRequest.bearerToken(Redacted.value(server.token))),
  );
  const failure = (operation: string, target: string) => () =>
    new GarageError({ operation, target });

  // Garage answers 404 for a bucket or key it does not have.
  const find = <A, I>(schema: S.Codec<A, I>, operation: string, target: string, url: string) =>
    client.execute(HttpClientRequest.get(url)).pipe(
      Effect.flatMap((response) =>
        response.status === 404
          ? Effect.succeed(Option.none<A>())
          : HttpClientResponse.filterStatusOk(response).pipe(
              Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
              Effect.map(Option.some),
            ),
      ),
      Effect.mapError(failure(operation, target)),
    );
  const get = <A, I>(schema: S.Codec<A, I>, operation: string, url: string) =>
    client
      .execute(HttpClientRequest.get(url))
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
        Effect.mapError(failure(operation, url)),
      );
  const post = (operation: string, target: string, url: string, body?: unknown) =>
    HttpClientRequest.bodyJson(HttpClientRequest.post(url), body ?? {}).pipe(
      Effect.flatMap(client.execute),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.mapError(failure(operation, target)),
    );
  const postFor = <A, I>(
    schema: S.Codec<A, I>,
    operation: string,
    target: string,
    url: string,
    body: unknown,
  ) =>
    post(operation, target, url, body).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
      Effect.mapError(failure(operation, target)),
    );

  return {
    /**
     * Gives the one node a storage role and applies the layout, when the layout has no role.
     * A new Garage node stores nothing until then; a later call finds the role and does nothing.
     */
    ensureLayout: Effect.gen(function* () {
      const layout = yield* get(ClusterLayout, "read layout", "/v2/GetClusterLayout");
      if (layout.roles.length > 0) return;
      const status = yield* get(ClusterStatus, "read cluster status", "/v2/GetClusterStatus");
      if (status.nodes.length !== 1) {
        return yield* new GarageError({
          operation: "assign layout",
          target: `${status.nodes.length} nodes; one node expected`,
        });
      }
      const node = status.nodes[0].id;
      yield* post("assign layout", node, "/v2/UpdateClusterLayout", {
        roles: [{ id: node, zone: "dc1", capacity: nodeCapacityBytes, tags: [] }],
      });
      yield* post("apply layout", node, "/v2/ApplyClusterLayout", { version: layout.version + 1 });
    }),
    /** The id of the bucket with this global alias, created when it is missing. */
    ensureBucket: Effect.fn("Garage.ensureBucket")(function* (bucket: string) {
      const found = yield* find(
        BucketInfo,
        "read bucket",
        bucket,
        `/v2/GetBucketInfo?globalAlias=${encodeURIComponent(bucket)}`,
      );
      if (Option.isSome(found)) return found.value.id;
      const created = yield* postFor(BucketInfo, "create bucket", bucket, "/v2/CreateBucket", {
        globalAlias: bucket,
      });
      return created.id;
    }),
    keyExists: (accessKeyId: string) =>
      find(
        S.Struct({ accessKeyId: S.String }),
        "read key",
        accessKeyId,
        `/v2/GetKeyInfo?id=${encodeURIComponent(accessKeyId)}`,
      ).pipe(Effect.map(Option.isSome)),
    createKey: (name: string) => postFor(CreatedKey, "create key", name, "/v2/CreateKey", { name }),
    /** Lets the key read and write the bucket. It never makes the key an owner. */
    allow: (bucketId: string, accessKeyId: string) =>
      post("allow key", accessKeyId, "/v2/AllowBucketKey", {
        bucketId,
        accessKeyId,
        permissions: { read: true, write: true, owner: false },
      }).pipe(Effect.asVoid),
    deleteKey: (accessKeyId: string) =>
      client
        .execute(HttpClientRequest.post(`/v2/DeleteKey?id=${encodeURIComponent(accessKeyId)}`))
        .pipe(
          Effect.flatMap((response) =>
            response.status === 404
              ? Effect.void
              : HttpClientResponse.filterStatusOk(response).pipe(Effect.asVoid),
          ),
          Effect.mapError(failure("delete key", accessKeyId)),
        ),
  };
};
