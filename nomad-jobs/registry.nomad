job "registry" {
  datacenters = ["home"]
  type        = "service"

  constraint {
    attribute = "${node.class}"
    value     = "web"
  }

  group "registry" {
    network {
      port "http" {
        static = 5000
        to     = 5000
      }
    }

    volume "registry-data" {
      type   = "host"
      source = "registry-data"
    }

    task "registry" {
      driver = "docker"

      config {
        image = "registry:2"
        ports = ["http"]
      }

      volume_mount {
        volume      = "registry-data"
        destination = "/var/lib/registry"
      }

      resources {
        cpu    = 100
        memory = 128
      }

      service {
        name = "docker-registry"
        port = "http"

        check {
          type     = "http"
          path     = "/v2/"
          interval = "15s"
          timeout  = "5s"
        }
      }
    }
  }
}
