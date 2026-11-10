# Health checks

Status: agreed 2026-11-10. Nothing is built yet.

Every app answers the same health request in the same way, and reconcile reads that answer after each deploy. A deployment counts as proved only when the running process reports the commit that reconcile released.

## The contract

`GET /healthz` on the service's HTTP port, with no authentication.

- 200 when the app can serve requests:

  ```json
  {"status":"ok","commit":"<GIT_COMMIT>"}
  ```

- 503 when a dependency the app needs to serve is unavailable, such as its database:

  ```json
  {"status":"error","commit":"<GIT_COMMIT>","failed":["database"]}
  ```

`commit` is the value of the `GIT_COMMIT` environment variable. The platform sets it in every task of a release, a staged deploy and a rollback (`Cartridge.ts`). When it is not set, as in local development, the app reports `"commit":"unknown"`.

`failed` names dependencies, not error text. The endpoint is public, so the app logs the detail and keeps it out of the response.

The response is small and cheap: Nomad and Traefik call it every few seconds.

## What the platform does with it

- `healthCheck: {"type": "http"}` with no `path` means `/healthz`. A cartridge may still name another path, so an app can move to the contract in its own time.
- Nomad's check and Traefik's health check use the path as they do now. A deploy waits for the check, and Nomad reverts a release whose check fails.
- After a deploy job succeeds, reconcile finds the service's address in Nomad's service registrations, which covers public and tailnet-only apps alike. It reads `/healthz` for a short time until the status is 200, then compares `commit` with the commit it released. The deployment record stores the result: proved, or the commit the process reported instead. Staged deploys get the same check.
- `ops dash` shows a release that is not proved.

## Workers

An app's background work runs in the server process as a library, not as a separate worker job. The server's `/healthz` then covers it: a worker that cannot reach its queue adds `"worker"` to `failed`. This removes the jobs that have no check today (`dfg-rocks-worker`, `giglist-worker`, `postgres-garden-worker`).

## Apps today

| App | Check now | Change |
|---|---|---|
| dfg.rocks | `/healthz`, the contract | move the worker in-process |
| giglist | `/healthz`, the contract | move the worker in-process |
| postgres.garden | `/healthz`, the contract; `failed` names only the first failed dependency | name every failed dependency; move the worker in-process |
| twitter-bookmarks | `/healthz`, the contract | none |
| noneuclid | TCP only | serve `/healthz` and use an HTTP check |
| rfchat | `/health` | serve `/healthz` |
