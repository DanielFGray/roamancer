/**
 * Where this program's own files are. On the control host the package is read-only in the
 * Nix store while a job's working directory, /var/lib/alchemy, holds Alchemy's `.alchemy`
 * state and the deployment record. So code and cartridges resolve here, never from the
 * working directory, and nothing is fetched at run time.
 */
import * as path from "node:path";

export const root = path.resolve(import.meta.dirname, "..");
/** Alchemy's CLI from this package's dependencies, run with the current Bun. */
export const alchemyCli = path.join(root, "node_modules/alchemy/bin/cli.js");
/** The entrypoint that plans and deploys stages. */
export const appEntry = path.join(root, "alchemy.run.ts");
/** The entrypoint that reads and destroys state without a cartridge. */
export const stateEntry = path.join(root, "state.run.ts");
/** The Alchemy stack that every stage belongs to; each stage deploys one cartridge. */
export const stack = "cartridge";
