{ pkgs }:
let
  # garage is still Garage 1, which has no admin API version 2 (tools/alchemy/src/GarageBucket.ts).
  garage = pkgs.garage_2;

  # Only settings that are not secret. GARAGE_ADMIN_TOKEN, from OpenBao, sets the admin token.
  # s3_region must equal garageRegion in GarageBucket.ts: Garage refuses a request signed for
  # any other region. Garage reads /etc/garage.toml by default, so `garage meta snapshot` in a
  # `podman exec` (nixos/cynic/backups.nix) finds the same file.
  config = pkgs.writeText "garage.toml" ''
    metadata_dir = "/var/lib/garage/meta"
    data_dir = "/var/lib/garage/data"
    db_engine = "lmdb"
    replication_factor = 1

    rpc_bind_addr = "127.0.0.1:3901"
    rpc_public_addr = "127.0.0.1:3901"
    rpc_secret_file = "/run/garage/rpc_secret"

    [s3_api]
    s3_region = "garage"
    api_bind_addr = "0.0.0.0:3900"

    [admin]
    api_bind_addr = "0.0.0.0:3903"
  '';

  # The RPC secret authenticates one Garage node to another. With one node, only this server and
  # the garage command in the same container use it, over 127.0.0.1, so each start makes a new
  # one that never leaves the container. A second node would need a shared secret from OpenBao.
  start = pkgs.writeShellApplication {
    name = "garage-start";
    runtimeInputs = [ garage pkgs.coreutils ];
    text = ''
      : "''${GARAGE_ADMIN_TOKEN:?set GARAGE_ADMIN_TOKEN}"
      umask 077
      mkdir -p /run/garage /var/lib/garage/meta /var/lib/garage/data
      od -An -N32 -tx1 /dev/urandom | tr -d ' \n' > /run/garage/rpc_secret
      exec garage server
    '';
  };
in
pkgs.dockerTools.buildLayeredImage {
  name = "platform-garage";
  tag = garage.version;
  contents = [ garage start pkgs.bashInteractive pkgs.coreutils ];
  fakeRootCommands = ''
    mkdir -p etc tmp run
    chmod 1777 tmp
    cp ${config} etc/garage.toml
    echo "root:x:0:0::/root:/bin/sh" > etc/passwd
    echo "root:x:0:" > etc/group
  '';
  enableFakechroot = true;
  # The container's root is the host's nomad user in nomad's rootless user namespace, so the
  # data volume is nomad's, and the nightly backup, which runs as nomad, reads it directly.
  config = {
    Entrypoint = [ "${start}/bin/garage-start" ];
    ExposedPorts = {
      "3900/tcp" = { };
      "3903/tcp" = { };
    };
  };
}
