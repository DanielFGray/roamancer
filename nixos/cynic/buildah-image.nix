# Platform image for Nomad batch builds: Buildah nested in the builder user's rootless
# Podman. Measured working with --isolation chroot and --storage-driver vfs
# (docs/design/continuous-deployment.md, 2026-11-08).
{ pkgs, registryCa }:
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
    mkdir -p etc/containers "etc/containers/certs.d/registry.cluster:5000"
    cp ${registriesConf} etc/containers/registries.conf
    cp ${storageConf} etc/containers/storage.conf
    # Public cluster CA from cluster-tls (nixos/cynic/registry-ca.crt). Rotate with the
    # CA: copy /var/lib/registry-ca/ca.crt from cynic and rebuild this image.
    cp ${registryCa} "etc/containers/certs.d/registry.cluster:5000/ca.crt"
  '';
  enableFakechroot = true;
  config = {
    Entrypoint = [ "${pkgs.buildah}/bin/buildah" ];
    Env = [
      "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
      "BUILDAH_ISOLATION=chroot"
    ];
  };
}
