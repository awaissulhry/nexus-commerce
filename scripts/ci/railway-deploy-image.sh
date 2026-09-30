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
# 2. Points the service at the image in the token's environment and starts a deployment, with four requests to
#    Railway's GraphQL API as the project token (header Project-Access-Token):
#      projectToken { environmentId project { environments } }   the token's environment, and the project's;
#      serviceInstanceUpdate(serviceId, environmentId, input: {source: {image}})  the service's source there;
#      serviceInstance(serviceId, environmentId) { source { image } }   the source Railway now has;
#      serviceInstanceDeployV2(serviceId, environmentId)   a deployment of it; returns its id.
#    2026-09-30, run 36697739589: `railway service source connect --image` answered the project token "Unauthorized"
#    and changed nothing. It sends serviceConnect, which changes the service in every environment, and a project token
#    acts on one environment of one project (Railway docs, integrations/api). That the token may send the two
#    mutations above is not proven yet: the next switch proves it.
#    The schema marks serviceInstanceUpdate's environmentId "[Experimental]": for an environment that is not a fork,
#    the change reaches every environment that is not a fork (read 2026-09-30). So nothing is changed unless the
#    project has exactly one environment that is not a fork, nor when its environments cannot all be read (denied, or
#    more than one page): the change could reach another environment. On 2026-09-30 the project had one, production.
#    Railway may stage a source change instead of applying it, as its dashboard does when it updates a versioned image
#    tag (review of PR 2, 2026-09-30); a deployment would then run the old build. So the source is read back first,
#    and nothing is deployed when it names another image, or none. A read that fails only warns: step 4 then needs
#    Railway's record of the deployment to name this image.
#    Railway answers a denial with HTTP 200 and `errors` ("Not Authorized"), so each answer is checked for errors and
#    for the field asked for. A request is cut after $RAILWAY_API_SECONDS (60 s). When curl could not reach Railway
#    (name, connection, TLS), nothing was sent; when no answer came in time, or the answer is a server error (HTTP
#    5xx), a mutation may still apply. The messages say which.
#    The deployment id comes back from the mutation, so nothing waits for one to appear. The CLI path waited up to a
#    minute, then ran `railway redeploy --from-source`: connecting an image was not proven to start a deployment, and
#    a plain `railway redeploy` re-runs the latest deployment with that deployment's own image. The schema describes
#    serviceInstanceDeployV2 as "Deploy a service instance. Returns a deployment ID", with no case that starts none,
#    so a re-run with the same image deploys it again. Railway's docs say it deploys "the commit currently associated
#    with the service" by default (integrations/api/manage-services). Not proven yet: that it deploys the image the
#    update set, and whether serviceInstanceUpdate starts a deployment of its own.
# 3. Follows that deployment to SUCCESS; 1 when it ends FAILED, CRASHED, REMOVED or SKIPPED, when a newer deployment
#    replaces it, when it stops being the latest after Railway listed it (the latest goes back to the one that served
#    before: removed or cancelled), or after 15 minutes. A failed deployment never takes traffic. Until Railway lists
#    the new deployment as the service's latest, the one that served before counts as waiting; after a minute of
#    that, Railway's list of deployments (which keeps removed ones) is read once a minute, and a deployment it lists
#    as ended ends the wait.
# 4. Checks what that deployment runs, from Railway's record of it (`railway deployment list --json`): meta.image is
#    this image → 0; another image, or meta.cliMessage and no image (a `railway up` build) → 1. SUCCESS alone does not
#    say: if Railway only staged the new source and the read-back failed, the deployment runs the old build and
#    reports SUCCESS. A record that names neither is read once more (it may not be complete yet). A record that still
#    names neither, or cannot be read, gives a warning when the read-back confirmed the
#    source, and 1 when it did not: then nothing confirms the image (review, 2026-09-30: a first switch, staged, with
#    the read-back denied, ended green). Railway's docs do not describe meta; public deploy scripts read meta.image as
#    the reference the service was pointed at. Only the API has a readiness check of its own commit afterwards.
#
# Writes deployment_id=<id> to $GITHUB_OUTPUT when it can. The follow loop is a small copy of follow_deployment in
# railway-up.sh, which stops earlier (at DEPLOYING: its caller watches the rollout). railway-up.sh goes away once every
# service deploys by image (plan §6, PR 4), so the two are not shared. The token is never printed and never on a
# command line: curl reads its header from a file descriptor, and tracing is switched off (review, 2026-09-30: with
# SHELLOPTS=xtrace a run printed the token).
#
# Polls every 10 s: each `railway service status` costs a few Railway API requests, and Hobby allows 1,000 an hour.
# The waits are deadlines, not poll counts: one read makes several requests and the CLI allows each 90 s (CLI 5.30.1,
# DEFAULT_HTTP_TIMEOUT_SECS), so 90 polls could take far longer than 15 minutes (review of PR 2, 2026-09-30). A read is
# cut at 60 s where `timeout` exists (the runner). Worst case, every read and request hanging to its limit: about 27
# minutes (first read 3 × 70 s, four API requests 4 × 60 s, follow 900 + 130 s, record check 130 s); usually the
# follow plus a few seconds. The jobs that run this allow 40 (45 for the API rollback, which then waits for readiness).
# RAILWAY_POLL_SECONDS, RAILWAY_FOLLOW_SECONDS, RAILWAY_READ_SECONDS, RAILWAY_API_SECONDS and RAILWAY_LIST_SECONDS
# change the timing; only tests set them.
set -euo pipefail
set +x

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
LIST_SECONDS=${RAILWAY_LIST_SECONDS:-60}
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

# What Railway's record of deployment $1 says it runs: "image <ref>" (meta.image), "cli" (meta.cliMessage and no
# image: a `railway up` build) or "none". Fails when Railway cannot be read or does not list that deployment. The JSON
# is never printed.
deployment_image() {
  railway_read deployment list --service "$service" --json --limit 10 |
    jq -er --arg id "$1" 'map(select(.id == $id)) | if length == 0 then error("not listed") else .[0].meta as $m
      | if ($m.image // "") != "" then "image " + $m.image elif ($m.cliMessage // "") != "" then "cli" else "none" end
      end' 2>/dev/null
}

# The status of deployment $1 in Railway's list of the service's deployments, which keeps removed ones. Fails when
# Railway cannot be read or does not list it.
listed_status() {
  railway_read deployment list --service "$service" --json --limit 10 |
    jq -er --arg id "$1" 'map(select(.id == $id)) | if length == 0 then error("not listed") else .[0].status // "" end' 2>/dev/null
}

# One request to Railway's GraphQL API as the project token; $1 is the request body (JSON, built with jq -n). Prints
# the answer (JSON). Otherwise prints why, on one line, and returns 3 when curl could not reach Railway (nothing was
# sent: curl exits 5, 6 and 7 for a name or connection, 35, 60 and 77 for TLS), 2 when no answer came within
# $API_SECONDS s or the answer is a server error (HTTP 5xx): a mutation may still apply. 1 when Railway refused: any
# other status that is not 2xx, a body that is not JSON, or `errors` in it (Railway denies with HTTP 200: "Not
# Authorized"; a nested field's path is named). The token reaches curl through a file descriptor, never its
# arguments; neither it nor any request header is printed.
graphql() {
  local out code status answer errors
  out=$(printf '%s' "$1" |
    curl -sS --max-time "$API_SECONDS" "$API_URL" -H 'Content-Type: application/json' \
      -H @<(printf 'Project-Access-Token: %s\n' "$RAILWAY_TOKEN") --data-binary @- -w '\n%{http_code}') || {
    code=$?
    case "$code" in
      5 | 6 | 7 | 35 | 60 | 77) echo "curl exit $code"; return 3 ;;
    esac
    echo "curl exit $code, limit $API_SECONDS s"
    return 2
  }
  status=${out##*$'\n'} answer=${out%$'\n'*}
  errors=$(jq -r 'if type == "object" and (.errors | type) == "array" and (.errors | length) > 0
    then [.errors[] | (.message // "no message" | tostring | gsub("\\s+"; " "))
      + (if (.path | type) == "array" and (.path | length) > 1 then " (" + (.path | map(tostring) | join(".")) + ")" else "" end)]
      | join("; ") | .[:300] else empty end' \
    <<< "$answer" 2>/dev/null) || errors=''
  case "$status" in
    2[0-9][0-9]) ;;
    5[0-9][0-9]) echo "HTTP $status, a server error${errors:+: $errors}"; return 2 ;;
    *) echo "HTTP $status${errors:+, $errors}"; return 1 ;;
  esac
  if ! jq -e 'type == "object"' <<< "$answer" > /dev/null 2>&1; then
    echo "its answer is not JSON (HTTP $status)"
    return 1
  fi
  if [ -n "$errors" ]; then
    echo "$errors"
    return 1
  fi
  printf '%s\n' "$answer"
}

# A request the deploy needs. Prints what the jq filter $2 picks from the answer: a string, else the answer counts as
# holding none. $1 names the request in messages, $3 is the ✗ line's end when Railway refuses or is not reached, $4
# its end when no answer comes, $5 the request body. Fails with a ✗ line on stderr.
railway_api() {
  local answer value code=0
  answer=$(graphql "$5") || code=$?
  case "$code" in
    0) ;;
    2) echo "✗ no answer from Railway to $1 ($answer) — $4" >&2; return 1 ;;
    3) echo "✗ could not reach Railway for $1 ($answer): nothing was sent — $3" >&2; return 1 ;;
    *) echo "✗ Railway refused $1: $answer — $3" >&2; return 1 ;;
  esac
  value=$(jq -r "$2 | strings" <<< "$answer" 2>/dev/null) || value=''
  if [ -z "$value" ]; then
    echo "✗ Railway refused $1: its answer holds no result — $3" >&2
    return 1
  fi
  printf '%s\n' "$value"
}

# Waits until deployment $1 is SUCCESS (0), or ends, is replaced or runs out of time (1). A failed read is retried.
# While the service's latest deployment is still the one that served before ($before), the new one is not listed yet;
# once it was listed, going back to that one means it was removed or cancelled (GONE).
follow_deployment() {
  local id=$1 status='' last='' start=$SECONDS seen=false ended=''
  local deadline=$((start + FOLLOW_SECONDS)) next_list=$((start + LIST_SECONDS))
  while :; do
    status=$(service_status |
      jq -r --arg id "$id" --arg before "$before" --argjson seen "$seen" '
        if .deploymentId == $id then .status
        elif (.deploymentId // "") == $before then (if $seen then "GONE" else "NOT LISTED YET" end)
        else "REPLACED:" + (.deploymentId // "none") end' 2>/dev/null) || status=''
    case "$status" in '' | 'NOT LISTED YET' | GONE | REPLACED:*) ;; *) seen=true ;; esac
    if [ -n "$status" ] && [ "$status" != "$last" ]; then
      echo "$(date -u +%H:%M:%S) deployment $id: $status"
      last=$status
    fi
    case "$status" in
      SUCCESS) return 0 ;;
      FAILED | CRASHED | REMOVED | SKIPPED) echo "✗ deployment $id ended $status — the previous build keeps serving"; return 1 ;;
      GONE) echo "✗ deployment $id is no longer Railway's latest (removed or cancelled) — the previous build keeps serving"; return 1 ;;
      REPLACED:*) echo "✗ deployment $id was replaced by deployment ${status#REPLACED:} before it succeeded"; return 1 ;;
      'NOT LISTED YET')
        if [ "$SECONDS" -ge "$next_list" ]; then
          next_list=$((SECONDS + LIST_SECONDS))
          ended=$(listed_status "$id") || ended=''
          case "$ended" in
            REMOVED | FAILED | CRASHED | SKIPPED)
              echo "✗ deployment $id ended $ended before Railway listed it as the service's latest — the previous build keeps serving"
              return 1
              ;;
          esac
        fi
        ;;
    esac
    [ "$SECONDS" -lt "$deadline" ] || break
    sleep "$POLL_SECONDS"
  done
  if [ "$status" = 'NOT LISTED YET' ]; then
    echo "✗ deployment $id was never listed by Railway as the service's latest within $((SECONDS - start)) s — it may have been removed; the previous build keeps serving"
  else
    echo "✗ deployment $id was still ${status:-unknown} after $((SECONDS - start)) s — the previous build keeps serving until it succeeds"
  fi
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

# The token's environment and the project's environments (header, step 2). When the environments cannot all be read,
# nothing is changed either: the update could reach an environment nobody checked. No id is printed: the logs of this
# public repository are public.
body=$(jq -n '{query: "query DeployImageToken { projectToken { environmentId project { environments(first: 100) { edges { node { id deletedAt sourceEnvironment { id } } } pageInfo { hasNextPage } } } } }"}')
token=$(railway_api "the token's environment and the project's environments (projectToken)" \
  '.data.projectToken | objects | select((.environmentId | type) == "string" and .environmentId != "") | tojson' \
  'nothing was changed' 'nothing was changed' "$body") || exit 1
environment=$(jq -r '.environmentId' <<< "$token")
roots=$(jq -r '.project.environments // {} | if (.edges | type) != "array" or (.pageInfo.hasNextPage | type) != "boolean"
    then "unread" elif .pageInfo.hasNextPage then "more"
    else [.edges[].node | select(.deletedAt == null and .sourceEnvironment == null)] | length end' <<< "$token" 2>/dev/null) ||
  roots=unread
case "$roots" in
  1) ;;
  0)
    echo "✗ every environment of the Railway project is a fork (each names a source environment), so what serviceInstanceUpdate would change is not clear — nothing was changed"
    exit 1
    ;;
  unread | more | '')
    why='its answer holds no list'
    if [ "$roots" = more ]; then why='more than 100'; fi
    echo "✗ could not read all of the Railway project's environments ($why) — nothing was changed: serviceInstanceUpdate changes the service in every environment that is not a fork, so it is sent only when there is one"
    exit 1
    ;;
  *)
    echo "✗ the Railway project has $roots environments that are not forks: serviceInstanceUpdate would change the service in all of them — nothing was changed"
    exit 1
    ;;
esac

echo "Pointing the service at $image"
body=$(jq -n --arg service "$service" --arg environment "$environment" --arg image "$image" '{
  query: "mutation DeployImageSource($service: String!, $environment: String!, $input: ServiceInstanceUpdateInput!) { serviceInstanceUpdate(serviceId: $service, environmentId: $environment, input: $input) }",
  variables: {service: $service, environment: $environment, input: {source: {image: $image}}}}')
railway_api "the change of the service's source to $image (serviceInstanceUpdate)" \
  '.data.serviceInstanceUpdate | select(. == true) | tostring' \
  'the previous build keeps serving' \
  "it may still apply; the previous build keeps serving, and Settings → Source may name $image" "$body" > /dev/null || exit 1

# The source Railway now has (header, step 2). The read succeeds when the answer holds the service instance and its
# source: null, or an object with an image (null for a service that has none, such as a `railway up` build).
body=$(jq -n --arg service "$service" --arg environment "$environment" '{
  query: "query DeployImageApplied($service: String!, $environment: String!) { serviceInstance(serviceId: $service, environmentId: $environment) { source { image } } }",
  variables: {service: $service, environment: $environment}}')
applied='' read_back=false
if answer=$(graphql "$body"); then
  if jq -e '.data.serviceInstance | type == "object" and has("source")
      and (.source == null or (.source | type == "object" and has("image")))' <<< "$answer" > /dev/null 2>&1; then
    read_back=true
    applied=$(jq -r '.data.serviceInstance.source.image // empty' <<< "$answer")
  else
    answer='its answer holds no source'
  fi
fi
if [ "$read_back" != true ]; then
  echo "::warning::Could not read the service's source back from Railway ($answer): deploying anyway; the job then passes only if Railway's record of the deployment names $image"
else
  case "$applied" in
    "$image" | "$image"@sha256:*) echo "✓ The service's source on Railway is now $image" ;;
    *)
      echo "The service's source on Railway: ${applied:-no image}"
      echo "✗ Railway staged the image change instead of applying it (Settings → Source) — nothing was deployed; the previous build keeps serving"
      exit 1
      ;;
  esac
fi

body=$(jq -n --arg service "$service" --arg environment "$environment" '{
  query: "mutation DeployImageStart($service: String!, $environment: String!) { serviceInstanceDeployV2(serviceId: $service, environmentId: $environment) }",
  variables: {service: $service, environment: $environment}}')
source_names="Settings → Source already names $image"
if [ "$read_back" != true ]; then source_names="Settings → Source may name $image (the read-back failed)"; fi
# The id goes into $GITHUB_OUTPUT: only letters, digits and dashes, so an answer cannot add a line there.
id=$(railway_api "a deployment of $image (serviceInstanceDeployV2)" \
  '.data.serviceInstanceDeployV2 | strings | select(test("\\A[A-Za-z0-9-]+\\z"))' \
  "the previous build keeps serving, while $source_names" \
  "a deployment may still start: check the service on Railway; $source_names" "$body") || exit 1
if [ "$id" = "$before" ]; then
  echo "::notice::Railway answered with the deployment that already serves ($id): it started no new one"
else
  echo "✓ Railway started deployment $id"
fi
if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "deployment_id=$id" >> "$GITHUB_OUTPUT"; fi

follow_deployment "$id"

# What the deployment runs, from Railway's record of it: read again, $POLL_SECONDS later, when the first read fails or
# names nothing (the record may not be complete yet).
record='' listed=false
for attempt in 1 2; do
  if read_record=$(deployment_image "$id"); then
    record=$read_record listed=true
    [ "$record" = none ] || break
  fi
  if [ "$attempt" = 1 ]; then sleep "$POLL_SECONDS"; fi
done
case "$record" in
  "image $image" | "image $image"@sha256:*) echo "✓ Railway runs $image (deployment $id)"; exit 0 ;;
  image\ *)
    echo "✗ deployment $id succeeded, but it runs ${record#image }, not $image: the service did not move. Railway may have staged the image change instead of applying it (the service's Settings → Source)."
    exit 1
    ;;
  cli)
    echo "✗ deployment $id succeeded, but it runs a \`railway up\` build, not $image: the service did not move. Railway may have staged the image change instead of applying it (the service's Settings → Source)."
    exit 1
    ;;
esac
why='could not be read'
if [ "$listed" = true ]; then why='names no image'; fi
if [ "$read_back" != true ]; then
  echo "✗ deployment $id succeeded, but neither the service's source (unread) nor Railway's record of the deployment ($why) confirms $image — check Settings → Source and the deployment on Railway"
  exit 1
fi
echo "::warning::Deployment $id succeeded and the service's source names $image, but Railway's record of the deployment $why: check on Railway once that it runs $image"
echo "✓ Railway reports SUCCESS for deployment $id (the service's source names $image; the deployment's record does not confirm it)"
