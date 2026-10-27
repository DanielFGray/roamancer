# atheist has two network cards. The LAN card has a fixed address on fw's LAN and
# carries every outgoing connection. The public card holds OVH's additional IP, the one
# public DNS names point at, with no gateway in the main table: replies from that
# address go back out the public card through table 100, and everything else leaves
# through the LAN.
{ site, ... }:
let
  cluster = site.cluster;
  host = site.hosts.atheist;
  publicAddress = host.publicAddress;
  # OVH's gateway for the additional IP. It is outside the /32, so the route to it is
  # on-link.
  publicGateway = host.publicGateway;
  publicTable = 100;
in
{
  networking.useDHCP = false;
  networking.useNetworkd = true;
  systemd.network.enable = true;

  # Each card is named by its MAC, so the two can never swap.
  systemd.network.links = {
    "10-lan" = {
      matchConfig.PermanentMACAddress = host.lanMac;
      linkConfig.Name = "ens18";
    };
    "10-public" = {
      matchConfig.PermanentMACAddress = host.publicMac;
      linkConfig.Name = "ens19";
    };
  };

  systemd.network.networks = {
    "20-lan" = {
      matchConfig.Name = "ens18";
      # A fixed address: cynic's firewall, Nomad's advertised address and every ssh config
      # name this one. fw leased it by MAC to Debian's dhclient, which sent no client ID;
      # any DHCP client that sends one gets a new lease, as the NixOS installer did (.84).
      address = [ "${cluster.nodes.atheist}/${toString cluster.lanPrefixLength}" ];
      gateway = [ cluster.lanGateway ];
      dns = [ cluster.lanGateway ];
      networkConfig.IPv6AcceptRA = true;
      linkConfig.RequiredForOnline = "routable";
    };
    "20-public" = {
      matchConfig.Name = "ens19";
      address = [ "${publicAddress}/32" ];
      networkConfig = {
        IPv6AcceptRA = false;
        LinkLocalAddressing = "no";
      };
      routes = [
        {
          Destination = "${publicGateway}/32";
          Scope = "link";
          Table = publicTable;
        }
        {
          Gateway = publicGateway;
          GatewayOnLink = true;
          Table = publicTable;
        }
      ];
      routingPolicyRules = [
        {
          From = "${publicAddress}/32";
          Table = publicTable;
          Priority = 100;
        }
      ];
      linkConfig.RequiredForOnline = "no";
    };
  };

  services.resolved.enable = true;

  networking.firewall = {
    enable = true;
    # The public card serves only the web. SSH reaches atheist over the LAN, which the
    # laptop reaches through fw's WireGuard, and over Tailscale.
    interfaces.ens19.allowedTCPPorts = [ 80 443 ];
    interfaces.ens18.allowedTCPPorts = [ host.sshPort ];
    trustedInterfaces = [ "tailscale0" ];
    # A packet to the public address arrives on ens19, but the main table would route a
    # reply to its sender through the LAN; strict reverse-path filtering would drop it.
    checkReversePath = "loose";
    # cynic reaches every TCP port, as atheist reaches every port on cynic: its jobs
    # call services placed here, such as OpenObserve, on Nomad's dynamic ports.
    extraCommands = ''
      iptables -A nixos-fw -i ${cluster.lanInterface} -s ${cluster.lanAddress} -p tcp -j nixos-fw-accept
    '';
  };
}
