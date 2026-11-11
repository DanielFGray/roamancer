/**
 * A `bao server -dev` on a free local port for an integration test: in memory, unsealed,
 * with the root token `token`. `layer()` is a fresh OpenBao service that uses it.
 */
import * as assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { ConfigProvider, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { OpenBao } from "../OpenBao.ts";
import { waitReady } from "./waitReady.ts";

export const devOpenBao = (token: string) => {
  let address = "";
  let child: ChildProcess | undefined;
  return {
    address: () => address,
    start: async () => {
      const port = await freePort();
      address = `http://127.0.0.1:${port}`;
      const server = spawn(
        "bao",
        ["server", "-dev", `-dev-root-token-id=${token}`, `-dev-listen-address=127.0.0.1:${port}`],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      child = server;
      const log: Array<string> = [];
      server.stdout.on("data", (chunk: Buffer) => log.push(chunk.toString()));
      server.stderr.on("data", (chunk: Buffer) => log.push(chunk.toString()));
      try {
        await waitReady("bao -dev", async () => {
          try {
            const response = await fetch(`${address}/v1/sys/health`);
            return response.ok || response.status === 429 || response.status === 472;
          } catch {
            return false; // not listening yet
          }
        });
      } catch (error) {
        server.kill("SIGTERM");
        assert.fail(`${String(error)}:\n${log.join("")}`);
      }
    },
    stop: () => {
      child?.kill("SIGTERM");
    },
    layer: () =>
      Layer.fresh(OpenBao.layer).pipe(
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnvRecord({ OPENBAO_ADDR: address, OPENBAO_TOKEN: token }),
          ),
        ),
      ),
  };
};

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("no port"));
        return;
      }
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
