job "deploy-site" {
  datacenters = ["home"]
  type        = "batch"

  constraint {
    attribute = "${node.class}"
    value     = "web"
  }

  parameterized {
    payload       = "forbidden"
    meta_required = ["site"]
  }

  group "build" {
    task "build" {
      driver = "raw_exec"

      # NOTE: raw_exec runs as Nomad's user (root). The deploy script
      # only touches /home/dan/build and /srv/www which are owned by dan.
      # For better isolation, consider switching to docker driver with
      # oven/bun image + volume mounts.
      config {
        command = "/opt/nomad/scripts/deploy-site.sh"
        args    = ["${NOMAD_META_site}"]
      }

      resources {
        cpu    = 500
        memory = 1024
      }
    }
  }
}
