{
  description = "NixOS hosts and Alchemy runtime for server-ansible";

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
    # `ops rebuild` and `ops install` override this input with your site folder.
    site = { url = "path:./nixos/site"; flake = false; };
    # The server-ansible commit this build is from, in the folder's `rev` file. Nix hides
    # self.rev once an input is overridden, and `ops rebuild` overrides site, so rebuild
    # overrides this input too, with the commit it switches to. Empty here: no revision.
    build = { url = "path:./nixos/build"; flake = false; };
  };

  outputs = { self, nixpkgs, bun2nix, disko, nixos-generators, site, build, ... }:
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
      # One flake for every host, so shared modules and tools/alchemy are inside its source.
      host = configuration: nixpkgs.lib.nixosSystem {
        inherit system;
        specialArgs = { site = siteConfig; siteDir = site; };
        modules = [
          disko.nixosModules.disko
          configuration
          ./nixos/modules/alchemy-runner.nix
          {
            services.alchemyRunner.package = self.packages.${system}.alchemy-runner;
          }
        ];
      };
    in {
      packages.${system} = {
        alchemy-runner = pkgs.callPackage ./nixos/modules/alchemy-runner-package.nix {
          # With no recorded commit the package omits ALCHEMY_RUNNER_REVISION.
          revision =
            let rev = nixpkgs.lib.trim (builtins.readFile "${build}/rev");
            in if rev == "" then null else rev;
        };

        postgres-image =
          import ./nixos/cynic/postgres-image.nix { pkgs = nixpkgs.legacyPackages.${system}; };

        # Disposable QEMU image of the same host config. It lives here, not in a
        # nested flake, so the shared modules under nixos/modules are in its source.
        testground-vm = nixos-generators.nixosGenerate {
          inherit system;
          format = "qcow";
          specialArgs = { site = siteConfig; siteDir = site; };
          modules = [
            ./nixos/testground/configuration.nix
            ./nixos/modules/alchemy-runner.nix
            {
              services.alchemyRunner = {
                enable = true;
                package = self.packages.${system}.alchemy-runner;
              };
            }
          ];
        };
      };

      nixosConfigurations.cynic = host ./nixos/cynic/configuration.nix;
      nixosConfigurations.atheist = host ./nixos/atheist/configuration.nix;
    };
}
