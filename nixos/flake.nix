{
  description = "NixOS configurations for the cluster's machines";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/cd4ea8d57de16f4810bc5f14207bac45fbf19f67";
  inputs.disko.url = "github:nix-community/disko/v1.12.0";
  inputs.disko.inputs.nixpkgs.follows = "nixpkgs";
  # The installation's own facts, as a folder that holds site.toml. The folder shipped here
  # holds placeholder values; `ops rebuild` and `install-host.sh` build from a copy of this
  # flake whose site folder is replaced by yours.
  inputs.site = { url = "path:./site"; flake = false; };

  # One flake for every host, so their shared modules (modules/) are inside its source: a
  # host's own folder cannot import files outside itself.
  outputs = { nixpkgs, disko, site, ... }:
    let
      host = configuration: nixpkgs.lib.nixosSystem {
        system = "x86_64-linux";
        specialArgs.site = builtins.fromTOML (builtins.readFile "${site}/site.toml");
        modules = [ disko.nixosModules.disko configuration ];
      };
    in
    {
      nixosConfigurations.cynic = host ./cynic/configuration.nix;
      nixosConfigurations.atheist = host ./atheist/configuration.nix;
      packages.x86_64-linux.postgres-image =
        import ./cynic/postgres-image.nix { pkgs = nixpkgs.legacyPackages.x86_64-linux; };
    };
}
