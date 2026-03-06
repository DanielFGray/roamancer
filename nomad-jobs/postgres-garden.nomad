job "postgres-garden" {
  datacenters = ["home"]
  type        = "service"

  constraint {
    attribute = "${node.class}"
    value     = "web"
  }

  group "app" {
    count = 1

    network {
      port "http" {
        static = 3000
        to     = 3000
      }
    }

    task "build" {
      # Build the image locally before the app starts.
      # On multi-node with a registry, replace this with a push/pull workflow.
      driver = "raw_exec"

      lifecycle {
        hook    = "prestart"
        sidecar = false
      }

      config {
        command = "/bin/bash"
        args = ["-c", <<-EOF
          cd /home/dan/build/postgres.garden
          git pull --ff-only || true
          docker build -t postgresgarden-app:latest .
        EOF
        ]
      }

      resources {
        cpu    = 500
        memory = 1024
      }
    }

    task "app" {
      driver = "docker"

      config {
        image = "postgresgarden-app:latest"
        ports = ["http"]
      }

      vault {
        policies = ["postgres-garden"]
      }

      template {
        data = <<-EOF
          NODE_ENV=production
          PORT=3000
          {{ with secret "secret/data/postgres-garden" }}
          ROOT_DATABASE_USER={{ .Data.data.root_database_user }}
          ROOT_DATABASE_PASSWORD={{ .Data.data.root_database_password }}
          ROOT_DATABASE_URL={{ .Data.data.root_database_url }}
          DATABASE_HOST={{ .Data.data.database_host }}
          DATABASE_PORT={{ .Data.data.database_port }}
          DATABASE_NAME={{ .Data.data.database_name }}
          DATABASE_OWNER={{ .Data.data.database_owner }}
          DATABASE_OWNER_PASSWORD={{ .Data.data.database_owner_password }}
          DATABASE_URL={{ .Data.data.database_url }}
          DATABASE_AUTHENTICATOR={{ .Data.data.database_authenticator }}
          DATABASE_AUTHENTICATOR_PASSWORD={{ .Data.data.database_authenticator_password }}
          SHADOW_DATABASE_PASSWORD={{ .Data.data.shadow_database_password }}
          SHADOW_DATABASE_URL={{ .Data.data.shadow_database_url }}
          AUTH_DATABASE_URL={{ .Data.data.auth_database_url }}
          DATABASE_VISITOR={{ .Data.data.database_visitor }}
          SECRET={{ .Data.data.secret }}
          VALKEY_URL={{ .Data.data.valkey_url }}
          VITE_ROOT_URL={{ .Data.data.vite_root_url }}
          OTEL_EXPORTER_OTLP_ENDPOINT={{ .Data.data.otel_exporter_otlp_endpoint }}
          VITE_OTEL_COLLECTOR_URL={{ .Data.data.vite_otel_collector_url }}
          GITHUB_KEY={{ .Data.data.github_client_id }}
          GITHUB_SECRET={{ .Data.data.github_client_secret }}
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
        name = "postgres-garden"
        port = "http"

        check {
          type     = "http"
          path     = "/"
          interval = "10s"
          timeout  = "3s"
        }
      }
    }

    task "worker" {
      driver = "docker"

      config {
        image   = "postgresgarden-app:latest"
        command = "sh"
        args    = ["-c", "cd worker && bun graphile-worker"]
      }

      vault {
        policies = ["postgres-garden"]
      }

      template {
        data = <<-EOF
          NODE_ENV=production
          {{ with secret "secret/data/postgres-garden" }}
          DATABASE_URL={{ .Data.data.database_url }}
          {{ end }}
        EOF
        destination = "secrets/env"
        env         = true
      }

      resources {
        cpu    = 200
        memory = 256
      }
    }
  }
}
