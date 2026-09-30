#!/bin/bash
#
# Which Railway services deploy from the GHCR images — docs/ci-fast-deploys/PLAN-2026-09-29.md §2 and §7.
#
# Reads the repository variable RAILWAY_IMAGE_SERVICES, a comma list of the names api, worker, scheduler and web (spaces
# around a name are ignored, e.g. "web, worker"), and prints api=, worker=, scheduler= and web= (true or false) for
# $GITHUB_OUTPUT. Empty means no service: every service keeps `railway up`. A name it does not know fails the run: a typo
# must not quietly leave a service on the old path. deploy-api.yml and rollback.yml both read it through this script.
#
#   RAILWAY_IMAGE_SERVICES="web,worker" scripts/ci/image-services.sh >> "$GITHUB_OUTPUT"
set -euo pipefail

list=${RAILWAY_IMAGE_SERVICES:-}
# Leading and trailing blanks go; a line break inside would hide every name after it from `read`.
list="${list#"${list%%[![:space:]]*}"}"
list="${list%"${list##*[![:space:]]}"}"
if [[ "$list" == *$'\n'* ]]; then
  echo "✗ RAILWAY_IMAGE_SERVICES must be one line, e.g. web,worker" >&2
  exit 1
fi

api=false worker=false scheduler=false web=false
IFS=',' read -r -a names <<< "$list"
for raw in ${names[@]+"${names[@]}"}; do
  name="${raw#"${raw%%[![:space:]]*}"}"
  name="${name%"${name##*[![:space:]]}"}"
  case "$name" in
    '') ;;
    api) api=true ;;
    worker) worker=true ;;
    scheduler) scheduler=true ;;
    web) web=true ;;
    *)
      echo "✗ RAILWAY_IMAGE_SERVICES names \"$name\": the names are api, worker, scheduler and web" >&2
      exit 1
      ;;
  esac
done

by_image='' other=''
for role in api worker scheduler web; do
  if [ "${!role}" = true ]; then by_image+=" $role"; else other+=" $role"; fi
done
echo "By image:${by_image:- none}. Not by image:${other:- none}." >&2
printf '%s\n' "api=$api" "worker=$worker" "scheduler=$scheduler" "web=$web"
