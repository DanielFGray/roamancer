# atheist has two network cards. The LAN card has a fixed address on fw's LAN and
# carries every outgoing connection. The public card holds OVH's additional IP, the one
# public DNS names point at, with no gateway in the main table: replies from that
# address go back out the public card through table 100, and everything else leaves
# through the LAN.
{ config, site, ... }:
let
  cluster = site.cluster;
  host = site.hosts.atheist;
  publicAddress = host.publicAddress;
  # OVH's gateway for the additional IP. It is outside the /32, so the route to it is
  # on-link.
  publicGateway = host.publicGateway;
  publicTable = 100;
  # Rootless Podman's pasta helper leaves the host as the builder user, so an OUTPUT
  # owner match fences the build.
  builderUid = toString config.users.users.builder.uid;
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

      # Builder egress: DNS, the cluster registry, and public HTTP(S) only. Drop the LAN
      # (except the registry), private ranges (the hypervisor is shared), the tailnet,
      # and everything else — including OpenBao 8200, Nomad 4646/4647 and Garage's admin
      # port on cynic. IPv6 gets DNS only: the host has a v6 default route and a tailnet
      # v6 range, and the registry and public web are reached over v4.
      iptables -N builder-egress 2>/dev/null || true
      iptables -F builder-egress
      iptables -D OUTPUT -m owner --uid-owner ${builderUid} -j builder-egress 2>/dev/null || true
      iptables -I OUTPUT -m owner --uid-owner ${builderUid} -j builder-egress
      iptables -A builder-egress -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
      iptables -A builder-egress -p udp --dport 53 -j ACCEPT
      iptables -A builder-egress -p tcp --dport 53 -j ACCEPT
      iptables -A builder-egress -d ${cluster.lanAddress} -p tcp --dport ${toString cluster.registryPort} -j ACCEPT
      iptables -A builder-egress -d ${cluster.lanAddress}/${toString cluster.lanPrefixLength} -j DROP
      for range in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10; do
        iptables -A builder-egress -d "$range" -j DROP
      done
      iptables -A builder-egress -p tcp --dport 80 -j ACCEPT
      iptables -A builder-egress -p tcp --dport 443 -j ACCEPT
      iptables -A builder-egress -j DROP

      ip6tables -N builder-egress 2>/dev/null || true
      ip6tables -F builder-egress
      ip6tables -D OUTPUT -m owner --uid-owner ${builderUid} -j builder-egress 2>/dev/null || true
      ip6tables -I OUTPUT -m owner --uid-owner ${builderUid} -j builder-egress
      ip6tables -A builder-egress -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
      ip6tables -A builder-egress -p udp --dport 53 -j ACCEPT
      ip6tables -A builder-egress -p tcp --dport 53 -j ACCEPT
      ip6tables -A builder-egress -j DROP
    '';
    extraStopCommands = ''
      for ipt in iptables ip6tables; do
        "$ipt" -D OUTPUT -m owner --uid-owner ${builderUid} -j builder-egress 2>/dev/null || true
        "$ipt" -F builder-egress 2>/dev/null || true
        "$ipt" -X builder-egress 2>/dev/null || true
      done
    '';
  };
}
