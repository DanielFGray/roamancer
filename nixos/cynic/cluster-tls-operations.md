# Cluster TLS operations

cynic is the only Nomad server. Other machines join as Nomad clients over the LAN. Three listeners face the LAN, all on cynic's address (`[cluster]` in `site.toml`):

| Port | Service | Clients |
|---|---|---|
| 4647 | Nomad RPC | Nomad clients on other machines (Nomad agent CA) |
| 8200 | OpenBao `lan` listener | jobs on other machines, through their Nomad client (Nomad agent CA) |
| 5000 | Image registry, as `registry.cluster` | Podman pulls and pushes (registry CA for the client cert; Nomad agent CA to verify the server) |

The firewall lets the machines in `nodes` reach every TCP port, so their jobs reach services on cynic, such as Postgres on 5432 and Nomad's dynamic ports. The `workstation` address reaches only the three ports above. Nomad HTTP (4646), serf (4648) and OpenBao's plain listener stay on loopback, or are not opened in the firewall.

## Certificates

`cluster-tls.service` keeps them in `/var/lib/cluster-tls`, readable by root only:

- `nomad-agent-ca.pem` and `nomad-agent-ca-key.pem`: the Nomad agent CA, valid for 5 years from its creation. Nomad RPC, OpenBao and the registry's *server* certificate chain to it.
- `registry-ca.pem` and `registry-ca-key.pem`: the registry client CA, valid for 5 years. Only this CA's client certificates can pull or push images. Nomad never accepts them, so a holder of a registry client key cannot register a Nomad node.
- `global-server-nomad.pem` and its key: cynic's server certificate, valid for one year. It names `server.global.nomad`, `registryName` and the IP `lanAddress`. All three listeners present it.

It also keeps cynic's registry client certificate in `/var/lib/registry-client`, readable by the `registry-client` group (`nomad` pulls; the operator may push from a build node). That folder holds:

- `ca.crt`: the Nomad agent CA (verifies the registry server certificate)
- `client.cert` / `client.key`: a certificate from the registry CA

`/etc/containers/certs.d/registry.cluster:5000` links to that folder. Podman reads the files on each pull or push.

The service runs before the listeners start, and daily from a timer. It creates each CA if none exists. It re-issues a certificate when fewer than 30 days remain or when the server certificate does not name `lanAddress` and `registryName`. After it re-issues the server certificate, it sends SIGHUP to Nomad and restarts OpenBao and the registry without waiting for them. OpenBao and the registry read systemd's copies of the files, made at start. OpenBao unseals itself after the restart. To see that a rebuild that re-issued the certificate has finished, run `systemctl status cluster-tls openbao docker-registry`: cluster-tls is inactive with result success, and the other two are active.

A rebuild does not restart OpenBao when its configuration changes; the NixOS module reports "NOT restarting openbao.service". After a change to OpenBao's settings or credentials, run `sudo systemctl restart openbao`. It unseals itself.

If a CA key is missing but certificates from that CA exist, the service fails and Nomad, OpenBao and the registry do not start. Creating a new CA would cut off every client without notice.

## Back up the CA keys

Do this once, after the first start, from your own terminal. The keys print on the terminal only:

```sh
ssh -t cynic 'sudo cat /var/lib/cluster-tls/nomad-agent-ca-key.pem /var/lib/cluster-tls/nomad-agent-ca.pem'
ssh -t cynic 'sudo cat /var/lib/cluster-tls/registry-ca-key.pem /var/lib/cluster-tls/registry-ca.pem'
```

Store the Nomad pair as "cynic cluster CA" and the registry pair as "cynic registry CA". To restore them, write both files of a pair back to `/var/lib/cluster-tls` with mode 0600, owned by root, before Nomad starts.

## Registry client certificates on other nodes

atheist (and any Nomad client) needs the same three files under `/var/lib/registry-client` that cynic keeps. Issue a client certificate on cynic from the registry CA, copy the files to the node, then delete the private key from cynic:

```sh
ssh -t cynic 'sudo bash -s' <<'EOF'
set -euo pipefail
out=$(mktemp -d)
cd /var/lib/cluster-tls
openssl req -newkey rsa:4096 -nodes -sha256 \
  -keyout "$out/client.key" -out "$out/req.csr" -subj "/CN=registry-client"
openssl x509 -req -in "$out/req.csr" -CA registry-ca.pem -CAkey registry-ca-key.pem \
  -CAcreateserial -out "$out/client.cert" -days 365 -sha256
cp nomad-agent-ca.pem "$out/ca.crt"
rm -f "$out/req.csr"
echo "$out"
EOF
```

Copy `ca.crt`, `client.cert` and `client.key` from that printed folder to the node's `/var/lib/registry-client/` (directory mode 0750, key mode 0640, group `registry-client`), then remove the temporary folder on cynic. For a first install, put the three files under `~/.local/state/server-ansible/extra-files/<host>/var/lib/registry-client/` before `ops install`, which copies them onto the new root.

Each client certificate lasts one year. Nothing renews the copies on other nodes; re-issue and replace them before they expire.

## Push images from the workstation

The workstation's Docker pushes to `registry.cluster:5000` over WireGuard with a registry-CA client certificate. Its certificate lasts one year, and nothing renews it, so repeat these steps every year:

1. On cynic, issue a client certificate with the openssl commands in [Registry client certificates on other nodes](#registry-client-certificates-on-other-nodes) (use a temporary folder instead of `/var/lib/registry-client-out`). Copy `ca.crt` (the Nomad agent CA), `client.cert` and `client.key` to the workstation, then delete the key from cynic.
2. On the workstation, put the Nomad agent CA in `/etc/docker/certs.d/registry.cluster:5000/ca.crt`, the registry client certificate in `client.cert` and the key in `client.key` (mode 0600).
3. Map the name in the workstation's `/etc/hosts`: `<lanAddress> registry.cluster`, with `lanAddress` from your `site.toml`.

Then push with `docker push registry.cluster:5000/<name>:<tag>`, and pin the pushed digest in the cartridge as `registry.cluster:5000/<name>@sha256:<digest>`.

## One-time rotation to the registry CA (live cluster)

A cluster that still authenticates registry clients with the Nomad agent CA must cut over once. Do the steps in order so pulls do not fail between them:

1. Rebuild cynic with this configuration. `cluster-tls` creates `registry-ca.pem` / `registry-ca-key.pem`, re-issues cynic's `/var/lib/registry-client` client pair from the registry CA, and the registry starts trusting only that CA (`clientcas`). Back up the new registry CA key (see above).
2. Immediately issue and install registry-CA client files on every other node (atheist) and on the workstation, as in the sections above. Until those files are in place, those machines cannot pull or push.
3. Confirm a pull on each node (`podman pull` of a known image as the nomad user) and a push from the workstation or a build node.
4. Old Nomad-CA client certificates for the registry are useless after step 1; discard them.

## When cynic's LAN address changes

The address comes from fw's DHCP. A new lease breaks the server certificate's IP, Raft's peer address, every client's `servers` entry and the `registry.cluster` entries in `/etc/hosts`, all at the same time. To recover:

1. Set `lanAddress` in your `site.toml` to the new address.
2. Stop Nomad and write `/var/lib/nomad/server/raft/peers.json` with the new address. This is the same step as in the first cluster rebuild.
3. Rebuild cynic. cluster-tls issues a certificate for the new address, and cynic's `/etc/hosts` follows `lanAddress`.
4. Update each client's `servers` entry and `/etc/hosts`, and the workstation's `/etc/hosts`.
