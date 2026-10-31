/**
 * The workstation's way to the dev databases: an SSH local forward from 127.0.0.1:5417 to the
 * platform Postgres host port on the server, kept by a systemd user unit that restarts it after
 * a network drop. The forward rides the operator's own SSH login, so the server needs no new
 * listener and Postgres sees the connections as the server's own.
 */
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Exec from "../Exec.ts";
import { Site } from "../Site.ts";
import { tunnelHost, tunnelPort } from "./Declaration.ts";

export const unitName = "ops-dev-db-tunnel.service";

/** Writes the unit when its text changed and makes sure it runs, restarted on a change. */
export const ensureTunnel = Effect.fn("devdb.ensureTunnel")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const site = yield* Site;
  const home = yield* Config.String("HOME");
  const dir = path.join(home, ".config/systemd/user");
  const file = path.join(dir, unitName);
  const text = unitText({ host: yield* site.host, lanAddress: yield* site.lanAddress });
  const previous = (yield* fs.exists(file)) ? yield* fs.readFileString(file) : "";
  if (previous !== text) {
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* fs.writeFileString(file, text);
    yield* Exec.run("systemctl", ["--user", "daemon-reload"]);
    yield* Exec.run("systemctl", ["--user", "enable", unitName]);
    yield* Exec.run("systemctl", ["--user", "restart", unitName]);
  } else {
    yield* Exec.run("systemctl", ["--user", "start", unitName]);
  }
});

/**
 * BatchMode makes a missing key fail instead of waiting for a prompt nobody sees, and
 * ExitOnForwardFailure makes a taken local port fail the unit instead of leaving ssh up
 * with no forward.
 */
export const unitText = (input: { readonly host: string; readonly lanAddress: string }) =>
  `[Unit]
Description=SSH tunnel to the ops dev databases on ${input.host}
After=network-online.target

[Service]
ExecStart=ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -L ${tunnelHost}:${tunnelPort}:${input.lanAddress}:5432 ${input.host}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
