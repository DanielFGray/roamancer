job "backups" {
  datacenters = ["home"]
  type        = "batch"

  constraint {
    attribute = "${node.class}"
    value     = "web"
  }

  periodic {
    crons            = ["0 3 * * *"]  # daily at 3am
    prohibit_overlap = true
  }

  group "postgres-backup" {
    task "pg-dump" {
      driver = "docker"

      config {
        image   = "postgres:17-alpine"
        command = "/bin/sh"
        args    = ["-c", <<-EOF
          set -eu
          STAMP=$(date +%Y%m%d-%H%M%S)
          mkdir -p /backups/postgres
          pg_dumpall -h postgres.service.consul -U postgres \
            | gzip > "/backups/postgres/all-${STAMP}.sql.gz"

          # keep last 7 days
          find /backups/postgres -name '*.sql.gz' -mtime +7 -delete
          echo "Backup complete: all-${STAMP}.sql.gz"
        EOF
        ]
        volumes = ["/opt/nomad/backups:/backups"]
      }

      vault {
        policies = ["infra"]
      }

      template {
        data = <<-EOF
          {{ with secret "secret/data/infra" }}
          PGPASSWORD={{ .Data.data.postgres_password }}
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

  group "vault-backup" {
    task "snapshot" {
      driver = "raw_exec"

      config {
        command = "/bin/bash"
        args    = ["-c", <<-EOF
          set -eu
          STAMP=$(date +%Y%m%d-%H%M%S)
          mkdir -p /opt/nomad/backups/vault
          tar czf "/opt/nomad/backups/vault/vault-${STAMP}.tar.gz" \
            -C /opt/vault data

          # keep last 7 days
          find /opt/nomad/backups/vault -name '*.tar.gz' -mtime +7 -delete
          echo "Vault backup: vault-${STAMP}.tar.gz"
        EOF
        ]
      }

      resources {
        cpu    = 100
        memory = 64
      }
    }
  }
}
