#!/bin/bash
#
# Deploy a Railway service from a Docker image and follow that deployment until Railway reports SUCCESS
# (docs/ci-fast-deploys/PLAN-2026-09-29.md §2). Railway builds nothing: it pulls the image, runs the service's
# pre-deploy command and waits for its health check before it moves traffic, as it does for a `railway up` build.
#
#   scripts/ci/railway-deploy-image.sh --service <id> --image ghcr.io/<owner>/nexus-api:<commit sha>
#
# 1. Reads the service's latest deployment, then points the service at the image with
#    `railway service source connect --image` (Railway CLI 5.30.1: the serviceConnect mutation).
# 2. Waits up to a minute for a NEW deployment. Connecting another image starts one: that is how Railway switches a
#    service's source. Connecting the image the service already has (a re-run of a failed job) may start none. Then
#    this asks for one with `railway redeploy --from-source`, which deploys the service's configured source (the
#    serviceInstanceDeploy mutation with latestCommit). A plain `railway redeploy` would not do: it re-runs the latest
#    deployment, with that deployment's own image.
# 3. Follows that deployment: 0 at SUCCESS; 1 when it ends FAILED, CRASHED, REMOVED or SKIPPED, when a newer
#    deployment replaces it, or after 15 minutes. A failed deployment never takes traffic.
#
# Writes deployment_id=<id> to $GITHUB_OUTPUT when it can. The follow loop is a small copy of follow_deployment in
# railway-up.sh, which stops earlier (at DEPLOYING: its caller watches the rollout). railway-up.sh goes away once every
# service deploys by image (plan §6, PR 4), so the two are not shared.
#
# Polls every 10 s: each `railway service status` costs a few Railway API requests, and Hobby allows 1,000 an hour.
# The waits are deadlines, not poll counts: one read makes several requests and the CLI allows each 90 s (CLI 5.30.1,
# DEFAULT_HTTP_TIMEOUT_SECS), so 90 polls could take far longer than 15 minutes (review of PR 2, 2026-09-30). A read is
# cut at 60 s where `timeout` exists (the runner); connect and redeploy are not, since a cut mutation may still apply.
# Worst case, every read and CLI request hanging to its limit: about 36 minutes; usually the follow plus a minute. The
# jobs that run this allow 40 (45 for the API rollback, which then waits for readiness). RAILWAY_POLL_SECONDS,
# RAILWAY_APPEAR_SECONDS, RAILWAY_FOLLOW_SECONDS and RAILWAY_READ_SECONDS change the timing; only tests set them.
set -euo pipefail

usage() { echo "usage: $0 --service <id> --image <ref>" >&2; exit 2; }

service='' image=''
while [ $# -gt 0 ]; do
  case "$1" in
    --service) [ $# -ge 2 ] || usage; service=$2; shift 2 ;;
    --image) [ $# -ge 2 ] || usage; image=$2; shift 2 ;;
    *) usage ;;
  esac
done
[ -n "$service" ] && [ -n "$image" ] || usage

POLL_SECONDS=${RAILWAY_POLL_SECONDS:-10}
APPEAR_SECONDS=${RAILWAY_APPEAR_SECONDS:-60}
FOLLOW_SECONDS=${RAILWAY_FOLLOW_SECONDS:-900}
READ_SECONDS=${RAILWAY_READ_SECONDS:-60}

# The service's latest deployment as JSON ({deploymentId, status, …}); fails when Railway cannot be read in time.
service_status() {
  if command -v timeout > /dev/null; then
    timeout "$READ_SECONDS" railway service status --service "$service" --json 2>/dev/null
  else
    railway service status --service "$service" --json 2>/dev/null
  fi
}

# Prints the id of a deployment newer than $before, once the service's latest deployment is one. Reads at least once.
wait_for_new_deployment() {
  local id deadline=$((SECONDS + APPEAR_SECONDS))
  while :; do
    id=$(service_status | jq -r '.deploymentId // empty' 2>/dev/null) || id=''
    if [ -n "$id" ] && [ "$id" != "$before" ]; then
      printf '%s\n' "$id"
      return 0
    fi
    [ "$SECONDS" -lt "$deadline" ] || return 1
    sleep "$POLL_SECONDS"
  done
}

# Waits until deployment $1 is SUCCESS (0), or ends, is replaced or runs out of time (1). A failed read is retried.
follow_deployment() {
  local id=$1 status='' last='' start=$SECONDS
  local deadline=$((start + FOLLOW_SECONDS))
  while :; do
    status=$(service_status |
      jq -r --arg id "$id" 'if .deploymentId == $id then .status else "REPLACED:" + (.deploymentId // "none") end' 2>/dev/null) || status=''
    if [ -n "$status" ] && [ "$status" != "$last" ]; then
      echo "$(date -u +%H:%M:%S) deployment $id: $status"
      last=$status
    fi
    case "$status" in
      SUCCESS) echo "✓ Railway serves $image (deployment $id)"; return 0 ;;
      FAILED | CRASHED | REMOVED | SKIPPED) echo "✗ deployment $id ended $status — the previous build keeps serving"; return 1 ;;
      REPLACED:*) echo "✗ deployment $id was replaced by deployment ${status#REPLACED:} before it succeeded"; return 1 ;;
    esac
    [ "$SECONDS" -lt "$deadline" ] || break
    sleep "$POLL_SECONDS"
  done
  echo "✗ deployment $id was still ${status:-unknown} after $((SECONDS - start)) s — the previous build keeps serving until it succeeds"
  return 1
}

# The deployment serving now, so the new one can be told apart. Nothing is changed when Railway cannot be read.
json=''
for _ in 1 2 3; do
  if json=$(service_status) && jq -e 'type == "object"' <<< "$json" > /dev/null 2>&1; then break; fi
  json=''
  sleep "$POLL_SECONDS"
done
if [ -z "$json" ]; then
  echo "✗ could not read the service's deployments from Railway — nothing was changed"
  exit 1
fi
before=$(jq -r '.deploymentId // empty' <<< "$json")
echo "Serving now: deployment ${before:-none}"

echo "Pointing the service at $image"
railway service source connect --image "$image" --service "$service" || {
  code=$?
  echo "✗ railway could not point the service at $image (exit $code) — the previous build keeps serving"
  exit "$code"
}

if id=$(wait_for_new_deployment); then
  echo "✓ connecting the image started deployment $id"
else
  echo "::notice::No new deployment within $APPEAR_SECONDS s of connecting $image (the service may already have had it) — deploying it from the service's source"
  railway redeploy --from-source --service "$service" --yes || {
    code=$?
    echo "✗ railway could not start a deployment of $image (exit $code) — the previous build keeps serving"
    exit "$code"
  }
  id=$(wait_for_new_deployment) || {
    echo "✗ Railway started no deployment of $image — the previous build keeps serving"
    exit 1
  }
  echo "✓ railway redeploy --from-source started deployment $id"
fi
if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "deployment_id=$id" >> "$GITHUB_OUTPUT"; fi

follow_deployment "$id"
