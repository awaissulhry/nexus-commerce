# Inventory Sync Operator Runbook

## Overview

Real-time inventory sync keeps stock quantities consistent across Amazon (FBA + FBM, EU markets), eBay, and Shopify (connected, not yet transacting). The system uses a single `applyStockMovement()` path that cascades stock changes through `OutboundSyncQueue` to per-channel pushes. A BullMQ worker handles immediate dispatch; a 60-second cron provides backstop coverage.

**Source of truth:**
- **FBM / eBay / Shopify:** Our database (`product_inventory` table, `ChannelListing.quantity`)
- **Amazon FBA:** Amazon owns quantities; Nexus reads via SP-API `GetInventorySupply` (15-min poll, daily reconcile cron)

The flow: Stock change (order fulfilment, manual edit, inbound receipt) → `applyStockMovement()` → enqueue to `OutboundSyncQueue` → BullMQ dispatch (immediate) or cron fallback (60s) → per-channel PATCH/POST → `SyncHealthLog` record (with latency, success/fail, clamping).

---

## Kill-Switch Flags

All default ON unless noted. Set to `0` to disable and redeploy.

| Flag | Purpose | Default | Notes |
|------|---------|---------|-------|
| `NEXUS_SYNC_ORDERING_V2` | Dispatch re-reads current `ChannelListing.quantity` and coalesces superseded queue rows; prevents last-writer-wins races. | ON | Disable only if causality debugging required. |
| `NEXUS_OVERSELL_CLAMP` | Amazon FBM clamp outbound quantity to `availableToPublish` (prevents listing 500 units when only 200 available). eBay clamp is always-on; FBA never clamped. | ON | Prevents customer-visible oversell on FBM. |
| `NEXUS_RESERVATION_RECONCILE` | Hourly reconcile of orphaned `OPEN_ORDER` reservations: CANCELLED → release, SHIPPED/DELIVERED → consume, else alert ops. | ON | Catches reservation leaks (e.g. order DB corruption, cancellation miss). |
| `NEXUS_OUTBOUND_PRIORITY` | Order-driven pushes (fulfillment, returns) get BullMQ priority queue over manual stock edits. | ON | Ensures fulfillment updates push before inventory tweaks. |
| `NEXUS_LATENCY_WATCHDOG` | Hourly latency check: emits alert if any channel's p95 push latency exceeds threshold. | ON | Detects degradation; see `NEXUS_LATENCY_P95_BREACH_MS`. |
| `NEXUS_LATENCY_P95_BREACH_MS` | Threshold (ms) for latency watchdog alert. | `60000` | Tune post-deploy from observed p95 baseline. |
| `NEXUS_EBAY_READBACK` | 30-minute eBay inventory read-back: polls eBay API for current quantities, compares to DB, emits `ChannelStockEvent` for drift pipeline. | ON | Catches eBay sales not flowing back via notifications. |
| `NEXUS_EBAY_READBACK_MAX` | Max SKUs polled per read-back run. | `200` | Prevents eBay API exhaustion; tune for account's call limits. |
| `NEXUS_RECONCILE_CRON` | Daily (03:45 UTC) Amazon reconciliation: reads `GetInventorySupply`, compares FBA qty vs DB, emits drift alerts. | ON | Primary Amazon ground-truth check. |
| `NEXUS_DRIFT_ALERTS` | Within reconcile cron: cumulative-bleed and stale-conflict alerts. | ON | If OFF, reconcile runs silent. |
| `ENABLE_QUEUE_WORKERS` | (Pre-existing) Activates BullMQ worker for immediate dispatch; if `0`, only 60s cron path active. | `1` | If `0`, all pushes delayed to cron cadence. |

---

## Events

Emitted on `/api/orders/events` (order-events SSE bus). Surfaced in RT alerting banner + control-tower live updates. **None are failures; all are operational signals.**

| Event | When | Severity | Remediation |
|-------|------|----------|-------------|
| `sync.oversell.clamped` | A push to Amazon FBM or eBay was clamped below the requested quantity (e.g., customer edited stock to 500 but only 200 available). | INFO | Normal guard firing; check that listing quantity buffer is realistic. |
| `sync.latency.breach` | A channel's p95 push latency exceeded `NEXUS_LATENCY_P95_BREACH_MS`. | WARN | Check channel API health, network, queue backlog via diagnostics endpoint. |
| `sync.realtime.degraded` | Sync is on 60s-cron path instead of BullMQ immediate (i.e., `ENABLE_QUEUE_WORKERS=0` or eBay notifications inactive). | WARN | Restarts delayed 60s; redeploy or re-enable eBay Platform Notifications. |
| `sync.reconcile.drift` | Amazon daily reconcile found FBA quantity drift exceeding cumulative threshold (default 5 units over 24h). | WARN | Run control-tower delta-preview for the SKU; if persistent, investigate SP-API feed processing. |
| `sync.drift.cumulative` | Repeated small auto-applies or clamping events summed over threshold (slow bleed detected). | WARN | Audit manual stock edits; check if buffer is too narrow. |
| `sync.conflict.stale` | `SyncHealthLog` conflict record unresolved for >7 days (e.g., a push succeeded on one channel but failed on another). | WARN | Review conflict via admin endpoint; may need manual sync reset on failed channel. |

---

## Scheduled Jobs

| Job | Cadence | Purpose |
|-----|---------|---------|
| `inventory-reconcile` | Daily, 03:45 UTC | Amazon FBA reconciliation: `GetInventorySupply` vs DB, emit drift alerts. |
| `reservation-reconcile` | Hourly | Orphaned `OPEN_ORDER` reservation sweep: CANCELLED release, SHIPPED/DELIVERED consume. |
| `latency-watchdog` | Hourly, :30 | Check per-channel p95 push latency; emit `sync.latency.breach` if exceeded. |
| `ebay-readback` | Every 30 min | Poll eBay `GetSellerInventory` for current quantities, emit drift events. |
| `sync-drift-detection` | Every 30 min | (Pre-existing) Detect slow bleed via cumulative drift & conflicts. |
| `fba-flip-guard` | Every 10 min | Detect FBA←→FBM quantity flips (guard against Marketplace API misfire). |
| `reservation-sweep` | Every 5 min | Clean up expired reservations (TTL-based). |
| `amazon-sqs-poll` | ~30s | Poll SQS for SP-API ORDER_CHANGE webhooks (live order events). |
| `amazon-inventory-sync` | Every 15 min | Poll `GetInventorySupply` for FBA (backstop to daily reconcile). |

---

## Admin & Diagnostic Endpoints

**`GET /api/admin/inventory-sync/diagnostics`**

Returns: is sync real-time right now?
- `dispatchPath`: `'immediate-bullmq'` (normal) or `'cron-60s-only'` (degraded)
- `ebayNotificationsActive`: boolean (eBay Platform Notifications configured?)
- `queueBacklog`: count of pending `OutboundSyncQueue` rows
- `dlqDepth`: count of dead-letter items
- `cronLastRuns`: last run timestamp for each scheduled job + any error
- `warnings`: array of operational issues (e.g., "eBay notifications inactive", "BullMQ worker unavailable")

**`GET /api/admin/outbound-latency?window=24h&syncType=QUANTITY_UPDATE`**

Returns per-channel push latency metrics (JSON):
- `channel`: (AMAZON_FBM, AMAZON_FBA, EBAY, SHOPIFY)
- `p50`, `p95`, `p99`: latency in ms
- `sampleCount`: number of pushes in window
- `lastPushAt`: ISO timestamp

**`GET /api/inventory-sync/control-tower`**

Returns the control-tower grid data (SKU × channel sync status).

**`GET /api/inventory-sync/control-tower/:sku/delta`**

Returns delta preview for a single SKU: current DB qty, what the next push will set, why (clamped, pending, etc.).

**Scripts (from `scripts/` directory):**

- `scripts/inventory-drift-baseline.ts` — Read-only: list Amazon FBA + eBay inventory drift (no write).
- `scripts/inventory-canary.ts` — Gated, net-zero round-trip latency probe: increments a test SKU, monitors push latency, decrements back.

---

## Operator Control Tower — `/fulfillment/stock/control-tower`

Per-SKU × per-channel sync status grid. Worst-wins chip logic:

```
DEAD > FAILED > CLAMPED > PENDING > IN_SYNC
```

**Columns:**
- SKU, Product, Channel (AMAZON_FBM, AMAZON_FBA, EBAY, SHOPIFY)
- Status chip (color + icon)
- Current quantity, queued quantity, available quantity
- Last sync timestamp, last error (if any)

**Filters:** by status (IN_SYNC / PENDING / CLAMPED / FAILED / DEAD), by channel.

**Actions:**
- Click SKU → delta-preview modal (what will the next push set? why is it blocked?)
- "Retry failed" bulk action → re-enqueue all FAILED + DEAD rows.
- Live events banner at top (last 10 `sync.*` events).
- DLQ badge (red if items present).

---

## Runbook: Common Situations

### "eBay sales aren't decrementing stock in real-time"

**Diagnosis:**
1. Open `/api/admin/inventory-sync/diagnostics` → check `ebayNotificationsActive`.
2. If `false`: eBay Platform Notifications (webhooks) are not configured. System falls back to 15-min poll.
3. If `true`: check `/fulfillment/stock/channel-drift` for recent eBay `ChannelStockEvent` rows (drift events).

**Fix:**
- If notifications not configured, run `/setup-ebay-notifications` (admin script). Requires eBay API credentials, Notification Hub re-auth.
- If notifications are on but drift detected, check eBay API latency; may need to increase `NEXUS_EBAY_READBACK_MAX` or readback cadence.

---

### "A channel shows the wrong quantity"

**Diagnosis:**
1. Go to `/fulfillment/stock/control-tower`.
2. Filter to the SKU; find the channel with the wrong qty.
3. Click the SKU → delta-preview modal. It shows: current DB qty, what the next push will set, and why (CLAMPED / PENDING / etc.).
4. If the status is FAILED or DEAD, there's a queue row stuck.

**Fix:**
- If FAILED/DEAD: bulk-select "Retry failed" (re-enqueues the row).
- If CLAMPED: the requested qty exceeds `availableToPublish`. Increase available qty or adjust the listing quantity.
- If PENDING for >60s: BullMQ may be stuck. Check `ENABLE_QUEUE_WORKERS=1` and queue backlog via diagnostics.
- Check `/fulfillment/stock/channel-drift` for drift events; if drift is recent, wait for next readback cycle (30 min for eBay, 15 min for Amazon).

---

### "Oversell clamp events firing a lot"

**Diagnosis:**
The guard is working: it prevented oversell (requesting qty > available qty). Check why.

**Fix:**
- Review recent stock edits via audit log. Is the buffer too aggressive (too little reserved)?
- Check if inbound receipts are delayed or stuck. Run `scripts/inventory-drift-baseline.ts` to see if on-hand vs listed is misaligned.
- If clamps are legitimate (buffer truly tight), increase inbound forecast or adjust marketing velocity.

---

### "Realtime degraded alert"

**Diagnosis:**
1. Open `/api/admin/inventory-sync/diagnostics`.
2. If `dispatchPath='cron-60s-only'`: either `ENABLE_QUEUE_WORKERS` is not `1`, or BullMQ worker is dead.
3. If `dispatchPath='immediate-bullmq'` but alert still fires: check `ebayNotificationsActive`. If `false`, eBay updates are 30-min delayed.

**Fix:**
- If BullMQ down: restart the worker (check Railway / ECS pod).
- If `ENABLE_QUEUE_WORKERS=0`: redeploy with it set to `1`.
- If eBay notifications down: run `/setup-ebay-notifications` to re-establish webhooks.
- Temporary freeze: set `NEXUS_SYNC_ORDERING_V2=0` and redeploy (will use cron path; slower but stable).

---

### Emergency: Freeze a behavior

Set any kill-switch flag to `0` (see table above) and redeploy or restart. For example:
- `NEXUS_OVERSELL_CLAMP=0` → allow over-publishing (not recommended; will cause customer oversell).
- `NEXUS_SYNC_ORDERING_V2=0` → use cron-only path (slower, more stable).
- `ENABLE_QUEUE_WORKERS=0` → disable BullMQ (all updates via 60s cron).

---

## Baseline Capture (Post-Deploy)

After deploying or restarting the sync system:

1. **Run diagnostics:**
   ```
   curl https://api.nexus.internal/api/admin/inventory-sync/diagnostics
   ```
   Record: `dispatchPath`, `ebayNotificationsActive`, `queueBacklog`, `dlqDepth`.

2. **Capture baseline latency:**
   ```
   curl https://api.nexus.internal/api/admin/outbound-latency?window=1h&syncType=QUANTITY_UPDATE
   ```
   Record p50 / p95 / p99 for each channel. Set `NEXUS_LATENCY_P95_BREACH_MS` to just above the observed p95 (e.g., if p95=42s, set to 50s).

3. **Run drift baseline:**
   ```
   npm run scripts/inventory-drift-baseline -- --output baseline.json
   ```
   Commit `baseline.json` to your oncall runbook; use as a reference for "normal" drift.

4. **Monitor the control tower** for 30 min. All SKUs should show `IN_SYNC`. If any PENDING/FAILED, investigate before considering the deploy stable.

---

## See Also

- `/fulfillment/stock`: Main inventory page (manual edits, per-channel grid).
- `/fulfillment/stock/channel-drift`: Drift event timeline (eBay readback + reconcile alerts).
- `/fulfillment/stock/control-tower`: Real-time sync status grid (operator headquarters).
- `TECH_DEBT.md`: Inventory sync backlog items.
- `docs/edit-ux.md`: Product editor stock field behavior.
