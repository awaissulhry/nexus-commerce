# FP10 — Analytics: page-cycle spec (awaiting Owner approval)

Written 2026-07-06 on FP9's approval. Gate 1 of the FP10 double gate — nothing below is built until the Owner approves. Seeds: `F0-IA.md` §2, PLAYBOOK §11-FP10, and the "three counters over leaderboards; local SQLite = any question one query away" verdict (BEAT Katana's export-only analytics). **This is the factory's rhythm.** Everything the first nine pages recorded — threads, quotes, orders, stage timestamps, the material ledger, consumed-hide cost — becomes the handful of numbers that drive a decision, each drilling straight back to the page it came from.

## Purpose (one sentence)

Give the Owner one screen that turns the factory's own records into decisions — three live counters for "what needs me now", and charts for throughput, where the floor bottlenecks, on-time-vs-promise, margin by product/customer/month (estimate vs actual), and quote win/loss — every number drilling back to its source, nothing re-typed, nothing exported to a BI tool.

## The stance (say it once)

**Every metric answers a decision, and every aggregate is a link.** No vanity leaderboards, no chart that doesn't drill to the rows behind it. Because it's local SQLite, any question is one query away — so FP10 is *curation*, not a data warehouse. Read-only over records that already exist; the only writes are the Owner's own saved filter views.

## Scope

**IN (FP10):**
- **Three live counters** (top, SSE-fresh via the existing `use-factory-events` bus): **Unanswered threads** (OPEN conversations whose last message is inbound), **Quotes awaiting approval** (SENT quotes), **Overdue promises** (orders past `promiseDateAt` not yet shipped). Each is a button → the filtered source page.
- **Throughput** — work orders finished per week (`finishedAt` of the last stage), a bar/line chart; drills to `/production`.
- **Stage lead-time + bottleneck** — median time in each stage (CUTTING…PACKING) from `WorkOrderStage` (`finishedAt − startedAt − pausedMs`, the FP6 pause-aware number), a horizontal bar with the **bottleneck** (longest median) flagged; drills to `/production`.
- **On-time vs promise** — for shipped/delivered orders, ship date (the FP8 shipment) vs `promiseDateAt` → an on-time **rate** + a small breakdown; drills to `/orders`.
- **Margin by customer / month / product** — reusing the FP9 rollup (`orderFinancials` → `partyRollup` / `periodRollup`, plus a new by-product fold on order lines): **estimate vs actual** margin, grain-gated; drills to `/financials` (party/month) or the filtered orders.
- **Quote win/loss** — ACCEPTED vs REJECTED/EXPIRED rate + a **by-reason** breakdown (`lostReason`); drills to `/quotes`.
- **Date-range filter** + **saved views** — a range scopes every panel; the Owner saves a named view (the `SavedView` model, `page:"analytics"`, personal/per-user).

**OUT (named, so the boundary is explicit):**
- **Forecasting / prediction / anomaly detection** — FP10 reports what happened; predictive analytics is not this cycle.
- **A custom report builder / pivot UI** — saved *filter* views yes; an arbitrary dimension-builder no.
- **External BI export / a warehouse** — the CSV exports already live on their source pages (financials, ledger, shipments, orders); FP10 doesn't add a BI pipe (the local DB *is* the warehouse).
- **Real-time streaming charts** — the three counters are live (SSE); the charts refresh on load and on demand, not per-event (they're aggregates, not tickers).
- **Cross-factory / multi-tenant benchmarking** — single instance, single factory.

## Layout

```text
/analytics:
  counters (SSE-fresh): [Unanswered threads] [Quotes awaiting approval] [Overdue promises]   → each drills
  toolbar: date range · [Saved views ▾] · [Save view]
  grid of panels (each a Card with a drill link in its header):
    · Throughput (WOs finished / week)          → /production
    · Stage lead-time + bottleneck (median/stage)→ /production
    · On-time vs promise (rate + breakdown)      → /orders
    · Margin by customer (est vs actual)*        → /financials
    · Margin by month (est vs actual)*           → /financials
    · Quote win/loss + reasons                   → /quotes
```
`*` = margin panels grain-gated (financials.margins.view); the page itself is `pages.analytics` (absent from the worker nav).

## Component reuse

| Region | Components |
|---|---|
| Counters | `Card` tiles + `use-factory-events` (live), the FP9 tile look |
| Charts | **recharts** (already a dep) wrapped in small `_components` chart cards (Bar/Line/Pie); theme tokens for colours |
| Panels | `Card` (header + drill link), `.factory-page` fill, `Skeleton`, `EmptyState` |
| Pure folds (tested) | `src/lib/analytics/*` — throughput / lead-time / on-time / win-loss / margin-by-product (builds on FP6 `stage-timer.elapsedMs` + FP9 `orderFinancials`/`load`) |
| Saved views | `SavedView` CRUD (personal, per-user) |

## Data & API

**No migration** — `WorkOrder` / `WorkOrderStage` (startedAt/finishedAt/pausedMs) / `Order` (promiseDateAt) / `Quote` (state/lostReason) / `OrderLine` / `SavedView` all exist. **No new dependency** (recharts present). **No new permission** — `pages.analytics` gates the page; saved-view writes are personal and ride `pages.analytics` (id-scoped to the caller); margin panels grain-gated via `jsonStripped`.

**Pure modules (tested — the risk):** `src/lib/analytics/`
- `throughput.ts` — `throughputByWeek(finishedAtISO[]) → [{weekKey, count}]`.
- `lead-time.ts` — `stageLeadTimes(stages) → [{stage, medianMs, count}]` + `bottleneck(rows)`; median from the FP6 pause-aware elapsed.
- `on-time.ts` — `onTimeRate([{promiseISO, shippedISO}]) → {onTime, late, rate}`.
- `win-loss.ts` — `quoteWinLoss(quotes) → {won, lost, rate, byReason:[{reason,count}]}`.
- `margin-by-product.ts` — group order lines by product → `{product, netCents, actualMarginCents}` (est vs actual via the FP9 fold).
All pure (cents / ISO in, numbers out) — no Prisma, no `Date.now()` inside (the caller passes `nowMs`).

**Routes** (all `guarded()` + coverage-checked; money via `jsonStripped`):

| Route | Methods | Permission |
|---|---|---|
| `/api/analytics/counters` | GET (the 3 live counters — cheap, SSE-refreshed) | `pages.analytics` |
| `/api/analytics` | GET (throughput · lead-times · on-time · margin-by-party/month/product · win-loss; date-ranged) | `pages.analytics` |
| `/api/saved-views` | GET (mine for a page), POST (save), DELETE | `pages.analytics` |

## Interactions

- **Land on `/analytics`:** three counters answer "what needs me now" and stay live as mail/quotes/orders move; the panels below show the week's rhythm.
- **Spot the bottleneck:** the stage lead-time bar flags the slowest stage — click it → `/production` to see the queue.
- **Chase the drift:** on-time rate dips → click → the `/orders` behind it.
- **Read the money:** margin-by-customer shows estimate vs actual (the hide cost bit); click a customer → `/financials`.
- **Learn from losses:** win/loss by reason → click → the `/quotes` marked lost for that reason.
- **Save the lens:** set a date range → **Save view** → it's one click next time.

## States

Skeletons per panel; EmptyState ("no finished work yet — throughput appears as work orders complete"); the counters show 0 cleanly; margin panels render "—" for a margin-blind caller (grain-stripped); charts degrade to a small "not enough data yet" note under ~2 points.

## RBAC

`pages.analytics` gates the page — absent from the worker nav (a worker never reaches it). **Margin panels behind `financials.margins.view`** via `jsonStripped` (a non-margin caller sees throughput/lead-time/on-time/win-loss but not money). Saved views are personal (id-scoped to the caller). No new permission.

## Bulk / import-export

None new — the exports already live on the source pages (financials/ledger/shipments/orders CSVs). Analytics *links* to them; it doesn't duplicate them. Saved views are the only persisted user state.

## Teardown verdicts applied (traceability)

| Verdict (F0-TEARDOWN) | Where it lands |
|---|---|
| Three counters over leaderboards — BEAT | The live top row; no vanity metrics |
| Every aggregate drills to source — SAP "Price Source" lineage | Every panel header is a link to the filtered page |
| Local SQLite = any question one query away — BEAT (Katana export-only) | Server folds; no warehouse, no BI pipe |
| Est-vs-actual is the factory's real question — ADAPT | Margin panels reuse the FP9 est/actual fold |
| Bottleneck is a decision, not a chart — ADAPT (MRPeasy) | The slowest stage is flagged, links to the queue |

## Acceptance targets (gate-2 click-through)

Open `/analytics` → the three counters show real numbers and update live when a thread/quote/order moves → **Throughput** shows WOs finished per week → **Stage lead-time** flags the bottleneck stage → **On-time** shows a rate → **Margin by customer/month** shows estimate vs actual (and is blank for a margin-blind caller) → **Win/loss** shows the rate + reasons → each panel header drills to its source → set a **date range** and **save a view** → reload and re-apply it. Plus: `throughputByWeek` / `stageLeadTimes` + `bottleneck` / `onTimeRate` / `quoteWinLoss` / `marginByProduct` unit-tested (medians, week bucketing, on-time boundary, reason tally); a test proves the analytics payload carries **no margin** to a margin-blind caller; 194+ existing tests stay green; rbac / no-touch / parity / build green.

## Build plan (no time estimates)

FP10.1 — pure folds (`throughput` / `lead-time` / `on-time` / `win-loss` / `margin-by-product`) + tests + `/api/analytics/counters` + the `/analytics` shell with the three **live** counters (SSE via `use-factory-events`). → FP10.2 — `/api/analytics` route + **throughput** and **stage lead-time/bottleneck** charts (recharts) with drill links. → FP10.3 — **margin by customer/month/product** + **quote win/loss** panels (reusing the FP9 rollup), grain-gated, drilling to `/financials` and `/quotes`. → FP10.4 — **on-time** panel + **date-range filter** + **saved views** (`SavedView` CRUD) + headless verify on isolated `:3199` + `FP10-REPORT.md`. Each sub-phase a scoped commit; push at cycle end; STOP for gate 2.
