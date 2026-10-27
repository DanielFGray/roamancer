/**
 * Commands that run on the control host: OpenBao login, a cartridge's secrets, the fleet
 * dashboard, Nomad status and logs, deployment records, and Alchemy's plan, deploy, destroy,
 * drift, state and rollback. `scripts/ops` reaches this file over SSH after `bun install` in
 * ~/alchemy.
 */
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import {
  Array as Arr,
  Config,
  ConfigProvider,
  Console,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Redacted,
  Runtime,
  Stdio,
  Stream,
} from "effect";
import { Schema as S } from "effect";
import { Argument, Command, Flag, Prompt } from "effect/cli";
import { FetchHttpClient } from "effect/http";
import { ChildProcess } from "effect/process";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import type { PlatformError } from "effect/PlatformError";
import * as Cartridge from "./Cartridge.ts";
import { route } from "./Exec.ts";
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

/** Alchemy exited non-zero; the process exits with that code and prints nothing further. */
export class AlchemyFailed extends S.TaggedError<AlchemyFailed>()("AlchemyFailed", {
  code: S.Number,
}) {
  readonly [Runtime.errorReported] = false;
  get [Runtime.errorExitCode]() {
    return this.code;
  }
}

const root = ".";
const controllerEnvPath = "/var/lib/nomad-acl/controller.env";
const name = Argument.String("name").pipe(Argument.withDescription("The cartridge's name"));

/** Alchemy commands whose flags, such as `--stage`, pass through unread. */
const alchemyCommands = ["plan", "deploy", "destroy", "drift", "state"] as const;

/**
 * KEY=VALUE lines, as `nomad-acl-issue-controller` writes them.
 */
export const parseEnvFile = (text: string): Record<string, string> => {
  const values: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    values[trimmed.slice(0, separator)] = trimmed.slice(separator + 1);
  }
  return values;
};

/** The value of `--stage` / `--stage=` among the arguments; none without one. */
export const stageFlag = (args: ReadonlyArray<string>): Option.Option<string> => {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === "--stage") return Option.fromNullishOr(args[index + 1]);
    if (arg.startsWith("--stage=")) return Option.some(arg.slice("--stage=".length));
  }
  return Option.none();
};

/**
 * Read `controllerEnv` (KEY=VALUE) and the OpenBao token under XDG_RUNTIME_DIR. Defaults
 * NOMAD_ADDR and OPENBAO_ADDR to the loopback listeners. Fails when the env file is
 * unreadable or XDG_RUNTIME_DIR is unset.
 */
export const loadHostEnvironment = Effect.fn("loadHostEnvironment")(function* (
  controllerEnv: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const readable = yield* fs.access(controllerEnv, { readable: true }).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
  if (!readable) {
    return yield* new CliError({
      message: [
        `cannot read ${controllerEnv}.`,
        "Run 'sudo nomad-acl-issue-controller' once after the rebuild so the",
        "env file becomes group-readable by the alchemy group.",
      ].join("\n"),
    });
  }
  const controller = parseEnvFile(yield* fs.readFileString(controllerEnv));
  const runtimeDir = yield* Config.option(Config.String("XDG_RUNTIME_DIR"));
  if (Option.isNone(runtimeDir)) {
    return yield* new CliError({ message: "XDG_RUNTIME_DIR is not set." });
  }
  const tokenFile = `${runtimeDir.value}/openbao.token`;
  const token = yield* fs.readFileString(tokenFile).pipe(
    Effect.map((text) => text.trim()),
    Effect.option,
  );
  const values: Record<string, string> =
    Option.isSome(token) && token.value !== ""
      ? {
          ...controller,
          NOMAD_ADDR: "http://127.0.0.1:4646",
          OPENBAO_ADDR: "http://127.0.0.1:8200",
          OPENBAO_TOKEN_FILE: tokenFile,
          OPENBAO_TOKEN: token.value,
        }
      : {
          ...controller,
          NOMAD_ADDR: "http://127.0.0.1:4646",
          OPENBAO_ADDR: "http://127.0.0.1:8200",
          OPENBAO_TOKEN_FILE: tokenFile,
        };
  return values;
});

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

/** Fail when a secret the cartridge references is not set. */
const checkSecrets = Effect.fn("checkSecrets")(function* (
  name: string,
  cartridgeFile: string | undefined,
) {
  const cartridgeName = Option.getOrElse(StagedCartridge.baseName(name), () => name);
  const cartridge =
    cartridgeFile === undefined
      ? yield* Cartridge.resolve(root, cartridgeName)
      : yield* appCartridgeAt(cartridgeFile, cartridgeName);
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
});

/**
 * Fail unless the cartridge at `file` is valid, pins its images, and comes from the app's
 * repository (`origin`).
 */
const checkDeployment = Effect.fn("checkDeployment")(function* (
  name: string,
  file: string,
  origin: string,
  revision: string,
) {
  const sent = yield* sentDeployment(name, file, origin, revision);
  const deployments = yield* Deployments.Deployments;
  yield* deployments.checkOrigin(name, sent.origin);
});

/** Record the cartridge at `file` as deployed. */
const recordDeployment = Effect.fn("recordDeployment")(function* (
  name: string,
  file: string,
  origin: string,
  revision: string,
) {
  const sent = yield* sentDeployment(name, file, origin, revision);
  const deployments = yield* Deployments.Deployments;
  const recorded = yield* deployments.record({ name, ...sent });
  yield* Console.log(`Recorded deployment ${recorded.id} of ${name} at ${recorded.revision}.`);
});

/**
 * Write a recorded deployment's cartridge to `file` and return its ORIGIN and REVISION.
 */
const restoreDeployment = Effect.fn("restoreDeployment")(function* (
  name: string,
  id: number,
  file: string,
) {
  const deployments = yield* Deployments.Deployments;
  const found = yield* deployments.get(name, id);
  if (Option.isNone(found)) {
    return yield* new CliError({ message: `'${name}' has no recorded deployment ${id}.` });
  }
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(file, found.value.cartridge);
  return { origin: found.value.origin, revision: found.value.revision };
});

/**
 * Plan or deploy one stage. A sent app cartridge must pin its images and come from the
 * repository the app was first deployed from; a deploy of one is recorded once Alchemy
 * exits 0. `env` is one record: host settings plus any CARTRIDGE_FILE, ORIGIN and REVISION.
 */
export const planOrDeploy = Effect.fn("planOrDeploy")(function* (
  command: "plan" | "deploy",
  args: ReadonlyArray<string>,
  env: Record<string, string>,
) {
  const stage = Option.getOrElse(stageFlag(args), () => "");
  const cartridgeFile = env["CARTRIDGE_FILE"];
  const origin = env["ORIGIN"];
  const revision = env["REVISION"];
  const recorded = cartridgeFile !== undefined && origin !== undefined && revision !== undefined;
  if (recorded) yield* checkDeployment(stage, cartridgeFile, origin, revision);
  yield* checkSecrets(stage, cartridgeFile);
  yield* runAlchemy([command, ...args], env);
  if (recorded && command === "deploy") {
    yield* recordDeployment(stage, cartridgeFile, origin, revision);
  }
});

const forwarded = {
  args: Argument.String("args").pipe(
    Argument.withDescription("Passed to Alchemy unread"),
    Argument.variadic(),
  ),
};

/**
 * Host settings plus CARTRIDGE_FILE, ORIGIN and REVISION from the process Config when set
 * (as `ops` sends them over ssh).
 */
const releaseEnv = (hostEnv: Record<string, string>) =>
  Effect.gen(function* () {
    const cartridgeFile = yield* Config.option(Config.String("CARTRIDGE_FILE"));
    const origin = yield* Config.option(Config.String("ORIGIN"));
    const revision = yield* Config.option(Config.String("REVISION"));
    return {
      ...hostEnv,
      ...(Option.isSome(cartridgeFile) ? { CARTRIDGE_FILE: cartridgeFile.value } : {}),
      ...(Option.isSome(origin) ? { ORIGIN: origin.value } : {}),
      ...(Option.isSome(revision) ? { REVISION: revision.value } : {}),
    };
  });

/**
 * Controller.env and the OpenBao token file as one record. Loaded only when a
 * command provides `hostLayer` (help and argument errors never do).
 */
class HostEnvironment extends Context.Service<HostEnvironment, Record<string, string>>()(
  "cli/HostEnvironment",
) {}

/** HostEnvironment plus Config, OpenBao, Nomad and Deployments for command handlers. */
const hostLayer = Layer.unwrap(
  Effect.gen(function* () {
    const env = yield* loadHostEnvironment(controllerEnvPath);
    return Layer.mergeAll(
      Layer.succeed(HostEnvironment, env),
      OpenBao.layer,
      NomadLive.layer(),
      Deployments.layer(),
    ).pipe(
      Layer.provideMerge(FetchHttpClient.layer),
      Layer.provideMerge(
        ConfigProvider.layerAdd(ConfigProvider.fromEnvRecord(env), { asPrimary: true }),
      ),
    );
  }),
);

/** Command tree for this host process. Host files load only inside each command handler. */
const makeCli = () => {
  const plan = Command.make(
    "plan",
    forwarded,
    Effect.fn(function* ({ args }) {
      const hostEnv = yield* HostEnvironment;
      yield* planOrDeploy("plan", args, yield* releaseEnv(hostEnv));
    }, Effect.provide(hostLayer)),
  ).pipe(Command.withDescription("Preview an Alchemy deploy of a stage"));

  const deploy = Command.make(
    "deploy",
    forwarded,
    Effect.fn(function* ({ args }) {
      const hostEnv = yield* HostEnvironment;
      yield* planOrDeploy("deploy", args, yield* releaseEnv(hostEnv));
    }, Effect.provide(hostLayer)),
  ).pipe(Command.withDescription("Run Alchemy's deploy of a stage"));

  const destroy = Command.make(
    "destroy",
    forwarded,
    Effect.fn(function* ({ args }) {
      const hostEnv = yield* HostEnvironment;
      yield* requireLogin;
      yield* runAlchemy(["destroy", ...args, "-c", "state.run.ts"], hostEnv);
    }, Effect.provide(hostLayer)),
  ).pipe(Command.withDescription("Destroy a stage's resources from Alchemy state only"));

  const drift = Command.make(
    "drift",
    forwarded,
    Effect.fn(function* ({ args }) {
      const hostEnv = yield* HostEnvironment;
      yield* requireLogin;
      yield* runAlchemy(["drift", ...args], hostEnv);
    }, Effect.provide(hostLayer)),
  ).pipe(Command.withDescription("Report drift between the state and the running resources"));

  const state = Command.make(
    "state",
    forwarded,
    Effect.fn(function* ({ args }) {
      const hostEnv = yield* HostEnvironment;
      yield* runAlchemy(["state", ...args, "-c", "state.run.ts"], hostEnv);
    }, Effect.provide(hostLayer)),
  ).pipe(Command.withDescription("Read Alchemy's state store"));

  const rollback = Command.make(
    "rollback",
    {
      name,
      id: Argument.Int("id").pipe(Argument.withDescription("The deployment to restore")),
    },
    Effect.fn(function* ({ name, id }) {
      const hostEnv = yield* HostEnvironment;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(".alchemy/input", { recursive: true });
      const cartridgeFile = `.alchemy/input/rollback-${name}-${id}.json`;
      const { origin, revision } = yield* restoreDeployment(name, id, cartridgeFile);
      yield* planOrDeploy("deploy", ["--stage", name], {
        ...hostEnv,
        CARTRIDGE_FILE: cartridgeFile,
        ORIGIN: origin,
        REVISION: revision,
      });
    }, Effect.provide(hostLayer)),
  ).pipe(Command.withDescription("Deploy a recorded deployment again: <name> <id>"));

  return Command.make("ops").pipe(
    Command.withDescription(
      "OpenBao login, secrets, the fleet dashboard, Nomad status and logs, deployment records, and Alchemy on this host",
    ),
    Command.withSubcommands([
      plan,
      deploy,
      destroy,
      drift,
      state,
      rollback,
      login,
      checkLogin,
      secret,
      dash,
      placeQueued,
      status,
      logs,
      stageImage,
      deployment,
    ]),
  );
};

const login = Command.make(
  "login",
  {},
  Effect.fn(function* () {
    const hostEnv = yield* HostEnvironment;
    const tokenFile = hostEnv["OPENBAO_TOKEN_FILE"];
    if (tokenFile === undefined) {
      return yield* new CliError({ message: "OPENBAO_TOKEN_FILE is not set." });
    }
    const rootToken = yield* readRootToken;
    // fresh: the host layer already shares an OpenBao; this one must read the root
    // token from the prompt instead.
    const token = yield* Effect.flatMap(OpenBao, (bao) => bao.createToken("2h")).pipe(
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
  }, Effect.provide(hostLayer)),
).pipe(
  Command.withDescription(
    "Mint a 2-hour OpenBao token from the root token, typed or piped on stdin",
  ),
);

/**
 * The root token from the terminal's prompt, or from a piped stdin, such as
 * `pass show infra/openbao-token | ops login`. Only the first line counts: `pass` puts the
 * secret there and metadata below it.
 */
const readRootToken = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  if (yield* stdio.stdinIsTerminal) {
    return yield* Prompt.run(Prompt.Password({ message: "OpenBao root token" }));
  }
  const text = yield* Stream.mkString(Stream.decodeText(stdio.stdin));
  const line = (text.split("\n")[0] ?? "").trim();
  if (line === "") {
    return yield* new CliError({
      message:
        "No OpenBao root token on stdin. Pipe the token in, or run `ops login` in a terminal.",
    });
  }
  return Redacted.make(line);
});

const checkLogin = Command.make(
  "check-login",
  {},
  Effect.fn(function* () {
    yield* requireLogin;
  }, Effect.provide(hostLayer)),
).pipe(Command.withDescription("Fail unless the OpenBao token from `login` is still valid"));

const secretCheck = Command.make(
  "check",
  { name },
  Effect.fn(function* ({ name }) {
    const file = yield* Config.option(Config.String("CARTRIDGE_FILE"));
    yield* checkSecrets(name, Option.getOrUndefined(file));
  }, Effect.provide(hostLayer)),
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
  }, Effect.provide(hostLayer)),
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
  }, Effect.provide(hostLayer)),
).pipe(Command.withDescription("Print a Nomad job's recent output, or why it is not running"));

const dash = Command.make(
  "dash",
  {},
  Effect.fn(function* () {
    yield* Console.log(FleetStatus.render(yield* FleetStatus.snapshot()));
  }, Effect.provide(hostLayer)),
).pipe(Command.withDescription("Print each job's health and each node's load, once"));

/**
 * Nomad does not retry a queued allocation when a node gains a host volume or memory,
 * so a rebuild that adds either leaves jobs queued until something asks again.
 */
const placeQueued = Command.make(
  "place-queued",
  {},
  Effect.fn(function* () {
    const nomad = yield* Nomad;
    const queued = (yield* nomad.jobs()).filter((job) => FleetStatus.queued(job) > 0);
    yield* Effect.forEach(queued, (job) =>
      nomad.evaluate(job.ID).pipe(Effect.andThen(Console.log(`asked Nomad to place ${job.ID}`))),
    );
  }, Effect.provide(hostLayer)),
).pipe(Command.withDescription("Ask Nomad to place every job that has queued allocations again"));

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
  }, Effect.provide(hostLayer)),
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
  }, Effect.provide(hostLayer)),
).pipe(Command.withDescription("List an app's recorded deployments, newest first"));

const deploymentCheck = Command.make(
  "check",
  { name },
  Effect.fn(function* ({ name }) {
    const file = yield* Config.String("CARTRIDGE_FILE");
    const origin = yield* Config.String("ORIGIN");
    const revision = yield* Config.String("REVISION");
    yield* checkDeployment(name, file, origin, revision);
  }, Effect.provide(hostLayer)),
).pipe(
  Command.withDescription(
    "Fail unless the cartridge in CARTRIDGE_FILE is valid, pins its images, and comes from the app's repository",
  ),
);

const deploymentRecord = Command.make(
  "record",
  { name },
  Effect.fn(function* ({ name }) {
    const file = yield* Config.String("CARTRIDGE_FILE");
    const origin = yield* Config.String("ORIGIN");
    const revision = yield* Config.String("REVISION");
    yield* recordDeployment(name, file, origin, revision);
  }, Effect.provide(hostLayer)),
).pipe(Command.withDescription("Record the cartridge in CARTRIDGE_FILE as deployed"));

const deploymentRestore = Command.make(
  "restore",
  {
    name,
    id: Argument.Int("id").pipe(Argument.withDescription("The deployment to restore")),
    file: Argument.String("file").pipe(Argument.withDescription("Where to write its cartridge")),
  },
  Effect.fn(function* ({ name, id, file }) {
    const { origin, revision } = yield* restoreDeployment(name, id, file);
    yield* Console.log(`ORIGIN=${origin} REVISION=${revision}`);
  }, Effect.provide(hostLayer)),
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
 * The deployment `ops` sent with a release: the cartridge at `file`, the repository root
 * commit in `origin`, and the released commit in `revision`. Every image must be pinned by
 * digest, so a recorded deployment always names exactly what ran.
 */
const sentDeployment = Effect.fn("sentDeployment")(function* (
  name: string,
  file: string,
  origin: string,
  revision: string,
) {
  const cartridge = yield* appCartridgeAt(file, name);
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

/** An app cartridge file whose `name` matches the stage. */
const appCartridgeAt = Effect.fn("appCartridgeAt")(function* (file: string, name: string) {
  const cartridge = yield* Cartridge.decodeFile(file, Cartridge.AppCartridge);
  if (cartridge.name !== name) {
    return yield* new CliError({
      message: `stage '${name}' was given the cartridge of '${cartridge.name}'`,
    });
  }
  return cartridge;
});

/** The images a recorded cartridge's services run; the record is valid JSON by construction. */
const images = (cartridge: string): ReadonlyArray<string> => [
  ...new Set(
    (JSON.parse(cartridge) as { services: ReadonlyArray<{ image: string }> }).services.map(
      (service) => service.image.replace(/^.*@sha256:(.{12}).*$/, "sha256:$1"),
    ),
  ),
];

/** Run Alchemy on this terminal with `env` added; on non-zero exit, fail with that code only. */
const runAlchemy = Effect.fn("cli.runAlchemy")(function* (
  args: ReadonlyArray<string>,
  env: Record<string, string>,
) {
  const spawner = yield* ChildProcessSpawner;
  const code = yield* spawner
    .exitCode(
      ChildProcess.make("bunx", ["alchemy", ...args], {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        env,
        extendEnv: true,
      }),
    )
    .pipe(
      Effect.mapError(
        (error: PlatformError) => new CliError({ message: `bunx: ${error.message}` }),
      ),
    );
  if (code !== 0) return yield* new AlchemyFailed({ code });
});

const main = Effect.gen(function* () {
  const args = yield* (yield* Stdio.Stdio).args;
  yield* Command.runWith(makeCli(), { version: "1" })(route(alchemyCommands)(args));
}).pipe(
  Effect.tapErrorTag("CliError", (error) => Console.error(error.message)),
  Effect.provide(BunServices.layer),
);

if (import.meta.main) main.pipe(BunRuntime.runMain);
