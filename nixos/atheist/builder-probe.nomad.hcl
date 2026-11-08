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
        command = "/bin/sh"
        args = [
          "-ec",
          "printf 'FROM scratch\\nCOPY Dockerfile /\\n' > /tmp/Dockerfile; buildah bud --isolation chroot --storage-driver vfs -t registry.cluster:5000/probe:probe /tmp; buildah push --storage-driver vfs registry.cluster:5000/probe:probe docker://registry.cluster:5000/probe:probe",
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
