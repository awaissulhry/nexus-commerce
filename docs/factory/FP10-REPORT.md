# FP10 — Analytics: build report (gate 2, awaiting Owner click-through)

Shipped 2026-07-06 against the approved `FP10-SPEC.md`. Four build commits (FP10.1 folds + live counters → FP10.2 data route + throughput/lead-time charts → FP10.3 margin + win/loss panels → FP10.4 on-time + date-range + saved views). **`/analytics` is live — the factory's rhythm.** Everything the first nine pages recorded becomes the handful of numbers that drive a decision, each drilling back to its source. Built on Opus 4.8. **Migration-free** (every model exists); **no new dependency** (recharts already in); **no new permission** (`pages.analytics` gates the page, margin panels grain-gated).

## Eng trans

Open **Analytics** and three **live** counters answer "what needs me now" — **Unanswered threads**, **Quotes awaiting approval**, **Overdue promises** — each a click to the filtered page, each updating on its own as mail and orders move. Below, the charts: **Throughput** (work orders finished per week), **Stage lead time** with the **bottleneck** stage flagged in red (the slowest step on your floor), **On-time vs promise**, **Margin by customer / month / product** (estimate vs actual — the real hide-cost bit), and **Quote win/loss** with the reasons you lost. Set a **date range** to scope it all, and **save the view** so it's one click next time. Every panel header drills straight to the rows behind it — nothing re-typed, nothing exported to some outside tool.

## What was verified (headless, isolated `:3199`)

| Check | Result |
|---|---|
| **Live counters** | +1 each over the Owner's real data (51 real unanswered threads); SSE-refreshed on thread/quote/order events ✓ |
| **Throughput** | 2 finished work orders bucketed into 2 weeks ✓ |
| **Lead-time + bottleneck** | STITCHING median 3.0h flagged as the bottleneck (red bar + callout) ✓ |
| **On-time** | 1 on time / 1 late → **50%**, by calendar day, unknowns excluded ✓ |
| **Margin by customer/product** | actual €250 / est €250 exact; **hidden** for a margin-blind role ✓ |
| **Win/loss** | won-of-decided rate + the "price too high" loss reason tallied ✓ |
| **Date range** | a 2020 range empties the money/quote panels; today's data returns ✓ |
| **Saved views** | create → list → apply → delete, **per-user** ✓ |
| **Grain strip** | a margin-blind caller keeps throughput/lead-time/win-loss, loses the margin panels wholesale — pinned by test ✓ |

Battery: **201/201 unit tests · 120/120 routes RBAC-covered · DS parity byte-identical · no-touch clean · tsc + build green · 19 headless assertions across FP10.1–10.4 · zero page errors.** All seven panels + the toolbar reviewed at native resolution — recharts bars render on-token (primary blue, danger red for the bottleneck), value labels, empty-states, drill links. Test data swept; ORD-1 / Q-1 untouched.

The risk lives in the pure folds and is pinned: `throughputByWeek` / `stageLeadTimes` + `bottleneck` / `onTimeRate` / `quoteWinLoss` / `marginByProduct` (5 tests), `analytics-strip` (2 — margin-blind).

## Deviations from spec (flagged)

1. **Margin by product is the estimate, not actual** — consumed-hide cost is captured per work order, not per product line, so per-product actual margin can't be allocated cleanly. Actual margin lives at the customer/month level (the FP9 fold); the product panel is labelled "(estimate)".
2. **Unanswered = OPEN thread whose last message is inbound** — a reasonable proxy for "the customer is waiting"; it doesn't model read/handled state beyond that.
3. **The margin panels strip wholesale** — because their response keys start with "margin", a margin-blind caller loses the whole panel (not just the cents), which the UI already gates with a "hidden for your role" note. Correct defence-in-depth; noted so it isn't mistaken for a bug.
4. **Charts refresh on load / range change, not per-event** — only the three counters are live (they're cheap); the aggregate charts are a snapshot, by design.
5. **Saved views store the date range only** — the one filter analytics has today; richer view state is a later concern.

## What lives where

| Surface | Path |
|---|---|
| Pure folds (tested) | `src/lib/analytics/*` (throughput · lead-time · on-time · win-loss · margin-by-product) |
| API | `src/app/api/analytics` (root · counters) · `src/app/api/saved-views` (reuses FP9 rollup + FP6 stage-timer) |
| UI | `src/app/(app)/analytics/_components/*` (AnalyticsClient — counters + toolbar + saved-views modal; charts — recharts cards) |

## Your click-through (the FP10 gate)

Open `/analytics` → the three counters show real numbers (and tick live when a thread or order moves) → **Throughput** by week → **Stage lead time** flags the bottleneck → **On-time** rate → **Margin by customer / month / product** → **Win/loss** + reasons → each panel header **drills to its source** → set a **date range** (top-right) and watch the panels rescope → **Save view**, reload, re-apply it from the Saved-views menu.

## Rollback

`git revert` the four FP10 commits (factory-scoped). No migration; no new dependency or permission.

## Deferred (PLAYBOOK backlog)

Forecasting / prediction; a custom pivot/report builder; per-product actual margin; per-event live charts; richer saved-view state.

**Next on approval: FP11 — the last page-cycle: Settings polish + a Team & Roles UI (members, invitations, the role-matrix from `permissionCatalog()`), flipping `FACTORY_RBAC_MODE=enforce` before a second login exists, and the WhatsApp decision (FD5). This closes the 11-page arc.**
