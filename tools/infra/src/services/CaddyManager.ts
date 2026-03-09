import { Effect, Schema as S } from "effect"
import { DeployMeta, type DeployMetaErr } from "./DeployMeta.ts"
import { CADDY_ADMIN_URL } from "../lib/config.ts"

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class CaddyError extends S.TaggedError<CaddyError>()(
  "CaddyError",
  { message: S.String },
) {}

export type CaddyErr = CaddyError | DeployMetaErr

// ---------------------------------------------------------------------------
// Route ID convention
//
// Every route managed by infra gets an @id prefixed with "infra/".
// Non-managed routes (Forgejo, monitoring, etc.) are left untouched.
// ---------------------------------------------------------------------------

const ROUTE_ID_PREFIX = "infra/"

const stageRouteId = (project: string, stage: string) =>
  `${ROUTE_ID_PREFIX}${project}/${stage}`

const productionRouteId = (project: string) =>
  `${ROUTE_ID_PREFIX}${project}/_production`

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const stageHost = (hash: string, domain: string) =>
  `${hash}-preview.${domain}`

export const previewUrl = (hash: string, domain: string) =>
  `https://${stageHost(hash, domain)}`

/** Build a Caddy JSON route for a static/SPA site */
const staticRoute = (id: string, host: string, root: string) => ({
  "@id": id,
  match: [{ host: [host] }],
  handle: [
    {
      handler: "subroute",
      routes: [
        {
          handle: [
            {
              handler: "rewrite",
              uri: "{http.matchers.file.relative}",
            },
            {
              handler: "file_server",
              root,
            },
          ],
          match: [
            {
              file: {
                root,
                try_files: ["{http.request.uri.path}", "/index.html"],
              },
            },
          ],
        },
      ],
    },
  ],
})

/** Build a Caddy JSON route for a reverse proxy */
const proxyRoute = (id: string, host: string, port: number) => ({
  "@id": id,
  match: [{ host: [host] }],
  handle: [
    {
      handler: "reverse_proxy",
      upstreams: [{ dial: `localhost:${port}` }],
    },
  ],
})

// ---------------------------------------------------------------------------
// Caddy admin API helpers
// ---------------------------------------------------------------------------

const caddyFetch = (method: string, path: string, body?: unknown) =>
  Effect.tryPromise({
    try: () =>
      fetch(`${CADDY_ADMIN_URL}${path}`, {
        method,
        ...(body !== undefined
          ? {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            }
          : {}),
      }),
    catch: (err) =>
      new CaddyError({
        message: `Failed to reach Caddy admin API: ${err instanceof Error ? err.message : String(err)}`,
      }),
  })

/** GET JSON from Caddy. Returns null on 404. */
const caddyGet = <T>(path: string): Effect.Effect<T | null, CaddyError> =>
  caddyFetch("GET", path).pipe(
    Effect.flatMap((res) => {
      if (res.status === 404) return Effect.succeed(null as T | null)
      if (!res.ok) return caddyErrorFromResponse(res)
      return Effect.tryPromise({
        try: () => res.json() as Promise<T>,
        catch: () => new CaddyError({ message: "failed to parse Caddy response" }),
      })
    }),
  )

/** PUT JSON to Caddy. Creates intermediate paths if they don't exist. */
const caddyPut = (path: string, body: unknown): Effect.Effect<void, CaddyError> =>
  caddyFetch("PUT", path, body).pipe(
    Effect.flatMap((res) => {
      if (!res.ok) return caddyErrorFromResponse(res)
      return Effect.void
    }),
  )

/** PATCH JSON to Caddy. Replaces existing value at path. */
const caddyPatch = (path: string, body: unknown): Effect.Effect<void, CaddyError> =>
  caddyFetch("PATCH", path, body).pipe(
    Effect.flatMap((res) => {
      if (!res.ok) return caddyErrorFromResponse(res)
      return Effect.void
    }),
  )

const caddyErrorFromResponse = (res: Response): Effect.Effect<never, CaddyError> =>
  Effect.tryPromise({
    try: () => res.text(),
    catch: () => new CaddyError({ message: `Caddy API returned ${res.status}` }),
  }).pipe(
    Effect.flatMap((text) =>
      new CaddyError({ message: `Caddy API returned ${res.status}: ${text}` }),
    ),
  )

// ---------------------------------------------------------------------------
// Service
//
// Reads current Caddy routes, preserves non-managed ones, and merges in
// our managed routes. Uses /config/... API instead of /load to avoid
// wiping routes managed by other tools.
// ---------------------------------------------------------------------------

export class CaddyManager extends Effect.Service<CaddyManager>()(
  "infra/CaddyManager",
  {
    effect: Effect.gen(function* () {
      const meta = yield* DeployMeta

      return {
        sync: () =>
          Effect.gen(function* () {
            const projects = yield* meta.listProjects()

            // Build our managed routes
            const managedRoutes: Array<Record<string, unknown>> = []

            yield* Effect.forEach(projects, (name) =>
              Effect.gen(function* () {
                const project = yield* meta.getProject(name)
                if (!project || Object.keys(project.stages).length === 0) return

                // Stage preview routes
                for (const [stage, info] of Object.entries(project.stages)) {
                  const host = stageHost(info.hash, info.domain)
                  const id = stageRouteId(name, stage)
                  if (info.type === "static") {
                    managedRoutes.push(
                      staticRoute(id, host, `/srv/www/${info.domain}/stages/${stage}`),
                    )
                  } else if (info.port != null) {
                    managedRoutes.push(proxyRoute(id, host, info.port))
                  }
                }

                // Production route (if promoted)
                if (project.promoted) {
                  const promoted = project.stages[project.promoted]
                  if (promoted) {
                    const id = productionRouteId(name)
                    if (promoted.type === "static") {
                      managedRoutes.push(
                        staticRoute(
                          id,
                          promoted.domain,
                          `/srv/www/${promoted.domain}/stages/${project.promoted}`,
                        ),
                      )
                    } else if (promoted.port != null) {
                      managedRoutes.push(proxyRoute(id, promoted.domain, promoted.port))
                    }
                  }
                }
              }),
            )

            // Ensure the Caddy HTTP server structure exists.
            // When Caddy starts with a minimal Caddyfile (just admin + auto_https off),
            // neither apps nor apps/http exist — bootstrap the whole tree.
            const apps = yield* caddyGet<Record<string, unknown>>(
              "/config/apps",
            )
            if (!apps) {
              yield* caddyPut("/config/apps", {
                http: {
                  servers: {
                    srv0: { listen: [":80"], routes: [] },
                  },
                },
              })
            } else {
              const httpApp = yield* caddyGet<Record<string, unknown>>(
                "/config/apps/http",
              )
              if (!httpApp) {
                yield* caddyPut("/config/apps/http", {
                  servers: {
                    srv0: { listen: [":80"], routes: [] },
                  },
                })
              }
            }

            // Read current routes, preserve non-managed ones
            const current =
              (yield* caddyGet<Array<Record<string, unknown>>>(
                "/config/apps/http/servers/srv0/routes",
              )) ?? []

            const externalRoutes = current.filter(
              (r) =>
                typeof r["@id"] !== "string" ||
                !r["@id"].startsWith(ROUTE_ID_PREFIX),
            )

            // Write merged routes: external first, then ours
            // Always PATCH since we ensure the server structure exists above
            yield* caddyPatch("/config/apps/http/servers/srv0/routes", [
              ...externalRoutes,
              ...managedRoutes,
            ])

            yield* Effect.log(
              `Caddy sync: ${managedRoutes.length} managed route(s), ${externalRoutes.length} external route(s) preserved`,
            )
          }),
      }
    }),
    dependencies: [DeployMeta.Default],
  },
) {}
