# Cluster TLS operations

cynic is the only Nomad server. Other machines join as Nomad clients over the LAN. Three listeners face the LAN, all on cynic's address (`[cluster]` in `site.toml`), and all accept only clients with a certificate from the cluster CA:

| Port | Service | Clients |
|---|---|---|
| 4647 | Nomad RPC | Nomad clients on other machines |
| 8200 | OpenBao `lan` listener | jobs on other machines, through their Nomad client |
| 5000 | Image registry, as `registry.cluster` | every machine's Podman pulls; the workstation pushes |

The firewall lets the machines in `nodes` reach every TCP port, so their jobs reach services on cynic, such as Postgres on 5432 and Nomad's dynamic ports. The `workstation` address reaches only the three ports above. Nomad HTTP (4646), serf (4648) and OpenBao's plain listener stay on loopback, or are not opened in the firewall.

## Certificates

`cluster-tls.service` keeps them in `/var/lib/cluster-tls`, readable by root only:

- `nomad-agent-ca.pem` and `nomad-agent-ca-key.pem`: the CA, valid for 5 years from its creation.
- `global-server-nomad.pem` and its key: cynic's server certificate, valid for one year. It names `server.global.nomad`, `registryName` and the IP `lanAddress`. All three listeners present it.

It also keeps cynic's own registry client certificate in `/var/lib/registry-client`, readable by the nomad user, whose rootless Podman pulls every job's image. `/etc/containers/certs.d/registry.cluster:5000` links to that folder.

The service runs before the listeners start, and daily from a timer. It creates the CA if none exists. It re-issues a certificate when fewer than 30 days remain or when the certificate does not name `lanAddress` and `registryName`. After it re-issues the server certificate, it sends SIGHUP to Nomad and restarts OpenBao and the registry without waiting for them. OpenBao and the registry read systemd's copies of the files, made at start. OpenBao unseals itself after the restart. To see that a rebuild that re-issued the certificate has finished, run `systemctl status cluster-tls openbao docker-registry`: cluster-tls is inactive with result success, and the other two are active.

A rebuild does not restart OpenBao when its configuration changes; the NixOS module reports "NOT restarting openbao.service". After a change to OpenBao's settings or credentials, run `sudo systemctl restart openbao`. It unseals itself.

If the CA key is missing but certificates exist, the service fails and Nomad, OpenBao and the registry do not start. Creating a new CA would cut off every client without notice.

## Back up the CA key

Do this once, after the first start, from your own terminal. The key prints on the terminal only:

```sh
ssh -t cynic 'sudo cat /var/lib/cluster-tls/nomad-agent-ca-key.pem /var/lib/cluster-tls/nomad-agent-ca.pem'
```

Store both blocks in the password manager as "cynic cluster CA". To restore them, write both files back to `/var/lib/cluster-tls` with mode 0600, owned by root, before Nomad starts.

## Push images from the workstation

The workstation's Docker pushes to `registry.cluster:5000` over WireGuard with its own client certificate. Its certificate lasts one year, and nothing renews it, so repeat these steps every year:

1. On cynic, issue a client certificate: `sudo nomad tls cert create -client -region global -ca /var/lib/cluster-tls/nomad-agent-ca.pem -key /var/lib/cluster-tls/nomad-agent-ca-key.pem` in an empty folder. Copy it to the workstation, then delete it from cynic.
2. On the workstation, put the CA in `/etc/docker/certs.d/registry.cluster:5000/ca.crt`, the certificate in `client.cert` and the key in `client.key` (mode 0600).
3. Map the name in the workstation's `/etc/hosts`: `10.13.37.196 registry.cluster`.

Then push with `docker push registry.cluster:5000/<name>:<tag>`, and pin the pushed digest in the cartridge as `registry.cluster:5000/<name>@sha256:<digest>`.

## When cynic's LAN address changes

The address comes from fw's DHCP. A new lease breaks the server certificate's IP, Raft's peer address, every client's `servers` entry and the `registry.cluster` entries in `/etc/hosts`, all at the same time. To recover:

1. Set `lanAddress` in your `site.toml` to the new address.
2. Stop Nomad and write `/var/lib/nomad/server/raft/peers.json` with the new address. This is the same step as in the first cluster rebuild.
3. Rebuild cynic. cluster-tls issues a certificate for the new address, and cynic's `/etc/hosts` follows `lanAddress`.
4. Update each client's `servers` entry and `/etc/hosts`, and the workstation's `/etc/hosts`.
