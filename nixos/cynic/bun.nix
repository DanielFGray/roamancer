# The pinned nixpkgs ships Bun 1.3.13. The Alchemy runtime was verified on Bun 1.4.2: it
# uses node:sqlite, and its version 1 bun lock is read by Bun 1.4. The root flake applies
# this overlay to its packages too. It lives under nixos/ because the host flake is built
# from /etc/nixos alone and cannot import files outside it.
final: prev: {
  bun = prev.bun.overrideAttrs (_: {
    version = "1.4.2";
    src = prev.fetchurl {
      url = "https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/bun-linux-x64.zip";
      hash = "sha256-NjaPrvdSeHXV/6UuU81IAhdB8qg+tiCKjdZAaNQiqRM=";
    };
  });
}
