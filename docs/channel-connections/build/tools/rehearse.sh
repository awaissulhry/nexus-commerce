#!/usr/bin/env bash
# Package A only. Builds/gates must finish before running; no production data.
set -euo pipefail
TOOLS=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
cd /private/tmp/cx-release-20260923
EV=/private/tmp/cx-release-20260923/docs/channel-connections/build/evidence/rehearsal-20260925
MODE=http
DISABLE_JOBS=1
PORT=18471
source "$TOOLS/rehearsal-common.sh"
start_database
prepare_history
boot "$REC" recovery "$RECOVERY_SHA"
boot "$REL" release "$RELEASE_SHA"
boot "$REC" recovery-2 "$RECOVERY_SHA"
log 'PASS: serving base → release → recovery → release → recovery'
