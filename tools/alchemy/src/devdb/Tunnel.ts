/**
 * The workstation's way to the dev databases: an SSH local forward from 127.0.0.1:5417, through
 * the control host, to the dev Postgres server's host port on its node (DevServer.ts), kept by a
 * systemd user unit that restarts it after a network drop. The forward rides the operator's own
 * SSH login, so no node needs a new listener for the workstation.
 */
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Exec from "../Exec.ts";
import { Site } from "../Site.ts";
import { tunnelHost, tunnelPort } from "./Declaration.ts";
import { devServer } from "./DevServer.ts";

export const unitName = "ops-dev-db-tunnel.service";

/** Writes the unit when its text changed and makes sure it runs, restarted on a change. */
export const ensureTunnel = Effect.fn("devdb.ensureTunnel")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const site = yield* Site;
  const home = yield* Config.String("HOME");
  const dir = path.join(home, ".config/systemd/user");
  const file = path.join(dir, unitName);
  const text = unitText({
    host: yield* site.host,
    address: yield* site.devDbAddress,
    port: (yield* devServer()).hostPort,
  });
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
export const unitText = (input: {
  readonly host: string;
  readonly address: string;
  readonly port: number;
}) =>
  `[Unit]
Description=SSH tunnel to the ops dev databases on ${input.host}
After=network-online.target

[Service]
ExecStart=ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -L ${tunnelHost}:${tunnelPort}:${input.address}:${input.port} ${input.host}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
