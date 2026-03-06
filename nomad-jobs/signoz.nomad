job "signoz" {
  datacenters = ["home"]
  type        = "service"

  constraint {
    attribute = "${node.class}"
    value     = "obs"
  }

  group "zookeeper" {
    network {
      port "client" { to = 2181 }
    }

    volume "zookeeper-data" {
      type   = "host"
      source = "zookeeper-data"
    }

    task "zookeeper" {
      driver = "docker"

      config {
        image = "signoz/zookeeper:3.7.1"
        ports = ["client"]
      }

      volume_mount {
        volume      = "zookeeper-data"
        destination = "/bitnami/zookeeper"
      }

      env {
        ZOO_SERVER_ID          = "1"
        ALLOW_ANONYMOUS_LOGIN  = "yes"
        ZOO_AUTOPURGE_INTERVAL = "1"
      }

      resources {
        cpu    = 200
        memory = 256
      }

      service {
        name = "signoz-zookeeper"
        port = "client"

        check {
          type     = "tcp"
          interval = "10s"
          timeout  = "5s"
        }
      }
    }
  }

  group "clickhouse" {
    network {
      port "http" { to = 8123 }
      port "tcp"  { to = 9000 }
    }

    volume "clickhouse-data" {
      type   = "host"
      source = "clickhouse-data"
    }

    task "clickhouse" {
      driver = "docker"

      config {
        image = "clickhouse/clickhouse-server:25.5.6"
        ports = ["http", "tcp"]
      }

      volume_mount {
        volume      = "clickhouse-data"
        destination = "/var/lib/clickhouse"
      }

      env {
        CLICKHOUSE_SKIP_USER_SETUP = "1"
      }

      resources {
        cpu    = 500
        memory = 1024
      }

      service {
        name = "signoz-clickhouse"
        port = "http"

        check {
          type     = "http"
          path     = "/ping"
          interval = "10s"
          timeout  = "5s"
        }
      }
    }
  }

  group "signoz-app" {
    network {
      port "ui" {
        static = 8080
        to     = 8080
      }
    }

    volume "signoz-data" {
      type   = "host"
      source = "signoz-data"
    }

    task "signoz" {
      driver = "docker"

      config {
        image = "signoz/signoz:v0.111.0"
        ports = ["ui"]
      }

      volume_mount {
        volume      = "signoz-data"
        destination = "/var/lib/signoz"
      }

      # Use Consul DNS to find clickhouse
      env {
        SIGNOZ_ALERTMANAGER_PROVIDER         = "signoz"
        SIGNOZ_TELEMETRYSTORE_CLICKHOUSE_DSN = "tcp://signoz-clickhouse.service.consul:9000"
        SIGNOZ_SQLSTORE_SQLITE_PATH          = "/var/lib/signoz/signoz.db"
        STORAGE                              = "clickhouse"
        GODEBUG                              = "netdns=go"
        DEPLOYMENT_TYPE                      = "docker-standalone-amd"
      }

      resources {
        cpu    = 500
        memory = 512
      }

      service {
        name = "signoz"
        port = "ui"

        check {
          type     = "http"
          path     = "/api/v1/health"
          interval = "10s"
          timeout  = "5s"
        }
      }
    }
  }

  group "otel-collector" {
    network {
      port "grpc" {
        static = 4317
        to     = 4317
      }
      port "http" {
        static = 4318
        to     = 4318
      }
    }

    task "otel-collector" {
      driver = "docker"

      config {
        image   = "signoz/signoz-otel-collector:v0.142.0"
        ports   = ["grpc", "http"]
        args    = ["--config=/etc/otel-collector-config.yaml"]
        volumes = ["local/otel-collector-config.yaml:/etc/otel-collector-config.yaml"]
      }

      template {
        data = <<-EOF
          receivers:
            otlp:
              protocols:
                grpc:
                  endpoint: 0.0.0.0:4317
                http:
                  endpoint: 0.0.0.0:4318
                  cors:
                    allowed_origins:
                      - "*"

          processors:
            batch:
              send_batch_size: 10000
              timeout: 1s

          exporters:
            clickhousetraces:
              datasource: tcp://signoz-clickhouse.service.consul:9000
            clickhousemetricswrite:
              endpoint: tcp://signoz-clickhouse.service.consul:9000
            clickhouselogsexporter:
              dsn: tcp://signoz-clickhouse.service.consul:9000

          service:
            pipelines:
              traces:
                receivers: [otlp]
                processors: [batch]
                exporters: [clickhousetraces]
              metrics:
                receivers: [otlp]
                processors: [batch]
                exporters: [clickhousemetricswrite]
              logs:
                receivers: [otlp]
                processors: [batch]
                exporters: [clickhouselogsexporter]
        EOF
        destination = "local/otel-collector-config.yaml"
      }

      env {
        OTEL_RESOURCE_ATTRIBUTES        = "host.name=signoz-host,os.type=linux"
        LOW_CARDINAL_EXCEPTION_GROUPING = "false"
      }

      resources {
        cpu    = 300
        memory = 512
      }

      service {
        name = "otel-collector"
        port = "http"

        check {
          type     = "tcp"
          interval = "10s"
          timeout  = "5s"
        }
      }
    }
  }
}
