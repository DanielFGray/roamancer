# Ingress on cynic

Traefik is the only HTTP entry point on cynic. Caddy runs behind it on loopback and serves the files of every static site. Nomad applications get their routes from tags on their Nomad services, and Traefik reads those tags from Nomad as they change.

This host has no public domain, no ACME certificate and no TLS listener. `tailscale serve` publishes `https://cynic.tail94d10f.ts.net` to the tailnet and forwards to `http://127.0.0.1:80`.

## Ownership

| Item | Owner | Where |
| --- | --- | --- |
| Traefik process, entry point, providers | NixOS | `nixos/cynic/traefik.nix` |
| Host health route, `static-sites` service | NixOS | `host.toml` in the routes folder, a link into the Nix store |
| Caddy file server and its Caddyfile | NixOS | `nixos/cynic/static-sites.nix` |
| Nomad application routes | Alchemy | tags on each release's Nomad service (`routeTags` in `tools/alchemy/src/ReleaseJob.ts`) |
| Static site routes | the site's owner | one file per site in `/var/lib/traefik-routes` |
| Static site releases | the site's owner | `/srv/www/<site>/<release>/` |
| Traefik's Nomad token | operator | `/var/lib/nomad-acl/traefik.env`, see `nomad-acl-operations.md` |
| Firewall rule for port 80 | NixOS | `nixos/cynic/traefik.nix` |

## Nomad application routes

A route is a set of Traefik tags on the Nomad service of a release job. With `exposedByDefault = false`, Traefik ignores every service without `traefik.enable=true`. With `watch = true`, Traefik follows Nomad's service events, so a route follows an allocation to its new address and port as soon as Nomad registers it.

A `Nomad.ReleaseSet` gives the stable host route to the selected release and the preview host route to the candidate. Every other release has no tags. A tag change is an in-place Nomad update: the allocation keeps running and keeps its port.

Traefik checks each routed service at the release's health path every 5 seconds. Nomad registers a service as soon as the allocation starts, not when it is ready, so this check is what keeps traffic off a release that is not ready.

Measured on cynic on 2026-10-21 with the `staged-probe` manifests:

- Promotion from v1 to v2 while requests ran every 0.2 s: 68 responses from v1, then 84 from v2, all HTTP 200, no allocation restart.
- Stopping the selected allocation: about 5 s of 404 and one 502, then 200 from the replacement on its new port. No Alchemy run was needed, and the next plan reported no changes.
- A host with no route returns 404.

## Static sites

One Caddy process serves every static site. A release is a folder that is never changed after it is written:

```
/srv/www/<site>/<release>/
```

The site's Traefik route sends its requests to the `static-sites@file` service and sets two request headers:

- `X-Site-Release` names the folder, for example `setlist/bb958b1`. Caddy serves files from `/srv/www/<X-Site-Release>`. A request without it gets 404.
- `X-Site-Fallback`, when present, names the page for a browser request that has no file, for example `/index.html` for a single-page app. A request that does not accept HTML, such as a script or an image, still gets 404 for a missing file.

Every route sets both headers. Traefik replaces a client's value of a header that the route sets. Set `X-Site-Fallback` to an empty value to turn the fallback off: Traefik then removes the client's header.

Caddy also sends `Cache-Control: no-cache` with every HTML response, including `/404.html`, which it serves from the release with status 404 when the release has one.

To promote or roll back a site, change `X-Site-Release` in its route file. Traefik reloads the file when it changes. Write the new file next to the old one and rename it over the old one, so Traefik never reads a half-written file.

Caddy listens on `127.0.0.1:8080` only, so a client outside the host reaches it only through a route, and the route chooses the folder. Processes on the host can reach Caddy directly and choose any folder under `/srv/www`.

The setlist preview route, `/var/lib/traefik-routes/setlist.toml`, was written by hand. It reproduces the hand-made Caddy route that served the same host before Traefik, including its CSP and its `/api` proxy to `127.0.0.1:3000`.

## Health endpoint

Every host name answers `GET /_traefik/health` with status 200 and the body `OK`.

```sh
curl -fsS http://127.0.0.1/_traefik/health
```

Traefik's own `/ping` router is off (`ping.manualRouting = true`), so an application's `/ping` is not hidden.

## First start and the token

The Traefik unit starts only when `/var/lib/nomad-acl/traefik.env` exists. Without the file, systemd skips the start and records the failed condition. This keeps failed starts from using up the NixOS module's limit of five starts a day.

On a new host:

```sh
sudo nomad-acl-issue-traefik
sudo systemctl start traefik
```

## Operator commands

```sh
systemctl status traefik caddy
journalctl -u traefik -f
ls -l /var/lib/traefik-routes
```

List the Nomad services that carry Traefik tags:

```sh
sudo sh -c 'export NOMAD_TOKEN="$(cat /var/lib/nomad-acl/bootstrap.token)"; for s in $(nomad service list -t "{{range .}}{{range .Services}}{{.ServiceName}} {{end}}{{end}}"); do nomad service info -t "{{range .}}{{.ServiceName}} {{.Address}}:{{.Port}} {{.Tags}}{{\"\\n\"}}{{end}}" "$s"; done'
```

## Live checks

On cynic:

```sh
curl -fsS http://127.0.0.1/_traefik/health
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: nobody.example' http://127.0.0.1/
ss -ltn | grep -E ':80 |:8080 '
sudo iptables -S nixos-fw | grep ens18
```

The second command must print `404`. The `ss` line for 8080 must show `127.0.0.1:8080`. The `iptables` line must show `--dport 80` with `-i ens18`.

## Limits

- Port 443 is closed. TLS for public domains is planned in Traefik, with Let's Encrypt and the Cloudflare DNS challenge. It is not configured.
- No Alchemy resource owns static sites yet. Their route files and release folders are written by hand.
- Alchemy reports a release ready when Nomad reports it healthy. It does not check that Traefik routes to it.
- Traefik listens on port 80 on every interface. The firewall rule for `ens18` keeps the port private.
