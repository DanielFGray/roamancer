# Facts the cluster modules share. cynic is the only Nomad server; other machines join
# as Nomad clients over the LAN, the Proxmox bridge shared with other tenants, with no
# tunnel. The laptop reaches that LAN through fw's WireGuard.
{
  lanInterface = "ens18";
  # From fw's DHCP, which has kept it stable. If the lease ever changes, the server
  # certificate, Raft's peer address and every client's `servers` entry break together.
  lanAddress = "10.13.37.196";
  # Machines that run Nomad clients, by Nomad node name. The firewall lets them reach
  # every TCP port here, so their jobs reach services such as Postgres's fixed 5432
  # and Nomad's dynamic ports. atheist lets cynic reach every TCP port in turn, for
  # services Nomad places there. Every listener on the LAN has its own authentication;
  # the address list only narrows who can try, on a bridge where addresses can be
  # forged.
  nodes = { atheist = "10.13.37.83"; };
  # The laptop's WireGuard address. It may reach only the listeners behind the cluster CA
  # (cluster-tls.nix): images are pushed from it, and test VMs on the laptop join from it.
  workstation = "10.10.10.3";
  # Every machine reaches the image registry on cynic by this name, which each one maps
  # to lanAddress in /etc/hosts, so a new lease changes no image reference.
  registryName = "registry.cluster";
  registryPort = 5000;
  # The cluster CA and leaf certificates. Root-only; never in the Nix store.
  tlsDir = "/var/lib/cluster-tls";
  # cynic's own client certificate for pulling from the registry, readable by the nomad
  # user, whose rootless Podman pulls every job's image.
  registryClientDir = "/var/lib/registry-client";
}
