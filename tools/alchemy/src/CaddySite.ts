export type SiteRouteInput = {
  readonly id: string;
  readonly host: string;
  // The built client folder on the Caddy host, for example a Vite dist directory.
  readonly root: string;
  // The API the /api prefix proxies to, as host:port.
  readonly apiUpstream: string;
  // Response headers set on every page, for example Content-Security-Policy.
  readonly headers: Readonly<Record<string, string>>;
};

/**
 * A single-page site with an API prefix. The shape matches what `caddy adapt` produces for
 * the setlist Caddyfile, so the same behavior holds:
 * - /api and /api/* proxy to the API, with X-Real-IP set from the connection
 * - /assets and /alphatab serve files and return 404 for a missing file
 * - every other path serves the file at that path, or /index.html for a client route
 *
 * Caddy evaluates the routes of a subroute in order and runs the first match, so the
 * order below is part of the behavior. Keep the API route first.
 */
export const siteRoute = (input: SiteRouteInput) => ({
  "@id": input.id,
  match: [{ host: [input.host] }],
  handle: [
    {
      handler: "subroute",
      routes: [
        {
          match: [{ path: ["/api", "/api/*"] }],
          handle: [
            {
              handler: "reverse_proxy",
              upstreams: [{ dial: input.apiUpstream }],
              headers: { request: { set: { "X-Real-Ip": ["{http.request.remote.host}"] } } },
              flush_interval: -1,
            },
          ],
        },
        {
          handle: [
            { handler: "vars", root: input.root },
            {
              handler: "headers",
              response: {
                set: Object.fromEntries(
                  Object.entries(input.headers).map(([name, value]) => [name, [value]]),
                ),
              },
            },
            {
              handler: "subroute",
              routes: [
                {
                  match: [{ path: ["/assets", "/assets/*", "/alphatab", "/alphatab/*"] }],
                  handle: [{ handler: "file_server" }],
                },
                {
                  match: [{ file: { try_files: ["{http.request.uri.path}", "/index.html"] } }],
                  handle: [{ handler: "rewrite", uri: "{http.matchers.file.relative}" }],
                },
                // Runs after the rewrite, so a client route that falls back to index.html gets it too.
                {
                  match: [{ path: ["/index.html"] }],
                  handle: [{ handler: "headers", response: { set: { "Cache-Control": ["no-cache"] } } }],
                },
                { handle: [{ handler: "file_server" }] },
              ],
            },
          ],
        },
      ],
    },
  ],
});
