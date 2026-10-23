#!/bin/sh
# Read-only inventory of atheist for the NixOS rebuild plan. Changes nothing.
# Usage: ssh atheist 'sh -s' < atheist-inventory.sh > atheist-inventory.txt
section() { printf '\n=== %s\n' "$1"; }

section host
uname -a
head -3 /etc/os-release
nproc; free -m | sed -n 2p; df -h / | tail -1
lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT
grep -o -m1 -w avx2 /proc/cpuinfo || echo "no avx2"
cat /sys/class/dmi/id/sys_vendor /sys/class/dmi/id/product_name 2>/dev/null
[ -d /sys/firmware/efi ] && echo boot=uefi || echo boot=bios

section network
ip -4 -o addr show scope global
ip -6 -o addr show scope global
ip route show default
cat /etc/resolv.conf | grep -v '^#'

section services
systemctl list-units --type=service --state=running --no-pager --plain --no-legend | awk '{print $1}'
systemctl list-timers --no-pager --plain --no-legend | awk '{print $(NF-1), $NF}'

section containers
for c in docker podman; do command -v $c >/dev/null && $c ps -a --format '{{.Names}}\t{{.Image}}\t{{.Status}}'; done

section cron
ls /etc/cron.d /var/spool/cron/crontabs 2>/dev/null
crontab -l 2>/dev/null

section listening
ss -tln | awk 'NR>1 {print $4, $6}'

section postgres
pg=$(docker ps --format '{{.Names}}' 2>/dev/null | grep -m1 -i 'infra-shared\|postgres')
echo "container=$pg"
if [ -n "$pg" ]; then
  q() { docker exec "$pg" psql -U postgres -At "$@"; }
  q -c "select version()"
  q -c "select datname, pg_size_pretty(pg_database_size(datname)), datcollate from pg_database where not datistemplate"
  for db in $(q -c "select datname from pg_database where not datistemplate and datname <> 'postgres'"); do
    echo "-- $db extensions: $(q -d "$db" -c "select string_agg(extname||' '||extversion, ', ') from pg_extension")"
  done
  q -c "select rolname, rolcanlogin, rolsuper from pg_roles where rolname !~ '^pg_'"
fi
