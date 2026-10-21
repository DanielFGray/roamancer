{
  description = "Disposable NixOS image for rootless Podman with Nomad";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    nixos-generators = {
      url = "github:nix-community/nixos-generators";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    bun2nix = {
      url = "github:nix-community/bun2nix/0f2a1f0b6f42cebe3b149bf62d38754c5e0e9729";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  nixConfig = {
    extra-substituters = [ "https://nix-community.cachix.org" ];
    extra-trusted-public-keys = [
      "nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs="
    ];
  };

  outputs = { self, nixpkgs, nixos-generators, bun2nix, ... }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs {
        inherit system;
        overlays = [ bun2nix.overlays.default ];
      };
    in {
      packages.${system} = {
        alchemy-staged = pkgs.callPackage ./alchemy-staged-package.nix { };
        default = nixos-generators.nixosGenerate {
          inherit system;
          format = "qcow";
          modules = [
            ./configuration.nix
            ../modules/alchemy-staged.nix
            ({ ... }: {
              services.alchemyStaged = {
                enable = true;
                package = self.packages.${system}.alchemy-staged;
              };
            })
          ];
        };
      };
    };
}
