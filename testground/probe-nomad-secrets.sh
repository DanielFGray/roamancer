#!/bin/sh
# Run on the Nomad client host with NOMAD_TOKEN set. Uses only a dummy value.
# This checks the mount shared by Nomad and rootless Podman, not OpenBao login.
set -eu

: "${NOMAD_TOKEN:?Set a Nomad token that can submit, inspect, exec, and purge the probe job}"
export NOMAD_ADDR="${NOMAD_ADDR:-http://127.0.0.1:4646}"
job="zz-secret-mount-$$"
work=$(mktemp -d)
cleanup() {
  nomad job stop -purge "$job" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

cat > "$work/job.nomad" <<EOF
job "$job" {
  datacenters = ["dc1"]
  type = "service"
  group "probe" {
    task "probe" {
      driver = "podman"
      config {
        image = "docker.io/library/busybox:1.37"
        network_mode = "bridge"
        command = "sh"
        args = ["-c", "sleep 300"]
      }
      template {
        data = "nomad-secret-mount-probe"
        destination = "secrets/probe"
        perms = "0400"
        uid = 1001
        gid = 1001
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
alloc=""
attempt=0
while [ "$attempt" -lt 90 ]; do
  alloc=$(nomad job allocs -json "$job" | jq -r '[.[] | select(.ClientStatus == "running")][0].ID // empty')
  if [ -n "$alloc" ]; then break; fi
  attempt=$((attempt + 1))
  sleep 1
done
if [ -z "$alloc" ]; then
  echo "FAIL: probe allocation did not start within 90 seconds" >&2
  nomad job status "$job"
  exit 1
fi

if ! nomad alloc exec -i=false -task probe "$alloc" \
  grep -qx nomad-secret-mount-probe /secrets/probe; then
  echo "FAIL: rendered secret file is not readable inside the Podman task" >&2
  exit 1
fi
secrets="/var/lib/nomad/alloc/$alloc/probe/secrets"
if [ "$(findmnt -n -o FSTYPE --target "$secrets")" != tmpfs ]; then
  echo "FAIL: the host does not see the secrets directory on tmpfs" >&2
  exit 1
fi
case ",$(findmnt -n -o OPTIONS --target "$secrets")," in
  *,noswap,*) ;;
  *) echo "FAIL: the secrets mount permits swap" >&2; exit 1 ;;
esac
printf '%s\n' "PASS: bridge-network Podman task reads the rendered dummy secret; host mount is tmpfs with noswap"
