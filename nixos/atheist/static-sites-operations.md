# Static sites on atheist

One Caddy process on atheist serves the files of every static site (`nixos/modules/static-sites.nix`). It listens on `127.0.0.1:8080` only, so a client outside the host reaches it only through a Traefik route on the ingress (`tools/alchemy/platform/ingress`), and the route chooses the folder. Processes on the host can reach Caddy directly and choose any folder under `/srv/www`.

## Ownership

| Item | Owner | Where |
| --- | --- | --- |
| Caddy file server and its Caddyfile | NixOS | `nixos/modules/static-sites.nix` |
| `static-sites` Traefik service | NixOS | `host.toml` in `/var/lib/traefik-routes`, a link into the Nix store |
| Site routes and redirects | NixOS | `routes/*.toml` in the site folder (`OPS_SITE`; `nixos/site/routes` holds an example), linked into `/var/lib/traefik-routes` |
| Site releases | the operator | `/srv/www/<site>/<release>/` |

## Releases

A release is a folder that is never changed after it is written:

```
/srv/www/<site>/<release>/
```

The site's Traefik route sends its requests to the `static-sites@file` service and sets two request headers:

- `X-Site-Release` names the folder, for example `setlist/bb958b1`. Caddy serves files from `/srv/www/<X-Site-Release>`. A request without it gets 404.
- `X-Site-Fallback`, when present, names the page for a browser request that has no file, for example `/index.html` for a single-page app. A request that does not accept HTML, such as a script or an image, still gets 404 for a missing file.

Every route sets both headers. Traefik replaces a client's value of a header that the route sets. Set `X-Site-Fallback` to an empty value to turn the fallback off: Traefik then removes the client's header.

Caddy also sends `Cache-Control: no-cache` with every HTML response, including `/404.html`, which it serves from the release with status 404 when the release has one.

## Publish, promote and roll back

1. Copy the new release folder to `/srv/www/<site>/<release>/` on atheist.
2. Change `X-Site-Release` in the site's route in `routes/sites.toml` of the site folder.
3. Rebuild atheist with `ops rebuild atheist`. The route file is a link into the Nix store, so the rebuild replaces it in one step and Traefik never reads a half-written file.

To roll back, set the previous release in the route and rebuild again. Keep old release folders until no route names them.

## Live checks

On atheist:

```sh
systemctl status caddy
ls -l /var/lib/traefik-routes
ss -ltn | grep ':8080 '
curl -s -o /dev/null -w '%{http_code}\n' -H 'X-Site-Release: example.com/2026-01-01' http://127.0.0.1:8080/
```

The `ss` line must show `127.0.0.1:8080`.

## Limits

- No Alchemy resource owns static sites. Their release folders are copied by hand, and their routes change through a rebuild.
