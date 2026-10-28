{ pkgs }:
let
  inherit (pkgs) lib;
  postgresql = pkgs.postgresql_17;

  # callPackage binds postgresqlBuildExtension to this postgresql.
  pg_hashids = postgresql.pkgs.callPackage ({ postgresqlBuildExtension }: postgresqlBuildExtension (finalAttrs: {
    pname = "pg_hashids";
    version = "1.2.1";
    src = pkgs.fetchFromGitHub {
      owner = "iCyberon";
      repo = "pg_hashids";
      tag = "v${finalAttrs.version}";
      hash = "sha256-2yQ0JrhwZF9dGEIydOviDpQ+3ZhJ8T16dQt6KIirAJ0=";
    };
  })) { };

  # Every extension an app may declare in its cartridge. The Postgres.Database provider
  # creates the declared ones in the app's database and fails on any not listed here.
  server = postgresql.withPackages (ps: [
    pg_hashids
    ps.pgtap
    ps.pgvector
    ps.pgsodium
  ]);

  # The data volume's mount point is owned by container uid 999 (nixos/cynic/nomad.nix),
  # the uid the official postgres image used, so this image keeps it.
  uid = "999";

  # The builtin C.UTF-8 locale does not depend on glibc, so a nixpkgs update cannot change the
  # sort order of stored text and corrupt its indexes. Apps that need linguistic order name an
  # ICU collation on the column or query.
  #
  # Same contract as the official image, which the platform data cartridge relies on:
  # an empty PGDATA is initialized with POSTGRES_PASSWORD for the postgres superuser,
  # local socket connections are trusted, and network logins use scram-sha-256.
  start = pkgs.writeShellApplication {
    name = "postgres-start";
    runtimeInputs = [ server pkgs.coreutils ];
    text = ''
      : "''${PGDATA:?}"
      if [ ! -s "$PGDATA/PG_VERSION" ]; then
        : "''${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD to initialize an empty PGDATA}"
        pwfile=$(mktemp)
        printf '%s' "$POSTGRES_PASSWORD" > "$pwfile"
        initdb --username=postgres --pwfile="$pwfile" --encoding=UTF8 \
          --locale-provider=builtin --builtin-locale=C.UTF-8 --locale=C.UTF-8 \
          --auth-local=trust --auth-host=scram-sha-256
        rm "$pwfile"
        echo "host all all all scram-sha-256" >> "$PGDATA/pg_hba.conf"
      fi
      # pgsodium's event trigger reads this GUC; without shared_preload it is
      # unknown unless set at startup. off keeps key-as-argument mode usable
      # (migrations/DDL) while the trigger remains installed.
      exec postgres -c listen_addresses='*' -c pgsodium.enable_event_trigger=off
    '';
  };
in
pkgs.dockerTools.buildLayeredImage {
  name = "platform-postgres";
  tag = "17";
  contents = [ server start pkgs.bashInteractive pkgs.coreutils ];
  fakeRootCommands = ''
    mkdir -p etc tmp run/postgresql
    chmod 1777 tmp
    echo "root:x:0:0::/root:/bin/sh" > etc/passwd
    echo "postgres:x:${uid}:${uid}::/var/lib/postgresql:/bin/sh" >> etc/passwd
    echo "root:x:0:" > etc/group
    echo "postgres:x:${uid}:" >> etc/group
    chown ${uid}:${uid} run/postgresql
  '';
  enableFakechroot = true;
  config = {
    User = "${uid}:${uid}";
    Entrypoint = [ "${start}/bin/postgres-start" ];
    Env = [
      "PGHOST=/run/postgresql"
    ];
    ExposedPorts."5432/tcp" = { };
  };
}
