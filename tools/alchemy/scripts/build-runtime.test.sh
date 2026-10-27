#!/usr/bin/env bash
# Process-boundary tests for build-runtime.sh.
#
# The tests run the real script against fake docker, df and tar commands.
# The fakes record what the script asked for, so every assertion comes from
# the process boundary and not from the script text.
#
# The interruption cases run the builder in the foreground. A shell that
# starts a background job with SIGINT ignored hands that disposition to the
# child, and a child that inherits an ignored SIGINT cannot trap it.

set -uo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
script_under_test="$(cd -- "$script_dir/.." && pwd)/build-runtime.sh"
real_tar="$(command -v tar)"
run_timeout=60

checks=0
failures=0
workspaces=()

ok() {
  checks=$((checks + 1))
  printf 'ok   %s\n' "$1"
}

bad() {
  checks=$((checks + 1))
  failures=$((failures + 1))
  printf 'FAIL %s\n' "$1"
}

assert_eq() {
  if [[ "$1" == "$2" ]]; then
    ok "$3"
  else
    bad "$3 (expected '$1', got '$2')"
  fi
}

assert_contains() {
  if [[ "$1" == *"$2"* ]]; then
    ok "$3"
  else
    bad "$3 (missing '$2')"
  fi
}

assert_not_contains() {
  if [[ "$1" != *"$2"* ]]; then
    ok "$3"
  else
    bad "$3 (found '$2')"
  fi
}

wait_for_file() {
  local path="$1"
  local tries=0
  while [[ ! -e "$path" ]]; do
    tries=$((tries + 1))
    if ((tries > 200)); then
      return 1
    fi
    sleep 0.1
  done
  return 0
}

write_fake_docker() {
  cat > "$1" <<'FAKE'
#!/usr/bin/env bash
# Fake docker. It records every call and emulates the container lifecycle.
set -uo pipefail
state="${FAKE_DOCKER_STATE:?}"
printf '%s\n' "$*" >>"$state/docker.log"
cmd="${1:-}"
shift || true
original_ppid="$(awk '{print $4}' "/proc/$$/stat")"

mount_src() {
  local want="$1"
  shift
  local arg rest src dst
  for arg in "$@"; do
    [[ "$arg" == type=bind,src=* ]] || continue
    rest="${arg#type=bind,src=}"
    src="${rest%%,dst=*}"
    dst="${rest#*,dst=}"
    dst="${dst%%,*}"
    if [[ "$dst" == "$want" ]]; then
      printf '%s' "$src"
      return 0
    fi
  done
  return 1
}

case "$cmd" in
  run)
    if src="$(mount_src /destination "$@")"; then
      mkdir -p "$src/var/nix/db"
      : >"$src/var/nix/db/db.sqlite"
    fi
    exit 0
    ;;
  create)
    printf '%s\n' "$@" >"$state/create.args"
    printf '%s\n' "$original_ppid" >"$state/script.pid"
    printf '%s\n' "${FAKE_DOCKER_ID:-f4kecontainerid00000000000000000000000000000000000000000000000000}"
    exit 0
    ;;
  start)
    if [[ -n "${FAKE_DOCKER_START_STDOUT:-}" ]]; then
      printf '%s\n' "$FAKE_DOCKER_START_STDOUT"
    fi
    mapfile -t created <"$state/create.args"
    case "${FAKE_DOCKER_START_MODE:-success}" in
      success)
        if src="$(mount_src /build-tmp "${created[@]+"${created[@]}"}")"; then
          printf '%s\n' "${FAKE_DOCKER_OUT_PATH:-/nix/store/fake-output-path}" >"$src/out-path"
        fi
        exit "${FAKE_DOCKER_START_EXIT:-0}"
        ;;
      fail)
        exit "${FAKE_DOCKER_START_EXIT:-1}"
        ;;
      hang)
        while :; do
          if [[ -f "$state/stopped" || -f "$state/removed" ]]; then
            exit 143
          fi
          if [[ "$(awk '{print $4}' "/proc/$$/stat")" != "$original_ppid" ]]; then
            exit 143
          fi
          sleep 0.1
        done
        ;;
    esac
    ;;
  stop)
    if [[ "${FAKE_DOCKER_STOP_EXIT:-0}" == 0 ]]; then
      : >"$state/stopped"
    fi
    exit "${FAKE_DOCKER_STOP_EXIT:-0}"
    ;;
  rm)
    : >"$state/removed"
    exit "${FAKE_DOCKER_RM_EXIT:-0}"
    ;;
  inspect)
    exit 0
    ;;
esac
exit 0
FAKE
  chmod +x "$1"
}

write_fake_df() {
  cat > "$1" <<'FAKE'
#!/usr/bin/env bash
# Fake df. It hands out one free-KiB value per call from a queue file.
set -uo pipefail
queue="${FAKE_DF_QUEUE:?}"
counter="${FAKE_DF_COUNTER:?}"
index=0
if [[ -f "$counter" ]]; then
  index="$(cat "$counter")"
fi
printf '%s\n' "$((index + 1))" >"$counter"
mapfile -t values <"$queue"
if ((index >= ${#values[@]})); then
  index=$((${#values[@]} - 1))
fi
free="${values[index]}"
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n'
printf 'fakefs 1000000 0 %s 0%% /\n' "$free"
FAKE
  chmod +x "$1"
}

write_fake_tar() {
  cat > "$1" <<FAKE
#!/usr/bin/env bash
# Fake tar. It passes archives through and lists what the snapshot received.
set -uo pipefail
real_tar="$real_tar"
mode=""
args=("\$@")
for ((i = 0; i < \${#args[@]}; i++)); do
  arg="\${args[i]}"
  [[ "\$arg" == --* || "\$arg" != -* ]] && continue
  case "\$arg" in
    *x*) mode=extract ;;
    *c*) mode=create ;;
  esac
done
if [[ "\$mode" == extract ]]; then
  archive="\${FAKE_TAR_ARCHIVE:?}"
  list="\${FAKE_TAR_LIST:?}"
  tee "\$archive" | "\$real_tar" "\$@"
  "\$real_tar" -tf "\$archive" >"\$list"
else
  exec "\$real_tar" "\$@"
fi
FAKE
  chmod +x "$1"
}

new_workspace() {
  ws="$(mktemp -d "${TMPDIR:-/tmp/opencode}/build-runtime-test.XXXXXXXX")"
  workspaces+=("$ws")
  mkdir -p "$ws/bin" "$ws/tmp" "$ws/builder" "$ws/state" \
    "$ws/repo/nixos/test" "$ws/repo/tools/alchemy/src" \
    "$ws/repo/tools/alchemy/node_modules" "$ws/repo/tools/alchemy/.alchemy"
  cp "$script_under_test" "$ws/repo/tools/alchemy/build-runtime.sh"
  : >"$ws/repo/flake.nix"
  : >"$ws/repo/flake.lock"
  : >"$ws/repo/nixos/test/default.nix"
  : >"$ws/repo/tools/alchemy/src/index.ts"
  : >"$ws/repo/tools/alchemy/node_modules/secret.txt"
  : >"$ws/repo/tools/alchemy/.alchemy/state.sqlite"
  : >"$ws/repo/tools/alchemy/.env"
  : >"$ws/repo/tools/alchemy/credentials.json"
  : >"$ws/repo/tools/alchemy/config.pem"
  write_fake_docker "$ws/bin/docker"
  write_fake_df "$ws/bin/df"
  write_fake_tar "$ws/bin/tar"
  df_queue="$ws/df-queue"
  df_counter="$ws/df-counter"
  : >"$df_counter"
  printf '4194304\n' >"$df_queue"
  docker_state="$ws/state"
  : >"$docker_state/docker.log"
  extra_env=()
}

builder_env() {
  builder_envs=(
    "PATH=$ws/bin:$PATH"
    "NIX_BUILDER_DIR=$ws/builder"
    "TMPDIR=$ws/tmp"
    "FAKE_DOCKER_STATE=$docker_state"
    "FAKE_DF_QUEUE=$df_queue"
    "FAKE_DF_COUNTER=$df_counter"
    "FAKE_TAR_ARCHIVE=$ws/archive.tar"
    "FAKE_TAR_LIST=$ws/archive.list"
  )
}

run_builder() {
  builder_env
  timeout "$run_timeout" env "${builder_envs[@]}" "${extra_env[@]+"${extra_env[@]}"}" \
    bash "$ws/repo/tools/alchemy/build-runtime.sh" \
    >"$ws/stdout.log" 2>"$ws/stderr.log"
  status=$?
  stdout="$(cat "$ws/stdout.log")"
  stderr="$(cat "$ws/stderr.log")"
  docker_log="$(cat "$docker_state/docker.log")"
  return "$status"
}

# Sends a signal to the running builder once it reached the container.
kill_builder() {
  local signal="$1"
  local tries=0
  while [[ ! -s "$docker_state/script.pid" ]]; do
    tries=$((tries + 1))
    if ((tries > 200)); then
      return 1
    fi
    sleep 0.1
  done
  kill "-$signal" "$(cat "$docker_state/script.pid")"
}

snapshot_leftovers() {
  find "$ws/tmp" -maxdepth 1 -name 'alchemy-nix-source.*' | wc -l
}

if [[ ! -r "$script_under_test" ]]; then
  printf 'Cannot read %s\n' "$script_under_test" >&2
  exit 1
fi

printf 'build-runtime.sh process boundary tests\n'

new_workspace
run_builder
assert_eq 0 "$status" 'a successful build exits 0'
assert_contains "$stdout" '/nix/store/fake-output-path' 'a successful build prints the output path'
assert_eq 1 "$(grep -c '^create ' "$docker_state/docker.log")" 'a successful build creates one container'
assert_eq 1 "$(grep -c '^start ' "$docker_state/docker.log")" 'a successful build starts the container once'
assert_eq 1 "$(grep -c '^rm -f ' "$docker_state/docker.log")" 'a successful build removes the container'
assert_contains "$docker_log" '--memory=2g' 'the container keeps a 2 GiB memory limit'
assert_contains "$docker_log" '--memory-swap=2g' 'the container keeps no swap'
assert_contains "$docker_log" '--cpus=1' 'the container keeps one CPU'
assert_contains "$docker_log" '--max-jobs 1 --cores 1' 'the build keeps one Nix build'
assert_contains "$docker_log" 'NIX_BUILD_TARGET=path:/src#alchemy-runner' 'the default target is the Alchemy runner package'
assert_not_contains "$docker_log" '/dev/kvm' 'a default build gets no KVM device'

new_workspace
extra_env=("NIX_BUILDER_KVM=1")
run_builder
assert_eq 0 "$status" 'a KVM build exits 0'
assert_contains "$docker_log" '--device /dev/kvm' 'a KVM build passes /dev/kvm to the container'
assert_contains "$docker_log" 'system-features = benchmark big-parallel nixos-test uid-range kvm' 'a KVM build adds the kvm system feature'

new_workspace
extra_env=("NIX_BUILD_TARGET=path:/src#testground-vm")
run_builder
assert_eq 0 "$status" 'a build can target another flake output'
assert_contains "$docker_log" 'NIX_BUILD_TARGET=path:/src#testground-vm' 'the chosen target reaches the container'
assert_contains "$docker_log" 'dst=/src,readonly' 'the source snapshot is read-only in the container'
assert_eq 0 "$(snapshot_leftovers)" 'a successful build leaves no source snapshot behind'

new_workspace
extra_env=(FAKE_DOCKER_START_MODE=fail FAKE_DOCKER_START_EXIT=42)
run_builder
assert_eq 42 "$status" 'a failed build reports the container exit code'
assert_contains "$stderr" 'Build failed' 'a failed build says so'
assert_not_contains "$stdout" '/nix/store/' 'a failed build prints no output path'
assert_contains "$docker_log" 'rm -f ' 'a failed build removes the container'
assert_eq 0 "$(snapshot_leftovers)" 'a failed build leaves no source snapshot behind'

new_workspace
extra_env=(FAKE_DOCKER_RM_EXIT=1)
run_builder
assert_eq 0 "$status" 'a failed container removal keeps the build status'
assert_eq 0 "$(snapshot_leftovers)" 'a failed container removal still clears the source snapshot'

new_workspace
extra_env=(FAKE_DOCKER_START_MODE=hang)
kill_builder INT &
killer_pid=$!
run_builder
wait "$killer_pid" 2>/dev/null
assert_eq 130 "$status" 'an interrupted build exits 130'
assert_contains "$(cat "$docker_state/docker.log")" 'rm -f ' 'an interrupted build removes the container'
assert_eq 0 "$(snapshot_leftovers)" 'an interrupted build leaves no source snapshot behind'

new_workspace
extra_env=(FAKE_DOCKER_START_MODE=hang)
kill_builder TERM &
killer_pid=$!
run_builder
wait "$killer_pid" 2>/dev/null
assert_eq 143 "$status" 'a terminated build exits 143'
assert_contains "$(cat "$docker_state/docker.log")" 'rm -f ' 'a terminated build removes the container'
assert_eq 0 "$(snapshot_leftovers)" 'a terminated build leaves no source snapshot behind'

new_workspace
printf '1024\n' >"$df_queue"
run_builder
assert_eq 3 "$status" 'a build without 2 GiB free disk exits 3'
assert_not_contains "$docker_log" 'create ' 'a build without free disk creates no container'

new_workspace
printf '4194304\n524288\n' >"$df_queue"
extra_env=(FAKE_DOCKER_START_MODE=hang)
run_builder
assert_eq 4 "$status" 'a build stopped by the disk guard exits 4'
assert_contains "$docker_log" 'stop ' 'the disk guard stops the container'
assert_contains "$docker_log" 'rm -f ' 'the disk guard removes the container'
assert_not_contains "$stdout" '/nix/store/' 'a build stopped by the disk guard prints no output path'
assert_contains "$stderr" 'free disk' 'the disk guard says why it stopped'

new_workspace
printf '4194304\n524288\n' >"$df_queue"
extra_env=(FAKE_DOCKER_START_MODE=hang FAKE_DOCKER_STOP_EXIT=1)
run_builder
assert_eq 4 "$status" 'a disk guard whose stop fails still ends the build'
assert_contains "$docker_log" 'rm -f ' 'a disk guard whose stop fails removes the container'
assert_eq 0 "$(snapshot_leftovers)" 'a disk guard whose stop fails clears the source snapshot'

new_workspace
run_builder
archive_list="$(cat "$ws/archive.list")"
assert_contains "$archive_list" 'flake.nix' 'the snapshot holds the flake'
assert_contains "$archive_list" 'nixos/' 'the snapshot holds the host modules'
assert_not_contains "$archive_list" 'node_modules' 'the snapshot drops node_modules'
assert_not_contains "$archive_list" '.alchemy' 'the snapshot drops local Alchemy state'
assert_not_contains "$archive_list" '.env' 'the snapshot drops environment credentials'
assert_not_contains "$archive_list" 'credentials.json' 'the snapshot drops credential files'
assert_not_contains "$archive_list" 'config.pem' 'the snapshot drops key material'

new_workspace
extra_env=(FAKE_DOCKER_START_MODE=hang)
builder_env
env "${builder_envs[@]}" "${extra_env[@]+"${extra_env[@]}"}" \
  bash "$ws/repo/tools/alchemy/build-runtime.sh" \
  >"$ws/stdout.log" 2>"$ws/stderr.log" &
lock_holder_pid=$!
wait_for_file "$docker_state/create.args"
mkdir -p "$ws/state-second"
: >"$ws/state-second/docker.log"
printf '4194304\n' >"$ws/df-queue-second"
: >"$ws/df-counter-second"
second_status=0
timeout 5 env \
  "PATH=$ws/bin:$PATH" \
  "NIX_BUILDER_DIR=$ws/builder" \
  "TMPDIR=$ws/tmp" \
  "FAKE_DOCKER_STATE=$ws/state-second" \
  "FAKE_DF_QUEUE=$ws/df-queue-second" \
  "FAKE_DF_COUNTER=$ws/df-counter-second" \
  "FAKE_TAR_ARCHIVE=$ws/archive-second.tar" \
  "FAKE_TAR_LIST=$ws/archive-second.list" \
  bash "$ws/repo/tools/alchemy/build-runtime.sh" \
  >"$ws/stdout-second.log" 2>"$ws/stderr-second.log" || second_status=$?
assert_eq 124 "$second_status" 'a second build waits for the builder lock'
assert_not_contains "$(cat "$ws/state-second/docker.log")" 'create ' 'a waiting build creates no container'
kill -TERM "$lock_holder_pid"
wait "$lock_holder_pid"
new_workspace
run_builder
assert_eq 0 "$status" 'the builder lock is released when a build ends'

printf '\n%s checks, %s failures\n' "$checks" "$failures"
if ((failures > 0)); then
  printf 'workspaces kept for inspection:\n'
  printf '  %s\n' "${workspaces[@]}"
  exit 1
fi
rm -rf -- "${workspaces[@]}"
exit 0
