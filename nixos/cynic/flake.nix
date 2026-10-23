{
  description = "NixOS configuration for the cynic production node";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/cd4ea8d57de16f4810bc5f14207bac45fbf19f67";
  inputs.disko.url = "github:nix-community/disko/v1.12.0";
  inputs.disko.inputs.nixpkgs.follows = "nixpkgs";

  outputs = { nixpkgs, disko, ... }: {
    nixosConfigurations.cynic = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [ disko.nixosModules.disko ./configuration.nix ];
    };
    packages.x86_64-linux.postgres-image =
      import ./postgres-image.nix { pkgs = nixpkgs.legacyPackages.x86_64-linux; };
  };
}
