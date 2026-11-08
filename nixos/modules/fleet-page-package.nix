# The fleet page: static files that the fleet service (`alchemy-runner fleet serve`)
# serves beside its snapshot API. Built with Vite from tools/alchemy/web; only the built
# files reach the output, so the build tools stay out of the runner's closure.
{
  lib,
  stdenv,
  stdenvNoCC,
  bun,
  bun2nix,
  autoPatchelfHook,
}:

stdenvNoCC.mkDerivation {
  pname = "alchemy-fleet-page";
  version = "0.1.0";
  src = ../../tools/alchemy;

  # The bundler (Rolldown), the CSS minifier (LightningCSS) and the Solid compiler are
  # prebuilt native modules that need glibc and libgcc_s. The sandbox has no /lib, so
  # autoPatchelf points them at the Nix store before Vite loads them.
  nativeBuildInputs = [ bun2nix.hook autoPatchelfHook ];
  buildInputs = [ stdenv.cc.cc.lib ];
  # Bun also installs the musl builds of Rolldown; glibc never loads them.
  autoPatchelfIgnoreMissingDeps = [ "libc.musl-x86_64.so.1" ];

  bunDeps = bun2nix.fetchBunDeps { bunNix = ../../tools/alchemy/bun.nix; };
  # Nix cache entries are immutable and owned by a different build user.
  bunInstallFlags = [ "--frozen-lockfile" "--linker=isolated" "--backend=copyfile" ];
  dontUseBunCheck = true;

  buildPhase = ''
    runHook preBuild
    autoPatchelf node_modules
    ${bun}/bin/bun run build:web
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    cp -R web/dist "$out"
    runHook postInstall
  '';

  meta = {
    description = "Fleet page served by the Alchemy fleet service";
    platforms = lib.platforms.linux;
  };
}
