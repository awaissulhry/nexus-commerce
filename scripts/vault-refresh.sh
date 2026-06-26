#!/usr/bin/env bash
# vault-refresh.sh — pull latest code from GitHub and report what changed
# Run manually when you want to sync the repo + know if vault notes need updating.
# Usage: ./scripts/vault-refresh.sh

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VAULT_DIR="$REPO_DIR/obsidian-vault"

echo "=== Nexus Commerce Vault Refresh ==="
echo "Repo: $REPO_DIR"
echo ""

cd "$REPO_DIR"

# ── 1. Pull latest from GitHub ───────────────────────────────────────────────
echo "▸ Pulling from GitHub..."
git fetch origin main --quiet

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

if [ "$LOCAL" = "$REMOTE" ]; then
  echo "  Already up to date ($(git rev-parse --short HEAD))."
  CHANGED_FILES=""
else
  CHANGED_FILES=$(git diff --name-only HEAD origin/main)
  git pull origin main --quiet
  echo "  Pulled $(git log --oneline "$LOCAL..HEAD" | wc -l | tr -d ' ') new commit(s)."
fi

echo ""

# ── 2. Analyse which architecture areas changed ───────────────────────────────
if [ -z "$CHANGED_FILES" ]; then
  echo "▸ No code changes — vault notes are current."
  exit 0
fi

echo "▸ Changed files:"
echo "$CHANGED_FILES" | sed 's/^/  /'
echo ""

echo "▸ Vault notes that may need updating:"
NEEDS_UPDATE=()

echo "$CHANGED_FILES" | grep -q "prisma/schema.prisma" \
  && NEEDS_UPDATE+=("05 - Database Schema")

echo "$CHANGED_FILES" | grep -qE "apps/api/src/routes/" \
  && NEEDS_UPDATE+=("04 - API Layer (Fastify)")

echo "$CHANGED_FILES" | grep -qE "apps/api/src/jobs/|\.job\.ts" \
  && NEEDS_UPDATE+=("06 - Background Jobs & Workers")

echo "$CHANGED_FILES" | grep -qE "apps/web/src/app/" \
  && NEEDS_UPDATE+=("10 - Pages & Routes")

echo "$CHANGED_FILES" | grep -qE "apps/web/src/design-system/" \
  && NEEDS_UPDATE+=("09 - Design System")

echo "$CHANGED_FILES" | grep -qE "amazon" \
  && NEEDS_UPDATE+=("11 - Amazon SP-API Integration")

echo "$CHANGED_FILES" | grep -qE "ebay" \
  && NEEDS_UPDATE+=("12 - eBay Integration")

echo "$CHANGED_FILES" | grep -qE "shopify" \
  && NEEDS_UPDATE+=("13 - Shopify Integration")

echo "$CHANGED_FILES" | grep -qE "products\." \
  && NEEDS_UPDATE+=("15 - Product Management")

echo "$CHANGED_FILES" | grep -qE "listing" \
  && NEEDS_UPDATE+=("16 - Listing Management")

echo "$CHANGED_FILES" | grep -qE "fulfillment|stock|inventory" \
  && NEEDS_UPDATE+=("17 - Inventory & Fulfillment")

echo "$CHANGED_FILES" | grep -qE "orders\." \
  && NEEDS_UPDATE+=("18 - Orders & Sales")

echo "$CHANGED_FILES" | grep -qE "pricing|repricing" \
  && NEEDS_UPDATE+=("19 - Pricing & Repricing")

echo "$CHANGED_FILES" | grep -qE "advertising|ads" \
  && NEEDS_UPDATE+=("20 - Advertising")

echo "$CHANGED_FILES" | grep -qE "marketing|content|dam" \
  && NEEDS_UPDATE+=("21 - Marketing & Content")

echo "$CHANGED_FILES" | grep -qE "review" \
  && NEEDS_UPDATE+=("22 - Reviews & Customer Engagement")

echo "$CHANGED_FILES" | grep -qE "analytics|insights|dashboard" \
  && NEEDS_UPDATE+=("23 - Analytics & Insights")

echo "$CHANGED_FILES" | grep -qE "bulk|automation" \
  && NEEDS_UPDATE+=("24 - Bulk Operations & Automation")

echo "$CHANGED_FILES" | grep -qE "auth|api-key|oauth" \
  && NEEDS_UPDATE+=("25 - Authentication & Authorization")

echo "$CHANGED_FILES" | grep -qE "services/bidding-engine" \
  && NEEDS_UPDATE+=("27 - Bidding Engine Microservice")

echo "$CHANGED_FILES" | grep -qE "railway\.toml|vercel\.json|docker-compose" \
  && NEEDS_UPDATE+=("03 - Deployment Architecture")

# Deduplicate
NEEDS_UPDATE=($(printf '%s\n' "${NEEDS_UPDATE[@]}" | sort -u))

if [ ${#NEEDS_UPDATE[@]} -eq 0 ]; then
  echo "  None — changes appear to be non-architectural (scripts, docs, config)."
else
  for note in "${NEEDS_UPDATE[@]}"; do
    echo "  ⚠  $note"
  done
  echo ""
  echo "  To refresh notes, open Claude Code in $REPO_DIR and ask:"
  echo "  \"Update the obsidian-vault notes for: ${NEEDS_UPDATE[*]}\""
fi

echo ""
echo "✓ Done. Vault: $VAULT_DIR"
