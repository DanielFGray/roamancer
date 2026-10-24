# Ingress

This cartridge runs Traefik on atheist, the node with the public address. It is the only proxy between the internet and the cluster.

- **Entry points.** `web` listens on 443 and terminates TLS with Let's Encrypt certificates. Every route names `web`: Alchemy's route tags and the file routes alike. `http` on port 80 redirects every request to `web`. `health` answers Nomad's check on port 18080 at `/ping`; Nomad checks the LAN address, and atheist's firewall keeps the port off the public card.
- **Certificates.** Traefik asks Let's Encrypt through the TLS-ALPN challenge on 443 and keeps its account and certificates in the `traefik-acme` host volume (`/var/lib/nomad/traefik-acme` on atheist). Keep that folder: without it, a restart asks for every certificate again, and Let's Encrypt rate-limits that.
- **Application routes.** Traefik polls Nomad's service list every 5 seconds through atheist's client agent on loopback, with the job's workload identity as its token. Services anywhere in the cluster register their LAN address and port, so Traefik reaches apps on cynic directly.
- **Static sites.** The file routes in `traefik-routes` come from atheist's NixOS config (`nixos/atheist/traefik-routes`), and send each site to the Caddy file server on atheist's loopback (`nixos/modules/static-sites.nix`). The `nix-store` mount resolves their symlinks into the Nix store.

Rootless Podman binds 80 and 443 because atheist sets `net.ipv4.ip_unprivileged_port_start` to 80.

From `tools/alchemy`:

```sh
scripts/ops plan --stage platform-ingress
scripts/ops deploy --stage platform-ingress
```

The provider polls instead of watching Nomad's event stream. Traefik v3.7.13 ignores errors on that stream and then queries Nomad in a tight loop, which on 2026-10-22 caused high CPU use in Traefik and Nomad. With `watch` off, Traefik never opens the stream. The cost is that a route change reaches Traefik up to 5 seconds late. `testground/probe-traefik-stream.mjs` reproduces the stream defect against a Traefik executable; run it before turning `watch` back on with a newer version.
