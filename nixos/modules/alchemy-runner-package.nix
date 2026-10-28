{
  lib,
  stdenvNoCC,
  bun,
  bun2nix,
  jq,
  makeWrapper,
  # server-ansible commit this package was built from (`self.rev`); null when dirty.
  revision ? null,
}:

stdenvNoCC.mkDerivation {
  pname = "alchemy-runner";
  version = "0.1.0";
  src = ../../tools/alchemy;

  nativeBuildInputs = [ bun2nix.hook jq makeWrapper ];
  bunDeps = bun2nix.fetchBunDeps { bunNix = ../../tools/alchemy/bun.nix; };
  # Nix cache entries are immutable and owned by a different build user.
  bunInstallFlags = [ "--frozen-lockfile" "--linker=isolated" "--backend=copyfile" ];
  dontUseBunBuild = true;
  dontUseBunCheck = true;
  doInstallCheck = true;

  installCheckPhase = ''
    runHook preInstallCheck
    timeout 30 "$out/bin/alchemy-runner" --help | grep -q login
    runHook postInstallCheck
  '';

  postPatch = ''
    jq 'del(.devDependencies)' package.json > package.json.tmp
    mv package.json.tmp package.json
    cp bun-production.lock bun.lock
  '';

  installPhase = ''
    mkdir -p "$out/lib/alchemy-runner" "$out/bin"
    cp -R . "$out/lib/alchemy-runner/"

    makeWrapper ${bun}/bin/bun "$out/bin/alchemy-runner" \
      --add-flags "$out/lib/alchemy-runner/src/cli.ts" \
      --set NOMAD_ADDR http://127.0.0.1:4646 \
      --set OPENBAO_ADDR http://127.0.0.1:8200 \
      ${
        if revision == null then
          ""
        else
          "--set ALCHEMY_RUNNER_REVISION ${lib.escapeShellArg revision}"
      }
  '';

  meta = {
    description = "Alchemy host program for the control host";
    platforms = lib.platforms.linux;
  };
}
