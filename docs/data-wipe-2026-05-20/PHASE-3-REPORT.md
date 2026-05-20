# Phase 3 — Channel ingestion hardening report

**Date:** 2026-05-20
**Status:** ✅ Phase 3 complete (non-destructive). Phase 4 BLOCKED on 3 issues.

---

## Channel cred validation results

| Channel | Status | Notes |
| --- | --- | --- |
| **Amazon SP-API** | ✅ OK | LWA refresh works. Seller `A1VRHKTGYO1JNU` registered in **18 marketplaces** including Amazon.it (`APJ6JRA9NG5V4`), .de, .es, .fr, .co.uk + 8 others + 5 "Non-Amazon" (off-Amazon channels). Backfill ready. |
| **eBay OAuth** | ❌ **HTTP 401 invalid_client** | `EBAY_CLIENT_ID`/`EBAY_CLIENT_SECRET` in .env do not authenticate against eBay's token endpoint. Either creds rotated or env mismatch (production vs sandbox). **Needs operator fix before eBay backfill.** |
| **Shopify** | ⚠ Not configured | No env vars, no ChannelConnection rows. Memory says Shopify is in scope — gap to fill if Xavia has a live store. |

## Production cron audit — the smoking gun

**Key finding:** the 4 ingestion crons that the user actually needs (`amazon-orders-sync`, `amazon-financial-sync`, `ebay-orders-sync`, `ebay-financial-sync`) **have never fired in production** (0 CronRun rows ever).

This is because the production Railway env does not have `NEXUS_ENABLE_AMAZON_ORDERS_CRON=1` etc. set. The local `.env` has them, but production differs.

What IS running in production:
- `amazon-inventory-sync` (652 runs/7d) → flag IS set in prod
- `ads-sync`, `ads-report-ingest`, `ads-v1-export-ingest` (~860 runs/7d) → flag IS set in prod
- `ebay-token-refresh` (325 runs/7d) → always-on, no flag needed

**Required action: set these 4 env vars in Railway production:**
```
NEXUS_ENABLE_AMAZON_ORDERS_CRON=1
NEXUS_ENABLE_AMAZON_FINANCIAL_CRON=1
NEXUS_ENABLE_EBAY_ORDERS_CRON=1
NEXUS_ENABLE_EBAY_FINANCIAL_CRON=1
```
Also consider:
```
NEXUS_ENABLE_AMAZON_RETURNS_POLL=1
```

Once set, production deploy will pick them up on next restart and crons begin firing automatically.

## Backfill scaffold ready

`scripts/first-backfill.mjs` is ready for Phase 4 to wire real handlers into.

Features:
- CLI: `--channel {amazon|ebay} --domain {orders|financial|returns} --from YYYY-MM-DD [--to] [--dry-run] [--resume]`
- Per-(channel, domain) chunk sizes encode API window limits (Amazon orders=30d, eBay orders=7d)
- Per-API throttles: SP-API getOrders 0.0167req/s, eBay 4req/s soft cap, etc.
- Resumable checkpoints at `/tmp/data-wipe-2026-05-20/backfill-CHECKPOINTS/`
- Idempotent (handlers will upsert on unique constraint)

Dry-run verified:
- Amazon orders 24mo → 25 × 30-day chunks
- eBay orders 24mo → 105 × 7-day chunks (eBay's 7-day API window)
- Resume skips completed chunks correctly

---

## 3 blockers before Phase 4 can run

1. **eBay creds (HTTP 401)** — Operator needs to either:
   - Refresh `EBAY_CLIENT_ID`/`EBAY_CLIENT_SECRET` in env from the eBay Developer dashboard, OR
   - Reauthorize the eBay OAuth grant (the existing refresh token is tied to the wrong app/secret)
2. **Production env flags** — Add the 4 `NEXUS_ENABLE_*_CRON=1` flags to Railway env
3. **Phase 4 handler implementation** — The `handleChunk` stubs in `first-backfill.mjs` need real wiring to:
   - `amazonOrdersService.syncAllOrders({ from, to })` (need to add date-range overload — current implementation is `daysBack` only)
   - `ebayOrdersService.pollWindow({ from, to })` (need explicit date params — current implementation uses 7d rolling)
   - `amazonFinancialEventsService.listForRange({ from, to })`

---

## Recommendation

Stop here and address the 3 blockers in this order:

**a)** Fix eBay creds (single env var update or one OAuth click)
**b)** Enable production cron flags (env update + Railway redeploy)
**c)** Approve Phase 4 work, which has two parts:
  - **4a (1-2h):** Add date-range overloads to the 3 services so the scaffold can call them with explicit windows
  - **4b (multi-hour):** Run the actual backfill in tmux/background — Amazon 25 chunks × ~60s throttle ≈ 25 min for orders; eBay 105 chunks × ~250ms ≈ 26 sec for orders. Financial is faster (smaller chunks, simpler API).

Total Phase 4 wall-clock: ~3-5 hours including monitoring + verification.
