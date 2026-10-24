# Nomad from HashiCorp's release zip, pinned by hash.
{ stdenvNoCC, fetchurl, autoPatchelfHook, unzip, glibc, zlib }:
stdenvNoCC.mkDerivation {
  pname = "nomad";
  version = "2.0.7";
  src = fetchurl {
    url = "https://releases.hashicorp.com/nomad/2.0.7/nomad_2.0.7_linux_amd64.zip";
    hash = "sha256-TJuKCFDW/Zyq27qwmz5v34t3qnd3KVQ8cMYbhazKaME=";
  };
  nativeBuildInputs = [ autoPatchelfHook unzip ];
  buildInputs = [ glibc zlib ];
  dontUnpack = true;
  dontBuild = true;
  installPhase = ''
    unzip -p $src nomad > nomad
    install -Dm755 nomad $out/bin/nomad
  '';
}
