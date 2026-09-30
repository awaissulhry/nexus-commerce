#!/usr/bin/env bash
# CI's `sheet` job (.github/workflows/ci.yml), step for step, on this machine: a disposable seeded PostgreSQL 17, the API
# in production mode on the restricted login (profiles ON, RBAC enforced, http cookies), `next build` + `next start`, then
# the product-sheet specs (apps/web/tests/sheet.config.ts). The commands are the job's; only the services differ (Docker
# containers here, service containers there).
#
#   scripts/ci/run-sheet-e2e-local.sh            all six specs
#   SHEET_SHARD=2/3 scripts/ci/run-sheet-e2e-local.sh   one CI shard
#   SKIP_BUILD=1 …                                reuse apps/web/.next from an earlier run of this script
#   PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium …   a browser already on the machine (never `playwright install` there)
#
# 🔴 Hard rules. The database is a throwaway container on 127.0.0.1:${PG_PORT:-55432} named *test*; the seeds refuse
# anything else. NEXT_PUBLIC_API_URL is always set (rule 3). The worker and scheduler are never started (rule 2). CI also
# fences the production hosts in /etc/hosts; this script only checks for that fence and warns, it does not edit the file.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
PG_PORT=${PG_PORT:-55432}
REDIS_PORT=${REDIS_PORT:-56379}
API_PORT=${API_PORT:-58080}
WEB_PORT=${WEB_PORT:-3000}
WORK=${WORK:-$(mktemp -d "${TMPDIR:-/tmp}/nexus-sheet-e2e.XXXXXX")}
ADMIN_DATABASE_URL="postgresql://postgres@127.0.0.1:$PG_PORT/nexus_sheet_test"
export SMOKE_SEED="$WORK/smoke.json"
PIDS=()
cleanup() {
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
  docker rm -f nexus-sheet-e2e-pg nexus-sheet-e2e-redis >/dev/null 2>&1 || true
}
trap cleanup EXIT

grep -q 'nexusapi-production-b7bb.up.railway.app' /etc/hosts || echo "⚠ production hosts are not fenced in /etc/hosts (CI fences them); relying on NEXT_PUBLIC_API_URL and the specs' route aborts"

echo "── services (the job's service containers)"
docker rm -f nexus-sheet-e2e-pg nexus-sheet-e2e-redis >/dev/null 2>&1 || true
docker run -d --name nexus-sheet-e2e-pg -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=nexus_sheet_test \
  -p "127.0.0.1:$PG_PORT:5432" --tmpfs /var/lib/postgresql/data pgvector/pgvector:pg17 >/dev/null
docker run -d --name nexus-sheet-e2e-redis -p "127.0.0.1:$REDIS_PORT:6379" redis:7-alpine >/dev/null
for _ in $(seq 1 60); do docker exec nexus-sheet-e2e-pg pg_isready -U postgres -h 127.0.0.1 >/dev/null 2>&1 && break; sleep 1; done

echo "── database, seed and restricted app login"
cd "$ROOT"
psql "postgresql://postgres@127.0.0.1:$PG_PORT/postgres" -qc "ALTER SYSTEM SET fsync = off" -c "ALTER SYSTEM SET synchronous_commit = off" -c "ALTER SYSTEM SET full_page_writes = off" -c "SELECT pg_reload_conf()"
npx tsx scripts/ci/prepare-test-database.mts --url "$ADMIN_DATABASE_URL"
npx tsx scripts/ci/seed-smoke.mts --url "$ADMIN_DATABASE_URL" --out "$SMOKE_SEED"
APP_DATABASE_URL=$(node -p 'require(process.env.SMOKE_SEED).appDatabaseUrl')

echo "── the API (NODE_ENV=production, restricted login, profiles ON, RBAC enforced, http cookies)"
(cd apps/api && NODE_ENV=production PORT=$API_PORT NEXUS_API_HOST=127.0.0.1 DATABASE_URL="$APP_DATABASE_URL" DIRECT_DATABASE_URL="$APP_DATABASE_URL" \
  REDIS_URL=redis://127.0.0.1:$REDIS_PORT NEXUS_WORKSPACES_ENABLED=1 NEXUS_RBAC_MODE=enforce NEXUS_AMAZON_ENV_TOKEN=off \
  COOKIE_SECURE=false COOKIE_SAMESITE=lax NEXUS_DISABLE_BACKGROUND_JOBS=1 ENABLE_QUEUE_WORKERS=0 \
  exec node --import tsx src/index.ts > "$WORK/api.log" 2>&1) &
PIDS+=($!)

if [ -z "${SKIP_BUILD:-}" ]; then
  echo "── next build (production)"
  (cd apps/web && NEXT_PUBLIC_WORKSPACES_ENABLED=1 NEXT_PUBLIC_API_URL=http://localhost:$API_PORT NEXUS_CI_SKIP_BUILD_TYPECHECK=1 NEXT_TELEMETRY_DISABLED=1 npx next build)
fi

echo "── next start"
for _ in $(seq 1 90); do curl -sf "http://127.0.0.1:$API_PORT/api/health/ready" >/dev/null && break; sleep 1; done
curl -sf "http://127.0.0.1:$API_PORT/api/health/ready" >/dev/null || { echo "✗ API did not become ready"; tail -50 "$WORK/api.log"; exit 1; }
(cd apps/web && NODE_ENV=production DATABASE_URL="$APP_DATABASE_URL" NEXUS_API_PROXY_TARGET=http://127.0.0.1:$API_PORT NEXT_TELEMETRY_DISABLED=1 \
  exec npx next start -p "$WEB_PORT" -H localhost > "$WORK/web.log" 2>&1) &
PIDS+=($!)
for _ in $(seq 1 60); do curl -sf -o /dev/null "http://localhost:$WEB_PORT/login" && break; sleep 1; done
curl -sf -o /dev/null "http://localhost:$WEB_PORT/login" || { echo "✗ web did not start"; tail -50 "$WORK/web.log"; exit 1; }

echo "── product sheet specs ${SHEET_SHARD:-(all)}"
cd apps/web
PLAYWRIGHT_BASE_URL=http://localhost:$WEB_PORT E2E_API_URL=http://127.0.0.1:$API_PORT E2E_DATABASE_URL="$ADMIN_DATABASE_URL" \
E2E_WORKSPACE_ID=nexus_legacy_workspace E2E_AUTH_STATE="$WORK/sheet-auth.json" E2E_OUTPUT_DIR="$WORK/sheet-results" \
E2E_EMAIL=$(node -p 'require(process.env.SMOKE_SEED).email') E2E_PASSWORD=$(node -p 'require(process.env.SMOKE_SEED).password') \
  npx playwright test -c tests/sheet.config.ts "$@"
echo "logs and results: $WORK"
