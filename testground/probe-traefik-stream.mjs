// Run with Bun and a Traefik executable path. Uses localhost and a dummy token.
// Exit 1 means a stream-failure case caused repeated service queries.
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const binary = process.argv[2];
if (!binary) {
  console.error("Usage: bun testground/probe-traefik-stream.mjs /absolute/path/to/traefik");
  process.exit(2);
}

const encoder = new TextEncoder();
const results = [];
let activeChild;
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  process.on(signal, () => {
    activeChild?.kill("SIGKILL");
    process.exit(code);
  });
}

for (const mode of ["healthy", "http403", "empty200", "eof", "reset"]) {
  const dir = mkdtempSync(join(tmpdir(), "traefik-stream-case-"));
  let services = 0, streams = 0, cutoff = false;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/v1/services") {
        services++;
        if (services >= 500 && !cutoff) {
          cutoff = true;
          activeChild?.kill();
        }
        return Response.json([]);
      }
      if (path !== "/v1/event/stream") return new Response("not found", { status: 404 });
      streams++;
      if (mode === "http403") return new Response("Permission denied", { status: 403 });
      if (mode === "empty200") return new Response("", { status: 200 });
      if (mode === "eof") return new Response("{}\n", { headers: { "Content-Type": "application/json" } });
      let timer;
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode("{}\n"));
          timer = mode === "reset"
            ? setTimeout(() => controller.error(new Error("simulated stream failure")), 300)
            : setInterval(() => controller.enqueue(encoder.encode("{}\n")), 300);
        },
        cancel() { clearTimeout(timer); clearInterval(timer); },
      });
      return new Response(body, { headers: { "Content-Type": "application/json" } });
    },
    error() { return new Response("simulated stream failure", { status: 500 }); },
  });
  const log = join(dir, "traefik.log");
  const fd = openSync(log, "w");
  activeChild = Bun.spawn([binary,
    "--global.checknewversion=false", "--global.sendanonymoususage=false", "--log.level=ERROR",
    "--entrypoints.web.address=127.0.0.1:0", "--providers.nomad=true",
    `--providers.nomad.endpoint.address=http://127.0.0.1:${server.port}`,
    "--providers.nomad.watch=true", "--providers.nomad.exposedbydefault=false",
  ], {
    cwd: dir,
    env: { HOME: dir, PATH: process.env.PATH, NOMAD_TOKEN: "local-dummy-token" },
    stdout: fd, stderr: fd,
  });
  const child = activeChild;
  const start = performance.now();
  const timeout = setTimeout(() => child.kill(), 3000);
  const forceStop = setTimeout(() => child.kill("SIGKILL"), 6000);
  await child.exited;
  clearTimeout(timeout);
  clearTimeout(forceStop);
  closeSync(fd);
  await server.stop(true);
  activeChild = undefined;
  results.push({ mode, services, streams, elapsedMs: Math.round(performance.now() - start),
    requestCutoff: cutoff, log: readFileSync(log, "utf8").slice(0, 1800) });
  rmSync(dir, { recursive: true, force: true });
}
console.log(JSON.stringify(results, null, 2));
const controlsValid = results[0].services === 1 && results[1].services === 0 && results[1].streams > 0;
if (!controlsValid) {
  console.error("INCONCLUSIVE: healthy-stream or HTTP-denial control failed");
  process.exitCode = 2;
} else if (results.slice(2).some((result) => result.services > 10)) {
  console.error("FAIL: stream failure caused repeated service queries");
  process.exitCode = 1;
} else {
  console.error("PASS: bounded service queries after stream failures");
}
