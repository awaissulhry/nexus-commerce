#!/bin/bash
#
# Which Railway services a release must ship: those whose files differ between the commit the service RUNS now and
# the commit being released. The Owner's rule of 2026-09-30: CI-only and docs-only changes deploy nothing.
#
# Why the running commit, not the last successful run: a newer push cancels a run still waiting in the `deploy-api`
# group, a failed run may have shipped only some services, and a service can be rolled back by hand. Each of those
# leaves a service on an older commit, and only the service itself knows which (2026-09-29: #164's API change sat in
# cancelled run 36614110677; runs 36642062783 and 36642190902 were cancelled after #179's API had already landed).
#
# The running commit is read from the service's latest SUCCESS deployment on Railway. A `railway up` deployment is
# named "<role> GitHub <sha>" by deploy-api.yml (`railway up --message`; a Railway redeploy keeps that name). An image
# deployment records its image, ghcr.io/<owner>/nexus-api:<sha> or nexus-web:<sha> (meta.image). When the commit
# cannot be read or fetched, that service ships: shipping too much is safe, skipping a change is not. A service that
# already runs a NEWER commit does not ship: re-running an old run must not roll it back onto a schema that has moved
# on. A service whose way of deploying changed ships, whatever its files: IMAGE_<ROLE>=true (RAILWAY_IMAGE_SERVICES
# names it) while it runs a `railway up` build, or false while it runs an image. So after the Owner changes the
# variable, a hand run (ship=changed) moves exactly that service. SHIP_ALL=true (`-f ship=all`) ships everything.
#
# Needs the history of main (checkout with fetch-depth 0; blob:none is enough).
#
#   GITHUB_SHA=<sha> RAILWAY_TOKEN=… API_SERVICE=<id> WORKER_SERVICE=<id> SCHEDULER_SERVICE=<id> WEB_SERVICE=<id> \
#     [IMAGE_API=… IMAGE_WORKER=… IMAGE_SCHEDULER=… IMAGE_WEB=…] [SHIP_ALL=true] scripts/ci/release-changes.sh
#
# Writes api, worker, scheduler and web (true/false) and background (the JSON list of worker/scheduler to ship) to
# $GITHUB_OUTPUT when it is set, and prints them either way.
set -uo pipefail

# The files each service is built from. Markdown never ships: CLAUDE.md files and notes live beside the code. BUILD is
# what Railway's own build reads at the root (2026-09-29: a root .dockerignore broke the API build, run 36636596664).
BUILD='package(-lock)?\.json$|patches/|\.npmrc$|\.dockerignore$|\.gitignore$|\.railwayignore$|railway\.(json|toml)$|railpack\.json$|nixpacks\.toml$|mise\.toml$|\.tool-versions$|Dockerfile$'
API_FILES="^(apps/api/|packages/(database|shared|events)/|$BUILD)"
# docs/fixtures/vt1/fixtures.ts: the one file outside the workspaces that the web imports (/design-system).
WEB_FILES="^(apps/web/|packages/(database|shared)/|docs/fixtures/vt1/fixtures\.ts$|$BUILD)"

# What a service runs: sets `kind` (image, up, or empty when Railway cannot be read) and `sha` (empty when the
# deployment names no commit). On the runner a hung call gives up after 60 s and the service ships (macOS has no
# `timeout`; the check runs without it there).
LIMIT=()
if command -v timeout >/dev/null; then LIMIT=(timeout 60); fi
read_running() {
  local service=$1 line
  kind='' sha=''
  line=$(${LIMIT[@]+"${LIMIT[@]}"} railway deployment list --service "$service" --limit 20 --json 2>/dev/null |
    jq -r 'sort_by(.createdAt) | reverse | first(.[] | select(.status == "SUCCESS")) | .meta |
      if (.image // "") != "" then "image " + .image else "up " + (.cliMessage // "") end' 2>/dev/null) || line=''
  case "$line" in
    image\ *)
      kind=image
      sha=$(grep -oE '/nexus-(api|web):[0-9a-f]{40}(@sha256:[0-9a-f]+)?$' <<< "${line#image }" | grep -oE '[0-9a-f]{40}' | head -1) ;;
    up\ *)
      kind=up
      sha=$(grep -oE 'GitHub [0-9a-f]{40}$' <<< "${line#up }" | cut -d' ' -f2) ;;
  esac
}

# The commit is here, or can be fetched.
have_commit() {
  git cat-file -e "$1^{commit}" 2>/dev/null || git fetch --no-tags --depth=1 -q origin "$1" 2>/dev/null
}

# Sets ship=true when $1 (the role) must ship, and prints why. $4: true when it deploys by image, false when by
# `railway up`, empty when unknown.
must_ship() {
  local role=$1 service=$2 files_re=$3 by_image=${4:-} all changed
  ship=true
  if [ "${SHIP_ALL:-}" = true ]; then
    echo "$role: ships (ship=all)"
    return
  fi
  if [ -z "$service" ]; then
    echo "$role: ships (no service ID to read what it runs)"
    return
  fi
  read_running "$service"
  # Newer first: a re-run of an older run must not roll a service back, not even one whose way of deploying changed
  # since (review of PR 2, 2026-09-30).
  if [ -n "$sha" ] && [ "$sha" != "$GITHUB_SHA" ] && have_commit "$sha" && git merge-base --is-ancestor "$GITHUB_SHA" "$sha" 2>/dev/null; then
    echo "::warning::$role: runs ${sha:0:9}, which is newer than this release — not rolled back"
    ship=false
    return
  fi
  if [ "$by_image" = true ] && [ "$kind" = up ]; then
    echo "$role: ships (it moves to image deploys: RAILWAY_IMAGE_SERVICES names it)"
    return
  fi
  if [ "$by_image" = false ] && [ "$kind" = image ]; then
    echo "$role: ships (it moves back to railway up: RAILWAY_IMAGE_SERVICES no longer names it)"
    return
  fi
  if [ -z "$sha" ]; then
    echo "::warning::$role: could not read the commit it runs from Railway — it ships"
    return
  fi
  if [ "$sha" = "$GITHUB_SHA" ]; then
    echo "$role: already runs $GITHUB_SHA"
    ship=false
    return
  fi
  if ! have_commit "$sha"; then
    echo "::warning::$role: could not fetch $sha, the commit it runs — it ships"
    return
  fi
  # --no-renames: a file moved out of a service's tree must count for that tree too. -z: git would otherwise quote a
  # path with a non-ASCII character, a quote or a tab, and the quoted path would miss the patterns.
  if ! all=$(git diff -z --no-renames --name-only "$sha" "$GITHUB_SHA" | tr '\0' '\n'); then
    echo "::warning::$role: could not compare $sha with $GITHUB_SHA — it ships"
    return
  fi
  changed=$(grep -vE '\.md$' <<< "$all" | grep -E "$files_re" || true)
  if [ -n "$changed" ]; then
    echo "$role: runs ${sha:0:9}; its files changed since:"
    sed 's/^/  /' <<< "$changed" | head -40
  else
    echo "$role: runs ${sha:0:9}; none of its files changed since"
    ship=false
  fi
}

: "${GITHUB_SHA:?GITHUB_SHA is required}"
must_ship api "${API_SERVICE:-}" "$API_FILES" "${IMAGE_API:-}"; api=$ship
must_ship worker "${WORKER_SERVICE:-}" "$API_FILES" "${IMAGE_WORKER:-}"; worker=$ship
must_ship scheduler "${SCHEDULER_SERVICE:-}" "$API_FILES" "${IMAGE_SCHEDULER:-}"; scheduler=$ship
must_ship web "${WEB_SERVICE:-}" "$WEB_FILES" "${IMAGE_WEB:-}"; web=$ship
background=$(jq -cn --arg w "$worker" --arg s "$scheduler" '[if $w == "true" then "worker" else empty end, if $s == "true" then "scheduler" else empty end]')

echo "api=$api worker=$worker scheduler=$scheduler web=$web background=$background"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  printf '%s\n' "api=$api" "worker=$worker" "scheduler=$scheduler" "web=$web" "background=$background" >> "$GITHUB_OUTPUT"
fi
