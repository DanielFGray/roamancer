{
  description = "NixOS host and Alchemy runtime for server-ansible";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/cd4ea8d57de16f4810bc5f14207bac45fbf19f67";
    bun2nix = {
      url = "github:nix-community/bun2nix/0f2a1f0b6f42cebe3b149bf62d38754c5e0e9729";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    nixos-generators = {
      url = "github:nix-community/nixos-generators";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, bun2nix, nixos-generators, ... }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs {
        inherit system;
        overlays = [
          bun2nix.overlays.default
          # The pinned nixpkgs ships Bun 1.3.13. The Alchemy runtime was verified on Bun 1.4.2,
          # and its version 1 bun lock is read by Bun 1.4. Applies to this flake's packages only.
          (final: prev: {
            bun = prev.bun.overrideAttrs (_: {
              version = "1.4.2";
              src = prev.fetchurl {
                url = "https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/bun-linux-x64.zip";
                hash = "sha256-NjaPrvdSeHXV/6UuU81IAhdB8qg+tiCKjdZAaNQiqRM=";
              };
            });
          })
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
        modules = [
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
