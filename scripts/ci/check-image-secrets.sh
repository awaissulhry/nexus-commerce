#!/bin/bash
#
# Refuses a Docker image that carries a secret. The API and web images are public on GHCR
# (docs/ci-fast-deploys/PLAN-2026-09-29.md), so this runs on the built image before it is pushed.
#
# Railway provides every secret at run time; none belongs in an image. The checks:
#   1. the image's environment holds only the names allowed below (a secret passed as ENV or ARG would show here);
#   2. no .env file, private key file or SSH key anywhere under /app;
#   3. no live-secret pattern (private key block, AWS key id, Anthropic/Google/Shopify/Neon token, a database URL
#      with a password on a hosted database) in /app outside node_modules, or in the image's build history.
# Exit 1 names every finding. Exit 2: could not inspect the image.
#
#   scripts/ci/check-image-secrets.sh <image>
set -uo pipefail

image=${1:?usage: check-image-secrets.sh <image>}
ALLOWED_ENV='^(PATH|NODE_VERSION|YARN_VERSION|NODE_ENV|HOSTNAME|PORT|NEXT_TELEMETRY_DISABLED|TURBO_TELEMETRY_DISABLED|NPM_CONFIG_UPDATE_NOTIFIER)$'
SECRET='-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|sk-ant-[a-z]+[0-9]*-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{35}|shp(at|ss|ca|pa)_[a-fA-F0-9]{32}|npg_[A-Za-z0-9]{12,}|postgres(ql)?://[^:/@[:space:]]+:[^@[:space:]]{6,}@[a-z0-9.-]+\.(neon\.tech|rlwy\.net|railway\.internal|railway\.app)'

found=0
report() { echo "✗ $1"; found=1; }

env_json=$(docker image inspect --format '{{json .Config.Env}}' "$image") || { echo "✗ cannot inspect $image"; exit 2; }
while IFS= read -r name; do
  [[ "$name" =~ $ALLOWED_ENV ]] || report "environment variable $name is baked into the image"
done < <(jq -r '.[] | split("=")[0]' <<< "$env_json")

files=$(docker run --rm --entrypoint sh "$image" -c \
  'find /app \( -name ".env" -o -name ".env.*" -o -name "*.pem" -o -name "*.key" -o -name "id_rsa*" -o -name "id_ed25519*" \) -print 2>/dev/null') \
  || { echo "✗ cannot list the files of $image"; exit 2; }
while IFS= read -r f; do [ -n "$f" ] && report "secret-shaped file $f"; done <<< "$files"

hits=$(docker run --rm --entrypoint sh -e SECRET="$SECRET" "$image" -c \
  'grep -rIlE --exclude-dir=node_modules -e "$SECRET" /app 2>/dev/null; true') \
  || { echo "✗ cannot scan the files of $image"; exit 2; }
while IFS= read -r f; do [ -n "$f" ] && report "live-secret pattern in $f"; done <<< "$hits"

if docker history --no-trunc --format '{{.CreatedBy}}' "$image" | grep -qE -e "$SECRET"; then
  report "live-secret pattern in the image's build history"
fi

[ "$found" -eq 0 ] && echo "✓ no secret found in $image"
exit "$found"
