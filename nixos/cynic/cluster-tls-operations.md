# Cluster TLS operations

cynic is the only Nomad server. Other machines join as Nomad clients over the LAN. Two listeners face the LAN, both on cynic's address (`cluster.nix`):

| Port | Service | Who may connect |
|---|---|---|
| 4647 | Nomad RPC | holders of a certificate from the cluster CA |
| 8200 | OpenBao `lan` listener | holders of a certificate from the cluster CA |

The firewall opens both ports only to the addresses in `clientSources`. Nomad HTTP (4646), serf (4648) and OpenBao's plain listener stay on loopback, or are not opened in the firewall.

## Certificates

`cluster-tls.service` keeps them in `/var/lib/cluster-tls`, readable by root only:

- `nomad-agent-ca.pem` and `nomad-agent-ca-key.pem`: the CA, valid for 5 years from its creation.
- `global-server-nomad.pem` and its key: cynic's server certificate, valid for one year, with the name `server.global.nomad` and the IP SAN `lanAddress`. Nomad RPC and OpenBao's `lan` listener both present it.

The service runs before Nomad and OpenBao start, and daily from a timer. It creates the CA if none exists. It renews the server certificate when fewer than 30 days remain, then sends SIGHUP to Nomad and restarts OpenBao. OpenBao reads systemd's copy of the files, which is made at start, and it unseals itself after the restart.

A rebuild does not restart OpenBao when its configuration changes; the NixOS module reports "NOT restarting openbao.service". After a change to OpenBao's settings or credentials, run `sudo systemctl restart openbao`. It unseals itself.

If the CA key is missing but certificates exist, the service fails and Nomad and OpenBao do not start. Creating a new CA would cut off every client without notice.

## Back up the CA key

Do this once, after the first start, from your own terminal. The key prints on the terminal only:

```sh
ssh -t cynic.dlab 'sudo cat /var/lib/cluster-tls/nomad-agent-ca-key.pem /var/lib/cluster-tls/nomad-agent-ca.pem'
```

Store both blocks in the password manager as "cynic cluster CA". To restore them, write both files back to `/var/lib/cluster-tls` with mode 0600, owned by root, before Nomad starts.

## When cynic's LAN address changes

The address comes from fw's DHCP. A new lease breaks the server certificate's SAN, Raft's peer address, and every client's `servers` entry, all at the same time. To recover:

1. Set `lanAddress` in `cluster.nix` to the new address.
2. Delete `global-server-nomad.pem`, so the next start issues a certificate for the new address.
3. Stop Nomad and write `/var/lib/nomad/server/raft/peers.json` with the new address. This is the same step as in the first cluster rebuild.
4. Rebuild cynic, then update each client's `servers` entry.
