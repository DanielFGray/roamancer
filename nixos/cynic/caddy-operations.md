# Caddy on cynic

Caddy is host infrastructure on cynic. NixOS owns the Caddy service, the Caddyfile and the firewall rule for port 80. Alchemy owns the application routes and writes them through the local admin API.

This host has no public domain, no DNS record, no ACME certificate and no TLS listener.

## Ownership

| Item | Owner | Where |
| --- | --- | --- |
| Caddy process and version | NixOS | `nixos/cynic/caddy.nix` |
| Caddyfile | NixOS | `nixos/cynic/caddy.nix`, written to `/etc/caddy/caddy_config` |
| Health endpoint | NixOS | Caddyfile |
| Application routes | Alchemy | admin API on `127.0.0.1:2019` |
| Firewall rule for port 80 | NixOS | `nixos/cynic/caddy.nix` |

The admin API listens on `127.0.0.1:2019` only. No other host can reach it. The firewall opens no port for it.

The Caddyfile holds no application route. Alchemy adds every application route through the admin API.

## Health endpoint

The host answers `GET /_caddy/health` on port 80 with status `200` and the body `cynic caddy ok`.

The path belongs to the host. Alchemy matches its routes by host name, so this path cannot hide an application health check.

On the host:

```sh
curl -fsS http://127.0.0.1/_caddy/health
```

From the private LAN:

```sh
ip -4 addr show ens18
curl -fsS http://<lan-address>/_caddy/health
```

## Operator commands

Service state and log:

```sh
systemctl status caddy
journalctl -u caddy -f
systemctl restart caddy
```

Check the config that Caddy runs:

```sh
caddy validate --config /etc/caddy/caddy_config --adapter caddyfile
caddy adapt --config /etc/caddy/caddy_config --adapter caddyfile --pretty
```

List the routes Alchemy owns:

```sh
curl -s http://127.0.0.1:2019/config/apps/http/servers/srv0/routes | jq -r '.[] | (."@id" // "(no id)")'
```

Check the firewall rule for port 80:

```sh
sudo iptables -S nixos-fw | grep ens18
```

## Restart and reload limits

Caddy saves the running config to `/var/lib/caddy/.config/caddy/autosave.json` after every config change. The service starts with `--resume`, so Caddy restores that file and ignores `/etc/caddy/caddy_config` while the file exists.

The results:

- A restart keeps the routes that Alchemy added. The applications keep their routes during a Caddy restart and during a NixOS rebuild that restarts Caddy.
- A change to the Caddyfile does not reach Caddy. The saved config wins over the file. To apply a Caddyfile change, remove the saved config and restart the service:

  ```sh
  sudo systemctl stop caddy
  sudo rm -f /var/lib/caddy/.config/caddy/autosave.json
  sudo systemctl start caddy
  ```

- That start loads the Caddyfile. The routes that Alchemy added are gone until the Alchemy controller reconciles. Cynic does not run `alchemy-staged-controller` yet, so an operator must restore the routes after deleting autosave. When installed, the controller from `nixos/modules/alchemy-staged.nix` must reconcile after Caddy starts.
- Do not run `caddy reload` on cynic. A reload loads the Caddyfile through the admin API and replaces the whole running config. The routes that Alchemy added are lost until the controller reconciles. The NixOS module does not use a reload. `services.caddy.enableReload = false`, so a config change restarts the service instead.

## Applying host changes

The live flake imports `caddy.nix` from `nixos/cynic/configuration.nix`. Copy updated files from a checkout to `/etc/nixos/cynic`, then apply them on cynic:

```nix
sudo nixos-rebuild dry-build --flake /etc/nixos/cynic#cynic
sudo nixos-rebuild switch --flake /etc/nixos/cynic#cynic
```

The flake pins nixpkgs. The first start has no saved config, so the Caddyfile applies as written.

## Live checks

On cynic:

```sh
systemctl status caddy
curl -fsS http://127.0.0.1/_caddy/health
curl -fsS http://127.0.0.1:2019/config/apps/http/servers/srv0/routes | jq .
ss -ltn | grep 2019
sudo iptables -S nixos-fw | grep ens18
```

The `ss` line must show `127.0.0.1:2019`. The `iptables` line must show `--dport 80` with `-i ens18`.

From another host on the private LAN:

```sh
curl -fsS http://<lan-address>/_caddy/health
curl -fsS --max-time 5 http://<lan-address>:2019/config/
curl -fsS --max-time 5 https://<lan-address>/
```

The first command must answer `cynic caddy ok`. The second and third commands must fail. The admin API and the TLS port must not answer from the LAN.

## Limits

- Port 443 is closed. Application traffic stays plain HTTP inside the private network.
- Caddy listens on port 80 on every interface. The firewall rule for `ens18` keeps the port private.
- The health path is reserved for the host.
