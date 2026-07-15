# F19 - Analytics (EPA)

> **Route:** `/analytics` · **EP code:** EPA · **Status:** ⚪ open — unclaimed; FP10 base shipped & verified.
> Canonical docs: `FP10-SPEC.md` / `FP10-REPORT.md` · charter: `F0-IA.md` §10

Part of [[F00 - Factory OS MOC]] · flow position: [[F01 - Mission & Golden Flow]] step 9 (the rhythm)

## Charter

The factory's rhythm — **every metric answers a decision**: which stage eats lead time, which brand's discounts erode margin, are promises being kept. Three live counters beat leaderboards (unanswered threads / quotes awaiting reply / overdue promises). Read-models only, no new writes; local SQLite = any question one query away (BEAT Katana export-only).

## As built (FP10)

Pure folds `src/lib/analytics/*` (throughput, pause-aware stage lead-times + bottleneck, on-time rate, win/loss, margin by product) · 3 SSE-live counters · 7 recharts panels, each header drilling to source · date-range filter · personal SavedViews · server-side grain-strip (margin panels vanish wholesale for margin-blind callers).

## Known open items for the future EPA session

- FP10 deferred: forecasting, custom pivot builder (**note:** [[F18 - Financials (EPF)]] EPF.6 research settled the house pattern — group-by-lite + saved views, explicitly NOT a pivot engine; EPA should follow), per-product actual margin (needs the per-line consumption allocation fold — coordinate with EPF/EPD), material-consumption trends.
- FS1 flagged residual: analytics p50 619ms vs 500 target — parked to protect fold purity; an EPA session may revisit WITH the parity script.
- [[F11 - Quotes (EPQ)]] EPQ.6 exposes per-quote pipeline aggregates for EPA to consume — the Analytics *page* remains EPA's home turf ([[F06 - Enterprise Program (EP)]] rule 3).
- Charts are snapshots today (only counters live) — FS2 makes live panels cheap when EPA claims.
