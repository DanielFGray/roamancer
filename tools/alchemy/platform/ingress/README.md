# Ingress

This cartridge runs Traefik on atheist, the node with the public address. It is the only proxy between the internet and the cluster.

- **Entry points.** `web` listens on 443 and terminates TLS with Let's Encrypt certificates. It is the default entry point, so a router that names none, such as a release route, serves only on 443. `http` on port 80 redirects every request to `web`. `health` answers Nomad's check on port 18080 at `/ping`; Nomad checks the LAN address, and atheist's firewall keeps the port off the public card.
- **Tailnet routes.** `tailnet` listens on port 18081 in plain HTTP. atheist's firewall keeps the port off the public card; cynic reaches it over the LAN, and tailnet clients through `tailscale0`. A job's tailnet route has a leased HTTPS port on cynic, where Tailscale Serve terminates TLS and forwards to `http://<atheist>:18081/_tailnet/<job>/`. The job's route tags match that path on `tailnet` only, strip it, and remove the `X-Forwarded-Prefix` header that stripping adds, so the job sees its own paths. Traefik keeps the `X-Forwarded-*` headers that Serve sets (`forwardedHeaders.insecure`), so the job sees `https` and the Serve address; only cynic and the tailnet reach this entry point. The port is `tailnetEntrypoint` in `src/Job.ts`.
- **Certificates.** Traefik asks Let's Encrypt through the TLS-ALPN challenge on 443 and keeps its account and certificates in the `traefik-acme` host volume (`/var/lib/nomad/traefik-acme` on atheist). Keep that folder: without it, a restart asks for every certificate again, and Let's Encrypt rate-limits that.
- **Application routes.** Traefik polls Nomad's service list every 5 seconds through atheist's client agent on loopback, with the job's workload identity as its token. Services anywhere in the cluster register their LAN address and port, so Traefik reaches apps on cynic directly.
- **Static sites.** The file routes in `traefik-routes` come from atheist's NixOS config (the `routes` folder of the site folder, see `nixos/site`), and send each site to the Caddy file server on atheist's loopback (`nixos/modules/static-sites.nix`). See `nixos/atheist/static-sites-operations.md` for releases. The `nix-store` mount resolves their symlinks into the Nix store.
- **Client address.** Traefik sets `X-Real-Ip` to the socket address of each request and drops any value the client sent, because no `forwardedHeaders.trustedIPs` is set. DNS points straight at atheist with no Cloudflare proxy, so that address is the real client. An app that limits by client reads `x-real-ip`: set `TRUSTED_PROXY_HEADER` to `x-real-ip` in the service's cartridge `environment`. A Cloudflare proxy in front would need `CF-Connecting-IP` copied into that header and Cloudflare's ranges trusted.
- **Releases.** A `Nomad.ReleaseSet` gives the stable host route to the selected release and the preview host route to the candidate; other releases carry no tags. A tag change is an in-place Nomad update, so the allocation keeps running and keeps its port. Nomad registers a service when its allocation starts, not when it is ready, so each route's health check keeps traffic off a release that is not ready. A host with no route returns 404.

Rootless Podman binds 80 and 443 because atheist sets `net.ipv4.ip_unprivileged_port_start` to 80.

From `tools/alchemy`:

```sh
scripts/ops plan --stage platform-ingress
scripts/ops deploy --stage platform-ingress
```

The provider polls instead of watching Nomad's event stream. Traefik v3.7.13 ignores errors on that stream and then queries Nomad in a tight loop, which on 2026-10-22 caused high CPU use in Traefik and Nomad. With `watch` off, Traefik never opens the stream. The cost is that a route change reaches Traefik up to 5 seconds late. `testground/probe-traefik-stream.mjs` reproduces the stream defect against a Traefik executable; run it before turning `watch` back on with a newer version.

Measured on cynic's earlier Traefik on 2026-10-21, with the same tags and the `staged-probe` manifests: promotion from v1 to v2 under requests every 0.2 s gave 68 responses from v1 and then 84 from v2, all HTTP 200, with no allocation restart. Stopping the selected allocation gave about 5 s of 404 and one 502, then 200 from the replacement on its new port, with no Alchemy run.
