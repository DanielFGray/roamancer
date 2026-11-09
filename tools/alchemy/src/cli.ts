/**
 * `alchemy-runner` on the control host. The operator runs `submit`, `version`, `login`
 * and `logs`; every other operation is a queued job that `job run` executes as the
 * runner user (queue/Schema.ts lists the job kinds). `ops` on the workstation reaches this
 * program over SSH.
 */
import * as Alchemy from "alchemy";
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
  Stdio,
  Stream,
} from "effect";
import { Schema as S } from "effect";
import { Argument, Command, Flag, Prompt } from "effect/cli";
import { FetchHttpClient } from "effect/http";
import { ChildProcess } from "effect/process";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import type { PlatformError } from "effect/PlatformError";
import * as path from "node:path";
import * as BuildJobs from "./BuildJob.ts";
import * as BuildStoreLive from "./BuildStore.ts";
import * as RegistryLive from "./Registry.ts";
import * as Cartridge from "./Cartridge.ts";
import { HttpApiClient } from "effect/http-api";
import * as Deployments from "./Deployments.ts";
import * as FleetApi from "./fleet/Api.ts";
import * as FleetServer from "./fleet/Server.ts";
import * as FleetStatus from "./FleetStatus.ts";
import * as NomadLive from "./Nomad.ts";
import * as Package from "./Package.ts";
import { Nomad } from "./Nomad.ts";
import { OpenBao, OpenBaoError } from "./OpenBao.ts";
import * as TaskLog from "./TaskLog.ts";
import { request as queueRequest } from "./queue/Client.ts";
import { LoginRequired } from "./queue/Errors.ts";
import * as QueueFinished from "./queue/Finished.ts";
import * as QueuePaths from "./queue/Paths.ts";
import * as QueueProtocol from "./queue/Protocol.ts";
import * as QueueRun from "./queue/Run.ts";
import * as QueueSignoff from "./queue/Signoff.ts";
import type {
  DeploySubmit,
  BuildSubmit,
  Job as QueuedJob,
  RollbackSubmit,
  StageSubmit,
} from "./queue/Schema.ts";
import * as QueueServe from "./queue/Serve.ts";
import * as StagelessJobs from "./queue/StagelessJobs.ts";
import * as DevDbHost from "./devdb/Host.ts";
import { layer as queueStoreLayer } from "./queue/Store.ts";
import * as QueueSubmit from "./queue/Submit.ts";
import * as QueueUpload from "./queue/Upload.ts";
import * as QueueUnits from "./queue/Units.ts";

/** A failure the operator can act on: printed as its message alone, without a stack trace. */
export class CliError extends S.TaggedError<CliError>()("CliError", {
  message: S.String,
}) {
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

/**
 * Nomad tokens `nomad-acl-issue-<name>` writes: read-write for jobs, read-only for the
 * operator and for the fleet service.
 */
const controllerEnvPath = "/var/lib/nomad-acl/controller.env";
const operatorEnvPath = "/var/lib/nomad-acl/operator.env";
const fleetEnvPath = "/var/lib/nomad-acl/fleet.env";
const openBaoAddr = "http://127.0.0.1:8200";

/**
 * KEY=VALUE lines, as the `nomad-acl-issue-*` scripts write them.
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

/**
 * Read a Nomad env file (KEY=VALUE) and default NOMAD_ADDR / OPENBAO_ADDR to the loopback
 * listeners. Fails, naming the script that writes it, when the file is unreadable.
 */
export const loadNomadEnvironment = Effect.fn("loadNomadEnvironment")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const readable = yield* fs.access(file, { readable: true }).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
  if (!readable) {
    return yield* new CliError({
      message: `cannot read ${file}. Run 'sudo nomad-acl-issue-${path.basename(file, ".env")}' once after the rebuild.`,
    });
  }
  return {
    ...parseEnvFile(yield* fs.readFileString(file)),
    NOMAD_ADDR: "http://127.0.0.1:4646",
    OPENBAO_ADDR: openBaoAddr,
  } as Record<string, string>;
});

/** Nomad with the read-only token an env file holds: the operator's, or the fleet service's. */
const readOnlyNomad = (file: string) =>
  Layer.unwrap(
    Effect.map(loadNomadEnvironment(file), (env) =>
      NomadLive.layer().pipe(
        Layer.provideMerge(FetchHttpClient.layer),
        Layer.provideMerge(
          ConfigProvider.layerAdd(ConfigProvider.fromEnvRecord(env), {
            asPrimary: true,
          }),
        ),
      ),
    ),
  );

/** OpenBao, Nomad, Deployments and the build services over `env`, for a job's body. */
const jobServices = (env: Record<string, string>) =>
  Layer.mergeAll(BuildStoreLive.layer, RegistryLive.layer).pipe(
    Layer.provideMerge(Layer.mergeAll(OpenBao.layer, NomadLive.layer(), Deployments.layer())),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(
      ConfigProvider.layerAdd(ConfigProvider.fromEnvRecord(env), {
        asPrimary: true,
      }),
    ),
  );

/** Command tree for this host process. Host files load only inside each command handler. */
const makeCli = () =>
  Command.make("alchemy-runner").pipe(
    Command.withDescription(
      "Submit Alchemy jobs, log in to OpenBao for them, set their KV secrets, and read the fleet's Nomad health and logs",
    ),
    Command.withSubcommands([
      submit,
      wait,
      signoff,
      signoffs,
      build,
      version,
      login,
      secret,
      logs,
      dash,
      fleet,
      queue,
      job,
      image,
    ]),
  );

const submit = Command.make(
  "submit",
  {},
  Effect.fn(function* () {
    const stdio = yield* Stdio.Stdio;
    const text = yield* Stream.mkString(Stream.decodeText(stdio.stdin));
    const id = yield* QueueSubmit.submitJob(text, QueuePaths.production.socket).pipe(
      Effect.mapError((error) => new CliError({ message: error.message })),
    );
    yield* Console.log(id);
  }),
).pipe(Command.withDescription("Queue the job one JSON request on stdin describes; print its id"));

const signoff = Command.make(
  "signoff",
  {},
  Effect.fn(function* () {
    const stdio = yield* Stdio.Stdio;
    const text = yield* Stream.mkString(Stream.decodeText(stdio.stdin));
    const id = yield* QueueSignoff.recordSignoff(text, QueuePaths.production.socket).pipe(
      Effect.mapError((error) => new CliError({ message: error.message })),
    );
    yield* Console.log(id);
  }),
).pipe(
  Command.withDescription(
    "Store one local-test signoff from a JSON request on stdin; print its id",
  ),
);

const build = Command.make(
  "build",
  {},
  Effect.fn(function* () {
    const stdio = yield* Stdio.Stdio;
    const id = yield* QueueUpload.forwardBuild(stdio.stdin, QueuePaths.production.socket).pipe(
      Effect.mapError((error) => new CliError({ message: error.message })),
    );
    yield* Console.log(id);
  }),
).pipe(
  Command.withDescription(
    "Queue a build: stdin is one build request JSON line, then the exported tree's tar; print the job id",
  ),
);

const signoffs = Command.make(
  "signoffs",
  { app: Argument.String("app").pipe(Argument.withDescription("The cartridge name to list")) },
  Effect.fn(function* ({ app }) {
    yield* QueueSignoff.printSignoffs(app, QueuePaths.production.socket).pipe(
      Effect.mapError((error) => new CliError({ message: error.message })),
    );
  }),
).pipe(Command.withDescription("Print an app's stored signoffs as JSON, newest first"));

const wait = Command.make(
  "wait",
  { id: Argument.Int("id").pipe(Argument.withDescription("The job id `submit` printed")) },
  Effect.fn(function* ({ id }) {
    const failure = yield* QueueSubmit.waitJob(id, QueuePaths.production.socket).pipe(Effect.flip);
    if (failure._tag === "SubmitExit") return yield* new AlchemyFailed({ code: failure.code });
    return yield* new CliError({ message: failure.message });
  }),
).pipe(
  Command.withDescription(
    "Stream a job's output until it ends and exit with its code; interrupt cancels a queued job",
  ),
);

/** Send the image request to the runner socket and fail on its error answer. */
const imageRequest = Effect.fn("imageRequest")(function* (
  request: typeof QueueProtocol.FindImage.Type,
) {
  const answer = yield* queueRequest(QueuePaths.production.socket, request).pipe(
    Effect.mapError((error) => new CliError({ message: error.message })),
  );
  if (answer._tag === "error") return yield* new CliError({ message: answer.message });
  return answer;
});

const imageFind = Command.make(
  "find",
  {
    repository: Argument.String("repository"),
    key: Argument.String("key").pipe(Argument.withDescription("The image key, a git tree hash")),
  },
  Effect.fn(function* ({ repository, key }) {
    const request = yield* S.decodeUnknownEffect(QueueProtocol.FindImage)({
      _tag: "findImage",
      repository,
      key,
    }).pipe(Effect.mapError((error) => new CliError({ message: `image find: ${error.message}` })));
    const answer = yield* imageRequest(request);
    if (answer._tag === "imageFound" && answer.digest !== null) yield* Console.log(answer.digest);
  }),
).pipe(
  Command.withDescription("Print the digest recorded for an image key; nothing when there is none"),
);

const image = Command.make("image").pipe(
  Command.withDescription("Find the image each tree of an app was built as"),
  Command.withSubcommands([imageFind]),
);

const version = Command.make(
  "version",
  {},
  Effect.fn(function* () {
    const revision = yield* Config.option(Config.String("ALCHEMY_RUNNER_REVISION"));
    if (Option.isNone(revision) || revision.value === "") {
      return yield* new CliError({
        message: "This runner was built from a dirty tree and has no revision. Run `ops rebuild`.",
      });
    }
    yield* Console.log(revision.value);
  }),
).pipe(Command.withDescription("Print the server-ansible commit this runner was built from"));

const login = Command.make(
  "login",
  {},
  Effect.fn(function* () {
    // Only the 10-hour child leaves this process: one login covers a working day.
    const token = yield* mintToken(yield* readRootToken, "10h");
    const stored = yield* queueRequest(QueuePaths.production.socket, {
      _tag: "token",
      value: Redacted.value(token),
    }).pipe(Effect.mapError((error) => new CliError({ message: error.message })));
    if (stored._tag === "error") return yield* new CliError({ message: stored.message });
    yield* Console.log("OpenBao token for 10 hours stored for the Alchemy runner.");
  }),
).pipe(
  Command.withDescription(
    "Mint a 10-hour OpenBao token from the root token and send it to the runner socket",
  ),
);

/** The KV references `ops secret list` and `check` send; the host never reads the cartridge. */
const references = Argument.String("references").pipe(
  Argument.withDescription("A JSON object: each KV v2 path and the keys the cartridge reads there"),
);

const secretList = Command.make(
  "list",
  { references },
  Effect.fn(function* ({ references }) {
    const referenced = yield* decodeReferences(references);
    const stored = yield* withRootToken(storedKeys(referenced));
    yield* Console.log(
      [...referenced]
        .map(([kvPath, keys]) => {
          const present = stored.get(kvPath) ?? [];
          return [
            kvPath,
            ...keys.map((key) => `  ${present.includes(key) ? "set    " : "MISSING"} ${key}`),
            ...present.filter((key) => !keys.includes(key)).map((key) => `  unused  ${key}`),
          ].join("\n");
        })
        .join("\n"),
    );
  }),
).pipe(Command.withDescription("Show which referenced secrets are set; never prints values"));

const secretCheck = Command.make(
  "check",
  {
    name: Argument.String("name").pipe(Argument.withDescription("The cartridge's name")),
    references,
  },
  Effect.fn(function* ({ name, references }) {
    yield* withRootToken(requireSecrets(name, yield* decodeReferences(references)));
  }),
).pipe(Command.withDescription("Fail when a referenced secret is not set"));

const secretSet = Command.make(
  "set",
  {
    path: Argument.String("path").pipe(
      Argument.withDescription("The KV v2 path, such as secret/data/giglist"),
    ),
    key: Argument.String("key").pipe(Argument.withDescription("The secret's key")),
  },
  Effect.fn(function* ({ path: kvPath, key }) {
    const stdio = yield* Stdio.Stdio;
    // Piped stdin holds the root token, so the value needs the prompt.
    if (!(yield* stdio.stdinIsTerminal)) {
      return yield* new CliError({
        message: "secret set prompts for the root token and the value: run it in a terminal.",
      });
    }
    yield* withRootToken(promptAndWrite(kvPath, key));
    yield* Console.log(`Set ${key} at ${kvPath}. Running tasks restart with the new value.`);
  }),
).pipe(Command.withDescription("Store one secret; prompts for the root token and the value"));

const secret = Command.make("secret").pipe(
  Command.withDescription("Read and set KV secrets with the root token, typed or piped on stdin"),
  Command.withSubcommands([secretList, secretCheck, secretSet]),
);

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
  Effect.fn(
    function* ({ job, tail, lines }) {
      const nomad = yield* Nomad;
      const newest = Arr.head(Arr.sort(yield* nomad.allocations(job), TaskLog.newestFirst));
      if (Option.isNone(newest)) {
        return yield* new CliError({
          message: `Nomad has no allocations for job '${job}'.`,
        });
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
    },
    Effect.provide(readOnlyNomad(operatorEnvPath)),
  ),
).pipe(Command.withDescription("Print a Nomad job's recent output, or why it is not running"));

const fleetUrl = `http://127.0.0.1:${FleetApi.port}`;

const dash = Command.make(
  "dash",
  {},
  Effect.fn(function* () {
    const client = yield* HttpApiClient.make(FleetApi.FleetApi, { baseUrl: fleetUrl });
    const snapshot = yield* client.fleet.snapshot().pipe(
      Effect.mapError(
        (error) =>
          new CliError({
            message: `the fleet service did not answer at ${fleetUrl} (${error.message}). See systemctl status alchemy-fleet.`,
          }),
      ),
    );
    yield* Console.log(FleetStatus.render(snapshot));
  }, Effect.provide(FetchHttpClient.layer)),
).pipe(Command.withDescription("Print the fleet service's snapshot once"));

const fleetServe = Command.make(
  "serve",
  {},
  Effect.fn(function* () {
    // The built fleet page; without it the service answers only the API.
    const webRoot = yield* Config.option(Config.String("FLEET_WEB_ROOT"));
    yield* Layer.launch(FleetServer.layer({ webRoot })).pipe(
      Effect.provide(
        Layer.mergeAll(
          readOnlyNomad(fleetEnvPath),
          Deployments.layer(),
          queueStoreLayer(QueuePaths.production.database),
          // The working directory's .alchemy/state, which the runner's deploys write.
          Alchemy.localState(),
        ).pipe(Layer.provideMerge(BunServices.layer)),
      ),
    );
  }),
).pipe(Command.withDescription("Serve the fleet snapshot API and page on loopback"));

const fleet = Command.make("fleet").pipe(
  Command.withDescription("The fleet service: one read-only snapshot for `dash` and the page"),
  Command.withSubcommands([fleetServe]),
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
        "No OpenBao root token on stdin. Pipe the token in, or run the command in a terminal.",
    });
  }
  return Redacted.make(line);
});

/** A child of `parent` that expires after `ttl`. */
const mintToken = (parent: Redacted.Redacted<string>, ttl: string) =>
  Effect.flatMap(OpenBao, (bao) => bao.createToken(ttl)).pipe(
    Effect.provide(openBaoWith(parent)),
    Effect.mapError(
      () => new CliError({ message: "Could not mint an OpenBao token from the root token." }),
    ),
  );

/**
 * Run `use` against OpenBao with a 5-minute child of the root token the operator types or
 * pipes in. Neither token leaves this process or reaches a file.
 */
const withRootToken = <A, E, R>(use: Effect.Effect<A, E | OpenBaoError, R>) =>
  Effect.gen(function* () {
    const child = yield* mintToken(yield* readRootToken, "5m");
    return yield* use.pipe(
      Effect.provide(openBaoWith(child)),
      Effect.catchIf(
        (error): error is OpenBaoError | Config.ConfigError =>
          error instanceof OpenBaoError || error instanceof Config.ConfigError,
        (error) => new CliError({ message: `OpenBao: ${error.message}` }),
      ),
    );
  });

/** OpenBao over `token` alone; fresh, so no other layer's token stands in for it. */
const openBaoWith = (token: Redacted.Redacted<string>) =>
  Layer.fresh(OpenBao.layer).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(
      ConfigProvider.layerAdd(
        ConfigProvider.fromEnvRecord({
          OPENBAO_ADDR: openBaoAddr,
          OPENBAO_TOKEN: Redacted.value(token),
        }),
        { asPrimary: true },
      ),
    ),
  );

const queueLayer = (paths: typeof QueuePaths.production) =>
  Layer.mergeAll(
    queueStoreLayer(paths.database),
    QueueUnits.layer,
    QueueServe.layerServer(paths),
  ).pipe(Layer.provideMerge(BunServices.layer));

const queueServe = Command.make(
  "serve",
  {},
  Effect.fn(function* () {
    yield* QueueServe.serve(QueuePaths.production).pipe(
      Effect.mapError((error) => new CliError({ message: error.message })),
      Effect.provide(queueLayer(QueuePaths.production)),
    );
  }),
).pipe(Command.withDescription("Accept job submissions on the Alchemy submit socket"));

const queue = Command.make("queue").pipe(
  Command.withDescription("The durable job queue front end"),
  Command.withSubcommands([queueServe]),
);

const jobRun = Command.make(
  "run",
  {
    id: Argument.Int("id").pipe(Argument.withDescription("The queued job to run")),
  },
  Effect.fn(function* ({ id }) {
    yield* QueueRun.runJob(id, QueuePaths.production, executeQueuedJob).pipe(
      Effect.catchTag("LoginRequired", () => new CliError({ message: "run ops login" })),
      Effect.catchTag("JobExit", (error) => new AlchemyFailed({ code: error.code })),
      Effect.catchTag("JobCommandError", (error) => new CliError({ message: error.message })),
      Effect.catchTag("JobNotFound", (error) => new CliError({ message: error.message })),
      Effect.catchTag("JobNotStarting", (error) => new CliError({ message: error.message })),
      Effect.provide(queueStoreLayer(QueuePaths.production.database)),
      Effect.provide(BunServices.layer),
    );
  }),
).pipe(Command.withDescription("Run one queued job body"));

const jobFinished = Command.make(
  "finished",
  {
    id: Argument.Int("id").pipe(Argument.withDescription("The job whose unit stopped")),
  },
  Effect.fn(function* ({ id }) {
    yield* QueueFinished.finished(id, QueuePaths.production).pipe(
      Effect.mapError((error) => new CliError({ message: error.message })),
      Effect.provide(queueStoreLayer(QueuePaths.production.database)),
      Effect.provide(BunServices.layer),
    );
  }),
).pipe(Command.withDescription("Finalise a stopped job unit and start the next"));

const job = Command.make("job").pipe(
  Command.withDescription("Run or finalise an alchemy-job@ unit"),
  Command.withSubcommands([jobRun, jobFinished]),
);

/**
 * A queued job's body, as the runner user with the controller Nomad token. `env` carries the
 * OpenBao token and any sent CARTRIDGE_FILE, ORIGIN and REVISION.
 */
export const executeQueuedJob: QueueRun.Execute = (job: QueuedJob, env) =>
  Effect.gen(function* () {
    const controller = yield* loadNomadEnvironment(controllerEnvPath).pipe(
      Effect.mapError((error) => new QueueRun.JobCommandError({ message: error.message })),
    );
    const jobEnv = { ...controller, ...env };
    yield* Effect.gen(function* () {
      const bao = yield* OpenBao;
      yield* bao.checkToken().pipe(Effect.catchTag("OpenBaoError", () => new LoginRequired()));
      const submit = job.submit;
      switch (submit.command) {
        case "plan":
        case "deploy":
        case "destroy":
        case "drift":
        case "rollback":
          return yield* runStageJob(submit, jobEnv);
        case "state":
          return yield* runAlchemy(
            [
              "state",
              submit.verb,
              ...(submit.path === null ? [] : [submit.path]),
              "-c",
              Package.stateEntry,
            ],
            jobEnv,
          );
        case "deployment":
          return yield* StagelessJobs.listDeployments(submit.name);
        case "status":
          return yield* StagelessJobs.status(submit.name);
        case "stage-image":
          return yield* StagelessJobs.stageImage(submit.name, submit.stable, submit.expect);
        case "place-queued":
          return yield* StagelessJobs.placeQueued();
        case "build":
          return yield* buildJob(submit, job.id);
        case "dev-db":
          return yield* DevDbHost.devDbJob(submit);
        case "dev-db-cluster":
          return yield* DevDbHost.devDbClusterJob(submit);
        default:
          return submit satisfies never;
      }
    }).pipe(Effect.provide(jobServices(jobEnv)), mapQueuedFailure);
  });

/**
 * Alchemy argv for a job that changes a stage. A queued job is already approved (the
 * workstation showed the plan and asked), so deploy, destroy and rollback pass `--yes`.
 * Rollback reports the deploy it runs after restoring the cartridge.
 */
export const alchemyArgv = (
  submit: StageSubmit | DeploySubmit | RollbackSubmit,
): ReadonlyArray<string> =>
  submit.command === "rollback"
    ? stageArgv("deploy", submit.name)
    : stageArgv(submit.command, submit.stage);

const stageArgv = (command: "plan" | "deploy" | "destroy" | "drift", stage: string) => [
  command,
  "--stage",
  stage,
  ...(command === "deploy" || command === "destroy" ? ["--yes"] : []),
  "-c",
  command === "destroy" ? Package.stateEntry : Package.appEntry,
];

const runStageJob = Effect.fn("runStageJob")(function* (
  submit: StageSubmit | DeploySubmit | RollbackSubmit,
  env: Record<string, string>,
) {
  switch (submit.command) {
    case "plan":
    case "deploy":
      return yield* planOrDeploy(submit.command, submit.stage, env);
    case "destroy":
    case "drift":
      return yield* runAlchemy(alchemyArgv(submit), env);
    case "rollback": {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(".alchemy/input", { recursive: true });
      const cartridgeFile = `.alchemy/input/rollback-${submit.name}-${submit.deploymentId}.json`;
      const { origin, revision } = yield* restoreDeployment(
        submit.name,
        submit.deploymentId,
        cartridgeFile,
      );
      return yield* planOrDeploy("deploy", submit.name, {
        ...env,
        CARTRIDGE_FILE: cartridgeFile,
        ORIGIN: origin,
        REVISION: revision,
      });
    }
  }
});

/**
 * Plan or deploy one stage. A sent app cartridge must pin its images and come from the
 * repository the app was first deployed from; a deploy of one is recorded once Alchemy
 * exits 0. `env` is one record: host settings plus any CARTRIDGE_FILE, ORIGIN and REVISION.
 */
export const planOrDeploy = Effect.fn("planOrDeploy")(function* (
  command: "plan" | "deploy",
  stage: string,
  env: Record<string, string>,
) {
  const cartridgeFile = env["CARTRIDGE_FILE"];
  const origin = env["ORIGIN"];
  const revision = env["REVISION"];
  const recorded = cartridgeFile !== undefined && origin !== undefined && revision !== undefined;
  if (recorded) yield* checkDeployment(stage, cartridgeFile, origin, revision);
  yield* checkSecrets(stage, cartridgeFile);
  yield* runAlchemy(stageArgv(command, stage), env);
  if (recorded && command === "deploy") {
    yield* recordDeployment(stage, cartridgeFile, origin, revision);
  }
});

const mapQueuedFailure = <
  A,
  E extends {
    readonly _tag: string;
    readonly message?: string;
    readonly code?: number;
  },
  R,
>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, QueueRun.JobExit | QueueRun.JobCommandError | LoginRequired, R> =>
  effect.pipe(
    Effect.mapError((error): QueueRun.JobExit | QueueRun.JobCommandError | LoginRequired => {
      if (error._tag === "AlchemyFailed" && typeof error.code === "number") {
        return new QueueRun.JobExit({ code: error.code });
      }
      if (error._tag === "OpenBaoError" || error._tag === "LoginRequired") {
        return new LoginRequired();
      }
      return new QueueRun.JobCommandError({
        message: typeof error.message === "string" ? error.message : error._tag,
      });
    }),
  );

/** Fail when a secret the cartridge references is not set. */
const checkSecrets = Effect.fn("checkSecrets")(function* (
  name: string,
  cartridgeFile: string | undefined,
) {
  const cartridgeName = Cartridge.liveName(name);
  const cartridge =
    cartridgeFile === undefined
      ? yield* Cartridge.resolve(Package.root, cartridgeName)
      : yield* appCartridgeAt(cartridgeFile, cartridgeName);
  yield* requireSecrets(name, Cartridge.kvKeys(cartridge));
});

/** Fail, naming each key, when a secret `name` reads from `references` is not set. */
const requireSecrets = Effect.fn("requireSecrets")(function* (
  name: string,
  references: Cartridge.KvReferences,
) {
  const missing = Cartridge.missingSecrets(references, yield* storedKeys(references));
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

/** The key names stored at each referenced KV path; none where nothing is stored. */
const storedKeys = Effect.fn("storedKeys")(function* (references: Cartridge.KvReferences) {
  const bao = yield* OpenBao;
  return new Map(
    yield* Effect.forEach(references.keys(), (path) =>
      bao
        .readKvKeys(path)
        .pipe(
          Effect.map(
            (keys) => [path, Option.getOrElse(keys, (): ReadonlyArray<string> => [])] as const,
          ),
        ),
    ),
  );
});

/** Ask for one secret's value and store it at `kvPath`, keeping the path's other keys. */
const promptAndWrite = Effect.fn("promptAndWrite")(function* (kvPath: string, key: string) {
  const bao = yield* OpenBao;
  const value = yield* Prompt.run(Prompt.Password({ message: `Value for ${kvPath} ${key}` }));
  yield* bao.writeKvKey(kvPath, key, value);
});

const decodeReferences = (text: string) =>
  S.decodeUnknownEffect(S.fromJsonString(S.Record(S.String, S.Array(S.String))))(text).pipe(
    Effect.map((record): Cartridge.KvReferences => new Map(Object.entries(record))),
    Effect.mapError(
      () => new CliError({ message: `not a JSON object of KV paths and their keys: ${text}` }),
    ),
  );

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
    return yield* new CliError({
      message: `'${name}' has no recorded deployment ${id}.`,
    });
  }
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(file, found.value.cartridge);
  return { origin: found.value.origin, revision: found.value.revision };
});

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

/** Run Alchemy on this terminal with `env` added; on non-zero exit, fail with that code only. */
const runAlchemy = Effect.fn("cli.runAlchemy")(function* (
  args: ReadonlyArray<string>,
  env: Record<string, string>,
) {
  const spawner = yield* ChildProcessSpawner;
  const code = yield* spawner
    .exitCode(
      ChildProcess.make(process.execPath, [Package.alchemyCli, ...args], {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        env,
        extendEnv: true,
      }),
    )
    .pipe(
      Effect.mapError(
        (error: PlatformError) => new CliError({ message: `alchemy: ${error.message}` }),
      ),
    );
  if (code !== 0) return yield* new AlchemyFailed({ code });
});

const main = Effect.gen(function* () {
  const args = yield* (yield* Stdio.Stdio).args;
  yield* Command.runWith(makeCli(), { version: "1" })(args);
}).pipe(
  Effect.tapErrorTag("CliError", (error) => Console.error(error.message)),
  Effect.provide(BunServices.layer),
);

if (import.meta.main) main.pipe(BunRuntime.runMain);

/**
 * A `build` job: build the tree the front end stored, record its digest, and remove the spool
 * file whatever the outcome. The registry's name and CA folder are site settings that the
 * unit's environment carries.
 */
const buildJob = Effect.fn("buildJob")(function* (submit: BuildSubmit, jobId: number) {
  const site = {
    registry: yield* Config.String("REGISTRY"),
    registryCaDir: yield* Config.String("REGISTRY_CA_DIR"),
  };
  const fs = yield* FileSystem.FileSystem;
  const tarFile = QueuePaths.spoolFile(QueuePaths.production, submit.spool);
  yield* BuildJobs.runBuild(
    {
      repository: submit.repository,
      key: submit.key,
      jobId,
      tarFile,
      memoryMaxMB: submit.memoryMaxMB,
    },
    site,
  ).pipe(Effect.ensuring(fs.remove(tarFile, { force: true }).pipe(Effect.ignore)));
});
