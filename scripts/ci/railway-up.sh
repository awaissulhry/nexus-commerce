#!/bin/bash
#
# `railway up`, retried ONLY when Railway's own builder could not download its tools.
#
# 2026-09-26, run 36265051900: the build failed with "Deploy failed" because Railway's builder timed out
# downloading `mise` from GitHub (i/o timeout) — infrastructure, not this repo. `railway up` prints only
# "Deploy failed", so the reason is read from the deployment's build log (its id is in the "Build Logs"
# link). A build that fails for any other reason fails at once, with its own exit code.
#
# 2026-09-29, run 36610576243: `railway up` exited 1 with "Failed to stream build logs: Failed to retrieve build
# log" while the deployment was still INITIALIZING; Railway built and served it 14 minutes later. A lost log
# stream says nothing about the build, so the deployment's own status decides instead (follow_deployment).
#
# Writes deployment_id=<id> to $GITHUB_OUTPUT when it can, so a later step can watch that deployment.
#
#   scripts/ci/railway-up.sh --service <id> --ci --message "…"
set -uo pipefail

INFRA='failed to (download|ensure mise)|i/o timeout|temporary failure fetching|TLS handshake timeout|connection reset by peer'
LOG_LOST='failed to (stream|retrieve) build log'

# The --service / --environment given to `railway up`, for `railway service status`.
status_args=()
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  case "${args[i]}" in
    --service | -s | --environment | -e) status_args+=("${args[i]}" "${args[i + 1]:-}") ;;
    --service=* | --environment=*) status_args+=("${args[i]}") ;;
  esac
done

# Waits (up to 25 minutes) until deployment $1 has left its build, as `railway up` would have: 0 once it is
# DEPLOYING or SUCCESS, 1 once it FAILED, CRASHED or was replaced. The caller's next step watches the rollout.
follow_deployment() {
  local id=$1 status=''
  for _ in $(seq 1 150); do
    status=$(railway service status ${status_args[@]+"${status_args[@]}"} --json 2>/dev/null |
      jq -r --arg id "$id" 'if .deploymentId == $id then .status else "REPLACED:" + (.deploymentId // "none") end' 2>/dev/null) || status=''
    case "$status" in
      DEPLOYING | SUCCESS) echo "✓ deployment $id built ($status)"; return 0 ;;
      FAILED | CRASHED | REMOVED | SKIPPED) echo "✗ deployment $id ended $status"; return 1 ;;
      REPLACED:*) echo "✗ deployment $id is no longer the service's latest (${status#REPLACED:})"; return 1 ;;
    esac
    sleep 10
  done
  echo "✗ deployment $id was still ${status:-unknown} after 25 minutes"
  return 1
}

for attempt in 1 2 3; do
  out=$(mktemp)
  railway up "$@" 2>&1 | tee "$out"
  code=${PIPESTATUS[0]}
  id=$(grep -oE 'id=[0-9a-f-]{36}' "$out" | tail -1 | cut -d= -f2 || true)
  if [ -n "$id" ] && [ -n "${GITHUB_OUTPUT:-}" ]; then echo "deployment_id=$id" >> "$GITHUB_OUTPUT"; fi
  [ "$code" -eq 0 ] && exit 0
  if [ -n "$id" ] && grep -qiE "$LOG_LOST" "$out"; then
    echo "::warning::railway up lost the build log stream of deployment $id — following its status instead"
    follow_deployment "$id"
    exit $?
  fi
  if [ "$attempt" -lt 3 ] && [ -n "$id" ] && timeout 60 railway logs "$id" --build 2>/dev/null | grep -qiE "$INFRA"; then
    echo "::warning::Railway's builder could not download its own tools (deployment $id, attempt $attempt) — trying again in 30 s"
    sleep 30
    continue
  fi
  exit "$code"
done
