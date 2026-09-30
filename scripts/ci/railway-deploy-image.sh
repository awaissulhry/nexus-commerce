#!/bin/bash
#
# Deploy a Railway service from a Docker image and follow that deployment until Railway reports SUCCESS
# (docs/ci-fast-deploys/PLAN-2026-09-29.md §2). Railway builds nothing: it pulls the image, runs the service's
# pre-deploy command and waits for its health check before it moves traffic, as it does for a `railway up` build.
#
#   RAILWAY_TOKEN=<project token> \
#     scripts/ci/railway-deploy-image.sh --service <id> --image ghcr.io/<owner>/nexus-api:<commit sha>
#
# 1. Reads the service's latest deployment with the CLI. When Railway cannot be read, nothing is changed.
# 2. Points the service at the image in the token's environment and starts a deployment, with three requests to
#    Railway's GraphQL API as the project token (header Project-Access-Token):
#      projectToken { environmentId }                                        the one environment the token acts on;
#      serviceInstanceUpdate(serviceId, environmentId, input: {source: {image}})  the service's source there;
#      serviceInstanceDeployV2(serviceId, environmentId)                     a deployment of it; returns its id.
#    2026-09-30, run 36697739589: `railway service source connect --image` answered the project token "Unauthorized"
#    and changed nothing. It sends serviceConnect, which changes the service in every environment, and a project token
#    acts on one environment of one project (Railway docs, integrations/api). That the token may send the two
#    mutations above is not proven yet: the next switch proves it. The schema marks serviceInstanceUpdate's
#    environmentId "[Experimental]": for an environment that is not a fork, the change reaches every environment that
#    is not a fork (read 2026-09-30).
#    Railway answers a denial with HTTP 200 and `errors` ("Not Authorized"), so each answer is checked for errors and
#    for the field asked for. A request is cut after $RAILWAY_API_SECONDS (60 s); a cut mutation may still apply, and
#    the message says so.
#    The deployment id comes back from the mutation, so nothing waits for one to appear. The CLI path waited up to a
#    minute, then ran `railway redeploy --from-source`: connecting an image was not proven to start a deployment, and
#    a plain `railway redeploy` re-runs the latest deployment with that deployment's own image. The schema describes
#    serviceInstanceDeployV2 as "Deploy a service instance. Returns a deployment ID", with no case that starts none,
#    so a re-run with the same image deploys it again.
# 3. Follows that deployment to SUCCESS; 1 when it ends FAILED, CRASHED, REMOVED or SKIPPED, when a newer deployment
#    replaces it, or after 15 minutes. A failed deployment never takes traffic. Until Railway lists the new deployment
#    as the service's latest, the one that served before counts as waiting, not as a replacement.
# 4. Checks which image that deployment runs, from Railway's record of it (`railway deployment list --json`, the
#    meta.image field): 0 when it is this image, 1 when it is another. SUCCESS alone does not say: if Railway only
#    staged the new source, as its dashboard does when it updates a versioned image tag, the deployment runs the old
#    image and reports SUCCESS (review of PR 2, 2026-09-30). Only the API has a readiness check of its own commit
#    afterwards. A record that names no image, or cannot be read, gives a warning, not a failure: Railway's docs do
#    not describe meta, and public deploy scripts read meta.image as the reference the service was pointed at.
#
# Writes deployment_id=<id> to $GITHUB_OUTPUT when it can. The follow loop is a small copy of follow_deployment in
# railway-up.sh, which stops earlier (at DEPLOYING: its caller watches the rollout). railway-up.sh goes away once every
# service deploys by image (plan §6, PR 4), so the two are not shared. The token is never printed and never on a
# command line: curl reads its header from a file descriptor.
#
# Polls every 10 s: each `railway service status` costs a few Railway API requests, and Hobby allows 1,000 an hour.
# The waits are deadlines, not poll counts: one read makes several requests and the CLI allows each 90 s (CLI 5.30.1,
# DEFAULT_HTTP_TIMEOUT_SECS), so 90 polls could take far longer than 15 minutes (review of PR 2, 2026-09-30). A read is
# cut at 60 s where `timeout` exists (the runner). Worst case, every read and request hanging to its limit: about 25
# minutes; usually the follow plus a few seconds. The jobs that run this allow 40 (45 for the API rollback, which then
# waits for readiness), set for the CLI path's 38. RAILWAY_POLL_SECONDS, RAILWAY_FOLLOW_SECONDS, RAILWAY_READ_SECONDS
# and RAILWAY_API_SECONDS change the timing; only tests set them.
set -euo pipefail

usage() { echo "usage: $0 --service <id> --image <ref>   (RAILWAY_TOKEN: a project token)" >&2; exit 2; }

service='' image=''
while [ $# -gt 0 ]; do
  case "$1" in
    --service) [ $# -ge 2 ] || usage; service=$2; shift 2 ;;
    --image) [ $# -ge 2 ] || usage; image=$2; shift 2 ;;
    *) usage ;;
  esac
done
[ -n "$service" ] && [ -n "$image" ] || usage
if [ -z "${RAILWAY_TOKEN:-}" ]; then
  echo "✗ RAILWAY_TOKEN is not set (the project token) — nothing was changed" >&2
  exit 2
fi

POLL_SECONDS=${RAILWAY_POLL_SECONDS:-10}
FOLLOW_SECONDS=${RAILWAY_FOLLOW_SECONDS:-900}
READ_SECONDS=${RAILWAY_READ_SECONDS:-60}
API_SECONDS=${RAILWAY_API_SECONDS:-60}
API_URL=https://backboard.railway.com/graphql/v2

# Runs a Railway read, cut at $READ_SECONDS where `timeout` exists. Its errors are dropped: callers retry or report.
railway_read() {
  if command -v timeout > /dev/null; then
    timeout "$READ_SECONDS" railway "$@" 2>/dev/null
  else
    railway "$@" 2>/dev/null
  fi
}

# The service's latest deployment as JSON ({deploymentId, status, …}); fails when Railway cannot be read in time.
service_status() {
  railway_read service status --service "$service" --json
}

# The image deployment $1 runs (meta.image), or nothing when its record names none. Fails when Railway cannot be read
# or does not list that deployment. The JSON is never printed: only meta.image comes out.
deployment_image() {
  railway_read deployment list --service "$service" --json --limit 10 |
    jq -er --arg id "$1" 'map(select(.id == $id)) | if length == 0 then error("not listed") else .[0].meta.image // "" end' 2>/dev/null
}

# One request to Railway's GraphQL API as the project token. Prints what the jq filter $2 picks from the answer: a
# string, else the answer counts as holding none. $1 names the request in messages, $3 is the ✗ line's end when
# Railway refuses, $4 its end when no answer comes (a mutation may still apply), $5 the request body (JSON, built
# with jq -n). Fails, with a ✗ line on stderr, when no answer comes within $API_SECONDS s, the HTTP status is not
# 2xx, the body is not JSON, it holds `errors`, or the filter picks nothing.
railway_api() {
  local what=$1 pick=$2 refused=$3 unanswered=$4 body=$5 out code status answer errors value
  out=$(printf '%s' "$body" |
    curl -sS --max-time "$API_SECONDS" "$API_URL" -H 'Content-Type: application/json' \
      -H @<(printf 'Project-Access-Token: %s\n' "$RAILWAY_TOKEN") --data-binary @- -w '\n%{http_code}') || {
    code=$?
    echo "✗ no answer from Railway to $what (curl exit $code, limit $API_SECONDS s) — $unanswered" >&2
    return 1
  }
  status=${out##*$'\n'} answer=${out%$'\n'*}
  errors=$(jq -r 'if type == "object" and (.errors | type) == "array" and (.errors | length) > 0
    then [.errors[] | .message // "no message" | tostring | gsub("\\s+"; " ")] | join("; ") | .[:300] else empty end' \
    <<< "$answer" 2>/dev/null) || errors=''
  case "$status" in
    2[0-9][0-9]) ;;
    *) echo "✗ Railway refused $what: HTTP $status${errors:+, $errors} — $refused" >&2; return 1 ;;
  esac
  if ! jq -e 'type == "object"' <<< "$answer" > /dev/null 2>&1; then
    echo "✗ Railway refused $what: its answer is not JSON (HTTP $status) — $refused" >&2
    return 1
  fi
  if [ -n "$errors" ]; then
    echo "✗ Railway refused $what: $errors — $refused" >&2
    return 1
  fi
  value=$(jq -r "$pick | strings" <<< "$answer" 2>/dev/null) || value=''
  if [ -z "$value" ]; then
    echo "✗ Railway refused $what: its answer holds no result (HTTP $status) — $refused" >&2
    return 1
  fi
  printf '%s\n' "$value"
}

# Waits until deployment $1 is SUCCESS (0), or ends, is replaced or runs out of time (1). A failed read is retried.
# While the service's latest deployment is still the one that served before ($before), the new one is not listed yet.
follow_deployment() {
  local id=$1 status='' last='' start=$SECONDS
  local deadline=$((start + FOLLOW_SECONDS))
  while :; do
    status=$(service_status |
      jq -r --arg id "$id" --arg before "$before" '
        if .deploymentId == $id then .status
        elif (.deploymentId // "") == $before then "NOT LISTED YET"
        else "REPLACED:" + (.deploymentId // "none") end' 2>/dev/null) || status=''
    if [ -n "$status" ] && [ "$status" != "$last" ]; then
      echo "$(date -u +%H:%M:%S) deployment $id: $status"
      last=$status
    fi
    case "$status" in
      SUCCESS) return 0 ;;
      FAILED | CRASHED | REMOVED | SKIPPED) echo "✗ deployment $id ended $status — the previous build keeps serving"; return 1 ;;
      REPLACED:*) echo "✗ deployment $id was replaced by deployment ${status#REPLACED:} before it succeeded"; return 1 ;;
    esac
    [ "$SECONDS" -lt "$deadline" ] || break
    sleep "$POLL_SECONDS"
  done
  echo "✗ deployment $id was still ${status:-unknown} after $((SECONDS - start)) s — the previous build keeps serving until it succeeds"
  return 1
}

# The deployment serving now, for the log and to tell the new one apart. Nothing is changed when Railway cannot be read.
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

# The environment is not printed: the logs of this public repository are public.
body=$(jq -n '{query: "query DeployImageToken { projectToken { environmentId } }"}')
environment=$(railway_api "the token's environment (projectToken)" '.data.projectToken.environmentId' \
  'nothing was changed' 'nothing was changed' "$body") || exit 1

echo "Pointing the service at $image"
body=$(jq -n --arg service "$service" --arg environment "$environment" --arg image "$image" '{
  query: "mutation DeployImageSource($service: String!, $environment: String!, $input: ServiceInstanceUpdateInput!) { serviceInstanceUpdate(serviceId: $service, environmentId: $environment, input: $input) }",
  variables: {service: $service, environment: $environment, input: {source: {image: $image}}}}')
railway_api "the change of the service's source to $image (serviceInstanceUpdate)" \
  '.data.serviceInstanceUpdate | select(. == true) | tostring' \
  'the previous build keeps serving' \
  "it may still apply; the previous build keeps serving, and Settings → Source may name $image" "$body" > /dev/null || exit 1

body=$(jq -n --arg service "$service" --arg environment "$environment" '{
  query: "mutation DeployImageStart($service: String!, $environment: String!) { serviceInstanceDeployV2(serviceId: $service, environmentId: $environment) }",
  variables: {service: $service, environment: $environment}}')
# The id goes into $GITHUB_OUTPUT: only letters, digits and dashes, so an answer cannot add a line there.
id=$(railway_api "a deployment of $image (serviceInstanceDeployV2)" \
  '.data.serviceInstanceDeployV2 | strings | select(test("\\A[A-Za-z0-9-]+\\z"))' \
  "the previous build keeps serving, while Settings → Source already names $image" \
  'a deployment may still start: check the service on Railway' "$body") || exit 1
if [ "$id" = "$before" ]; then
  echo "::notice::Railway answered with the deployment that already serves ($id): it started no new one"
else
  echo "✓ Railway started deployment $id"
fi
if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "deployment_id=$id" >> "$GITHUB_OUTPUT"; fi

follow_deployment "$id"

# Which image the deployment runs: two reads, $POLL_SECONDS apart.
ran='' listed=false
for attempt in 1 2; do
  if ran=$(deployment_image "$id"); then listed=true; break; fi
  if [ "$attempt" = 1 ]; then sleep "$POLL_SECONDS"; fi
done
if [ "$listed" != true ] || [ -z "$ran" ]; then
  why='could not be read'
  if [ "$listed" = true ]; then why='names no image'; fi
  echo "::warning::Deployment $id succeeded, but Railway's record of it $why: check on Railway that it runs $image"
  echo "✓ Railway reports SUCCESS for deployment $id (its image is not confirmed)"
  exit 0
fi
case "$ran" in
  "$image" | "$image"@sha256:*) echo "✓ Railway runs $image (deployment $id)" ;;
  *)
    echo "✗ deployment $id succeeded, but it runs $ran, not $image: the service did not move. Railway may have staged the image change instead of applying it (the service's Settings → Source)."
    exit 1
    ;;
esac
