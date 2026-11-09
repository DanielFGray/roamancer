# Proves the builder user's Podman on a worker node: a batch job in the platform-buildah
# image builds a two-line Dockerfile and pushes it to the cluster registry. After
# `ops rebuild` of the nodes, and after `ops image buildah-image` prints the
# platform-buildah digest, run from cynic with a Nomad token that can submit jobs:
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
        image  = var.image
        socket = "builder"
        # The node's registry CA folder (site.toml registryCaDir), read-only. buildah
        # reads it with --cert-dir, so the image holds no site facts.
        volumes = ["/var/lib/registry-ca:/run/registry-ca:ro"]
        command = "/bin/sh"
        args = [
          "-ec",
          <<-EOT
          printf 'FROM busybox\nRUN echo probe > /probe\n' > /tmp/Dockerfile
          buildah bud --isolation chroot --storage-driver vfs --cert-dir /run/registry-ca -t registry.cluster:5000/probe:probe /tmp
          buildah push --storage-driver vfs --cert-dir /run/registry-ca registry.cluster:5000/probe:probe
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
