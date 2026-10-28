/*
 * `ops` commands that run on the control host. Each one but `login` and `logs` is a job in
 * the host's queue (src/Remote.ts). A deploy is two jobs: a plan, shown here, then a deploy
 * that names that plan, so the host refuses it when anything changed the stage since.
 */
import { Config, Effect, FileSystem, Option, Stdio } from "effect";
import { Argument, Command, Flag, Prompt } from "effect/cli";
import { OpsError } from "./Exec.ts";
import type { StageSubmit } from "./queue/Schema.ts";
import { Remote } from "./Remote.ts";

/** What a stage job carries besides the stage. */
export type Sent = Omit<StageSubmit, "command" | "stage">;

/**
 * Plan `stage`, ask, then deploy that plan. `yes` skips the question, as a script without
 * a terminal must.
 */
export const deployStage = Effect.fn("Jobs.deployStage")(function* (
  stage: string,
  sent: Sent,
  yes: boolean,
) {
  const remote = yield* Remote;
  const planJobId = yield* remote.run({ command: "plan", stage, ...sent });
  yield* confirm(`Deploy this plan of ${stage}?`, yes);
  yield* remote.run({ command: "deploy", stage, ...sent, planJobId });
});

/** Destroy every resource in `stage`'s Alchemy state, after asking. */
export const destroyStage = Effect.fn("Jobs.destroyStage")(function* (stage: string, yes: boolean) {
  yield* confirm(`Destroy every resource of ${stage}?`, yes);
  yield* (yield* Remote).run({ command: "destroy", stage, ...unsent });
});

/** Ask a yes/no question; fails on no, or with no terminal unless `yes`. */
const confirm = Effect.fn("Jobs.confirm")(function* (message: string, yes: boolean) {
  if (yes) return;
  if (!(yield* (yield* Stdio.Stdio).stdinIsTerminal)) {
    return yield* new OpsError({ message: `${message} No terminal to ask on: pass --yes.` });
  }
  if (!(yield* Prompt.run(Prompt.Confirm({ message })))) {
    return yield* new OpsError({ message: "Stopped; nothing was changed." });
  }
});

const unsent: Sent = { cartridge: null, origin: "", revision: "", stagedImage: null };

/** CARTRIDGE names a cartridge file for a stage job; without one the host uses its record. */
const cartridgeFromEnv = Effect.gen(function* () {
  const path = yield* Config.option(Config.String("CARTRIDGE"));
  if (Option.isNone(path)) return unsent;
  const text = yield* (yield* FileSystem.FileSystem).readFileString(path.value);
  return { ...unsent, cartridge: text };
});

const stage = Flag.String("stage").pipe(
  Flag.withDescription("The stage, which is the cartridge's name, such as giglist"),
);
const yes = Flag.Boolean("yes").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Do not ask, as a script without a terminal must"),
);
const name = Argument.String("name").pipe(Argument.withDescription("The app's name"));

const plan = Command.make(
  "plan",
  { stage },
  Effect.fn(function* ({ stage }) {
    yield* (yield* Remote).run({ command: "plan", stage, ...(yield* cartridgeFromEnv) });
  }),
).pipe(Command.withDescription("Preview an Alchemy deploy of a stage"));

const deploy = Command.make(
  "deploy",
  { stage, yes },
  Effect.fn(function* ({ stage, yes }) {
    yield* deployStage(stage, yield* cartridgeFromEnv, yes);
  }),
).pipe(Command.withDescription("Plan a stage, ask, then deploy that plan"));

const destroy = Command.make(
  "destroy",
  { stage, yes },
  Effect.fn(function* ({ stage, yes }) {
    yield* destroyStage(stage, yes);
  }),
).pipe(Command.withDescription("Destroy a stage's resources"));

const drift = Command.make(
  "drift",
  { stage },
  Effect.fn(function* ({ stage }) {
    yield* (yield* Remote).run({ command: "drift", stage, ...(yield* cartridgeFromEnv) });
  }),
).pipe(Command.withDescription("Report drift between the state and the running resources"));

const statePath = Argument.String("path").pipe(
  Argument.withDescription("A state path, such as cartridge/giglist/output"),
);

const state = Command.make("state").pipe(
  Command.withDescription("Read Alchemy's state store"),
  Command.withSubcommands([
    Command.make(
      "list",
      { path: statePath.pipe(Argument.optional) },
      Effect.fn(function* ({ path }) {
        yield* (yield* Remote).run({
          command: "state",
          verb: "list",
          path: Option.getOrNull(path),
        });
      }),
    ).pipe(Command.withDescription("List state paths, under `path` when given")),
    Command.make(
      "read",
      { path: statePath },
      Effect.fn(function* ({ path }) {
        yield* (yield* Remote).run({ command: "state", verb: "read", path });
      }),
    ).pipe(Command.withDescription("Print the value at a state path")),
  ]),
);

const rollback = Command.make(
  "rollback",
  {
    name,
    id: Argument.Int("id").pipe(Argument.withDescription("A deployment id from `deployment`")),
    yes,
  },
  Effect.fn(function* ({ name, id, yes }) {
    yield* confirm(`Deploy recorded deployment ${id} of ${name} again?`, yes);
    yield* (yield* Remote).run({ command: "rollback", name, deploymentId: id });
  }),
).pipe(Command.withDescription("Deploy a recorded deployment again, spec and image together"));

const deployment = Command.make("deployment").pipe(
  Command.withDescription("The recorded deployments of an app"),
  Command.withSubcommands([
    Command.make(
      "list",
      { name },
      Effect.fn(function* ({ name }) {
        yield* (yield* Remote).run({ command: "deployment", name });
      }),
    ).pipe(Command.withDescription("An app's recorded deployments, newest first")),
  ]),
);

const status = Command.make(
  "status",
  { name },
  Effect.fn(function* ({ name }) {
    yield* (yield* Remote).run({ command: "status", name });
  }),
).pipe(Command.withDescription("A cartridge's Nomad allocation status"));

const stageImage = Command.make(
  "stage-image",
  {
    name,
    stable: Flag.Boolean("stable").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Fail unless every staged job is deployed and healthy"),
    ),
  },
  Effect.fn(function* ({ name, stable }) {
    yield* (yield* Remote).run({ command: "stage-image", name, stable, expect: null });
  }),
).pipe(Command.withDescription("The image a staged deploy runs"));

const dash = Command.make(
  "dash",
  {},
  Effect.fn(function* () {
    yield* (yield* Remote).run({ command: "dash" });
  }),
).pipe(Command.withDescription("Every job's health and each node's load, once"));

const placeQueued = Command.make(
  "place-queued",
  {},
  Effect.fn(function* () {
    yield* (yield* Remote).run({ command: "place-queued" });
  }),
).pipe(Command.withDescription("Ask Nomad to place queued jobs again"));

const login = Command.make(
  "login",
  {},
  Effect.fn(function* () {
    yield* (yield* Remote).direct(["login"]);
  }),
).pipe(
  Command.withDescription(
    "Mint a 2-hour OpenBao token for jobs from the root token, typed or piped on stdin",
  ),
);

const logs = Command.make(
  "logs",
  {
    args: Argument.String("args").pipe(
      Argument.withDescription("`alchemy-runner logs` arguments: <job> [--tail] [-n lines]"),
      Argument.variadic(),
    ),
  },
  Effect.fn(function* ({ args }) {
    yield* (yield* Remote).direct(["logs", ...args]);
  }),
).pipe(Command.withDescription("A Nomad job's logs, or why it is not running"));

/** The host commands, to register under `ops`. `logs` forwards its argv unread. */
export const commands = [
  plan,
  deploy,
  destroy,
  drift,
  state,
  rollback,
  deployment,
  status,
  stageImage,
  dash,
  placeQueued,
  login,
  logs,
];
export const forwarded = ["logs"];
