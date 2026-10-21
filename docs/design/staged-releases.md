# Staged release goals

## Goal

Deploy and test an app release before it receives traffic at the app's usual URL. Keep the current release live while the candidate runs at a generated preview URL. After the candidate passes health checks and real client testing, promote it to the usual URL. Keep the previous release available for rollback.

The release system must preserve application data. It must not run two versions against shared writable data unless the app and its data store support concurrent versions.

## Candidate, promotion, and rollback

- A **candidate release** is a specific app version deployed for review. It has a preview URL and does not change the live route.
- **Promotion** changes the live route to a candidate after health checks pass and an operator approves it.
- **Rollback** changes the live route back to the previous release. It does not reverse database writes or schema changes.
- A **traffic split** sends production requests to more than one release according to an explicit policy. The later A/B testing goal includes round-robin assignment and is separate from preview URLs.

For a game release, the operator deploys a candidate, opens its generated URL on a phone, checks for regressions, and promotes it only after review. The usual URL continues to reach the current release until promotion.

## Work order

1. Deploy a candidate beside the live app at a generated URL. Keep the live route unchanged.
2. Check candidate health and expose the preview URL for manual testing.
3. Promote the candidate by changing the stable app route. Retain the previous release and provide an explicit rollback operation.
4. Add round-robin traffic splitting between releases for A/B tests. Define session behavior and measurement before implementation.

The first three steps are the release foundation. Traffic splitting is a later capability. Do not make automatic promotion part of the first version.

## Ownership

App repositories declare release inputs such as the image and health check. Alchemy owns the desired release set and promotion state. Nomad runs the release allocations. NixOS owns host networking, rootless Podman, storage, and the stable ingress service. The ingress service provides the generated preview route and the stable app route.

The first implementation is one Alchemy `ReleaseSet` resource. It owns distinct Nomad jobs for declared releases, Nomad health checks, the selected release, a candidate preview route, stable route publication, promotion, rollback, and cleanup. Alchemy's local state records desired properties; Caddy's API configuration is applied state. A caller requests a candidate or selected release through one JSON manifest. Local state must be preserved because the provider cannot discover or adopt a release set after state loss.

Candidate images must be immutable and available to every eligible Nomad node. Preview URLs need production DNS and TLS. A preview deployment must not expose secrets or production data to a candidate unless the app's access policy permits it.

## Existing behavior and current gap

The earlier `tools/infra` deployer assigned preview URLs from a release hash, checked service health before promotion, changed Caddy routing, and retained the previous promoted stage for rollback. This code is a behavioral reference. It is not the current NixOS and Alchemy implementation.

The existing Alchemy cartridge declares one fixed-port Nomad job; its update produced about 5.7 seconds of failed HTTP probes. The new stateless `ReleaseSet` proof ran two digest-pinned `whoami` releases at once. Stable traffic remained on v1 while the v2 preview returned HTTP 200. Promotion moved stable traffic to v2; rollback returned it to v1. Both releases used separate Nomad jobs and stayed healthy during route changes. Cleanup removed v2 and its preview route, and the final Alchemy plan had no changes. See `tools/alchemy/README.md` for the operator flow and sample manifests.

The fresh Nix image booted only after an ext4 repair on its disposable overlay. The cause is not established, so repeatable image builds are not proven. The test used `localhost` hostnames and an SSH tunnel for Caddy's loopback admin API. A Caddy restart preserved the API-managed stable route, and a new Alchemy plan reported no changes. A manual Caddyfile reload removed the route; Alchemy detected the missing route, restored it, and returned HTTP 200 with the release marker. The test did not cover public preview DNS/TLS, recovery after losing Alchemy state, cross-node placement, active-user connections, or A/B traffic splitting. Noneuclid remains unsafe for overlapping releases because both versions would use the same writable SQLite file.

The traffic-cutover work for updates is related to promotion but does not replace it. Updating a candidate must not change the live route. Promotion then changes which healthy release receives traffic. Stateful apps need a separate compatibility and data-safety policy before versions can overlap or roll back.

## Routing proof on the disposable Nomad VM

On 2026-10-11, a disposable single-node Nomad VM ran a Traefik Nomad provider and two stateless `whoami` jobs. The candidate had a generated preview host while the existing release kept the usual host. Both hosts returned HTTP 200 from their expected allocations. The second run saved responses, route samples, and allocation status under `.audit/staged-route-*`.

Promotion and rollback changed the candidate's Nomad service tags. Traefik switched the usual host to the candidate and back to the old allocation. In the second run, seven half-second samples returned the old version before the eighth returned the candidate; rollback took 19 samples to return to the old version. All sampled requests returned HTTP 200. The Nomad allocation IDs stayed unchanged, and each task reported zero restarts. The probe jobs were then removed; the VM had no running jobs afterward.

This proves dynamic preview and live route selection on one disposable node through Traefik. It does not prove production DNS or TLS, multi-node placement, concurrent database safety, or round-robin traffic splitting. The proxy needed host networking in this VM because Nomad's API listened on the VM loopback address. The rebuilt image starts Nomad and Caddy and serves the Nomad UI through Caddy.

On 2026-10-11, Alchemy deployed a stateless v1 release and a v2 candidate as distinct Nomad jobs. The stable host returned `X-Alchemy-Release: v1` while the preview host returned `v2`. Promotion changed the stable response to v2, rollback changed it to v1, and no allocation restarted during either route change. Removing v2 from desired state removed its job and preview route. The final plan reported no changes. This proves Alchemy owns preview, promotion, rollback, and cleanup on one local VM. It does not prove external client access, Caddy recovery after restart, A/B traffic splitting, cross-node routing, or safe use by apps with shared writable data.

The stable route stores the selected Nomad service address and dynamic port from the last Alchemy apply. A stopped v1 allocation made Caddy keep an old port while Nomad started a replacement; stable requests returned HTTP 502. The operator-run controller now listens for allocation events and invokes Alchemy from the last successfully applied manifest. On the disposable VM it restored HTTP 200 with the v1 marker without applying a different working manifest. The final strict readiness check also requires Nomad deployment health. Recovery took about 20 seconds in the second forced-reschedule probe. The controller is not yet a NixOS service; shared apply locking, reconnect recovery, and process cleanup are implemented in the workstation trial but need host verification. Public DNS/TLS and cross-node movement remain unproven.

Resource settings such as CPU, memory, and health checks are shared across all declared releases. Changing them can update the selected Nomad job and replace its allocation. Keep these settings fixed during a staged image rollout until job configuration is versioned per release.

The result supports keeping candidate and live releases in separate Nomad jobs and changing routing metadata without restarting application allocations. The saved preview retry series contains nine HTTP 404 responses, then HTTP 200 after Traefik discovered the healthy candidate. Promotion changed the live response after eight samples; rollback changed it after 19 samples. Requests were about 0.5 seconds apart, and all promotion and rollback samples returned HTTP 200. This does not prove there was no sub-second gap or interruption to active connections. The measured discovery delay also means a release command must not report a preview as ready based only on Nomad health.

The probe used a live router tag on each app service and router priorities to model selection. A first rollback trial left a low-priority live route on the unselected candidate. Review found that stale route could take over if the higher-priority service disappeared. The corrected trial gave the candidate only its preview route before promotion and removed its live route on rollback. This is evidence against using per-release priority tags as the production promotion contract. The production route must have one authoritative selection in Alchemy, fail closed when that selected release is unavailable, and reconcile from that selection.

Use Caddy as the preferred ingress. It fits this platform because it serves static game files and proxies app services. The existing `tools/infra` path demonstrated preview URLs, health-checked promotion, and rollback by writing managed Caddyfile snippets and running `caddy reload`; it does not use Caddy's admin API.

Caddy's admin API saves its active configuration by default. Caddy resumes that config after a restart when it starts with `--resume`. The pinned NixOS module exposes this as `services.caddy.resume`. The testground config enables it and keeps the Nomad UI route in the bootstrap Caddyfile. The module normally reloads a changed Caddyfile, which would replace API-managed routes and their autosave. The testground sets `services.caddy.enableReload = false`; the module then restarts Caddy for a changed Caddyfile, and `--resume` restores saved routes. This also means the changed Caddyfile may not become active while a valid autosave exists. A manual Caddyfile reload replaced API-managed routes in the test VM; Alchemy restored them after a plan and deploy. Alchemy must reconcile its local desired state after manual reloads and after any restart where the autosave is missing or invalid. Caddy's autosave is an operational snapshot, not a write-ahead log, backup, or desired-state owner. The stable API-managed route survived a direct Caddy restart in the testground VM. The test did not cover a changed Caddyfile or invalid/missing autosave. The admin API binds to localhost by default. Alchemy must run on the host or use an authenticated local control path. See the [Caddy API guide](https://caddyserver.com/docs/api) and the [NixOS Caddy module](https://github.com/NixOS/nixpkgs/blob/6510408d147d8c5e6d76043e899e9251756f6a75/nixos/modules/services/web-servers/caddy/default.nix).

Keep Caddy as the NixOS-owned host service and have Alchemy reconcile the selected release through its local admin API. Alchemy's local state is authoritative for the release selection; Caddy's saved JSON config is a restart snapshot. The NixOS bootstrap Caddyfile owns the Nomad UI route. Disable NixOS automatic Caddyfile reloads so a NixOS switch restarts Caddy with `--resume` and retains API-managed routes. Alchemy must restore routes after manual Caddyfile reloads and recover from a missing or invalid autosave. The current provider uses Caddy `PATCH` for an identified route replacement and one request per route change. It has not been exercised under a dense request stream or active connection load.

References: [Caddy API](https://caddyserver.com/docs/api), [Caddy command line](https://caddyserver.com/docs/command-line), [upstream systemd service notes](https://github.com/caddyserver/dist/blob/master/init/caddy.service).
