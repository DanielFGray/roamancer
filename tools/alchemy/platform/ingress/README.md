# Ingress readiness deployment

This cartridge runs Traefik on host port `18080` alongside the NixOS Traefik service. It does not change port 80, port 443, Tailscale Serve, or certificates.

The default Nomad workload identity supplies `NOMAD_TOKEN`. No token value belongs in the cartridge. Nomad grants the identity service-listing access, which is what Traefik's Nomad provider uses: it polls the service list every 5 seconds. The `read-job` policy associated with job `traefik`, group `service`, task `server` is still applied; the event stream needed it, and a live check must show polling works without it before it is removed. Run `sudo nomad-acl-apply-policies` on the host after activating the Nix configuration. It refreshes policies without issuing tokens.

Host networking lets Traefik reach Nomad and Caddy on loopback. The read-only `traefik-routes` and `nix-store` host volumes must be registered on the Nomad client and permitted by the deployment token's ACL policy. The second mount resolves the absolute Nix store symlink used by `host.toml`.

From `tools/alchemy`, with the Nomad API reachable and `NOMAD_TOKEN` set for deployment:

```sh
export ALCHEMY_CARTRIDGE=$PWD/platform/ingress/cartridge.json
bun run plan --stage platform-ingress
bun run deploy --stage platform-ingress
```

Use the same working directory for later plans so the local Alchemy state remains available.

The provider polls instead of watching Nomad's event stream. Traefik v3.7.13 ignores errors on that stream and then queries Nomad in a tight loop, which on 2026-10-22 caused high CPU use in Traefik and Nomad. With `watch` off, Traefik never opens the stream. The cost is that a route change reaches Traefik up to 5 seconds late. `testground/probe-traefik-stream.mjs` reproduces the stream defect against a Traefik executable; run it before turning `watch` back on with a newer version.

Before moving live ingress, verify stable interval CPU use, the host health route, an existing static-site route, and a tagged Nomad application route through port `18080`. Check route changes and allocation replacement too. A healthy ping alone does not prove service discovery or routing.

Rootless Podman cannot bind port 80 under the current host settings. Live cutover needs reviewed firewall redirects to high ports and a rollback procedure. Keep the current systemd service and its credential until the replacement passes those checks. Cloudflare file delivery and persistent certificate storage are separate work.
