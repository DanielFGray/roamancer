job "infra" {
  datacenters = ["home"]
  type        = "service"

  constraint {
    attribute = "${node.class}"
    value     = "web"
  }

  group "postgres" {
    network {
      port "db" {
        static = 5432
        to     = 5432
      }
    }

    volume "postgres-data" {
      type   = "host"
      source = "postgres-data"
    }

    task "postgres" {
      driver = "docker"

      config {
        image = "postgres:17-alpine"
        ports = ["db"]
        args  = [
          "postgres",
          "-c", "shared_preload_libraries=pg_stat_statements",
          "-c", "pg_stat_statements.track=all",
        ]
      }

      volume_mount {
        volume      = "postgres-data"
        destination = "/var/lib/postgresql/data"
      }

      vault {
        policies = ["infra"]
      }

      template {
        data = <<-EOF
          {{ with secret "secret/data/infra" }}
          POSTGRES_USER={{ .Data.data.postgres_user }}
          POSTGRES_PASSWORD={{ .Data.data.postgres_password }}
          {{ end }}
        EOF
        destination = "secrets/env"
        env         = true
      }

      resources {
        cpu    = 500
        memory = 512
      }

      service {
        name = "postgres"
        port = "db"

        check {
          type     = "script"
          command  = "pg_isready"
          args     = ["-U", "postgres"]
          interval = "10s"
          timeout  = "5s"
        }
      }
    }
  }

  group "valkey" {
    network {
      port "redis" {
        static = 6379
        to     = 6379
      }
    }

    volume "valkey-data" {
      type   = "host"
      source = "valkey-data"
    }

    task "valkey" {
      driver = "docker"

      config {
        image = "valkey/valkey:8-alpine"
        ports = ["redis"]
        args  = ["valkey-server", "--save", "60", "1", "--loglevel", "warning"]
      }

      volume_mount {
        volume      = "valkey-data"
        destination = "/data"
      }

      resources {
        cpu    = 200
        memory = 256
      }

      service {
        name = "valkey"
        port = "redis"

        check {
          type     = "script"
          command  = "valkey-cli"
          args     = ["ping"]
          interval = "10s"
          timeout  = "5s"
        }
      }
    }
  }
}
