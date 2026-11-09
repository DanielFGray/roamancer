# Probe for ts-ba95f0: after `ops rebuild` of atheist and cynic, and after
# `ops image buildah-image` prints the platform-buildah digest, run from cynic
# (operator Nomad token):
#
#   nomad job run -var="image=registry.cluster:5000/platform-buildah@sha256:..." \
#     nixos/atheist/builder-probe.nomad.hcl
#
# Expect: job complete; `curl -fk https://registry.cluster:5000/v2/probe/tags/list`
# shows probe; from a one-shot builder alloc, cynic:8200 is refused and :5000 answers.
variable "image" {
  type        = string
  description = "platform-buildah reference from ops image buildah-image"
}

job "builder-probe" {
  type = "batch"

  constraint {
    attribute = "${meta.builder}"
    value     = "true"
  }

  group "build" {
    restart {
      attempts = 0
    }

    task "buildah" {
      driver = "podman"

      config {
        image   = var.image
        socket  = "builder"
        # The node's registry CA folder (site.toml registryCaDir), read-only. A volumes
        # string cannot hold the colon in certs.d/registry.cluster:5000, so the script
        # links the folder there, as the hosts' /etc/containers/certs.d does.
        volumes = ["/var/lib/registry-ca:/run/registry-ca:ro"]
        command = "/bin/sh"
        args = [
          "-ec",
          <<-EOT
          mkdir -p /etc/containers/certs.d
          ln -s /run/registry-ca /etc/containers/certs.d/registry.cluster:5000
          printf 'FROM busybox\nRUN echo probe > /probe\n' > /tmp/Dockerfile
          buildah bud --isolation chroot --storage-driver vfs -t registry.cluster:5000/probe:probe /tmp
          buildah push --storage-driver vfs registry.cluster:5000/probe:probe docker://registry.cluster:5000/probe:probe
          EOT
        ]
      }

      resources {
        cpu        = 500
        memory     = 256
        memory_max = 2048
      }
    }
  }
}
