import { Args, Command, Options } from "@effect/cli";
import { Console, Effect, Option } from "effect";
import { InfraClient } from "../services/InfraClient.ts";
import { DeployRunner } from "../services/DeployRunner.ts";
import { DeployMeta } from "../services/DeployMeta.ts";
import { SshClient } from "../services/SshClient.ts";
import { DEPLOYMENT_ROOTS, SVC_USER } from "../lib/config.ts";
import { deploymentNames, deploymentPaths } from "../lib/deployment.ts";

// ---------------------------------------------------------------------------
// Default commands (via HTTP server)
// ---------------------------------------------------------------------------

export const deployCommand = Command.make("deploy", {
  name: Args.text({ name: "name" }).pipe(Args.withDescription("Project name")),
  ref: Args.text({ name: "ref" }).pipe(
    Args.withDefault(""),
    Args.withDescription("Git ref (branch/tag/sha)"),
  ),
  as: Options.text("as").pipe(Options.optional, Options.withDescription("Stage name override")),
  repo: Options.text("repo").pipe(
    Options.optional,
    Options.withDescription("Git repo URL override"),
  ),
}).pipe(
  Command.withHandler(
    Effect.fnUntraced(function* ({ name, ref, as: asStage, repo }) {
      const client = yield* InfraClient;
      const result = yield* client.deploy(
        name,
        ref === "" ? undefined : ref,
        Option.getOrUndefined(asStage),
        Option.getOrUndefined(repo),
      );
      yield* Console.log(`Deployed ${result.name}@${result.hash} -> ${result.stage}`);
      yield* Console.log(`  Preview: ${result.previewUrl}`);
    }),
  ),
  Command.withDescription("Deploy a project"),
);

export const promoteCommand = Command.make("promote", {
  name: Args.text({ name: "name" }).pipe(Args.withDescription("Project name")),
  stage: Args.text({ name: "stage" }).pipe(Args.withDescription("Stage to promote")),
}).pipe(
  Command.withHandler(
    Effect.fnUntraced(function* ({ name, stage }) {
      const client = yield* InfraClient;
      const result = yield* client.promote(name, stage);
      yield* Console.log(`Promoted ${result.name}/${result.stage} -> ${result.domain}`);
    }),
  ),
  Command.withDescription("Promote a stage to production"),
);

export const rollbackCommand = Command.make("rollback", {
  name: Args.text({ name: "name" }).pipe(Args.withDescription("Project name")),
}).pipe(
  Command.withHandler(
    Effect.fnUntraced(function* ({ name }) {
      const client = yield* InfraClient;
      const result = yield* client.rollback(name);
      yield* Console.log(`Rolled back ${result.name} -> ${result.stage}`);
    }),
  ),
  Command.withDescription("Rollback to previous promotion"),
);

export const teardownCommand = Command.make("teardown", {
  name: Args.text({ name: "name" }).pipe(Args.withDescription("Project name")),
  stage: Args.text({ name: "stage" }).pipe(Args.withDescription("Stage to tear down")),
}).pipe(
  Command.withHandler(
    Effect.fnUntraced(function* ({ name, stage }) {
      const client = yield* InfraClient;
      const result = yield* client.teardown(name, stage);
      yield* Console.log(`Torn down ${result.name}/${result.stage}`);
    }),
  ),
  Command.withDescription("Tear down a stage"),
);

export const projectsCommand = Command.make("projects").pipe(
  Command.withHandler(
    Effect.fnUntraced(function* () {
      const client = yield* InfraClient;
      const projects = yield* client.listProjects();
      if (projects.length === 0) {
        yield* Console.log("No projects deployed");
        return;
      }
      yield* Console.log("Deployed projects:\n");
      yield* Effect.forEach(projects, (p) => {
        const promoted = p.promoted ? ` -> ${p.promoted}` : "";
        return Console.log(
          `  ${p.name}  (${p.stageCount} stage${p.stageCount !== 1 ? "s" : ""})${promoted}`,
        );
      });
    }),
  ),
  Command.withDescription("List all deployed projects"),
);

export const stagesCommand = Command.make("stages", {
  name: Args.text({ name: "name" }).pipe(Args.withDescription("Project name")),
}).pipe(
  Command.withHandler(
    Effect.fnUntraced(function* ({ name }) {
      const client = yield* InfraClient;
      const result = yield* client.getStages(name);
      yield* Console.log(`Stages for ${result.name}:\n`);
      yield* Effect.forEach(result.stages, (s) => {
        const promoted = s.promoted ? " [production]" : "";
        return Console.log(
          `  ${s.stage}${promoted}  ${s.type}  ${s.ref}@${s.hash}\n` + `    ${s.previewUrl}`,
        );
      });
      if (result.production) {
        yield* Console.log(`\nProduction domain: ${result.production}`);
      }
    }),
  ),
  Command.withDescription("List stages for a project"),
);

export const statusCommand = Command.make("status").pipe(
  Command.withHandler(
    Effect.fnUntraced(function* () {
      const client = yield* InfraClient;
      const result = yield* client.status();
      yield* Console.log(result.message);
    }),
  ),
  Command.withDescription("System status"),
);

export const backupsCommand = Command.make("backups").pipe(
  Command.withHandler(
    Effect.fnUntraced(function* () {
      const client = yield* InfraClient;
      const result = yield* client.backups();

      yield* Console.log("Postgres backup:");
      yield* Console.log(`  last run:    ${result.postgres.lastRun ?? "(never)"}`);
      yield* Console.log(`  last result: ${result.postgres.lastResult}`);
      yield* Console.log(`  last file:   ${result.postgres.lastFile ?? "(none)"}`);
      if (result.postgres.lastError) {
        yield* Console.log(`  last error:  ${result.postgres.lastError}`);
      }

      yield* Console.log("");
      yield* Console.log("Vault backup:");
      yield* Console.log(`  last run:    ${result.vault.lastRun ?? "(never)"}`);
      yield* Console.log(`  last result: ${result.vault.lastResult}`);
      yield* Console.log(`  last file:   ${result.vault.lastFile ?? "(none)"}`);
      if (result.vault.lastError) {
        yield* Console.log(`  last error:  ${result.vault.lastError}`);
      }
    }),
  ),
  Command.withDescription("Backup status"),
);

// ---------------------------------------------------------------------------
// Logs (direct SSH, works from anywhere)
// ---------------------------------------------------------------------------

export const logsCommand = Command.make("logs", {
  name: Args.text({ name: "name" }).pipe(Args.withDescription("Project name")),
  stage: Args.text({ name: "stage" }).pipe(
    Args.withDefault(""),
    Args.withDescription("Stage name (default: first/only stage)"),
  ),
  lines: Options.integer("lines").pipe(
    Options.withAlias("n"),
    Options.withDefault(50),
    Options.withDescription("Number of lines to show"),
  ),
  follow: Options.boolean("follow").pipe(
    Options.withAlias("f"),
    Options.withDefault(false),
    Options.withDescription("Follow log output"),
  ),
}).pipe(
  Command.withHandler(
    Effect.fnUntraced(function* ({ name, stage: stageArg, lines, follow }) {
      const meta = yield* DeployMeta;
      const ssh = yield* SshClient;

      const project = yield* meta.getProject(name);
      if (!project || Object.keys(project.stages).length === 0) {
        yield* Console.error(`No stages found for: ${name}`);
        return;
      }

      // Resolve stage name
      const stageName = stageArg !== "" ? stageArg : Object.keys(project.stages)[0]!;
      const info = project.stages[stageName];
      if (!info) {
        yield* Console.error(
          `Stage "${stageName}" not found. Available: ${Object.keys(project.stages).join(", ")}`,
        );
        return;
      }

      const unitName = deploymentNames(name, stageName).serviceUnit;
      const followFlag = follow ? " -f" : "";
      const cmd = `XDG_RUNTIME_DIR=/run/user/$(id -u) journalctl --user -u ${unitName} --no-pager -n ${lines}${followFlag}`;

      if (info.type === "static") {
        yield* Console.log(`${name}/${stageName} is a static site — no service logs.`);
        yield* Console.log(
          `Files at: ${info.host}:${deploymentPaths(info.domain, stageName, DEPLOYMENT_ROOTS).staticFiles}`,
        );
        return;
      }

      const output = yield* ssh.exec(info.host, cmd, SVC_USER);
      yield* Console.log(output.trim());
    }),
  ),
  Command.withDescription("View service logs for a deployed stage"),
);

// ---------------------------------------------------------------------------
// Direct mode (bypasses HTTP server, runs locally via SSH)
// ---------------------------------------------------------------------------

const directDeploy = Command.make("deploy", {
  name: Args.text({ name: "name" }).pipe(Args.withDescription("Project name")),
  ref: Args.text({ name: "ref" }).pipe(
    Args.withDefault(""),
    Args.withDescription("Git ref (branch/tag/sha)"),
  ),
  as: Options.text("as").pipe(Options.optional, Options.withDescription("Stage name override")),
  repo: Options.text("repo").pipe(
    Options.optional,
    Options.withDescription("Git repo URL override"),
  ),
}).pipe(
  Command.withHandler(
    Effect.fnUntraced(function* ({ name, ref, as: asStage, repo }) {
      const runner = yield* DeployRunner;
      const result = yield* runner.deploy({
        name,
        ref: ref === "" ? undefined : ref,
        stage: Option.getOrUndefined(asStage),
        repo: Option.getOrUndefined(repo),
      });
      yield* Console.log(`Deployed ${result.name}@${result.hash} -> ${result.stage}`);
      yield* Console.log(`  Preview: ${result.previewUrl}`);
    }),
  ),
  Command.withDescription("Deploy directly (no HTTP server)"),
);

const directPromote = Command.make("promote", {
  name: Args.text({ name: "name" }).pipe(Args.withDescription("Project name")),
  stage: Args.text({ name: "stage" }).pipe(Args.withDescription("Stage to promote")),
  force: Options.boolean("force").pipe(
    Options.withDefault(false),
    Options.withDescription("Skip health checks"),
  ),
}).pipe(
  Command.withHandler(
    Effect.fnUntraced(function* ({ name, stage, force }) {
      const runner = yield* DeployRunner;
      yield* runner.promote({ name, stage, force });
      yield* Console.log(`Promoted ${name}/${stage}`);
    }),
  ),
  Command.withDescription("Promote directly (no HTTP server)"),
);

const directRollback = Command.make("rollback", {
  name: Args.text({ name: "name" }).pipe(Args.withDescription("Project name")),
}).pipe(
  Command.withHandler(
    Effect.fnUntraced(function* ({ name }) {
      const runner = yield* DeployRunner;
      yield* runner.rollback({ name });
      yield* Console.log(`Rolled back ${name}`);
    }),
  ),
  Command.withDescription("Rollback directly (no HTTP server)"),
);

const directTeardown = Command.make("teardown", {
  name: Args.text({ name: "name" }).pipe(Args.withDescription("Project name")),
  stage: Args.text({ name: "stage" }).pipe(Args.withDescription("Stage to tear down")),
}).pipe(
  Command.withHandler(
    Effect.fnUntraced(function* ({ name, stage }) {
      const runner = yield* DeployRunner;
      yield* runner.teardown({ name, stage });
      yield* Console.log(`Torn down ${name}/${stage}`);
    }),
  ),
  Command.withDescription("Teardown directly (no HTTP server)"),
);

const directProjects = Command.make("projects").pipe(
  Command.withHandler(
    Effect.fnUntraced(function* () {
      const runner = yield* DeployRunner;
      const projects = yield* runner.listProjects();
      if (projects.length === 0) {
        yield* Console.log("No projects deployed");
        return;
      }
      yield* Console.log("Deployed projects:\n");
      yield* Effect.forEach(projects, (p) => {
        const promoted = p.promoted ? ` -> ${p.promoted}` : "";
        return Console.log(
          `  ${p.name}  (${p.stageCount} stage${p.stageCount !== 1 ? "s" : ""})${promoted}`,
        );
      });
    }),
  ),
  Command.withDescription("List projects directly (no HTTP server)"),
);

const directStages = Command.make("stages", {
  name: Args.text({ name: "name" }).pipe(Args.withDescription("Project name")),
}).pipe(
  Command.withHandler(
    Effect.fnUntraced(function* ({ name }) {
      const runner = yield* DeployRunner;
      const result = yield* runner.getStages(name);
      if (!result) {
        yield* Console.log(`No stages for ${name}`);
        return;
      }
      yield* Console.log(`Stages for ${result.name}:\n`);
      yield* Effect.forEach(result.stages, (s) => {
        const promoted = s.promoted ? " [production]" : "";
        return Console.log(
          `  ${s.stage}${promoted}  ${s.type}  ${s.ref}@${s.hash}\n` + `    ${s.previewUrl}`,
        );
      });
      if (result.production) {
        yield* Console.log(`\nProduction domain: ${result.production}`);
      }
    }),
  ),
  Command.withDescription("List stages directly (no HTTP server)"),
);

export const directCommand = Command.make("direct").pipe(
  Command.withHandler(() => Effect.void),
  Command.withSubcommands([
    directDeploy,
    directPromote,
    directRollback,
    directTeardown,
    directProjects,
    directStages,
  ]),
  Command.withDescription("Run commands directly via SSH (bypasses HTTP server)"),
);
