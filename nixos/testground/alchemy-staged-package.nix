{
  lib,
  stdenvNoCC,
  bash,
  bun,
  bun2nix,
  jq,
  makeWrapper,
  util-linux,
}:

stdenvNoCC.mkDerivation {
  pname = "server-alchemy-staged";
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
    timeout 30 "$out/bin/alchemy-cli" --help > /dev/null
    runHook postInstallCheck
  '';

  postPatch = ''
    jq 'del(.devDependencies)' package.json > package.json.tmp
    mv package.json.tmp package.json
    cp bun-production.lock bun.lock
  '';

  installPhase = ''
    mkdir -p "$out/lib/server-alchemy" "$out/bin"
    cp -R . "$out/lib/server-alchemy/"

    makeWrapper ${bun}/bin/bun "$out/bin/alchemy-cli" \
      --add-flags "run" \
      --add-flags "$out/lib/server-alchemy/node_modules/alchemy/bin/cli.js"
    makeWrapper ${bash}/bin/bash "$out/bin/alchemy-staged" \
      --add-flags "$out/lib/server-alchemy/staged-host-runner.sh" \
      --prefix PATH : ${util-linux}/bin \
      --set ALCHEMY_CLI "$out/bin/alchemy-cli" \
      --set ALCHEMY_STACK_FILE "$out/lib/server-alchemy/staged.run.ts" \
      --set ALCHEMY_STAGE staged \
      --set ALCHEMY_STATE_DIR /var/lib/alchemy \
      --set NOMAD_ADDR http://127.0.0.1:4646 \
      --set CADDY_ADMIN_ADDR http://127.0.0.1:2019
  '';

  meta = {
    description = "Pinned Alchemy runtime for staged Nomad releases";
    platforms = lib.platforms.linux;
  };
}
