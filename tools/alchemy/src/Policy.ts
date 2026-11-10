/**
 * The site policy: which apps the runner watches, and whether a push to `main` releases them.
 * It is `policy.toml` in the site folder, beside site.toml. Nix reads it when it builds the
 * control host and writes it to a file the runner reads (nixos/modules/alchemy-runner.nix),
 * so changing it needs `ops rebuild`. An app repository never holds it: a push could change it.
 * Each watched app has a bare repository on the control host, named after the app
 * (queue/Paths.ts `repositoryOf`), which the operator pushes to.
 */
import { Config, Effect, FileSystem, Schema as S } from "effect";

/** An app name, which is its cartridge's name. It becomes a file name, so it holds no path. */
const appName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const Deploy = S.Literals(["auto", "manual"]);
export type Deploy = typeof Deploy.Type;

export const AppPolicy = S.Struct({
  deploy: S.optionalKey(Deploy),
});
export type AppPolicy = typeof AppPolicy.Type;

export const Policy = S.Struct({
  apps: S.optionalKey(S.Record(S.String, AppPolicy)),
}).check(
  // A record's key schema does not check the keys it decodes, so the names are checked here.
  S.makeFilter((policy) => {
    const bad = Object.keys(policy.apps ?? {}).filter((name) => !appName.test(name));
    return bad.length === 0
      ? undefined
      : `app names must be lowercase letters, digits and single hyphens: ${bad.join(", ")}`;
  }),
);
export type Policy = typeof Policy.Type;

/** The policy a JSON document holds; Nix writes that document from policy.toml. */
export const decode = S.decodeUnknownEffect(S.fromJsonString(Policy));

/** The apps in the policy, by name, each with its `deploy` default filled in. */
export const apps = (
  policy: Policy,
): ReadonlyArray<{ readonly app: string; readonly deploy: Deploy }> =>
  Object.entries(policy.apps ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([app, entry]) => ({ app, deploy: entry.deploy ?? "auto" }));

/** The apps the timer reconciles: those whose pushes release unattended. */
export const autoApps = (policy: Policy) => apps(policy).filter((entry) => entry.deploy === "auto");

/** Where nixos/modules/alchemy-runner.nix writes the policy on the control host. */
export const policyFile = "/etc/alchemy/policy.json";

/** Read the policy file; `ALCHEMY_POLICY` names another, as tests do. */
export const load = Effect.fn("Policy.load")(function* () {
  const file = yield* Config.String("ALCHEMY_POLICY").pipe(Config.withDefault(policyFile));
  const text = yield* (yield* FileSystem.FileSystem).readFileString(file);
  return yield* decode(text);
});
