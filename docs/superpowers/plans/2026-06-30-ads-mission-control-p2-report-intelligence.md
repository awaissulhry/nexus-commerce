# Ads Mission Control — P2: Report Intelligence (inspector) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the inspector *informative* — surface the full real metric set per object (spend, sales, ACoS, ROAS, impressions, clicks, CTR, CVR, CPC, orders, true profit, margin) with aggregation up the tree, plus a **report-freshness "as-of"** chip — all from data the campaigns API already returns (no new fetches, read-only).

**Architecture:** Extend `campaignsToObjects` to carry a per-object `detail` bag (real campaign metrics; summed/derived for portfolios + markets) + `lastSyncedAt`. A small `format.ts` renders values. The inspector renders a metric grid + freshness chip + a settings line for campaigns. Pure aggregation is unit-tested.

## Global Constraints
- Light H10, image-free; no new deps; **no backend changes**; read-only (no writes). `tsc` clean; pure logic unit-tested; native screenshot verified (dev on **:3000** — CORS). Commit per task with `git commit <paths>`.

## Tasks

### Task 1: Carry + aggregate real metrics (TDD)
- Modify `_canvas/accountGraph.ts`: extend `ApiCampaign` (add sales, roas, impressions, clicks, orders/ppcOrders, trueProfitCents, trueProfitMarginPct, status, type, dailyBudget, lastSyncedAt). Add `OpsDetail` to `types.ts` and `OpsObject.detail?`. In `campaignsToObjects`: build `detail` per campaign (coerced); for portfolio + market, **sum** spend/sales/impressions/clicks/orders/trueProfitCents and **derive** acos = cost/sales, roas = sales/cost, marginPct = trueProfit/sales; `lastSyncedAt` = max child timestamp.
- Test (`accountGraph.vitest.test.ts`, add cases): market `detail` sums children (sales, impressions, orders), derives ACoS = Σspend/Σsales, and `lastSyncedAt` = latest child.
- Run `npx vitest run apps/web/src/app/marketing/ads/_canvas/accountGraph.vitest.test.ts` → pass. Commit.

### Task 2: format helpers
- Create `_canvas/format.ts`: `eur(n)`, `pct(frac)`, `intl(n)`, `roas(n)` (→ "3.2×"), `ago(iso)` (→ "as of 30 Jun"). Pure.
- Quick test or rely on tsc + screenshot. Commit.

### Task 3: rich inspector
- Modify `autopilot/MissionControlClient.tsx`: when an object is selected, render a **metric grid** (Spend, Sales, ACoS, ROAS, Impressions, Clicks, CTR, CVR, CPC, Orders, True profit, Margin) computing CTR=clicks/impr, CVR=orders/clicks, CPC=spend/clicks from `detail`; a **freshness chip** ("as of …" from `detail.lastSyncedAt`); for campaigns a settings line (Status · Type · €budget/day). Em-dash for missing values.
- Append inspector styles to `mission-control.css`.
- `tsc` clean. Commit.

### Task 4: verify
- `tsc` + `vitest _canvas` pass. Dev on :3000, select a market/campaign, screenshot: metric grid populated with real numbers + freshness chip. Commit any fix.

## Self-Review
- Coverage: rich metrics + aggregation (T1) + freshness (T1/T3) + formatting (T2) + inspector (T3) = the P2 read-only scope. Deferred (P2.2): on-select search-term/placement/SQP detail panels (need per-object fetches).
- No placeholders; types: `OpsDetail` defined in types.ts, produced in T1, consumed in T3.
