{
  description = "NixOS configurations for the cluster's machines";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/cd4ea8d57de16f4810bc5f14207bac45fbf19f67";
  inputs.disko.url = "github:nix-community/disko/v1.12.0";
  inputs.disko.inputs.nixpkgs.follows = "nixpkgs";

  # One flake for every host, so their shared modules (modules/, cluster.nix) are inside
  # its source: a host's own folder cannot import files outside itself.
  outputs = { nixpkgs, disko, ... }:
    let
      host = configuration: nixpkgs.lib.nixosSystem {
        system = "x86_64-linux";
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
