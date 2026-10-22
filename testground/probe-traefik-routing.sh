#!/bin/sh
# Run on the Nomad host. This submits only a disposable backend job.
set -eu
: "${NOMAD_TOKEN:?Set a Nomad token that can submit and purge the probe job}"
export NOMAD_ADDR="${NOMAD_ADDR:-http://127.0.0.1:4646}"
ingress="${TRAEFIK_PROBE_URL:-http://127.0.0.1:18080}"
job="zz-ingress-routing-$$"
work=$(mktemp -d)
cleanup() {
  nomad job stop -purge "$job" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
render() {
  cat > "$work/job.nomad" <<EOF
job "$job" {
  datacenters = ["dc1"]
  group "probe" {
    network {
      port "http" { to = 8080 }
    }
    service {
      name = "$job"
      provider = "nomad"
      port = "http"
      tags = [
        "traefik.enable=true",
        "traefik.http.routers.$job.rule=Host(\u0060$1\u0060)",
        "traefik.http.routers.$job.entrypoints=web"
      ]
    }
    task "backend" {
      driver = "podman"
      config {
        image = "docker.io/library/busybox:1.37"
        network_mode = "bridge"
        ports = ["http"]
        command = "sh"
        args = ["-ec", "echo ingress-routing-proof > /tmp/index.html; exec httpd -f -p 8080 -h /tmp"]
      }
      resources {
        cpu = 100
        memory = 64
      }
    }
  }
}
EOF
  nomad job run -detach "$work/job.nomad"
}
wait_route() {
  attempt=0
  while [ "$attempt" -lt 90 ]; do
    if curl -fsS --max-time 3 -H "Host: $1" "$ingress/" > "$work/body" 2>/dev/null &&
      grep -qx ingress-routing-proof "$work/body"; then
      return
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
  echo "FAIL: tagged backend route did not become available" >&2
  exit 1
}
curl -fsS --max-time 5 "$ingress/_traefik/health" > "$work/health"
grep -qx OK "$work/health"
render "$job.invalid"
wait_route "$job.invalid"
render "$job-updated.invalid"
wait_route "$job-updated.invalid"
code=$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' -H "Host: $job.invalid" "$ingress/")
test "$code" = 404
printf '%s\n' "PASS: ingress health, workload-identity service discovery, tagged backend routing and route update"
