/**
 * A throwaway postgres:17-alpine container for an integration test, listening on
 * 127.0.0.1:`port` with the superuser `postgres` and `password`. Each test file gives its own
 * name and port, so files that run at once do not share a server.
 */
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { waitReady } from "./waitReady.ts";

export const postgresContainer = (name: string, port: number, password: string) => ({
  /** Replace any container left by an earlier run, then wait until Postgres answers. */
  start: async () => {
    spawnSync("docker", ["rm", "-f", name], { encoding: "utf8" });
    const started = spawnSync(
      "docker",
      [
        "run",
        "-d",
        "--name",
        name,
        "-e",
        `POSTGRES_PASSWORD=${password}`,
        "-p",
        `127.0.0.1:${port}:5432`,
        "postgres:17-alpine",
      ],
      { encoding: "utf8" },
    );
    assert.equal(started.status, 0, started.stderr);
    await waitReady(
      `postgres container ${name}`,
      () =>
        spawnSync("docker", ["exec", name, "pg_isready", "-U", "postgres", "-h", "127.0.0.1"], {
          encoding: "utf8",
        }).status === 0,
    );
  },
  remove: () => {
    spawnSync("docker", ["rm", "-f", name], { encoding: "utf8" });
  },
});
