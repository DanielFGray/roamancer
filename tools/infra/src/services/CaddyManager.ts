import { Effect, Schema as S } from "effect";
import { BunContext } from "@effect/platform-bun";
import * as FileSystem from "@effect/platform/FileSystem";
import * as Path from "@effect/platform/Path";
import { spawn } from "bun";
import { DeployMeta, type DeployMetaErr } from "./DeployMeta.ts";
import { CADDY_SITES_DIR, DEPLOYMENT_ROOTS } from "../lib/config.ts";
import { deploymentNames, deploymentPaths, previewHost } from "../lib/deployment.ts";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class CaddyError extends S.TaggedError<CaddyError>()("CaddyError", { message: S.String }) {}

export type CaddyErr = CaddyError | DeployMetaErr;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MANAGED_SNIPPET_PREFIX = "infra--";

const isManagedSnippet = (filename: string) =>
  filename.startsWith(MANAGED_SNIPPET_PREFIX) && filename.endsWith(".caddyfile");

// ---------------------------------------------------------------------------
// Snippet generators
// ---------------------------------------------------------------------------

const staticSnippet = (host: string, root: string) =>
  `${host} {
\troot * ${root}
\ttry_files {path} /index.html
\tfile_server
}
`;

const proxySnippet = (host: string, port: number) =>
  `${host} {
\treverse_proxy localhost:${port}
}
`;

// ---------------------------------------------------------------------------
// Caddy reload
// ---------------------------------------------------------------------------

const reloadCaddy = Effect.fnUntraced(function* () {
  const proc = spawn({
    cmd: ["caddy", "reload", "--config", "/etc/caddy/Caddyfile"],
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = yield* Effect.promise(() => proc.exited);
  if (exitCode !== 0) {
    const stderr = yield* Effect.promise(() => proc.stderr.text());
    return yield* new CaddyError({
      message: `caddy reload failed (exit ${exitCode}): ${stderr.trim()}`,
    });
  }
});

// ---------------------------------------------------------------------------
// Service
//
// Reads deployment metadata, writes Caddyfile snippets to sites-enabled/,
// removes orphans, and reloads Caddy. Routes survive restarts.
// ---------------------------------------------------------------------------

export class CaddyManager extends Effect.Service<CaddyManager>()("infra/CaddyManager", {
  effect: Effect.gen(function* () {
    const meta = yield* DeployMeta;
    const fs = yield* FileSystem.FileSystem;
    const pathSvc = yield* Path.Path;

    const writeTo = (filename: string, content: string) =>
      fs
        .writeFileString(pathSvc.join(CADDY_SITES_DIR, filename), content)
        .pipe(
          Effect.mapError(
            (err) => new CaddyError({ message: `Failed to write ${filename}: ${err}` }),
          ),
        );

    const removeFile = (filename: string) =>
      fs
        .remove(pathSvc.join(CADDY_SITES_DIR, filename))
        .pipe(
          Effect.mapError(
            (err) => new CaddyError({ message: `Failed to remove ${filename}: ${err}` }),
          ),
        );

    const listFiles = () =>
      fs.readDirectory(CADDY_SITES_DIR).pipe(
        Effect.map((entries) => entries.filter((f) => f.endsWith(".caddyfile"))),
        Effect.mapError(
          (err) => new CaddyError({ message: `Failed to list ${CADDY_SITES_DIR}: ${err}` }),
        ),
      );

    const readFile = (filename: string) =>
      fs
        .readFileString(pathSvc.join(CADDY_SITES_DIR, filename))
        .pipe(
          Effect.mapError(
            (err) => new CaddyError({ message: `Failed to read ${filename}: ${err}` }),
          ),
        );

    return {
      /** List current snippet files and their contents */
      listRoutes: Effect.fnUntraced(function* () {
        const files = yield* listFiles();
        return yield* Effect.forEach(files, (file) =>
          readFile(file).pipe(Effect.map((content) => ({ file, content }))),
        );
      }),

      /** Reconcile snippet files from deploy state and reload Caddy */
      sync: Effect.fnUntraced(function* () {
        const projects = yield* meta.listProjects();
        const expectedFiles = new Set<string>();

        yield* Effect.forEach(
          projects,
          Effect.fnUntraced(function* (name) {
            const project = yield* meta.getProject(name);
            if (!project || Object.keys(project.stages).length === 0) return;

            // Stage preview routes
            for (const [stage, info] of Object.entries(project.stages)) {
              const host = previewHost(info.hash, info.domain);
              const filename = deploymentNames(name, stage).stageSnippet;
              expectedFiles.add(filename);

              const content =
                info.type === "static"
                  ? staticSnippet(
                      host,
                      deploymentPaths(info.domain, stage, DEPLOYMENT_ROOTS).staticFiles,
                    )
                  : info.port != null
                    ? proxySnippet(host, info.port)
                    : null;

              if (content) yield* writeTo(filename, content);
            }

            // Production route (if promoted)
            if (project.promoted) {
              const promoted = project.stages[project.promoted];
              if (promoted) {
                const filename = deploymentNames(name, project.promoted).productionSnippet;
                expectedFiles.add(filename);

                const content =
                  promoted.type === "static"
                    ? staticSnippet(
                        promoted.domain,
                        deploymentPaths(promoted.domain, project.promoted, DEPLOYMENT_ROOTS)
                          .staticFiles,
                      )
                    : promoted.port != null
                      ? proxySnippet(promoted.domain, promoted.port)
                      : null;

                if (content) yield* writeTo(filename, content);
              }
            }
          }),
        );

        // Other tools may own snippets in this directory. Reconcile only ours.
        const existing = yield* listFiles();
        for (const file of existing) {
          if (isManagedSnippet(file) && !expectedFiles.has(file)) {
            yield* removeFile(file);
          }
        }

        // Reload Caddy to pick up changes
        yield* reloadCaddy();

        const orphansRemoved = existing.filter(
          (file) => isManagedSnippet(file) && !expectedFiles.has(file),
        ).length;
        yield* Effect.log(
          `Caddy sync: ${expectedFiles.size} snippet(s) written, ${orphansRemoved} orphan(s) removed`,
        );
      }),
    };
  }),
  dependencies: [DeployMeta.Default, BunContext.layer],
}) {}
