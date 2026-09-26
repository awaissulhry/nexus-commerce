#!/usr/bin/env bash
# Sourced by the two Package A entrypoints; never source another worktree's .env.
set -euo pipefail
TOOLS=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
VERIFY="$TOOLS/rehearsal-verify.mjs"
OA=/private/tmp/cx-0a-20260923
REL=/private/tmp/cx-release-20260923
REC=/private/tmp/cx-recovery-20260923
BASE_SHA=${CX_BASE_SHA:-a22f2fc361488c3620d6c8110344e8200c46ebb2}
RELEASE_SHA=${CX_RELEASE_SHA:-77c787559d95dc394df358a9fea7b10179b6d5a0}
RECOVERY_SHA=${CX_RECOVERY_SHA:-a5efa0dd926ea49e886af18ad0f3be278bd910a4}
FAKEHOME="$EV/empty-home"
APP=''
NAME="cx-rehearsal-${MODE}-$$"
log() { echo "[$(date -u +%H:%M:%SZ)] $*" | tee -a "$EV/rehearsal.log"; }
fail() { log "FAILED: $*"; exit 1; }
cleanup() {
  local status=$?
  trap - EXIT
  if [[ -n "$APP" ]]; then kill "$APP" 2>/dev/null || true; wait "$APP" 2>/dev/null || true; fi
  docker stop "$NAME" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT
trap 'echo "FAILED: rehearsal command at line $LINENO" >&2' ERR
mkdir -p "$EV" "$FAKEHOME"
cd "$REL"

preflight() {
  local tree=$1 expected=$2 built=$3 actual
  [[ "$expected" =~ ^[a-f0-9]{40}$ ]] || fail 'expected commit is not a full SHA'
  actual=$(git -C "$tree" rev-parse HEAD)
  [[ "$actual" == "$expected" ]] || fail "unexpected HEAD in $tree"
  git -C "$tree" diff --quiet HEAD -- apps/api/src packages/database packages/shared packages/events || fail "dirty source in $tree"
  node "$VERIFY" env "$tree"
  if [[ "$built" == yes ]]; then [[ -s "$tree/apps/api/dist/index.js" ]] || fail "API build missing in $tree"; fi
  log "preflight $tree @ $actual; env checked without exposing values"
}
preflight "$OA" "$BASE_SHA" no
preflight "$REL" "$RELEASE_SHA" yes
preflight "$REC" "$RECOVERY_SHA" yes
for item in base release recovery; do
  case "$item" in base) tree=$OA;; release) tree=$REL;; recovery) tree=$REC;; esac
  node "$VERIFY" manifest "$tree" > "$EV/manifest-$item.json"
done
node "$VERIFY" delta "$EV/manifest-base.json" "$EV/manifest-release.json" "$EV/manifest-recovery.json"
log 'release and recovery preserve the baseline and add exactly 20260923a..h_cx_*'

# env -i alone is insufficient: dotenv can read files. Preflight checks every
# loader location; the preload additionally prevents any non-loopback Node socket.
clean_env() {
  exec env -i PATH="$PATH" HOME="$FAKEHOME" NODE_ENV=production DATABASE_URL="$DATABASE_URL" \
    NODE_OPTIONS="--require=$TOOLS/rehearsal-network.cjs" npm_config_offline=true \
    AWS_EC2_METADATA_DISABLED=true REDIS_URL=redis://127.0.0.1:1 \
    NEXUS_ENABLE_EBAY_INBOUND_PROCESSING=0 NEXUS_ENABLE_EBAY_ORDER_NOTICES=0 \
    NEXUS_ENABLE_ETSY_ORDER_INGEST=0 NEXUS_ENABLE_ETSY_RECEIPTS_POLL_CRON=0 \
    NEXUS_AMAZON_FINANCES_2024_WRITER=0 NEXUS_ENABLE_EBAY_NOTIFICATION_SETUP=0 "$@"
}
Q() { docker exec "$NAME" psql -X -U postgres -h 127.0.0.1 -d cx_rh -v ON_ERROR_STOP=1 -Atc "$1"; }
history() {
  Q 'SELECT json_agg(t ORDER BY name) FROM (SELECT id, migration_name AS name, checksum, finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS "rolledBack", started_at, finished_at, rolled_back_at FROM _prisma_migrations) t' > "$1"
}
check_history() {
  history "$EV/history-$1.json"
  node "$VERIFY" history "$EV/history-$1.json" "$EV/manifest-release.json"
  node "$VERIFY" history "$EV/history-$1.json" "$EV/manifest-recovery.json"
  node "$VERIFY" unchanged "$EV/history-migrated.json" "$EV/history-$1.json"
  log "$1: complete migration history/checksums unchanged and match release + recovery"
}
objects() {
  Q "SELECT json_build_object(
    'ownerSafe', (SELECT count(*)=1 FROM pg_roles WHERE rolname='nexus_owner' AND NOT rolsuper AND rolbypassrls AND rolcreatedb AND rolcreaterole AND NOT rolreplication),
    'rolesSafe', (SELECT count(*)=3 AND bool_and(NOT (rolcanlogin OR rolinherit OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) FROM pg_roles WHERE rolname IN ('nexus_ebay_quarantine_writer','nexus_ebay_quarantine_maintenance','nexus_ebay_quarantine_custodian')),
    'functionsSafe', (SELECT count(*)=4 AND bool_and(coalesce(prosecdef AND proconfig @> ARRAY['search_path=pg_catalog, pg_temp'] AND pg_get_userbyid(proowner)='nexus_ebay_quarantine_writer', false)) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('nexus_rewrap_ebay_quarantine','nexus_ebay_quarantine_inventory','nexus_ebay_quarantine_manifest','nexus_ebay_quarantine_cipher_batch')),
    'tablesSafe', (SELECT count(*)=2 AND bool_and(relrowsecurity AND relforcerowsecurity) FROM pg_class WHERE relnamespace='public'::regnamespace AND relname IN ('EbayNoticeQuarantine','EbayQuarantineMaintenanceAudit')),
    'runtimeDenied', (SELECT count(*)=4 AND bool_and(NOT has_function_privilege('nexus_workspace_runtime', oid, 'EXECUTE')) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('nexus_rewrap_ebay_quarantine','nexus_ebay_quarantine_inventory','nexus_ebay_quarantine_manifest','nexus_ebay_quarantine_cipher_batch')),
    'membershipSafe', NOT EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid JOIN pg_roles u ON u.oid=m.member WHERE (r.rolname LIKE 'nexus_ebay_quarantine_%' AND (u.rolname='nexus_workspace_runtime' OR m.inherit_option OR m.set_option)) OR u.rolname LIKE 'nexus_ebay_quarantine_%'),
    'auditTrigger', EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.\"EbayQuarantineMaintenanceAudit\"'::regclass AND tgname='nexus_retain_quarantine_audit' AND tgenabled='O'))" > "$EV/objects-$1.json"
  node "$VERIFY" objects "$EV/objects-$1.json"
  log "$1: maintenance roles, attributes, objects and pinned definers verified"
}
start_database() {
  docker run -d --rm --name "$NAME" -p 127.0.0.1::5432 -e POSTGRES_HOST_AUTH_METHOD=trust --tmpfs /var/lib/postgresql/data pgvector/pgvector:pg17 > "$EV/container.txt"
  P=$(docker port "$NAME" 5432/tcp | head -1 | awk -F: '{print $NF}')
  [[ "$P" =~ ^[0-9]+$ ]] || fail 'throwaway PostgreSQL port missing'
  local available=no
  for i in $(seq 1 60); do
    if docker exec "$NAME" pg_isready -U postgres -h 127.0.0.1 >/dev/null 2>&1; then available=yes; break; fi
    sleep 0.5
  done
  [[ "$available" == yes ]] || fail 'PostgreSQL did not become ready'
  docker exec "$NAME" psql -X -U postgres -h 127.0.0.1 -v ON_ERROR_STOP=1 -c 'CREATE ROLE nexus_owner LOGIN NOSUPERUSER BYPASSRLS CREATEDB CREATEROLE' > "$EV/create-role.log"
  docker exec "$NAME" psql -X -U postgres -h 127.0.0.1 -v ON_ERROR_STOP=1 -c 'CREATE DATABASE cx_rh OWNER nexus_owner' > "$EV/create-database.log"
  DATABASE_URL="postgresql://nexus_owner@127.0.0.1:$P/cx_rh"
  log "throwaway PostgreSQL $(Q 'SHOW server_version') on port $P"
}
prepare_history() {
  (cd "$OA" && clean_env node packages/database/scripts/bootstrap-fresh-database.mjs) > "$EV/base-bootstrap.log" 2>&1
  (cd "$OA/packages/database" && clean_env node scripts/check-applied-but-missing.mjs) > "$EV/base-gate.log" 2>&1
  history "$EV/history-base.json"
  node "$VERIFY" history "$EV/history-base.json" "$EV/manifest-base.json"
  (cd "$REL/packages/database" && clean_env node scripts/migrate-direct.mjs) > "$EV/release-migrate.log" 2>&1
  history "$EV/history-migrated.json"
  node "$VERIFY" history "$EV/history-migrated.json" "$EV/manifest-release.json"
  node "$VERIFY" history "$EV/history-migrated.json" "$EV/manifest-recovery.json"
  local refusal=0
  (cd "$OA/packages/database" && clean_env node scripts/migrate-direct.mjs) > "$EV/base-refusal.log" 2>&1 || refusal=$?
  node "$VERIFY" refusal "$refusal" "$EV/base-refusal.log"
  check_history after-base-refusal
  objects migrated
  log 'bootstrap + release migration succeeded; serving base refused the eight CX additions'
}
boot() { # worktree, label, exact SHA
  local tree=$1 label=$2 expected=$3 status=000 ready=no
  node "$VERIFY" env "$tree"
  printf '%s\n' "$expected" > "$tree/apps/api/.release-sha"
  clean_env PORT="$PORT" NEXUS_DISABLE_BACKGROUND_JOBS="$DISABLE_JOBS" \
    sh -c 'cd "$1/packages/database" && node scripts/migrate-direct.mjs && cd "$1" && exec node apps/api/dist/index.js' sh "$tree" > "$EV/boot-$label.log" 2>&1 &
  APP=$!
  for i in $(seq 1 120); do
    kill -0 "$APP" 2>/dev/null || fail "$label process exited before readiness"
    status=$(curl --noproxy '*' -sS --max-time 2 -o "$EV/boot-$label-ready.json" -w '%{http_code}' "http://127.0.0.1:$PORT/api/health/ready" 2>/dev/null) || status=000
    if [[ "$status" == 200 ]]; then ready=yes; break; fi
    sleep 1
  done
  [[ "$ready" == yes ]] || fail "$label readiness did not reach HTTP 200"
  node "$VERIFY" ready "$status" "$EV/boot-$label-ready.json" "$expected"
  # Ready is emitted before start() has initialized all background jobs.
  for i in $(seq 1 120); do
    kill -0 "$APP" 2>/dev/null || fail "$label process exited during initialization"
    if /usr/bin/grep -q 'API server initialized' "$EV/boot-$label.log"; then break; fi
    sleep 1
  done
  if [[ "$MODE" == jobs ]]; then
    for i in $(seq 1 45); do sleep 1; kill -0 "$APP" 2>/dev/null || fail "$label process exited in jobs observation"; done
  fi
  kill -0 "$APP" 2>/dev/null || fail "$label process exited after readiness"
  node "$VERIFY" boot "$EV/boot-$label.log" "$MODE"
  status=$(curl --noproxy '*' -sS --max-time 2 -o "$EV/boot-$label-ready-final.json" -w '%{http_code}' "http://127.0.0.1:$PORT/api/health/ready")
  node "$VERIFY" ready "$status" "$EV/boot-$label-ready-final.json" "$expected"
  kill "$APP"
  local stopped=0
  wait "$APP" || stopped=$?
  APP=''
  [[ "$stopped" == 0 || "$stopped" == 143 ]] || fail "$label unexpected shutdown status $stopped"
  node "$VERIFY" boot "$EV/boot-$label.log" "$MODE"
  check_history "$label"
  objects "$label"
  log "$label: ready=200 build=${expected:0:8} initialized=yes mode=$MODE; assertions passed"
}
