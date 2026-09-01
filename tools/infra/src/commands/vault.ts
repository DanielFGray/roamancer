import { Command, Args } from "@effect/cli";
import { Console, Effect, Schema as S } from "effect";
import * as FileSystem from "@effect/platform/FileSystem";
import * as Path from "@effect/platform/Path";
import * as ProcessCommand from "@effect/platform/Command";
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
  OPENBAO_ADDR,
  PROJECTS_DIR,
  SERVICES_DIR,
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

class VaultInitAlreadyExistsError extends S.TaggedError<VaultInitAlreadyExistsError>()(
  "VaultInitAlreadyExistsError",
  { path: S.String },
) {
  override get message() {
    return `${this.path} already exists. Move it aside first if a genuine re-init is what you want -- overwriting it here would strand whatever cluster it belongs to.`;
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONFIG_DIR = ".config/infra";

// Keyed by the OpenBao instance's own hostname, mirroring roles/vault's
// per-cluster recovery file (keyed by inventory_hostname) -- bootstrapping a
// second cluster from this same machine can't clobber the first cluster's
// recovery material.
const CLUSTER_KEY = new URL(OPENBAO_ADDR).hostname;

const configPath = Effect.gen(function* () {
  const path = yield* Path.Path;
  return path.join(HOME_DIR, CONFIG_DIR, "vault-init", `${CLUSTER_KEY}.json`);
});

// The on-disk recovery file above is the only copy of material that
// unseals this OpenBao and can mint fresh agent tokens -- losing it (disk
// failure, a wiped laptop) permanently strands the cluster, since there's
// no cloud auto-unseal and no Shamir quorum here. Mirroring it into the
// operator's own `pass` store piggybacks on whatever durability that store
// already has (its own git remote, if any) instead of building new backup
// machinery for one file. Best-effort: `pass` may not be installed or
// configured, and that's never a reason to fail a bootstrap that already
// wrote the primary copy.
const mirrorRecoveryToPass = (content: string) =>
  ProcessCommand.make("pass", "insert", "-m", "-f", `infra/openbao/${CLUSTER_KEY}`).pipe(
    ProcessCommand.feed(content),
    ProcessCommand.exitCode,
    Effect.flatMap((code) =>
      code === 0
        ? Console.log(`Mirrored recovery material into pass: infra/openbao/${CLUSTER_KEY}`)
        : Console.log(
            `Warning: \`pass insert\` exited ${code} -- recovery material was not mirrored. The control-machine copy is now the only one; back it up manually.`,
          ),
    ),
    Effect.catchAll(() =>
      Console.log(
        "Warning: `pass` is not available -- recovery material was not mirrored. The control-machine copy is now the only one; back it up manually.",
      ),
    ),
  );

const SECRETS_POLICY = `
path "secret/data/*" { capabilities = ["create", "read", "update"] }
`.trim();

const BACKUPS_POLICY = `
path "secret/data/infra" { capabilities = ["read"] }
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
    pathSvc.join(SERVICES_DIR, name, ".env.example"),
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

      // OpenBao's own /v1/sys/init would refuse a second init anyway, but
      // check here first so a stale or reused recovery file gets caught
      // before we mint (and then discard) a second root token nobody keeps.
      if (yield* fs.exists(initPath)) {
        return yield* new VaultInitAlreadyExistsError({ path: initPath });
      }

      yield* Console.log("Initializing OpenBao...");
      const result = yield* bao.init();

      // Persisted before any mutating call below: a crash here leaves an
      // initialized-but-unconfigured OpenBao, recoverable from this file.
      // Persisting after would risk an initialized OpenBao with no way to
      // unseal it.
      const recoveryJson = yield* S.encodeUnknown(S.parseJson(VaultInitFile, { space: 2 }))({
        unseal_key: result.unsealKeys[0]!,
        root_token: result.rootToken,
      });

      const dir = initPath.replace(/\/[^/]+$/, "");
      yield* fs.makeDirectory(dir, { recursive: true });
      yield* fs.writeFileString(initPath, recoveryJson, { mode: 0o600 });
      yield* mirrorRecoveryToPass(recoveryJson);

      yield* Console.log("Unsealing...");
      yield* bao.unseal(result.unsealKeys[0]!);

      yield* Console.log("Enabling KV-v2 secrets engine...");
      yield* bao.enableSecretsEngine("secret", "kv-v2");

      yield* Console.log("Enabling KV-v2 meta engine...");
      yield* bao.enableSecretsEngine("meta", "kv-v2");

      yield* Console.log("Creating infra-agent policies...");
      yield* bao.createPolicy("infra-agent-secrets", SECRETS_POLICY);
      yield* bao.createPolicy("infra-agent-backups", BACKUPS_POLICY);

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

      yield* Console.log("Checking vault status...");
      const status = yield* bao.sealStatus();
      yield* Console.log(`  initialized: ${String(status.initialized)}`);
      yield* Console.log(`  sealed:      ${String(status.sealed)}`);

      if (status.sealed || !status.initialized) return;

      const projectNames = yield* scanForEnvExamples(PROJECTS_DIR);
      const serviceNames = yield* scanForEnvExamples(SERVICES_DIR);
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
