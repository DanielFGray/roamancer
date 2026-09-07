import { Args, Command, Options } from "@effect/cli";
import { Console, Effect, Option, Schedule, Schema as S } from "effect";
import * as FileSystem from "@effect/platform/FileSystem";
import * as Path from "@effect/platform/Path";
import { SshClient } from "../services/SshClient.ts";
import { OpenBaoClient } from "../services/OpenBaoClient.ts";
import {
  ConsulClient,
  type ConsulClientShape,
  type ConsulServiceDefinition,
} from "../services/ConsulClient.ts";
import { SchemaResolver } from "../services/SchemaResolver.ts";
import { backupByService } from "../services/BackupRunner.ts";
import { formatEnv } from "../lib/env-format.ts";
import { SERVICES_DIR, SVC_USER } from "../lib/config.ts";

interface InfraService {
  readonly name: string;
  readonly composeDir: string;
  readonly remoteDir: string;
  readonly port: number;
  readonly dataOwner: string;
  readonly dataGroup: string;
  readonly check: ConsulServiceDefinition["Check"];
}

// Kept in sync with site.yml's compose_stacks entries.
const infraServices: ReadonlyArray<InfraService> = [
  {
    name: "postgres",
    composeDir: `${SERVICES_DIR}/postgres`,
    remoteDir: "/opt/services/postgres",
    port: 5432,
    dataOwner: "70",
    dataGroup: "70",
    check: { TCP: "127.0.0.1:5432", Interval: "10s" },
  },
  {
    name: "valkey",
    composeDir: `${SERVICES_DIR}/valkey`,
    remoteDir: "/opt/services/valkey",
    port: 6379,
    dataOwner: "999",
    dataGroup: "1000",
    check: { TCP: "127.0.0.1:6379", Interval: "10s" },
  },
  {
    name: "zookeeper",
    composeDir: `${SERVICES_DIR}/zookeeper`,
    remoteDir: "/opt/services/zookeeper",
    port: 2181,
    dataOwner: "1001",
    dataGroup: "0",
    // A ruok/imok script check would be more precise, but Consul only ever
    // executes script checks defined in the agent's own on-disk config --
    // never one registered through the HTTP API, local or remote, without
    // enabling enable_script_checks cluster-wide (arbitrary remote script
    // execution). A TCP check is what the API path actually supports.
    check: { TCP: "127.0.0.1:2181", Interval: "10s" },
  },
  {
    name: "clickhouse",
    composeDir: `${SERVICES_DIR}/clickhouse`,
    remoteDir: "/opt/services/clickhouse",
    port: 8123,
    dataOwner: "101",
    dataGroup: "101",
    check: { HTTP: "http://127.0.0.1:8123/ping", Interval: "10s" },
  },
  {
    name: "signoz",
    composeDir: `${SERVICES_DIR}/signoz`,
    remoteDir: "/opt/services/signoz",
    port: 8080,
    dataOwner: "0",
    dataGroup: "0",
    check: { HTTP: "http://127.0.0.1:8080/api/v1/health", Interval: "10s" },
  },
];

class UnknownServiceError extends S.TaggedError<UnknownServiceError>()("UnknownServiceError", {
  name: S.String,
  available: S.Array(S.String),
}) {
  override get message() {
    return `Unknown service: ${this.name}\nAvailable: ${this.available.join(", ")}`;
  }
}

class ServiceMoveError extends S.TaggedError<ServiceMoveError>()("ServiceMoveError", {
  message: S.String,
}) {}

const findService = (name: string) =>
  Effect.fromNullable(infraServices.find((service) => service.name === name)).pipe(
    Effect.mapError(
      () =>
        new UnknownServiceError({
          name,
          available: infraServices.map((service) => service.name),
        }),
    ),
  );

const serviceNameArg = Args.text({ name: "name" }).pipe(
  Args.withDescription("Infrastructure service (postgres, valkey, zookeeper, clickhouse, signoz)"),
);
const destinationOption = Options.text("to").pipe(Options.withDescription("Destination host"));
const optionalDestinationOption = destinationOption.pipe(Options.optional);

const provisionServiceSecrets = Effect.fnUntraced(function* (svc: InfraService) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const bao = yield* OpenBaoClient;
  const resolver = yield* SchemaResolver;
  const envPath = path.join(svc.composeDir, ".env.schema");
  if (!(yield* fs.exists(envPath))) return null;
  const schemaSource = yield* fs.readFileString(envPath);
  const existing = yield* bao.kvGet(svc.name).pipe(Effect.orElseSucceed(() => null));
  if (existing) return existing;
  yield* Console.log("Seeding secrets to vault...");
  const resolved = yield* resolver.resolve(schemaSource);
  yield* bao.kvPut(svc.name, resolved);
  return resolved;
});

// Address is set explicitly to the same host string used with `--to` (an
// fqdn like cynic.dlab, not an IP) -- Consul otherwise defaults ServiceAddress
// to "" and resolveServiceHost falls back to the node's raw catalog IP, which
// bypasses the SSH safety scoping (INFRA_SSH_CONFIG_FILE's Host patterns only
// match hostnames) and the port map keyed on the same hostnames.
const serviceDefinition = (svc: InfraService, host: string): ConsulServiceDefinition => ({
  Name: svc.name,
  ID: svc.name,
  Port: svc.port,
  Address: host,
  Check: svc.check,
});

const register = (consul: ConsulClientShape, svc: InfraService, host: string) =>
  consul.registerService(serviceDefinition(svc, host), host);

const deployFiles = Effect.fnUntraced(function* (ssh: SshClient, svc: InfraService, host: string) {
  // Containers run under SVC_USER's own rootless podman: a container-internal
  // UID like svc.dataOwner isn't a host UID, it's remapped through SVC_USER's
  // subuid range. `podman unshare` runs the chown inside that same user
  // namespace, where the raw number means what the container expects.
  yield* ssh.exec(
    host,
    `mkdir -p ${svc.remoteDir} /srv/data/${svc.name} && podman unshare chown -R ${svc.dataOwner}:${svc.dataGroup} /srv/data/${svc.name}`,
    SVC_USER,
  );
  yield* ssh.rsync(`${svc.composeDir}/`, svc.remoteDir, host, SVC_USER);
  const secrets = yield* provisionServiceSecrets(svc);
  if (secrets) {
    yield* ssh.writeFile(host, `${svc.remoteDir}/.env`, formatEnv(secrets), {
      mode: "600",
      user: SVC_USER,
    });
  }
});

const serviceUp = Command.make("up", {
  name: serviceNameArg,
  to: optionalDestinationOption,
}).pipe(
  Command.withHandler(
    Effect.fnUntraced(function* ({ name, to }) {
      const ssh = yield* SshClient;
      const consul = yield* ConsulClient;
      const svc = yield* findService(name);
      const host = yield* Option.match(to, {
        onNone: () => consul.resolveServiceHost(name),
        onSome: Effect.succeed,
      });
      yield* Console.log(`Setting up ${svc.name} on ${host}...`);
      yield* deployFiles(ssh, svc, host);
      yield* ssh.exec(host, `cd ${svc.remoteDir} && podman-compose up -d`, SVC_USER);
      yield* register(consul, svc, host);
      yield* Console.log(`${svc.name} is up on ${host}`);
    }),
  ),
  Command.withDescription("Deploy and start an infrastructure service"),
);

const serviceDown = Command.make("down", { name: serviceNameArg }).pipe(
  Command.withHandler(
    Effect.fnUntraced(function* ({ name }) {
      const ssh = yield* SshClient;
      const consul = yield* ConsulClient;
      const svc = yield* findService(name);
      const host = yield* consul.resolveServiceHost(name);
      yield* Console.log(`Stopping ${svc.name} on ${host}...`);
      yield* ssh.exec(host, `cd ${svc.remoteDir} && podman-compose down`, SVC_USER);
      yield* consul.deregisterService(svc.name, host);
      yield* Console.log(`${svc.name} stopped`);
    }),
  ),
  Command.withDescription("Stop an infrastructure service"),
);

const serviceStatus = Command.make("status").pipe(
  Command.withHandler(
    Effect.fnUntraced(function* () {
      const ssh = yield* SshClient;
      const consul = yield* ConsulClient;
      yield* Effect.forEach(infraServices, (svc) =>
        consul.resolveServiceHost(svc.name).pipe(
          Effect.flatMap((host) =>
            Console.log(`${svc.name} (${host}):`).pipe(
              Effect.zipRight(
                ssh.exec(
                  host,
                  `cd ${svc.remoteDir} && podman-compose ps 2>/dev/null || echo "  not deployed"`,
                  SVC_USER,
                ),
              ),
            ),
          ),
          Effect.orElseSucceed(() => "  not registered"),
          Effect.tap(Console.log),
          Effect.tap(() => Console.log("")),
        ),
      );
    }),
  ),
  Command.withDescription("Show status of infrastructure services"),
);

const serviceList = Command.make("list").pipe(
  Command.withHandler(() =>
    Console.log("Infrastructure services:").pipe(
      Effect.zipRight(
        Effect.forEach(infraServices, (svc) => Console.log(`  ${svc.name} (${svc.remoteDir})`)),
      ),
    ),
  ),
  Command.withDescription("List available infrastructure services"),
);

const serviceSnapshot = Command.make("snapshot", { name: serviceNameArg }).pipe(
  Command.withHandler(
    Effect.fnUntraced(function* ({ name }) {
      const backup = backupByService[name];
      if (!backup) {
        return yield* new UnknownServiceError({ name, available: Object.keys(backupByService) });
      }
      const result = yield* backup;
      yield* Console.log(`${name} snapshot: ${result.file} (${result.size})`);
    }),
  ),
  Command.withDescription("Create an on-demand service snapshot"),
);

const parseBytes = (label: string, output: string) => {
  const value = Number(output.trim());
  return Number.isSafeInteger(value) && value >= 0
    ? Effect.succeed(value)
    : Effect.fail(
        new ServiceMoveError({ message: `Could not parse ${label} bytes: ${output.trim()}` }),
      );
};

const waitForHealth = Effect.fnUntraced(function* (consul: ConsulClientShape, name: string) {
  yield* consul.serviceIsPassing(name).pipe(
    Effect.filterOrFail(
      Boolean,
      () => new ServiceMoveError({ message: `${name} failed its Consul health check` }),
    ),
    Effect.retry(Schedule.spaced("2 seconds").pipe(Schedule.intersect(Schedule.recurs(30)))),
  );
});

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const serviceMove = Command.make("move", {
  name: serviceNameArg,
  to: destinationOption,
}).pipe(
  Command.withHandler(
    Effect.fnUntraced(function* ({ name, to: destination }) {
      const ssh = yield* SshClient;
      const consul = yield* ConsulClient;
      const svc = yield* findService(name);
      const entries = yield* consul.catalogService(name);
      const source = yield* consul.resolveServiceHost(name);
      const hosts = [...new Set(entries.map((entry) => entry.ServiceAddress || entry.Address))];
      if (hosts.some((host) => host !== source)) {
        return yield* new ServiceMoveError({
          message: `${name} is registered on multiple hosts: ${hosts.join(", ")}`,
        });
      }
      if (source === destination) {
        return yield* new ServiceMoveError({
          message: `${name} is already registered on ${destination}`,
        });
      }

      yield* Console.log(`Preparing ${name} on ${destination}...`);
      yield* deployFiles(ssh, svc, destination);
      const sourceBytes = yield* ssh
        .exec(source, `podman unshare du -s -B1 /srv/data/${name} | awk '{print $1}'`, SVC_USER)
        .pipe(Effect.flatMap((output) => parseBytes("source data", output)));
      const destinationFree = yield* ssh
        .exec(destination, `df -P -B1 /srv/data/${name} | tail -1 | awk '{print $4}'`, SVC_USER)
        .pipe(Effect.flatMap((output) => parseBytes("destination free space", output)));
      if (destinationFree < sourceBytes) {
        return yield* new ServiceMoveError({
          message: `Destination has ${destinationFree} bytes free but ${sourceBytes} are needed`,
        });
      }

      // /srv/data/<name> is owned inside SVC_USER's rootless podman user
      // namespace (see deployFiles' podman unshare chown), so touch/rm
      // against it need the same namespace re-mapping to see the directory.
      const markerPath = `/srv/data/${name}/.move-in-progress`;
      const clearMarkers = Effect.forEach(
        [source, destination],
        (host) => ssh.exec(host, `podman unshare rm -f ${markerPath}`, SVC_USER),
        { concurrency: "unbounded" },
      ).pipe(Effect.ignore);
      yield* Effect.forEach(
        [source, destination],
        (host) => ssh.exec(host, `podman unshare touch ${markerPath}`, SVC_USER),
        { concurrency: "unbounded" },
      ).pipe(
        Effect.catchAllCause((cause) =>
          clearMarkers.pipe(Effect.zipRight(Effect.failCause(cause))),
        ),
      );

      const rollback = ssh
        .exec(destination, `cd ${svc.remoteDir} && podman-compose down`, SVC_USER)
        .pipe(
          Effect.ignore,
          Effect.zipRight(consul.deregisterService(svc.name, destination).pipe(Effect.ignore)),
          Effect.zipRight(
            ssh
              .exec(source, `cd ${svc.remoteDir} && podman-compose up -d`, SVC_USER)
              .pipe(
                Effect.zipRight(register(consul, svc, source).pipe(Effect.ignore)),
                Effect.zipRight(clearMarkers),
              ),
          ),
          Effect.ignore,
        );
      const move = Effect.gen(function* () {
        yield* ssh.exec(source, `cd ${svc.remoteDir} && podman-compose down`, SVC_USER);
        yield* consul.deregisterService(svc.name, source);
        // Both ends of /srv/data/<name> live inside a rootless podman user
        // namespace (source's existing data, destination's freshly chowned
        // directory from deployFiles) -- wrap the local side with `podman
        // unshare` and the remote side via --rsync-path so the SSH-spawned
        // rsync on the destination gets the same re-mapped view.
        //
        // `podman unshare` maps SVC_USER's real UID to 0 *inside* the
        // namespace -- ssh's own tilde expansion for its default config path
        // resolves via getpwuid(0) ("root"), not $HOME, so it silently misses
        // /home/<SVC_USER>/.ssh/config (the per-host Port/HostName trust
        // config roles/common deploys for host-to-host operations like this)
        // and falls back to the bare default port. Pointing -e at that config
        // file explicitly sidesteps the lookup instead of relying on it.
        yield* ssh.exec(
          source,
          `podman unshare rsync -a -e ${shellQuote(`ssh -F /home/${SVC_USER}/.ssh/config`)} --rsync-path='podman unshare rsync' /srv/data/${name}/ ${shellQuote(`${SVC_USER}@${destination}:/srv/data/${name}/`)}`,
          SVC_USER,
        );
        yield* ssh.exec(destination, `cd ${svc.remoteDir} && podman-compose up -d`, SVC_USER);
        yield* register(consul, svc, destination);
        yield* waitForHealth(consul, name);
      });
      yield* move.pipe(
        Effect.catchAllCause((cause) => rollback.pipe(Effect.zipRight(Effect.failCause(cause)))),
      );
      yield* clearMarkers;
      yield* Console.log(`${name} moved from ${source} to ${destination}`);
    }),
  ),
  Command.withDescription("Move a running infrastructure service to another host"),
);

export const serviceCommand = Command.make("service").pipe(
  Command.withHandler(() => Effect.void),
  Command.withSubcommands([
    serviceUp,
    serviceDown,
    serviceStatus,
    serviceList,
    serviceMove,
    serviceSnapshot,
  ]),
  Command.withDescription("Manage infrastructure services"),
);
