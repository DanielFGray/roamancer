/**
 * Builds the fleet page into web/dist. The fleet service serves that directory
 * (FLEET_WEB_ROOT). Under `vite web` the dev server forwards the API to a fleet service
 * on this machine's loopback port.
 */
import solid from "@solidjs/vite-plugin";
import { defineConfig } from "vite";
import { port } from "../src/fleet/Api.ts";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [solid()],
  build: { outDir: "dist", emptyOutDir: true },
  server: { proxy: { "/api": `http://127.0.0.1:${port}` } },
});
