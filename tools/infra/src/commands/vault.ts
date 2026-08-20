import { Command, Args } from "@effect/cli";
import { Console, Effect, Schema as S } from "effect";
import * as FileSystem from "@effect/platform/FileSystem";
import * as Path from "@effect/platform/Path";
import { OpenBaoClient } from "../services/OpenBaoClient.ts";
import { SecretResolver } from "../services/SecretResolver.ts";
import { PasswordGenerator } from "../services/PasswordGenerator.ts";
import { parseEnvExample } from "../lib/env-parser.ts";
import {
  INFRA_AGENT_API_TOKEN_KEY,
  INFRA_AGENT_SECRET_PATH,
  INFRA_AGENT_WEBHOOK_SECRET_KEY,
  API_TOKEN,
  HOME_DIR,
  PROJECTS_DIR,
  REPO_ROOT,
  WEBHOOK_SECRET,
} from "../lib/config.ts";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

class EnvExampleNotFoundError extends S.TaggedError<EnvExampleNotFoundError>()(
  "EnvExampleNotFoundError",
  { name: S.String },
) {
  override get message() {
    return `No .env.example found for: ${this.name}`;
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONFIG_DIR = ".config/infra";
const INIT_FILE = "vault-init.json";

const configPath = Effect.gen(function* () {
  const path = yield* Path.Path;
  return path.join(HOME_DIR, CONFIG_DIR, INIT_FILE);
});

const BACKUPS_POLICY = `
path "secret/data/*" { capabilities = ["read"] }
path "sys/storage/raft/snapshot" { capabilities = ["read"] }
`.trim();

const VaultInitFile = S.Struct({
  unseal_key: S.String,
  root_token: S.String,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const findEnvExampleContent = Effect.fnUntraced(function* (name: string) {
  const fs = yield* FileSystem.FileSystem;
  const pathSvc = yield* Path.Path;

  const candidates = [
    pathSvc.join(PROJECTS_DIR, name, ".env.example"),
    pathSvc.join(REPO_ROOT, "services", name, ".env.example"),
  ];

  const found = yield* Effect.reduce(candidates, null as string | null, (acc, candidate) =>
    acc !== null
      ? Effect.succeed(acc)
      : fs
          .exists(candidate)
          .pipe(
            Effect.flatMap((exists) =>
              exists ? fs.readFileString(candidate) : Effect.succeed(null),
            ),
          ),
  );

  if (found === null) {
    return yield* new EnvExampleNotFoundError({ name });
  }
  return found;
});

/** Scan a directory for subdirectories that contain .env.example */
const scanForEnvExamples = Effect.fnUntraced(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const pathSvc = yield* Path.Path;

  const exists = yield* fs.exists(dir);
  if (!exists) return [] as ReadonlyArray<string>;

  const entries = yield* fs.readDirectory(dir);
  return yield* Effect.filter(entries, (entry) =>
    fs.exists(pathSvc.join(dir, entry, ".env.example")),
  );
});

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

const vaultInit = Command.make("init").pipe(
  Command.withHandler(
    Effect.fnUntraced(function* () {
      const bao = yield* OpenBaoClient;
      const fs = yield* FileSystem.FileSystem;
      const initPath = yield* configPath;

      yield* Console.log("Initializing OpenBao...");
      const result = yield* bao.init();

      yield* Console.log("Unsealing...");
      yield* bao.unseal(result.unsealKeys[0]!);

      const dir = initPath.replace(/\/[^/]+$/, "");
      yield* fs.makeDirectory(dir, { recursive: true });
      yield* fs.writeFileString(
        initPath,
        yield* S.encodeUnknown(S.parseJson(VaultInitFile, { space: 2 }))({
          unseal_key: result.unsealKeys[0]!,
          root_token: result.rootToken,
        }),
        { mode: 0o600 },
      );

      yield* Console.log("Enabling KV-v2 secrets engine...");
      yield* bao.enableSecretsEngine("secret", "kv-v2");

      yield* Console.log("Enabling KV-v2 meta engine...");
      yield* bao.enableSecretsEngine("meta", "kv-v2");

      yield* Console.log("Creating backups policy...");
      yield* bao.createPolicy("backups", BACKUPS_POLICY);

      yield* Console.log("");
      yield* Console.log(`Vault initialized. Credentials saved to: ${initPath}`);
      yield* Console.log("IMPORTANT: Back up this file securely.");
    }),
  ),
  Command.withDescription("Initialize OpenBao, unseal, and enable secrets engine"),
);

const rotateNameArg = Args.text({ name: "name" }).pipe(
  Args.withDescription("Project or service name to rotate secrets for"),
);

const vaultRotate = Command.make("rotate", { name: rotateNameArg }).pipe(
  Command.withHandler(
    Effect.fnUntraced(function* ({ name }) {
      const bao = yield* OpenBaoClient;
      const resolver = yield* SecretResolver;

      const content = yield* findEnvExampleContent(name);
      const fields = parseEnvExample(content);

      if (fields.length === 0) {
        yield* Console.log(`No fields found in .env.example for: ${name}`);
        return;
      }

      yield* Console.log(`Fetching current values for ${name}...`);
      const current = yield* bao.kvGet(name);

      const resolved = yield* resolver.resolve(fields, current);
      yield* bao.kvPut(name, resolved);

      const rotated = fields
        .filter((f) => f.kind === "generated" || f.kind === "composed")
        .map((f) => f.key);

      yield* Console.log(`Rotated fields in ${name}:`);
      yield* Effect.forEach(rotated, (key) => Console.log(`  - ${key}`));
    }),
  ),
  Command.withDescription("Rotate generated secrets for a project or service"),
);

const vaultStatus = Command.make("status").pipe(
  Command.withHandler(
    Effect.fnUntraced(function* () {
      const bao = yield* OpenBaoClient;
      const pathSvc = yield* Path.Path;

      yield* Console.log("Checking vault status...");
      const status = yield* bao.sealStatus();
      yield* Console.log(`  initialized: ${String(status.initialized)}`);
      yield* Console.log(`  sealed:      ${String(status.sealed)}`);

      if (status.sealed || !status.initialized) return;

      const projectNames = yield* scanForEnvExamples(PROJECTS_DIR);
      const serviceNames = yield* scanForEnvExamples(pathSvc.join(REPO_ROOT, "services"));
      const names = [...projectNames, ...serviceNames];

      yield* Console.log("");
      yield* Console.log("Secret paths:");
      yield* Effect.forEach(names, (name) =>
        bao.kvGet(name).pipe(
          Effect.map(() => true),
          Effect.orElseSucceed(() => false),
          Effect.flatMap((exists) => Console.log(`  ${exists ? "[ok]" : "[empty]"} ${name}`)),
        ),
      );
    }),
  ),
  Command.withDescription("Show vault seal status and secret paths"),
);

const vaultSeedAgentSecrets = Command.make("seed-agent-secrets").pipe(
  Command.withHandler(
    Effect.fnUntraced(function* () {
      const bao = yield* OpenBaoClient;
      const gen = yield* PasswordGenerator;

      const existing = yield* bao
        .kvGet(INFRA_AGENT_SECRET_PATH)
        .pipe(Effect.orElseSucceed(() => ({}) as Record<string, string>));

      const apiToken = API_TOKEN ?? existing[INFRA_AGENT_API_TOKEN_KEY] ?? (yield* gen.generate());
      const webhookSecret =
        WEBHOOK_SECRET ?? existing[INFRA_AGENT_WEBHOOK_SECRET_KEY] ?? (yield* gen.generate());

      yield* bao.kvPut(INFRA_AGENT_SECRET_PATH, {
        ...existing,
        [INFRA_AGENT_API_TOKEN_KEY]: apiToken,
        [INFRA_AGENT_WEBHOOK_SECRET_KEY]: webhookSecret,
      });
      yield* Console.log(`Seeded infra-agent secrets to OpenBao path: ${INFRA_AGENT_SECRET_PATH}`);
    }),
  ),
  Command.withDescription("Seed infra-agent API/webhook secrets into OpenBao"),
);

// ---------------------------------------------------------------------------
// Group command
// ---------------------------------------------------------------------------

export const vaultCommand = Command.make("vault").pipe(
  Command.withHandler(() => Effect.void),
  Command.withSubcommands([vaultInit, vaultRotate, vaultStatus, vaultSeedAgentSecrets]),
  Command.withDescription("Manage OpenBao vault (init, rotate, status)"),
);
