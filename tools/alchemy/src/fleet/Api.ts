/**
 * The fleet service's HTTP API: the snapshot that `ops dash` prints and the fleet page
 * polls. One process on the control host serves it (Server.ts), outside the job queue, so
 * the view keeps updating while a deploy runs.
 */
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { Snapshot } from "./Snapshot.ts";

/** The loopback port the fleet service listens on. nixos/modules/alchemy-runner.nix publishes it on the tailnet. */
export const port = 8780;

export class FleetApi extends HttpApi.make("fleet").add(
  HttpApiGroup.make("fleet").add(
    HttpApiEndpoint.get("snapshot", "/api/snapshot", { success: Snapshot }),
  ),
) {}
