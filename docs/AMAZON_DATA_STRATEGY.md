# Amazon Data & Reports Strategy

**Status:** PROPOSAL — awaiting approval before any implementation.
**Date:** 2026-06-17.
**Goal:** Always have *all* Amazon reports + seller economics in Nexus, as fresh as Amazon allows, as the source of truth for **agentic workflows that populate and rebuild pages (replenishment, stock, …)**.

---

## 0. The core question: "Can't we just use Amazon's reports instead of building our own?"

**Verdict: Yes — mirror Amazon verbatim; compute almost nothing.**

The SP-API **Reports API** and **Data Kiosk** are the *same engines* that power Seller Central's report downloads and Business/Economics views. A report we pull via the API is byte-for-byte the file a human downloads from Seller Central. So the right strategy is:

- **MIRROR** everything Amazon produces (reports + economics + transactional events) — exact numbers, no estimation.
- **OVERLAY** only the two things Amazon *cannot* give us:
  1. **Your COGS** (Amazon doesn't know what you paid your supplier) → needed for true margin.
  2. **A live estimate** to fill the T+1 gap *before* the official number lands (clearly labelled, auto-reconciled when the real report arrives).

Building our own reconstruction (what we partly do today with a hard-coded 15% fee) is **less exact** and creates "why does Nexus disagree with Seller Central?" drift. Mirroring is simpler *and* more correct.

**Honest limit:** "real-time" only applies to the transactional layer (orders, stock, offers — push, ~30–90s). Money data (finances, settlements, economics) is **inherently T+1 to T+5** because Amazon's batch cadence controls it. We can *match* Seller Central exactly; we cannot beat Amazon's clock. Anyone showing "real-time P&L" is showing an estimate.

---

## 1. What already exists (strong foundation)

### Ingestion substrate (reusable, cheap to extend)
- **Consistent pattern:** `fetch → parse → upsert by stable ID` across every ingest service. Idempotent (dedupe on `reportId` / `amazonTransactionId` / `reimbursementId` / `channelEventId`).
- **`CRON_REGISTRY`** (`jobs/cron-registry.ts`): typed job map; adding a new report pull = ~1 line + a ~100-line job/service. Auto-appears in `/sync-logs` for manual trigger.
- **`recordCronRun()`** observability + **`OutboundApiCallLog`** per-call audit.
- **BullMQ queues** (`lib/queue.ts`) + **SQS push** (Notifications API) for the real-time transactional layer.
- **`sp-api-reports.service.ts`** — generic request→poll(10s, 5min ceiling)→download→decompress orchestrator already exists.

### Reports we pull today (11)
Sales & Traffic, Merchant Listings (All + Defect), FBM + FBA Returns, FBA Reimbursements, FBA Inventory Adjustments, FBA Aged Inventory, FBA Estimated Fees, V2 Settlement, All-Orders. Plus data APIs: Orders, Finances (events + settlements), Inventory, Pricing, Catalog, Account Health, Ads.

### The consuming side is already sophisticated
The replenishment + stock pages are **not thin** — they already run a real engine fed by Amazon reports:
- **`DailySalesAggregate`** ← `GET_SALES_AND_TRAFFIC_REPORT` (preferred) + OrderItem (live fallback).
- **`ReplenishmentForecast`** ← Holt-Winters / Holt-Linear / Croston engine, category-seasonality pooling, weather/holiday/event signals.
- **`StockLevel`** ← FBA inventory sync (`getInventorySummaries`, ~15min) + multi-location ledger.
- **`FbaRestockRow`** ← FBA restock report (Amazon's own reorder rec, used as a cross-check).
- **`ReplenishmentRecommendation`** ← EOQ + Greene safety-stock (σ_d, σ_LT), lead-time stats from PO history, ATP (on-hand + inbound).

**Implication:** "rebuild the pages from reports" does **not** mean rebuilding the forecast engine. It means (a) widen + freshen the report inputs, (b) close the economics gaps, (c) add an agentic layer that populates/reconciles/acts.

---

## 2. What needs doing (the gaps)

| Gap | Impact | Fix source |
|---|---|---|
| **No Data Kiosk** | No real per-SKU economics; analytics via legacy reports only | Data Kiosk Economics + Sales&Traffic GraphQL |
| **Hard-coded fees** (referral 15%, storage €0, per-order not per-SKU) | Profit + Pricing Watchdog are estimates, not real | Data Kiosk Economics / fee preview report |
| **Reports not pulled** (inventory ledger, stranded inventory, FBA health, fee preview, settlement line-items) | Blind spots | Reports API (cheap to add) |
| **No generic report store / freshness registry** | Freshness inferred from `CronRun`; no "last-updated per dataset" surface | New thin substrate |
| **Finances on legacy `listFinancialEvents`** | Fine but not the freshest path | Migrate to `listTransactions` (2024) |
| **No "Reports hub" UI** | Can't see/download the raw Amazon files in Nexus | New page |

---

## 3. Every option for getting Amazon data in — flexibility & trade-offs

| # | Option | What | Freshness | Flexibility | Effort | Exactness | Best for |
|---|---|---|---|---|---|---|---|
| 1 | **Reports API (batch)** | Pull `GET_*` report files on our cron, store each | T+1 → settlement-cycle | High (100+ types) | Low (reuse substrate, ~100 lines each) | Exact (Amazon's file) | Documents: settlement, FBA, returns, listings, fee preview |
| 2 | **Data Kiosk (GraphQL)** | Query sales&traffic + **economics** (per-SKU net proceeds, real fees) | T+1 (batch query) | Very high (pick fields) | Medium–High (net-new, no code) | Exact (Amazon's numbers) | **Seller economics**, analytics |
| 3 | **Data APIs + Push (SQS)** | Orders/Finances(`listTransactions`)/Inventory/Pricing + Notifications | ~30–90s (push) | High freshness | Mostly built | Exact | **Real-time** transactional (orders, stock, offers) — *done* |
| 4 | **Report Schedules** | `createReportSchedule` → Amazon auto-generates recurring | Same as #1 | Medium (hands-off) | Low | Exact | Set-and-forget recurring; marginal over our cron |
| 5 | **Manual upload / SC export** | Operator downloads from Seller Central, uploads | Manual | Low | Low | Exact | Restricted reports without API role only |
| 6 | **Build our own (reconstruct)** | Compute from OrderItem + local logic | Live | Total control; granularity Amazon lacks | High (maintenance, drift) | **Estimate** (less exact) | The T+1 *gap estimate* + the **COGS join** only |

### Why not just #6 (build our own)?
It's the only one that's *less exact* — it disagrees with Seller Central. Reserve it strictly for the two jobs Amazon can't do: the live gap-filler and the COGS overlay.

### Why not #3 alone (real-time everything)?
Push can't deliver reports/economics — Amazon doesn't push those. #3 is the real-time *transactional* layer (already built); it can't be the economics source.

---

## 4. Recommended architecture: **"Mirror + Overlay"**

```
                 ┌─────────────────── MIRROR (exact Amazon) ───────────────────┐
   Reports API (1) ──▶ raw report store + domain tables  ┐
   Data Kiosk  (2) ──▶ economics: net proceeds, real fees ├─▶  UNIFIED AMAZON DATA SUBSTRATE
   Push/SQS    (3) ──▶ orders, stock, offers (~30–90s)    ┘     (+ per-dataset freshness registry)
                 └──────────────────────────────────────────────────────────┘
                                          │
                 ┌──────────── OVERLAY (only what Amazon can't) ──────────────┐
                 │  • COGS join  → true margin                                 │
                 │  • live estimate → fills T+1 gap, auto-reconciled           │
                 └────────────────────────────────────────────────────────────┘
                                          │
                          ┌───────────────▼────────────────┐
                          │   AGENTIC LAYER (ACP runtime)   │
                          │  tools read substrate → agents  │
                          │  populate + reconcile + propose │
                          │  PO drafts / stock fixes / reorder
                          └───────────────┬────────────────┘
                                          │  (approval inbox — never auto-applies)
                          ┌───────────────▼────────────────┐
                          │  REBUILT PAGES: replenishment,  │
                          │  stock, … (agent-populated)     │
                          └─────────────────────────────────┘
```

- **Substrate = source of truth.** A generic report store (raw file + parsed rows) + a **freshness registry** (per dataset: last-updated, source, official-vs-estimate, next-expected). Extends the existing `CronRun`/idempotency patterns.
- **Agentic top reuses ACP** (the layer we just built): new read-tools expose the substrate; new autonomous agents (Replenishment Keeper, Stock Reconciler) read it and **propose** PO drafts / stock corrections / reorder actions into the **same approval inbox** — never auto-apply.

This is exactly the user's goal: *use the reports + data to drive an agentic workflow that populates and rebuilds replenishment/stock.*

---

## 5. Proposed phased plan (each approval-gated + verified, like ACP)

> Agents stay **default-OFF** (per "do not run the agents yet"); they're enabled in the Control Center when ready. Early phases are pure data — no AI.

- **R0 — Unified substrate + Reports hub.** Generic report store + per-dataset freshness registry; a Nexus "Amazon Reports" page mirroring Seller Central (view/download raw files, stamped with freshness). *Foundation; no AI.*
- **R1 — Data Kiosk economics.** Real per-SKU net proceeds + actual referral/FBA/storage fees → replace hard-coded 15%; feed `ProductProfitDaily` + unblock the Pricing Watchdog. *The economics unlock.*
- **R2 — Widen report coverage.** Pull the missing reports (inventory ledger, stranded, FBA health, fee preview, settlement line-items). *Completeness.*
- **R3 — Freshness + reconciliation cockpit.** Every dataset shows last-updated/source/official-vs-estimate; live estimates auto-reconcile when the official report lands. *Trust.*
- **R4 — COGS overlay.** True margin everywhere = Amazon's exact revenue/fees − your cost. *The one computation.*
- **R5 — Agentic page rebuild.** ACP tools over the substrate + Replenishment Keeper / Stock Reconciler agents that populate + propose into the inbox; rebuild replenishment/stock to be agent-driven. *The goal.*

---

## 6. Open questions / decisions needed before building

1. **Priority:** full **economics accuracy** first (R1, heavier) or maximum **freshness/coverage** first (R0+R2, lighter)? Or strict R0→R5 order?
2. **SP-API role grants:** Data Kiosk + some reports (Finance, restricted Brand Analytics) require specific role approval on the app. Need to confirm our app's authorized roles before R1/R2 (may need an Amazon approval step — out of our control).
3. **Agent scope (R5):** how autonomous? (Propose-only into the inbox is the default + safest; matches ACP.)
4. **Estimates:** keep the live T+1 estimate as a labelled fallback, or show only official numbers (blank until Amazon's report lands)?

---

## 7. Honest caveats
- Money data freshness = Amazon's batch cadence (T+1 to T+5). We match Seller Central exactly; we can't make it real-time.
- Data Kiosk is net-new (no existing code) — R1 is the heaviest phase.
- This is a multi-week engagement, larger than a single ACP phase.
- Role approval (Q2) could gate R1/R2 on an external Amazon step.
