#!/usr/bin/env bash
# Bring up the local testground: two Debian VMs on the dlab network, addressed
# and port-mapped exactly as inventory/hosts.yml already expects.
#
# Idempotent by design. Re-running it is how a half-built ground is repaired,
# and `down.sh && up.sh` is how it is reset. Nothing here may require an edit to
# the inventory — the point of the ground is to prove the playbook that ships.
set -euo pipefail

# Must match the VPS. A testground on a different release proves a different
# playbook: apt package names and systemd unit names both move between releases.
RELEASE="${DEBIAN_RELEASE:-bookworm}"
VERSION="${DEBIAN_VERSION:-12}"

URI="qemu:///system"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/dlab-testground"
POOL="$CACHE/disks"
PUBKEY="${TESTGROUND_PUBKEY:-$HOME/.ssh/id_ed25519.pub}"
BASE="$CACHE/debian-${VERSION}-genericcloud-amd64.qcow2"

# name : mac : ip : ssh port -- the ip and port are read from inventory, never chosen here.
NODES=(
  "cynic:52:54:00:13:37:c9:10.13.38.196:2022:4096:2"
  "atheist:52:54:00:13:37:a7:10.13.38.83:10022:6144:2"
)

mkdir -p "$POOL"
[[ -r "$PUBKEY" ]] || { echo "no ssh public key at $PUBKEY" >&2; exit 1; }

# qemu:///system runs the guests as libvirt-qemu, which cannot traverse a home
# directory. Search permission on the path and read on the pool is the whole
# grant; the alternative is putting the disks under /var/lib/libvirt, which
# needs root for something that is otherwise entirely unprivileged.
# Requires user/group = "dan" in /etc/libvirt/qemu.conf, so guests run as the
# owner of this pool. The alternative is granting libvirt-qemu an ACL path into
# a home directory, which then breaks on the second run: libvirt takes ownership
# of the disks it runs, and setfacl cannot touch a file this user no longer
# owns. It also leaves the serial log root-owned 0600 — a boot you cannot read
# is a ground you cannot debug.
if ! grep -qE '^\s*user\s*=\s*"'"$(id -un)"'"' /etc/libvirt/qemu.conf 2>/dev/null; then
  echo "set user/group = \"$(id -un)\" in /etc/libvirt/qemu.conf and restart libvirtd" >&2
  exit 1
fi

# --- network -----------------------------------------------------------------
if ! virsh -c "$URI" net-info dlab-tg &>/dev/null; then
  virsh -c "$URI" net-define "$HERE/network.xml"
fi
virsh -c "$URI" net-start dlab-tg 2>/dev/null || true
virsh -c "$URI" net-autostart dlab-tg

# --- base image --------------------------------------------------------------
if [[ ! -f "$BASE" ]]; then
  echo "fetching debian $VERSION ($RELEASE) cloud image"
  curl -fL --progress-bar \
    "https://cloud.debian.org/images/cloud/$RELEASE/latest/debian-${VERSION}-genericcloud-amd64.qcow2" \
    -o "$BASE.part"
  mv "$BASE.part" "$BASE"
fi

for node in "${NODES[@]}"; do
  IFS=: read -r name m1 m2 m3 m4 m5 m6 ip port mem cpus <<<"$node"
  mac="$m1:$m2:$m3:$m4:$m5:$m6"
  disk="$POOL/$name.qcow2"
  seed="$POOL/$name-seed.iso"

  if virsh -c "$URI" dominfo "$name" &>/dev/null; then
    echo "$name exists; starting if down"
    virsh -c "$URI" start "$name" 2>/dev/null || true
    continue
  fi

  # A qcow2 overlay, so resetting a node is deleting one file rather than
  # re-downloading the image.
  qemu-img create -f qcow2 -F qcow2 -b "$BASE" "$disk" 20G >/dev/null
  qemu-img resize "$disk" 20G >/dev/null

  # sshd moves to the port the inventory already names. Debian's stock config
  # Includes this directory, so a drop-in avoids editing the shipped file.
  cat > "$POOL/$name-user-data" <<EOF
#cloud-config
hostname: $name
fqdn: $name.dlab
preserve_hostname: false
users:
  - name: dan
    groups: [sudo]
    shell: /bin/bash
    sudo: "ALL=(ALL) NOPASSWD:ALL"
    ssh_authorized_keys:
      - $(cat "$PUBKEY")
write_files:
  - path: /etc/ssh/sshd_config.d/99-testground.conf
    content: |
      Port $port
      PasswordAuthentication no
packages: [python3, sudo]
package_update: true
runcmd:
  - [systemctl, restart, ssh]
EOF
  cat > "$POOL/$name-meta-data" <<EOF
instance-id: $name-0
local-hostname: $name
EOF
  cloud-localds "$seed" "$POOL/$name-user-data" "$POOL/$name-meta-data"

  virt-install --connect "$URI" --name "$name" \
    --memory "$mem" --vcpus "$cpus" --cpu host-passthrough \
    --disk "path=$disk,format=qcow2,bus=virtio" \
    --disk "path=$seed,device=cdrom" \
    --network "network=dlab-tg,mac=$mac,model=virtio" \
    --os-variant "debian${VERSION}" \
    --serial "file,path=$POOL/$name-console.log" \
    --graphics none --noautoconsole --import
  echo "created $name at $ip:$port"
done

echo
echo "waiting for cloud-init; then:"
echo "  ansible -i inventory/hosts.yml all -m ping"
