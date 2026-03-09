import { Args, Command } from "@effect/cli"
import { Console, Effect } from "effect"
import { InfraClient } from "../services/InfraClient.ts"
import { INFRA_SERVER_URL } from "../lib/config.ts"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const pad = (label: string, width = 22) =>
  label + " " + ".".repeat(Math.max(1, width - label.length)) + " "

const probe = (
  url: string,
  timeoutMs = 10_000,
): Effect.Effect<{ status: number; ms: number; tlsOk: boolean }, Error> =>
  Effect.tryPromise({
    try: async () => {
      const start = performance.now()
      const res = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "follow",
      })
      const ms = Math.round(performance.now() - start)
      return {
        status: res.status,
        ms,
        tlsOk: url.startsWith("https://"),
      }
    },
    catch: (err) =>
      new Error(
        `unreachable: ${err instanceof Error ? err.message : String(err)}`,
      ),
  })

// ---------------------------------------------------------------------------
// infra doctor
// ---------------------------------------------------------------------------

export const doctorCommand = Command.make("doctor").pipe(
  Command.withHandler(() =>
    Effect.gen(function* () {
      const client = yield* InfraClient

      // 1. Agent health
      const agentResult = yield* client
        .status()
        .pipe(Effect.either)
      if (agentResult._tag === "Right") {
        yield* Console.log(`${pad("Agent")}ok (${INFRA_SERVER_URL})`)
      } else {
        yield* Console.log(`${pad("Agent")}unreachable (${INFRA_SERVER_URL})`)
        return
      }

      // 2. Routes
      const routesResult = yield* client
        .routes()
        .pipe(Effect.either)
      if (routesResult._tag === "Right") {
        const routes = routesResult.right
        if (routes.length === 0) {
          yield* Console.log(`${pad("Caddy routes")}no routes loaded`)
        } else {
          yield* Console.log(
            `${pad("Caddy routes")}${routes.length} loaded`,
          )
        }
      } else {
        yield* Console.log(`${pad("Caddy routes")}error fetching routes`)
      }

      // 3. Projects
      const projectsResult = yield* client
        .listProjects()
        .pipe(Effect.either)
      if (projectsResult._tag === "Left") {
        yield* Console.log(`${pad("Projects")}error fetching projects`)
        return
      }

      const projects = projectsResult.right
      if (projects.length === 0) {
        yield* Console.log(`${pad("Projects")}none deployed`)
        return
      }

      yield* Console.log("Projects:")

      yield* Effect.forEach(projects, (project) =>
        Effect.gen(function* () {
          const stagesResult = yield* client
            .getStages(project.name)
            .pipe(Effect.either)
          if (stagesResult._tag === "Left") {
            yield* Console.log(`  ${project.name} ... error`)
            return
          }

          const info = stagesResult.right
          yield* Console.log(`  ${info.name}`)

          yield* Effect.forEach(info.stages, (stage) =>
            Effect.gen(function* () {
              const promoted = stage.promoted ? " [production]" : ""
              const label = `    ${stage.stage}${promoted}`

              // Probe preview URL
              const previewProbe = yield* probe(stage.previewUrl).pipe(
                Effect.either,
              )

              if (previewProbe._tag === "Right") {
                yield* Console.log(
                  `${pad(label, 30)}${stage.previewUrl} -> ${previewProbe.right.status}`,
                )
              } else {
                yield* Console.log(
                  `${pad(label, 30)}${stage.previewUrl} -> unreachable`,
                )
              }

              // 4. If promoted, also probe production domain
              if (stage.promoted && info.production) {
                const prodUrl = `https://${info.production}`
                const prodProbe = yield* probe(prodUrl).pipe(Effect.either)
                const prodLabel = `    production`
                if (prodProbe._tag === "Right") {
                  yield* Console.log(
                    `${pad(prodLabel, 30)}${prodUrl} -> ${prodProbe.right.status}`,
                  )
                } else {
                  yield* Console.log(
                    `${pad(prodLabel, 30)}${prodUrl} -> unreachable`,
                  )
                }
              }
            }),
          )
        }),
      )
    }),
  ),
  Command.withDescription("Run comprehensive health checks"),
)

// ---------------------------------------------------------------------------
// infra routes
// ---------------------------------------------------------------------------

export const routesCommand = Command.make("routes").pipe(
  Command.withHandler(() =>
    Effect.gen(function* () {
      const client = yield* InfraClient
      const routes = yield* client.routes()

      if (routes.length === 0) {
        yield* Console.log("No routes loaded")
        return
      }

      yield* Console.log("Routes:")
      yield* Effect.forEach(routes, (route) => {
        const id = (route as Record<string, unknown>)["@id"] ?? "(unknown)"
        const matchEntries = (route as Record<string, unknown>)["match"] as
          | Array<Record<string, unknown>>
          | undefined
        const hosts =
          matchEntries
            ?.flatMap((m) => (m["host"] as string[] | undefined) ?? [])
            .join(", ") ?? "(no match)"
        return Console.log(`  ${id}  ->  ${hosts}`)
      })
    }),
  ),
  Command.withDescription("Show Caddy routes"),
)

// ---------------------------------------------------------------------------
// infra sync
// ---------------------------------------------------------------------------

export const syncCommand = Command.make("sync").pipe(
  Command.withHandler(() =>
    Effect.gen(function* () {
      const client = yield* InfraClient
      const result = yield* client.syncRoutes()
      yield* Console.log(result.message)
    }),
  ),
  Command.withDescription("Sync Caddy routes from deployed state"),
)

// ---------------------------------------------------------------------------
// infra probe <domain>
// ---------------------------------------------------------------------------

export const probeCommand = Command.make("probe", {
  domain: Args.text({ name: "domain" }).pipe(
    Args.withDescription("Domain to probe"),
  ),
}).pipe(
  Command.withHandler(({ domain }) =>
    Effect.gen(function* () {
      const url = domain.startsWith("http") ? domain : `https://${domain}`
      yield* Console.log(`Probing ${url} ...`)

      const result = yield* probe(url, 10_000).pipe(Effect.either)

      if (result._tag === "Left") {
        yield* Console.log(`  Status: unreachable`)
        yield* Console.log(`  Error:  ${result.left.message}`)
        return
      }

      const { status, ms, tlsOk } = result.right
      yield* Console.log(`  Status: ${status}`)
      yield* Console.log(`  Time:   ${ms}ms`)
      yield* Console.log(`  TLS:    ${tlsOk ? "ok" : "n/a (not https)"}`)
    }),
  ),
  Command.withDescription("Probe a domain over HTTPS"),
)

// ---------------------------------------------------------------------------
// infra dns <domain>
// ---------------------------------------------------------------------------

export const dnsCommand = Command.make("dns", {
  domain: Args.text({ name: "domain" }).pipe(
    Args.withDescription("Domain to look up"),
  ),
}).pipe(
  Command.withHandler(({ domain }) =>
    Effect.gen(function* () {
      const result = yield* Effect.tryPromise({
        try: async () => {
          const proc = Bun.spawn(["dig", "+short", domain], {
            stdout: "pipe",
            stderr: "pipe",
          })
          const output = await new Response(proc.stdout).text()
          await proc.exited
          return output.trim()
        },
        catch: (err) =>
          new Error(
            `dig failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
      })

      if (result) {
        yield* Console.log(result)
      } else {
        yield* Console.log(`No DNS records found for ${domain}`)
      }
    }),
  ),
  Command.withDescription("DNS lookup via dig"),
)
