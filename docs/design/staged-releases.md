# Staged release goals

## Goal

Deploy and test an app release before it receives traffic at the app's usual URL. Keep the current release live while the candidate runs at a generated preview URL. After the candidate passes health checks and real client testing, promote it to the usual URL. Keep the previous release available for rollback.

The release system must preserve application data. It must not run two versions against shared writable data unless the app and its data store support concurrent versions.

## Candidate, promotion, and rollback

- A **candidate release** is a specific app version deployed for review. It has a preview URL and does not change the live route.
- **Promotion** changes the live route to a release after health checks pass. A merge into `main` is the operator's approval: a push to `main` deploys and promotes. A preview of another branch never goes live by itself.
- **Rollback** changes the live route back to the previous release. It does not reverse database writes or schema changes.
- A **traffic split** sends production requests to more than one release according to an explicit policy. The later A/B testing goal includes round-robin assignment and is separate from preview URLs.

For a game release, the operator creates a preview of the branch, opens its generated URL on a phone, checks for regressions, and merges the branch into `main` only after review. The usual URL continues to reach the current release until that merge deploys.

## Work order

1. Deploy a candidate beside the live app at a generated URL. Keep the live route unchanged.
2. Check candidate health and expose the preview URL for manual testing.
3. Promote the candidate by changing the stable app route. Retain the previous release and provide an explicit rollback operation.
4. Add round-robin traffic splitting between releases for A/B tests. Define session behavior and measurement before implementation.

The first three steps are the release foundation. Traffic splitting is a later capability. Do not make automatic promotion part of the first version.

## Ownership

App repositories declare release inputs. Release inputs include the image and the health check. Alchemy owns the desired release set and the promotion state. Nomad runs the release allocations. NixOS owns host networking, rootless Podman, and storage. NixOS also owns Traefik. Traefik is the ingress service. An ingress service is the first HTTP entry point for a host. Traefik provides the preview route and the stable app route.

Staged releases of app cartridges use the staged copy (`tools/alchemy/src/StagedCartridge.ts`), which gives the copy its own databases, roles, secrets and routes. Pull request previews build on the staged copy; see `pr-previews.md`. The `ReleaseSet` resource proved preview routing, promotion and rollback for one stateless service. It owns one Nomad job for each declared release. The resource also owns Nomad health checks, release selection, the candidate preview route, stable route publication, promotion, rollback, and cleanup. A caller requests a candidate or a selected release with one JSON manifest. The Nomad job spec is the whole desired state for a release. The job spec includes the route tags for the release. A plan with no job change means the routes also match the desired state. Alchemy does not repair routes outside the job spec. Alchemy can adopt a release set after state loss. Adoption requires one matching owned Nomad job for each declared release.

Candidate images must be immutable and available to every eligible Nomad node. Preview URLs need production DNS and TLS. A preview deployment must not expose secrets or production data to a candidate unless the app's access policy permits it.

## Existing behavior and current gap

History: the earlier `tools/infra` deployer assigned preview URLs from a release hash. It checked service health before promotion. It changed Caddy routing. It retained the previous promoted stage for rollback. This code is a behavioral reference. It is not the current NixOS and Alchemy implementation.

The existing Alchemy cartridge declares one fixed-port Nomad job. Its update produced about 5.7 seconds of failed HTTP probes. The new stateless `ReleaseSet` proof ran two digest-pinned `whoami` releases at once. Stable traffic remained on v1. The v2 preview returned HTTP 200. Promotion moved stable traffic to v2. Rollback returned it to v1. Both releases used separate Nomad jobs. Both releases stayed healthy during route changes. Cleanup removed v2 and its preview route. The final Alchemy plan had no changes. See `tools/alchemy/README.md` for the operator flow and sample manifests.

The fresh Nix image booted only after an ext4 repair on its disposable overlay. The cause is not established. Repeatable image builds are not proven. The test did not cover public preview DNS or TLS. It did not cover cross-node placement, active-user connections, or A/B traffic splitting. Noneuclid remains unsafe for overlapping releases. Both versions would use the same writable SQLite file.

History: that test also used `localhost` hostnames and an SSH tunnel for the Caddy loopback admin API. A Caddy restart preserved the API-managed stable route. A new Alchemy plan reported no changes. A manual Caddyfile reload removed the route. Alchemy detected the missing route and restored it. The route then returned HTTP 200 with the release marker.

The traffic-cutover work for updates is related to promotion but does not replace it. Updating a candidate must not change the live route. Promotion then changes which healthy release receives traffic. Stateful apps need a separate compatibility and data-safety policy before versions can overlap or roll back.

## Routing proof on the disposable Nomad VM

On 2026-10-11, a disposable single-node Nomad VM ran a Traefik Nomad provider and two stateless `whoami` jobs. The candidate had a generated preview host. The existing release kept the usual host. Both hosts returned HTTP 200 from their expected allocations.

Promotion and rollback changed the candidate's Nomad service tags. Traefik switched the usual host to the candidate. Traefik then switched the usual host back to the old allocation. In the second run, seven half-second samples returned the old version. The eighth sample returned the candidate. Rollback took 19 samples to return to the old version. All sampled requests returned HTTP 200. The Nomad allocation IDs stayed unchanged. Each task reported zero restarts. The probe jobs were then removed. The VM had no running jobs afterward.

This proves dynamic preview and live route selection on one disposable node through Traefik. It does not prove production DNS or TLS. It does not prove multi-node placement, concurrent database safety, or round-robin traffic splitting. The proxy needed host networking in this VM. Nomad's API listened on the VM loopback address.

History: on 2026-10-11, Alchemy used Caddy admin-API routes on a local VM. Alchemy deployed a stateless v1 release and a v2 candidate as distinct Nomad jobs. The stable host returned `X-Alchemy-Release: v1`. The preview host returned `v2`. Promotion changed the stable response to v2. Rollback changed it to v1. No allocation restarted during either route change. Removing v2 from desired state removed its job and preview route. The final plan reported no changes. This proved Alchemy owned preview, promotion, rollback, and cleanup on one local VM. It did not prove external client access, A/B traffic splitting, cross-node routing, or safe use by apps with shared writable data.

History: with Caddy admin-API routes, the stable route stored the Nomad service address and dynamic port from the last Alchemy apply. A stopped v1 allocation left Caddy with an old port. Nomad started a replacement allocation. Stable requests returned HTTP 502. An operator-run controller then listened for allocation events. It invoked Alchemy from the last successfully applied manifest. On the disposable VM, it restored HTTP 200 with the v1 marker. Recovery took about 20 seconds in the second forced-reschedule probe.

The staged allocation controller is removed. The controller existed to repair routes after Nomad moved an allocation. Traefik now reads routes from Nomad service tags. Traefik follows a moved allocation to its new address and port. No Alchemy run is necessary. On cynic, a stopped selected allocation returned HTTP 200 from its replacement after about 5 seconds. The next Alchemy plan reported no changes. Public DNS and TLS remain unproven. Cross-node movement remains unproven.

Resource settings such as CPU, memory, and health checks are shared across all declared releases. Changing them can update the selected Nomad job and replace its allocation. Keep these settings fixed during a staged image rollout until job configuration is versioned per release.

The result supports one Nomad job for each release. It supports a change of routing metadata with no restart of an application allocation. The saved preview retry series contains nine HTTP 404 responses. It then contains HTTP 200. Traefik had discovered the healthy candidate at that point. Promotion changed the live response after eight samples. Rollback changed it after 19 samples. Requests were about 0.5 seconds apart. All promotion and rollback samples returned HTTP 200. This does not prove there was no sub-second gap. It does not prove there was no interruption to active connections. The measured discovery delay has one consequence. A release command must not report a preview as ready from Nomad health alone.

The probe used a live router tag on each app service. It used router priorities to model selection. A first rollback trial left a low-priority live route on the unselected candidate. Review found a risk. That stale route could take over if the higher-priority service disappeared. The corrected trial gave the candidate only its preview route before promotion. It removed the live route from the candidate on rollback. This is evidence against per-release priority tags as the production promotion contract. The production contract gives the stable host to the selected release only. Every other release gets no stable route.

## Ingress decision

Use Traefik as the ingress on cynic. Traefik is the only HTTP entry point on cynic. Traefik reads application routes from tags on Nomad services. A tag is a text label on a Nomad service. Traefik watches Nomad service events. A route follows a moved allocation to its new address and port.

Alchemy sets the route tags in each release job spec. The selected release gets the stable host. The candidate gets the preview host. Every other release gets no route tags. Traefik ignores a service with no `traefik.enable=true` tag. A promotion changes the tags in the job spec. Nomad applies a tag change as an in-place update. The allocation keeps running. The allocation keeps its port. Traefik also checks each routed service at the release health path every 5 seconds.

The job spec is the whole desired state. No route state exists outside the job spec. Alchemy does not repair routes. A plan with no job change means the routes match the desired state.

One Caddy process on atheist serves static sites behind Traefik. Caddy is a loopback static-site file server in this design. Caddy listens on `127.0.0.1:8080` only. A client outside the host reaches Caddy only through a Traefik route. The route selects the site release folder under `/srv/www`. See `nixos/atheist/static-sites-operations.md` for the static-site route and header rules.

History: the existing `tools/infra` path used Caddy as the ingress. It demonstrated preview URLs, health-checked promotion, and rollback. It wrote managed Caddyfile snippets and ran `caddy reload`. It did not use the Caddy admin API. A later design used the Caddy admin API as the ingress. Commit `2b4a453` replaced that design with Traefik on cynic.

References: `tools/alchemy/platform/ingress/README.md`, `tools/alchemy/src/ReleaseJob.ts` (`routeTags`), and `tools/alchemy/src/ReleaseSet.ts`.
