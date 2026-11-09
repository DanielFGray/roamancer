# Platform image for Nomad batch builds: Buildah nested in the builder user's rootless
# Podman. Measured working with --isolation chroot and --storage-driver vfs
# (docs/design/continuous-deployment.md, 2026-11-08). The image holds no site facts: the
# job mounts the node's registry CA folder at /etc/containers/certs.d/registry.cluster:5000.
{ pkgs }:
let
  registriesConf = pkgs.writeText "registries.conf" ''
    unqualified-search-registries = ["docker.io"]
    short-name-mode = "permissive"
  '';

  # vfs needs no kernel overlay; chroot isolation is set on each buildah invocation.
  storageConf = pkgs.writeText "storage.conf" ''
    [storage]
    driver = "vfs"
  '';

  # Buildah resolves HOME from passwd and refuses to run without a root entry.
  passwd = pkgs.writeText "passwd" "root:x:0:0:root:/root:/bin/sh\n";
  group = pkgs.writeText "group" "root:x:0:\n";
  policy = pkgs.writeText "policy.json" ''{"default":[{"type":"insecureAcceptAnything"}]}'';
in
pkgs.dockerTools.buildLayeredImage {
  name = "platform-buildah";
  tag = "1";
  contents = [
    pkgs.buildah
    pkgs.busybox
    pkgs.cacert
  ];
  fakeRootCommands = ''
    mkdir -p etc/containers root tmp var/tmp
    chmod 1777 tmp var/tmp
    cp ${passwd} etc/passwd
    cp ${group} etc/group
    cp ${registriesConf} etc/containers/registries.conf
    cp ${storageConf} etc/containers/storage.conf
    cp ${policy} etc/containers/policy.json
  '';
  enableFakechroot = true;
  config = {
    Env = [
      "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
      "BUILDAH_ISOLATION=chroot"
    ];
  };
}
