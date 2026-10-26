import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as S from "effect/Schema";
import { appIdentifier, type Cartridge } from "./Cartridge.ts";
import {
  type CartridgeEnvironmentEntry,
  type CartridgeJob,
  type CartridgeSecretReference,
} from "./Job.ts";

/**
 * A staged instance is a second copy of a cartridge, deployed beside the live one.
 * `alchemy plan|deploy|destroy --stage <app>-staged` runs the same services on the
 * candidate image under suffixed names, with tailnet-only routes, so it names, writes and
 * routes nothing the live instance owns.
 */

/** The suffix every derived name of a staged instance carries. */
export const stagedSuffix = "-staged";

/** Refused when the cartridge's services do not all run one image. */
export class ImagesNotShared extends S.TaggedError<ImagesNotShared>()("ImagesNotShared", {
  cartridge: S.String,
  images: S.Array(S.String),
}) {
  override get message() {
    const found =
      this.images.length === 0
        ? "no image"
        : `${this.images.length} images: ${this.images.join(", ")}`;
    return `cartridge '${this.cartridge}' declares ${found}; a staged instance runs one candidate image`;
  }
}

/** Refused when the candidate image names no tag: the tag is the commit in the preview host. */
export class UntaggedImage extends S.TaggedError<UntaggedImage>()("UntaggedImage", {
  image: S.String,
}) {
  override get message() {
    return `image '${this.image}' has no tag; a staged route requires a commit tag`;
  }
}

/** Refused when a service would mount its live host volume in the staged copy too. */
export class WritableStorage extends S.TaggedError<WritableStorage>()("WritableStorage", {
  cartridge: S.String,
  service: S.String,
  volume: S.String,
}) {
  override get message() {
    return `service '${this.service}' of cartridge '${this.cartridge}' writes host volume '${this.volume}'; a staged copy would write the live host volume`;
  }
}

/** The base cartridge name of a stage, none when the stage is not `<name>-staged`. */
export const baseName = (stage: string): Option.Option<string> =>
  stage.endsWith(stagedSuffix)
    ? Option.filter(Option.some(stage.slice(0, -stagedSuffix.length)), (base) => base.length > 0)
    : Option.none();

/**
 * The staged copy of `cartridge`: every name it derives carries the suffix, every service
 * runs the tagged `image`, and each route is available only from the tailnet. The cartridge
 * passed in is not touched.
 *
 * An environment entry that names one of the cartridge's databases is replaced by that
 * database's staged name, whether it carries the name as a value or as the database of a
 * role entry. A staged instance therefore gets its own owner and visitor roles; nothing in
 * the copy names a role of the live instance.
 *
 * Refused when the services do not all run one image, because one candidate image cannot
 * replace them, and when a service writes a host volume, because the copy would write the
 * live volume.
 */
export const staged = (
  cartridge: Cartridge,
  image: string,
): Effect.Effect<Cartridge, ImagesNotShared | WritableStorage | UntaggedImage> =>
  Effect.gen(function* () {
    const commit = yield* Option.match(imageTag(image), {
      onNone: () => Effect.fail(new UntaggedImage({ image })),
      onSome: Effect.succeed,
    });
    const jobs = jobsOf(cartridge);
    const images = [...new Set(cartridge.services.map((service) => service.image))];
    if (images.length !== 1) {
      return yield* Effect.fail(new ImagesNotShared({ cartridge: cartridge.name, images }));
    }
    yield* Option.match(firstWritableService(jobs), {
      onNone: () => Effect.void,
      onSome: (writable) =>
        Effect.fail(new WritableStorage({ cartridge: cartridge.name, ...writable })),
    });

    const derived: DerivedNames = {
      ownServices: new Set(jobs.map((job) => job.name)),
      databases: databaseNames(cartridge),
      database: (database) => stagedDatabaseName(cartridge, database),
      liveHosts: new Set(jobs.flatMap((job) => job.routes.map((route) => route.host))),
      host: (host) => `${commit}.staged.${host}`,
    };
    return {
      ...cartridge,
      name: `${cartridge.name}${stagedSuffix}`,
      services: cartridge.services.map((service) => stagedJob({ ...service, image }, derived)),
      servers: cartridge.servers.map((server) => ({
        ...server,
        service: stagedJob(server.service, derived),
      })),
      // The staged database copies the live one, so it names it; its roles are its own.
      postgres: cartridge.postgres.map((entry) => ({
        ...entry,
        database: derived.database(entry.database),
        copyFrom: entry.database,
      })),
    };
  });

/**
 * The names one job derives from the live cartridge: which services are its own to
 * retarget, which values name a database, and how a database name stages.
 */
type DerivedNames = {
  readonly ownServices: ReadonlySet<string>;
  readonly databases: ReadonlySet<string>;
  readonly database: (database: string) => string;
  readonly liveHosts: ReadonlySet<string>;
  readonly host: (host: string) => string;
};

/** Every job of the cartridge, the servers' services first, in declaration order. */
const jobsOf = (cartridge: Cartridge): ReadonlyArray<CartridgeJob> => [
  ...cartridge.servers.map((server) => server.service),
  ...cartridge.services,
];

/** The live database names of the cartridge, the values an environment entry may name. */
const databaseNames = (cartridge: Cartridge) =>
  new Set(cartridge.postgres.map((entry) => entry.database));

/**
 * The staged name of a database: the live app identifier it starts with is replaced by
 * the staged one, so `giglist` becomes `giglist_staged` and `giglist_reports` becomes
 * `giglist_staged_reports`. Cartridge requires every database to start with the app
 * identifier, so the prefix to replace is always there.
 */
const stagedDatabaseName = (cartridge: Cartridge, database: string) => {
  const live = appIdentifier(cartridge.name);
  const stagedApp = appIdentifier(`${cartridge.name}${stagedSuffix}`);
  return `${stagedApp}${database.slice(live.length)}`;
};

/**
 * The first service that would write a host volume, with the volume it writes. The staged
 * copy mounts the same host volume as the live service, so a writable volume is refused
 * rather than renamed; `readOnlyMounts` mount read-only and are safe to copy.
 */
const firstWritableService = (jobs: ReadonlyArray<CartridgeJob>) =>
  Arr.head(
    jobs.flatMap((job) =>
      job.storage === undefined ? [] : [{ service: job.name, volume: job.storage.volume }],
    ),
  );

const stagedSecret = (
  secret: CartridgeSecretReference,
  derived: DerivedNames,
): CartridgeSecretReference =>
  secret._tag === "PostgresCredentials"
    ? { ...secret, database: derived.database(secret.database) }
    : secret;

const stagedMigrate = (
  migrate: Exclude<CartridgeJob["migrate"], undefined>,
  derived: DerivedNames,
) => ({
  ...migrate,
  secrets: migrate.secrets.map((secret) => stagedSecret(secret, derived)),
});

/**
 * One environment entry of the copy. A database role entry follows its database's rename, so
 * the copy's services name their own roles; a literal value that names one of this cartridge's
 * databases is replaced by that database's staged name. Every other value names no database of
 * this cartridge and stands as it is.
 */
const stagedEnvironment = (entry: CartridgeEnvironmentEntry, derived: DerivedNames) => {
  if ("database" in entry) return { ...entry, database: derived.database(entry.database) };
  // A root URL names a live route host; the copy serves it at the staged host instead.
  const url = entry.value.replace(/\/$/, "");
  const host = url.startsWith("https://") ? url.slice("https://".length) : "";
  return derived.liveHosts.has(host)
    ? { ...entry, value: `https://${derived.host(host)}` }
    : derived.databases.has(entry.value)
      ? { ...entry, value: derived.database(entry.value) }
      : entry;
};

/**
 * One job of the copy, already carrying its staged name and image. Connections to services
 * of this cartridge follow their target's rename; a connection to a service this cartridge
 * does not declare names another cartridge's service and stays as it is.
 */
const stagedJob = (job: CartridgeJob, derived: DerivedNames): CartridgeJob => {
  const named = {
    ...job,
    name: `${job.name}${stagedSuffix}`,
    routes: job.routes.map((route) => ({
      ...route,
      host: derived.host(route.host),
      access: "tailnet" as const,
    })),
    environment: job.environment.map((entry) => stagedEnvironment(entry, derived)),
    connections: job.connections.map((connection) =>
      derived.ownServices.has(connection.service)
        ? { ...connection, service: `${connection.service}${stagedSuffix}` }
        : connection,
    ),
    secrets: job.secrets.map((secret) => stagedSecret(secret, derived)),
  };
  return job.migrate === undefined
    ? named
    : { ...named, migrate: stagedMigrate(job.migrate, derived) };
};

/**
 * The tag of an image reference such as `registry:5000/app:3f9c2ab@sha256:…`: the text after
 * the last colon of the last path segment, once the digest is removed. A registry port is in
 * an earlier segment, so it is never taken for a tag.
 */
const imageTag = (image: string): Option.Option<string> => {
  const name = image.split("@")[0];
  const segment = name.slice(name.lastIndexOf("/") + 1);
  const colon = segment.indexOf(":");
  return colon === -1 ? Option.none() : Option.some(segment.slice(colon + 1));
};
