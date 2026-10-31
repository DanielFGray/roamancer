/*
 * `ops`, the operator's command: releases and secrets from an app's repository, host
 * configuration (`rebuild`, `install`), and every Alchemy and Nomad command, which is a job on the
 * control host. `scripts/ops` starts this file. The site folder that OPS_SITE names says
 * where the control host is (src/Site.ts).
 */
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Console, Effect, Layer, Stdio } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { Builder } from "./Builder.ts";
import { commands as devCommands } from "./devdb/Commands.ts";
import { OpsError, route } from "./Exec.ts";
import { HostName, install, rebuild } from "./Nixos.ts";
import { commands as releaseCommands } from "./release.ts";
import { commands as jobCommands, forwarded } from "./Jobs.ts";
import { Remote } from "./Remote.ts";
import { secret } from "./secrets.ts";
import { Site } from "./Site.ts";

const hostName = Argument.String("host").pipe(Argument.withSchema(HostName));

const rebuildCommand = Command.make(
  "rebuild",
  {
    host: hostName.pipe(
      Argument.withDescription("A host in the root flake.nix; every host when omitted"),
      Argument.optional,
    ),
    target: Argument.String("target").pipe(
      Argument.withDescription("The ssh target; defaults to the host name"),
      Argument.optional,
    ),
  },
  ({ host, target }) => rebuild(host, target),
).pipe(
  Command.withDescription("Sync the repository to a running host and switch it to that config"),
);

const installCommand = Command.make(
  "install",
  {
    yes: Flag.Boolean("yes").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Erase the disk without asking, as a script without a terminal must"),
    ),
    host: hostName.pipe(Argument.withDescription("The host in the root flake.nix to install")),
    target: Argument.String("target").pipe(
      Argument.withDescription("The ssh target of the machine, such as root@192.168.50.10"),
    ),
    anywhere: Argument.String("nixos-anywhere-args").pipe(
      Argument.withDescription("After `--`: further arguments for nixos-anywhere"),
      Argument.variadic(),
    ),
  },
  install,
).pipe(Command.withDescription("Erase a machine's disk and install a host's configuration"));

const ops = Command.make("ops").pipe(
  Command.withDescription("Release apps, rebuild hosts, and run Alchemy on the control host"),
  Command.withSubcommands([
    ...releaseCommands,
    ...devCommands,
    secret,
    rebuildCommand,
    installCommand,
    ...jobCommands,
  ]),
);

const main = Effect.gen(function* () {
  const args = yield* (yield* Stdio.Stdio).args;
  yield* Command.runWith(ops, { version: "1" })(route(forwarded)(args));
}).pipe(
  Effect.tapErrorTag("OpsError", (error: OpsError) => Console.error(error.message)),
  Effect.provide(
    Remote.layer.pipe(
      Layer.provideMerge(Builder.layer),
      Layer.provideMerge(Site.layer),
      Layer.provideMerge(BunServices.layer),
    ),
  ),
);

if (import.meta.main) main.pipe(BunRuntime.runMain);
