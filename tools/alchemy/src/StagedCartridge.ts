import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as S from "effect/Schema";
import { type Cartridge, instanceDatabaseName } from "./Cartridge.ts";
import {
  type CartridgeEnvironmentEntry,
  type CartridgeJob,
  type CartridgeSecretReference,
  Route,
} from "./Job.ts";

/**
 * A staged instance is a second copy of a cartridge, deployed beside the live one.
 * `alchemy plan|deploy|destroy --stage <app>-staged` runs the same services on the
 * candidate image under suffixed names, with tailnet-only routes, so it names, writes and
 * routes nothing the live instance owns.
 */

/** The suffix every derived name of a staged instance carries. */
export const stagedSuffix = "-staged";
const stagedTailnetRoute: Route = { access: "tailnet" };

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
 * Each staged database copies its live database when the app has been released. A
 * never-released app has no live database to copy, so its staged databases start empty
 * and the cartridge's migrations build them. The caller decides from the deployment
 * record, not from whether the live database exists, so a released app whose live
 * database is missing still fails its copy instead of staging on empty data.
 *
 * The copy's object store key reads and writes the live bucket, so its rows name objects that
 * exist. So a staged copy can change live objects; docs/design/object-store.md records why.
 *
 * Refused when the services do not all run one image, because one candidate image cannot
 * replace them, and when a service writes a host volume, because the copy would write the
 * live volume.
 */
export const staged = (
  cartridge: Cartridge,
  image: string,
  live: { readonly released: boolean },
): Effect.Effect<Cartridge, ImagesNotShared | WritableStorage> =>
  Effect.gen(function* () {
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
      database: (database) => instanceDatabaseName(cartridge.name, "staged", database),
      liveHosts: new Map(
        jobs.flatMap((job) =>
          job.routes.flatMap((route) =>
            route.access === "public" ? [[route.host, `${job.name}${stagedSuffix}`] as const] : [],
          ),
        ),
      ),
    };
    return {
      ...cartridge,
      name: `${cartridge.name}${stagedSuffix}`,
      services: cartridge.services.map((service) => stagedJob({ ...service, image }, derived)),
      servers: cartridge.servers.map((server) => ({
        ...server,
        service: stagedJob(server.service, derived),
      })),
      // A copy names the live database it copies; its roles are its own either way. A
      // never-released entry keeps whatever copy source its own declaration names.
      postgres: cartridge.postgres.map((entry) => ({
        ...entry,
        database: derived.database(entry.database),
        copyFrom: live.released ? entry.database : entry.copyFrom,
      })),
      // The staged key uses the live bucket (docs/design/object-store.md); its name, the copy's
      // own, comes from the cartridge name.
      ...(cartridge.objectStore === undefined
        ? {}
        : {
            objectStore: {
              ...cartridge.objectStore,
              bucket: cartridge.objectStore.bucket ?? cartridge.name,
            },
          }),
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
  readonly liveHosts: ReadonlyMap<string, string>;
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
 * databases is replaced by that database's staged name. A Valkey key prefix entry stands as it
 * is: expansion resolves it from the copy's own name. Every other value names no database of
 * this cartridge and stands as it is.
 */
const stagedEnvironment = (entry: CartridgeEnvironmentEntry, derived: DerivedNames) => {
  if ("database" in entry) return { ...entry, database: derived.database(entry.database) };
  if ("valkey" in entry) return entry;
  if ("route" in entry) {
    return derived.ownServices.has(entry.route)
      ? { ...entry, route: `${entry.route}${stagedSuffix}` }
      : entry;
  }
  // A root URL names a live route host; the copy serves it at the staged host instead.
  const url = entry.value.replace(/\/$/, "");
  const host = url.startsWith("https://") ? url.slice("https://".length) : "";
  const servingJob = derived.liveHosts.get(host);
  return servingJob === undefined
    ? derived.databases.has(entry.value)
      ? { ...entry, value: derived.database(entry.value) }
      : entry
    : { name: entry.name, route: servingJob };
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
    routes: job.routes.some((route) => route.access === "public")
      ? [stagedTailnetRoute]
      : job.routes,
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
