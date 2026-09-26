#!/usr/bin/env bash
# Repeat with background jobs initialized and eBay processing explicitly held.
set -euo pipefail
TOOLS=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
cd /private/tmp/cx-release-20260923
EV=/private/tmp/cx-release-20260923/docs/channel-connections/build/evidence/rehearsal-jobs-20260925
MODE=jobs
DISABLE_JOBS=0
PORT=18472
source "$TOOLS/rehearsal-common.sh"
start_database
prepare_history
boot "$REC" recovery "$RECOVERY_SHA"
boot "$REL" release "$RELEASE_SHA"
boot "$REC" recovery-2 "$RECOVERY_SHA"
log 'PASS: recovery → release → recovery; background jobs initialized, eBay processing held'
