# Facts the cluster modules share. cynic is the only Nomad server; other machines join
# as Nomad clients over the LAN, the Proxmox bridge shared with other tenants, with no
# tunnel. The laptop reaches that LAN through fw's WireGuard.
{
  lanInterface = "ens18";
  # From fw's DHCP, which has kept it stable. If the lease ever changes, the server
  # certificate, Raft's peer address and every client's `servers` entry break together.
  lanAddress = "10.13.37.196";
  # Sources that may open Nomad RPC (4647) and OpenBao (8200): atheist, and the
  # laptop's WireGuard address, which test VMs on the laptop arrive from. mTLS is the
  # control; this list narrows who can try, on a bridge where addresses can be forged.
  clientSources = [ "10.13.37.83" "10.10.10.3" ];
  # The cluster CA and leaf certificates. Root-only; never in the Nix store.
  tlsDir = "/var/lib/cluster-tls";
}
