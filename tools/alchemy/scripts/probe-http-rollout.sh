#!/usr/bin/env bash
set -euo pipefail

if [[ ${1:-} == --summarize ]]; then
  if (( $# < 2 || $# > 5 )); then
    printf 'Usage: %s --summarize SAMPLE_FILE [MAX_SAMPLE_GAP_MS [WINDOW_START_UTC WINDOW_END_UTC]]\n' "$0" >&2
    exit 2
  fi

  sample_file=$2
  max_allowed_gap=${3:-500}
  window_start=${4:-}
  window_end=${5:-}
  if [[ ! $max_allowed_gap =~ ^[0-9]+$ ]] || (( max_allowed_gap < 1 )) || [[ ! -r $sample_file ]]; then
    printf 'Give a readable sample file and a positive integer gap limit.\n' >&2
    exit 2
  fi
  if [[ -n $window_start || -n $window_end ]]; then
    if (( $# != 5 )) || [[ ! $window_start =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$ || ! $window_end =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$ || $window_start > $window_end ]]; then
      printf 'Give both window bounds as ordered UTC timestamps with milliseconds.\n' >&2
      exit 2
    fi
  fi

  awk -F '\t' -v limit="$max_allowed_gap" -v window_start="$window_start" -v window_end="$window_end" '
    NR == 1 {
      if ($1 != "timestamp_utc" || $2 != "http_status" || $3 != "curl_exit_code" || $4 != "total_seconds" || $5 != "gap_since_previous_ms") invalid = 1
      next
    }
    NF == 0 { next }
    {
      if (NF != 5 || $2 !~ /^[0-9][0-9][0-9]$/ || $3 !~ /^-?[0-9]+$/ || $5 !~ /^[0-9]+$/) {
        invalid = 1
        next
      }
      samples++
      if (samples == 1) first_sample = $1
      last_sample = $1
      if ($1 !~ /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$/) invalid = 1
      gap = $5 + 0
      if (gap > max_gap) max_gap = gap
      failed = ($2 != "200" || $3 != "0")
      if (failed) {
        failures++
        failed_run++
        if (failed_run > longest_failed_run) longest_failed_run = failed_run
      } else {
        failed_run = 0
      }
    }
    END {
      if (invalid) {
        print "verdict=INCONCLUSIVE (invalid sample format)"
        exit 2
      }
      if (samples == 0) {
        print "samples=0"
        print "verdict=INCONCLUSIVE"
        exit 2
      }
      printf "samples=%d\nfirst_sample_utc=%s\nlast_sample_utc=%s\nfailed_samples=%d\nlongest_failed_run=%d\nmax_sample_gap_ms=%d\n", samples, first_sample, last_sample, failures, longest_failed_run, max_gap
      if (failures > 0) {
        if (window_start != "" && (first_sample > window_start || last_sample < window_end)) {
          printf "expected_window_start_utc=%s\nexpected_window_end_utc=%s\n", window_start, window_end
          print "verdict=FAIL (requests failed; samples do not cover expected rollout window)"
        } else if (max_gap > limit) print "verdict=FAIL (requests failed; sample gap also exceeds limit)"
        else print "verdict=FAIL (one or more requests failed)"
        exit 1
      }
      if (window_start != "" && (first_sample > window_start || last_sample < window_end)) {
        printf "expected_window_start_utc=%s\nexpected_window_end_utc=%s\n", window_start, window_end
        print "verdict=INCONCLUSIVE (samples do not cover expected rollout window)"
        exit 2
      }
      if (max_gap > limit) {
        printf "verdict=INCONCLUSIVE (gap exceeds %d ms)\n", limit
        exit 2
      }
      print "verdict=PASS"
    }
  ' "$sample_file"
  exit $?
fi

if (( $# < 1 || $# > 4 )); then
  printf 'Usage: %s URL [INTERVAL_SECONDS] [REQUEST_TIMEOUT_SECONDS] [DURATION_SECONDS]\n' "$0" >&2
  exit 2
fi

url=$1
interval=${2:-0.25}
request_timeout=${3:-2}
duration=${4:-60}

if [[ ! $interval =~ ^[0-9]+([.][0-9]+)?$ || ! $request_timeout =~ ^[0-9]+([.][0-9]+)?$ || ! $duration =~ ^[0-9]+$ || $interval =~ ^0+([.]0+)?$ || $request_timeout =~ ^0+([.]0+)?$ ]] || (( duration < 1 )); then
  printf 'Interval and timeout must be positive numbers; duration must be a positive integer.\n' >&2
  exit 2
fi

printf 'timestamp_utc\thttp_status\tcurl_exit_code\ttotal_seconds\tgap_since_previous_ms\n'
end_ms=$(date -u +%s%3N)
end_ms=$((end_ms + duration * 1000))
previous_sample_ms=0

while (( $(date -u +%s%3N) < end_ms )); do
  timestamp=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
  sample_start_ms=$(date -u +%s%3N)
  gap_since_previous_ms=0
  if (( previous_sample_ms > 0 )); then
    gap_since_previous_ms=$((sample_start_ms - previous_sample_ms))
  fi

  # curl can print status 000 and still exit non-zero; record both facts separately.
  if result=$(curl --silent --show-error \
    --connect-timeout "$request_timeout" \
    --max-time "$request_timeout" \
    --output /dev/null \
    --write-out '%{http_code}\t%{time_total}' \
    "$url" 2>/dev/null); then
    curl_exit_code=0
  else
    curl_exit_code=$?
  fi

  http_status=${result%%$'\t'*}
  total_seconds=${result#*$'\t'}
  printf '%s\t%s\t%s\t%s\t%s\n' "$timestamp" "$http_status" "$curl_exit_code" "$total_seconds" "$gap_since_previous_ms"
  previous_sample_ms=$sample_start_ms
  sleep "$interval"
done
