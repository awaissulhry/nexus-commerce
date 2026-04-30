#!/bin/bash
set -euo pipefail

BACKEND="https://nexusapi-production-b7bb.up.railway.app"
OFFSET=0
LIMIT=50
BATCH=1
TOTAL_LINKED=0
TOTAL_PROCESSED=0

echo "🔄 Starting product hierarchy reindex…"
echo "   Endpoint: $BACKEND/api/amazon/products/reindex-hierarchy"
echo ""

while true; do
  echo "── Batch $BATCH (offset=$OFFSET, limit=$LIMIT) ──────────────────"

  RESPONSE=$(curl -s -X POST \
    "$BACKEND/api/amazon/products/reindex-hierarchy?offset=$OFFSET&limit=$LIMIT" \
    -H "Content-Type: application/json")

  echo "$RESPONSE" | jq '.'

  # Extract fields (fall back to 0 / false if jq can't find them)
  DONE=$(echo "$RESPONSE"      | jq -r '.done      // false')
  PROCESSED=$(echo "$RESPONSE" | jq -r '.processed // 0')
  LINKED=$(echo "$RESPONSE"    | jq -r '.linked    // 0')
  REMAINING=$(echo "$RESPONSE" | jq -r '.remaining // "?"')

  TOTAL_PROCESSED=$((TOTAL_PROCESSED + PROCESSED))
  TOTAL_LINKED=$((TOTAL_LINKED + LINKED))

  echo ""
  echo "   processed=$PROCESSED  linked=$LINKED  remaining=$REMAINING"
  echo "   running totals → processed=$TOTAL_PROCESSED  linked=$TOTAL_LINKED"
  echo ""

  if [ "$DONE" = "true" ]; then
    echo "✅ All products reindexed!"
    echo "   Total processed : $TOTAL_PROCESSED"
    echo "   Total linked    : $TOTAL_LINKED"
    break
  fi

  OFFSET=$((OFFSET + LIMIT))
  BATCH=$((BATCH + 1))

  echo "   Waiting 2 s before next batch…"
  sleep 2
done
