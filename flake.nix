{
  description = "NixOS host and Alchemy runtime for server-ansible";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/cd4ea8d57de16f4810bc5f14207bac45fbf19f67";
    bun2nix = {
      url = "github:nix-community/bun2nix/0f2a1f0b6f42cebe3b149bf62d38754c5e0e9729";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    disko = {
      url = "github:nix-community/disko/v1.12.0";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    nixos-generators = {
      url = "github:nix-community/nixos-generators";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    # The installation's own facts, as a folder that holds site.toml. The folder shipped
    # here holds placeholder values; pass yours with `--override-input site path:<folder>`.
    site = { url = "path:./nixos/site"; flake = false; };
  };

  outputs = { self, nixpkgs, bun2nix, disko, nixos-generators, site, ... }:
    let
      system = "x86_64-linux";
      siteConfig = builtins.fromTOML (builtins.readFile "${site}/site.toml");
      pkgs = import nixpkgs {
        inherit system;
        overlays = [
          bun2nix.overlays.default
          (import ./nixos/cynic/bun.nix)
        ];
      };
    in {
      packages.${system} = {
        alchemy-staged = pkgs.callPackage ./nixos/testground/alchemy-staged-package.nix { };

        # Disposable QEMU image of the same host config. It lives here, not in a
        # nested flake, so the shared modules under nixos/modules are in its source.
        testground-vm = nixos-generators.nixosGenerate {
          inherit system;
          format = "qcow";
          specialArgs = { site = siteConfig; siteDir = site; };
          modules = [
            ./nixos/testground/configuration.nix
            ./nixos/modules/alchemy-staged.nix
            {
              services.alchemyStaged = {
                enable = true;
                package = self.packages.${system}.alchemy-staged;
              };
            }
          ];
        };
      };

      nixosConfigurations.cynic = nixpkgs.lib.nixosSystem {
        inherit system;
        specialArgs = { site = siteConfig; siteDir = site; };
        modules = [
          disko.nixosModules.disko
          ./nixos/cynic/configuration.nix
          ./nixos/modules/alchemy-staged.nix
          {
            services.alchemyStaged = {
              enable = true;
              package = self.packages.${system}.alchemy-staged;
            };
          }
        ];
      };
    };
}
