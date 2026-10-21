{ lib, pkgs, ... }:
let
  version = "0.9.5";

  # The release binary is static, so it runs without patching. Its build ID matches
  # the workstation copy; the release copy is unstripped, so the hashes differ.
  herdr = pkgs.stdenvNoCC.mkDerivation {
    pname = "herdr";
    inherit version;

    src = pkgs.fetchurl {
      url = "https://github.com/herdrdev/herdr/releases/download/v${version}/herdr-linux-x86_64";
      hash = "sha256-FNnovItKngEY13wyJm921GHwm0A0LrI3UpYL2J9Zkp0=";
    };

    dontUnpack = true;

    installPhase = ''
      install -Dm755 "$src" "$out/bin/herdr"
    '';

    meta = {
      description = "Runtime for coding agents: supervise several agents in one terminal";
      homepage = "https://herdr.dev";
      license = lib.licenses.asl20;
      mainProgram = "herdr";
      platforms = [ "x86_64-linux" ];
    };
  };
in
{
  environment.systemPackages = [ herdr ];
}
