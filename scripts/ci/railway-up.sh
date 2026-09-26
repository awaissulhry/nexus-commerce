#!/bin/bash
#
# `railway up`, retried ONLY when Railway's own builder could not download its tools.
#
# 2026-09-26, run 36265051900: the build failed with "Deploy failed" because Railway's builder timed out
# downloading `mise` from GitHub (i/o timeout) — infrastructure, not this repo. `railway up` prints only
# "Deploy failed", so the reason is read from the deployment's build log (its id is in the "Build Logs"
# link). A build that fails for any other reason fails at once, with its own exit code.
#
# Writes deployment_id=<id> to $GITHUB_OUTPUT when it can, so a later step can watch that deployment.
#
#   scripts/ci/railway-up.sh --service <id> --ci --message "…"
set -uo pipefail

INFRA='failed to (download|ensure mise)|i/o timeout|temporary failure fetching|TLS handshake timeout|connection reset by peer'

for attempt in 1 2 3; do
  out=$(mktemp)
  railway up "$@" 2>&1 | tee "$out"
  code=${PIPESTATUS[0]}
  id=$(grep -oE 'id=[0-9a-f-]{36}' "$out" | tail -1 | cut -d= -f2 || true)
  if [ -n "$id" ] && [ -n "${GITHUB_OUTPUT:-}" ]; then echo "deployment_id=$id" >> "$GITHUB_OUTPUT"; fi
  [ "$code" -eq 0 ] && exit 0
  if [ "$attempt" -lt 3 ] && [ -n "$id" ] && timeout 60 railway logs "$id" --build 2>/dev/null | grep -qiE "$INFRA"; then
    echo "::warning::Railway's builder could not download its own tools (deployment $id, attempt $attempt) — trying again in 30 s"
    sleep 30
    continue
  fi
  exit "$code"
done
