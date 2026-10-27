/**
 * The commands Alchemy has no place for: OpenBao login, a cartridge's secrets,
 * its Nomad allocation status, and a job's logs read from Nomad by job name, which
 * also work for a job whose first deploy failed. Deploys and plans are Alchemy's
 * own commands. `scripts/ops` runs both kinds from the laptop over SSH, through
 * `scripts/ops-on-host.sh`.
 */
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import {
  Array as Arr,
  Config,
  ConfigProvider,
  Console,
  Effect,
  FileSystem,
  Layer,
  Option,
  Redacted,
  Runtime,
  Stream,
} from "effect";
import { Schema as S } from "effect";
import { Argument, Command, Flag, Prompt } from "effect/cli";
import { FetchHttpClient } from "effect/http";
import * as Cartridge from "./Cartridge.ts";
import * as NomadLive from "./Nomad.ts";
import { Nomad } from "./Nomad.ts";
import { OpenBao } from "./OpenBao.ts";
import * as TaskLog from "./TaskLog.ts";
import * as Deployments from "./Deployments.ts";
import * as FleetStatus from "./FleetStatus.ts";
import * as StagedCartridge from "./StagedCartridge.ts";

/** A failure the operator can act on: printed as its message alone, without a stack trace. */
export class CliError extends S.TaggedError<CliError>()("CliError", { message: S.String }) {
  readonly [Runtime.errorReported] = false;
}

const root = ".";
const name = Argument.String("name").pipe(Argument.withDescription("The cartridge's name"));

const login = Command.make(
  "login",
  {},
  Effect.fn(function* () {
    const tokenFile = yield* Config.String("OPENBAO_TOKEN_FILE");
    const rootToken = yield* Prompt.run(Prompt.Password({ message: "OpenBao root token" }));
    const token = yield* Effect.gen(function* () {
      const bao = yield* OpenBao;
      return yield* bao.createToken("2h");
    }).pipe(
      // fresh: the program already shares an OpenBao built without a token; this one
      // must read the root token from the prompt instead.
      Effect.provide(
        Layer.fresh(OpenBao.layer).pipe(
          Layer.provide(
            ConfigProvider.layerAdd(
              ConfigProvider.fromEnvRecord({ OPENBAO_TOKEN: Redacted.value(rootToken) }),
              { asPrimary: true },
            ),
          ),
        ),
      ),
    );
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(tokenFile, Redacted.value(token), { mode: 0o600 });
    yield* Console.log(`OpenBao token for 2 hours written to ${tokenFile}.`);
  }),
).pipe(Command.withDescription("Mint a 2-hour OpenBao token from the root token"));

const checkLogin = Command.make("check-login", {}, () => requireLogin).pipe(
  Command.withDescription("Fail unless the OpenBao token from `login` is still valid"),
);

const secretCheck = Command.make(
  "check",
  { name },
  Effect.fn(function* ({ name }) {
    const cartridgeName = Option.getOrElse(StagedCartridge.baseName(name), () => name);
    const cartridge = yield* Cartridge.resolve(root, cartridgeName);
    yield* requireLogin;
    const bao = yield* OpenBao;
    const stored = new Map(
      yield* Effect.forEach(Cartridge.kvKeys(cartridge).keys(), (path) =>
        bao
          .readKvKeys(path)
          .pipe(
            Effect.map(
              (keys) => [path, Option.getOrElse(keys, (): ReadonlyArray<string> => [])] as const,
            ),
          ),
      ),
    );
    const missing = Cartridge.missingSecrets(cartridge, stored);
    if (missing.length > 0) {
      return yield* new CliError({
        message: [
          `${name} reads secrets that are not set, so its tasks would wait forever:`,
          ...missing.map(({ path, key }) => `  ${path} ${key}`),
          "Set each with `ops secret set <key>` in the cartridge's repository.",
        ].join("\n"),
      });
    }
  }),
).pipe(Command.withDescription("Fail when a secret the cartridge references is not set"));

// The workstation sets and lists secrets (src/secrets.ts); the host keeps the check that
// guards each plan and deploy against the sent or recorded cartridge.
const secret = Command.make("secret").pipe(
  Command.withDescription("Check a cartridge's OpenBao secrets before a deploy"),
  Command.withSubcommands([secretCheck]),
);

const status = Command.make(
  "status",
  { name },
  Effect.fn(function* ({ name }) {
    const cartridge = yield* Cartridge.resolve(root, name);
    const nomad = yield* Nomad;
    yield* Effect.forEach(cartridge.services, (service) =>
      nomad.allocations(service.name).pipe(
        Effect.flatMap((allocations) =>
          Console.log(
            [
              service.name,
              ...(allocations.length === 0 ? ["  no allocations"] : []),
              ...Arr.sort(allocations, TaskLog.newestFirst)
                .slice(0, 3)
                .map((allocation) => {
                  const tasks = Object.entries(allocation.TaskStates ?? {})
                    .map(
                      ([task, state]) =>
                        `${task}=${state.State}${state.Failed ? " (failed)" : ""}` +
                        (state.Restarts > 0 ? ` restarts=${state.Restarts}` : ""),
                    )
                    .join(" ");
                  return `  ${allocation.ID.slice(0, 8)} v${allocation.JobVersion} ${allocation.ClientStatus} ${tasks}`;
                }),
            ].join("\n"),
          ),
        ),
      ),
    );
  }),
).pipe(Command.withDescription("Show each service's newest allocations"));

const logs = Command.make(
  "logs",
  {
    job: Argument.String("job").pipe(
      Argument.withDescription(
        "The Nomad job, which is the resource's name, such as giglist-worker",
      ),
    ),
    tail: Flag.Boolean("tail").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Keep printing new lines"),
    ),
    lines: Flag.Int("lines").pipe(
      Flag.withAlias("n"),
      Flag.withDefault(100),
      Flag.withDescription("How many past lines to print"),
    ),
  },
  Effect.fn(function* ({ job, tail, lines }) {
    const nomad = yield* Nomad;
    const newest = Arr.head(Arr.sort(yield* nomad.allocations(job), TaskLog.newestFirst));
    if (Option.isNone(newest)) {
      return yield* new CliError({ message: `Nomad has no allocations for job '${job}'.` });
    }
    const allocation = newest.value;
    // A job that never started has no output; its task events say why, such as a
    // template blocked on a missing secret or a failed image pull.
    if (allocation.ClientStatus !== "running") {
      return yield* Console.log(
        [
          `${job}: newest allocation ${allocation.ID.slice(0, 8)} is ${allocation.ClientStatus}`,
          ...Object.entries(allocation.TaskStates ?? {}).flatMap(([task, state]) =>
            (state.Events ?? []).map(
              (event) =>
                `${new Date(event.Time / 1e6).toISOString()} ${task} ${event.Type}: ${event.DisplayMessage}`,
            ),
          ),
        ].join("\n"),
      );
    }
    const show = (line: { readonly timestamp: Date; readonly message: string }) =>
      Console.log(`${line.timestamp.toISOString()} ${line.message}`);
    yield* Effect.forEach(yield* TaskLog.recent(nomad, job, { limit: lines }), show);
    if (tail) yield* Stream.runForEach(TaskLog.follow(nomad, job), show);
  }),
).pipe(Command.withDescription("Print a Nomad job's recent output, or why it is not running"));

const dash = Command.make(
  "dash",
  {},
  Effect.fn(function* () {
    yield* Console.log(FleetStatus.render(yield* FleetStatus.snapshot()));
  }),
).pipe(Command.withDescription("Print each job's health and each node's load, once"));

/** OpenBao commands need the 2-hour token that `login` writes. */
const requireLogin = Effect.gen(function* () {
  const bao = yield* OpenBao;
  yield* bao.checkToken().pipe(
    Effect.mapError(
      () =>
        new CliError({
          message: "The OpenBao token is missing or expired. Run `ops login` first.",
        }),
    ),
  );
});

const stageImage = Command.make(
  "stage-image",
  {
    name,
    stable: Flag.Boolean("stable").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Fail unless every staged job's current version deployed successfully"),
    ),
  },
  Effect.fn(function* ({ name, stable }) {
    const cartridge = yield* Cartridge.resolve(root, name);
    const nomad = yield* Nomad;
    // Only application services run the candidate image; a server keeps its own.
    const jobs = cartridge.services.map(
      (service) => `${service.name}${StagedCartridge.stagedSuffix}`,
    );
    // A staged deploy can stop after registering some jobs, so the jobs Nomad has are enough.
    const snapshots = (yield* Effect.forEach(jobs, (job) => nomad.job(job))).flatMap(
      Option.toArray,
    );
    if (snapshots.length === 0) {
      return yield* new CliError({
        message: `Nomad has no staged job of '${name}'.`,
      });
    }
    const unstable = snapshots
      .filter((snapshot) => !snapshot.Stable)
      .map((snapshot) => snapshot.ID);
    if (stable && (snapshots.length < jobs.length || unstable.length > 0)) {
      return yield* new CliError({
        message: `the staged instance of '${name}' is not fully deployed (${[...unstable, ...jobs.filter((job) => !snapshots.some((s) => s.ID === job))].join(", ")}); fix or discard it first`,
      });
    }
    const unique = [
      ...new Set(
        snapshots.flatMap((snapshot) =>
          snapshot.TaskGroups.flatMap((group) =>
            group.Tasks.flatMap((task) => Option.toArray(Option.fromNullishOr(task.Config.image))),
          ),
        ),
      ),
    ];
    if (unique.length !== 1) {
      return yield* new CliError({
        message: `the staged jobs of '${name}' run ${unique.length} images; expected one`,
      });
    }
    yield* Console.log(unique[0]);
  }),
).pipe(Command.withDescription("Print the image a staged instance runs"));

const deploymentList = Command.make(
  "list",
  { name },
  Effect.fn(function* ({ name }) {
    const deployments = yield* Deployments.Deployments;
    const all = yield* deployments.list(name);
    if (all.length === 0) return yield* Console.log(`No recorded deployment of '${name}'.`);
    yield* Effect.forEach(all, (deployment) =>
      Console.log(
        `${deployment.id}\t${deployment.deployedAt}\t${deployment.revision}\t${images(deployment.cartridge).join(" ")}`,
      ),
    );
  }),
).pipe(Command.withDescription("List an app's recorded deployments, newest first"));

const deploymentCheck = Command.make(
  "check",
  { name },
  Effect.fn(function* ({ name }) {
    const sent = yield* sentDeployment(name);
    const deployments = yield* Deployments.Deployments;
    yield* deployments.checkOrigin(name, sent.origin);
  }),
).pipe(
  Command.withDescription(
    "Fail unless the cartridge in CARTRIDGE_FILE is valid, pins its images, and comes from the app's repository",
  ),
);

const deploymentRecord = Command.make(
  "record",
  { name },
  Effect.fn(function* ({ name }) {
    const sent = yield* sentDeployment(name);
    const deployments = yield* Deployments.Deployments;
    const recorded = yield* deployments.record({ name, ...sent });
    yield* Console.log(`Recorded deployment ${recorded.id} of ${name} at ${recorded.revision}.`);
  }),
).pipe(Command.withDescription("Record the cartridge in CARTRIDGE_FILE as deployed"));

const deploymentRestore = Command.make(
  "restore",
  {
    name,
    id: Argument.Int("id").pipe(Argument.withDescription("The deployment to restore")),
    file: Argument.String("file").pipe(Argument.withDescription("Where to write its cartridge")),
  },
  Effect.fn(function* ({ name, id, file }) {
    const deployments = yield* Deployments.Deployments;
    const found = yield* deployments.get(name, id);
    if (Option.isNone(found)) {
      return yield* new CliError({ message: `'${name}' has no recorded deployment ${id}.` });
    }
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(file, found.value.cartridge);
    // Read by ops-on-host.sh with `eval`: both values are git object names.
    yield* Console.log(`ORIGIN=${found.value.origin} REVISION=${found.value.revision}`);
  }),
).pipe(
  Command.withDescription(
    "Write a recorded deployment's cartridge to a file and print its ORIGIN and REVISION",
  ),
);

const deployment = Command.make("deployment").pipe(
  Command.withDescription("The record of each app's deployed cartridges"),
  Command.withSubcommands([deploymentList, deploymentCheck, deploymentRecord, deploymentRestore]),
);

/**
 * The deployment `ops` sent with a release: the cartridge in CARTRIDGE_FILE, the root
 * commit of its repository in ORIGIN, and the released commit in REVISION. Every image must
 * be pinned by digest, so a recorded deployment always names exactly what ran.
 */
const sentDeployment = Effect.fn("sentDeployment")(function* (name: string) {
  const file = yield* Config.String("CARTRIDGE_FILE");
  const origin = yield* Config.String("ORIGIN");
  const revision = yield* Config.String("REVISION");
  const cartridge = yield* Cartridge.resolve(root, name);
  const unpinned = cartridge.services
    .map((service) => service.image)
    .filter((image) => !image.includes("@sha256:"));
  if (unpinned.length > 0) {
    return yield* new CliError({
      message: `${name} names images without a digest: ${unpinned.join(", ")}. Deploy it with \`ops release\`.`,
    });
  }
  const fs = yield* FileSystem.FileSystem;
  return { origin, revision, cartridge: yield* fs.readFileString(file) };
});

/** The images a recorded cartridge's services run; the record is valid JSON by construction. */
const images = (cartridge: string): ReadonlyArray<string> => [
  ...new Set(
    (JSON.parse(cartridge) as { services: ReadonlyArray<{ image: string }> }).services.map(
      (service) => service.image.replace(/^.*@sha256:(.{12}).*$/, "sha256:$1"),
    ),
  ),
];

const cli = Command.make("ops").pipe(
  Command.withDescription(
    "OpenBao login, secrets, the fleet dashboard, Nomad status and logs, and deployment records",
  ),
  Command.withSubcommands([login, checkLogin, secret, dash, status, logs, stageImage, deployment]),
);

cli.pipe(
  Command.run({ version: "1" }),
  Effect.tapErrorTag("CliError", (error) => Console.error(error.message)),
  Effect.provide(
    Layer.mergeAll(OpenBao.layer, NomadLive.layer(), Deployments.layer()).pipe(
      Layer.provideMerge(Layer.mergeAll(FetchHttpClient.layer, BunServices.layer)),
    ),
  ),
  BunRuntime.runMain,
);
