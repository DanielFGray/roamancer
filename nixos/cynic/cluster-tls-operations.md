# Cluster TLS operations

cynic is the only Nomad server. Other machines join as Nomad clients over the LAN. Three listeners face the LAN, all on cynic's address (`[cluster]` in `site.toml`):

| Port | Service | Clients |
|---|---|---|
| 4647 | Nomad RPC | Nomad clients on other machines (Nomad agent CA) |
| 8200 | OpenBao `lan` listener | jobs on other machines, through their Nomad client (Nomad agent CA) |
| 5000 | Image registry, as `registry.cluster` | Podman pulls and pushes from `nodes` and the `workstation` (no client certificate; Nomad agent CA verifies the server) |

The firewall lets the machines in `nodes` reach every TCP port, so their jobs reach services on cynic, such as Postgres on 5432 and Nomad's dynamic ports. The `workstation` address reaches only the three ports above. Nomad HTTP (4646), serf (4648) and OpenBao's plain listener stay on loopback, or are not opened in the firewall.

## Certificates

`cluster-tls.service` keeps them in `/var/lib/cluster-tls`, readable by root only:

- `nomad-agent-ca.pem` and `nomad-agent-ca-key.pem`: the Nomad agent CA, valid for 5 years from its creation. Nomad RPC, OpenBao and the registry's *server* certificate chain to it.
- `global-server-nomad.pem` and its key: cynic's server certificate, valid for one year. It names `server.global.nomad`, `registryName` and the IP `lanAddress`. All three listeners present it.

It also copies the Nomad agent CA to `/var/lib/registry-ca/ca.crt` (`registryCaDir` in `site.toml`), readable by everyone; the CA is public. `/etc/containers/certs.d/registry.cluster:5000` links to that folder, and Podman reads it on each pull or push to trust the registry's server certificate.

The registry checks no client credentials. Only `nodes` and the `workstation` reach port 5000 through the firewall, image deletion is off, and cartridges pin each image by digest, so a pushed tag changes nothing deployed.

The service runs before the listeners start, and daily from a timer. It creates the CA if none exists. It re-issues a certificate when fewer than 30 days remain or when the server certificate does not name `lanAddress` and `registryName`. After it re-issues the server certificate, it sends SIGHUP to Nomad and restarts OpenBao and the registry without waiting for them. OpenBao and the registry read systemd's copies of the files, made at start. OpenBao unseals itself after the restart. To see that a rebuild that re-issued the certificate has finished, run `systemctl status cluster-tls openbao docker-registry`: cluster-tls is inactive with result success, and the other two are active.

A rebuild does not restart OpenBao when its configuration changes; the NixOS module reports "NOT restarting openbao.service". After a change to OpenBao's settings or credentials, run `sudo systemctl restart openbao`. It unseals itself.

If the CA key is missing but certificates from it exist, the service fails and Nomad, OpenBao and the registry do not start. Creating a new CA would cut off every client without notice.

## Back up the CA key

Do this once, after the first start, from your own terminal. The key prints on the terminal only:

```sh
ssh -t cynic 'sudo cat /var/lib/cluster-tls/nomad-agent-ca-key.pem /var/lib/cluster-tls/nomad-agent-ca.pem'
```

Store the pair as "cynic cluster CA". To restore it, write both files back to `/var/lib/cluster-tls` with mode 0600, owned by root, before Nomad starts.

## The registry CA on other nodes

atheist (and any Nomad client) needs `ca.crt`, the Nomad agent CA, in `registryCaDir` (`/var/lib/registry-ca`). The CA is public, so copy it as a plain file:

```sh
ssh -n cynic 'cat /var/lib/registry-ca/ca.crt' | ssh -t atheist 'sudo install -D -m 0644 /dev/stdin /var/lib/registry-ca/ca.crt'
```

For a first install, put it at `~/.local/state/server-ansible/extra-files/<host>/var/lib/registry-ca/ca.crt` before `ops install`, which copies it onto the new root. Copy it again only when the CA changes (every 5 years).

## Push images from the workstation

The workstation's Docker pushes to `registry.cluster:5000` over WireGuard. It needs only the CA to trust the server:

1. Put the Nomad agent CA in `/etc/docker/certs.d/registry.cluster:5000/ca.crt`:
   `ssh -n cynic 'cat /var/lib/registry-ca/ca.crt' | sudo install -D -m 0644 /dev/stdin /etc/docker/certs.d/registry.cluster:5000/ca.crt`
2. Map the name in the workstation's `/etc/hosts`: `<lanAddress> registry.cluster`, with `lanAddress` from your `site.toml`.

Then push with `docker push registry.cluster:5000/<name>:<tag>`, and pin the pushed digest in the cartridge as `registry.cluster:5000/<name>@sha256:<digest>`.

## One-time move from registry client certificates (live cluster)

A cluster whose registry still asks for client certificates moves once:

1. Rebuild cynic. The registry stops asking for client certificates, and `cluster-tls` writes `/var/lib/registry-ca/ca.crt`.
2. Rebuild atheist, then copy the CA to it as in [The registry CA on other nodes](#the-registry-ca-on-other-nodes). Until then its Podman cannot verify the registry.
3. Confirm a pull on each node (`podman pull` of a known image as the nomad user) and a push from the workstation.
4. Remove `/var/lib/registry-client` on every node, and `client.cert` / `client.key` from the workstation's `/etc/docker/certs.d/registry.cluster:5000`. They held Nomad client-agent keys, which can join the cluster.

## When cynic's LAN address changes

The address comes from fw's DHCP. A new lease breaks the server certificate's IP, Raft's peer address, every client's `servers` entry and the `registry.cluster` entries in `/etc/hosts`, all at the same time. To recover:

1. Set `lanAddress` in your `site.toml` to the new address.
2. Stop Nomad and write `/var/lib/nomad/server/raft/peers.json` with the new address. This is the same step as in the first cluster rebuild.
3. Rebuild cynic. cluster-tls issues a certificate for the new address, and cynic's `/etc/hosts` follows `lanAddress`.
4. Update each client's `servers` entry and `/etc/hosts`, and the workstation's `/etc/hosts`.
