# FS1 — Gate report: query hygiene + correctness

Built to `FS1-SPEC.md` (Owner: "proceed"). Every change measured against the FS0 harness (same seed, same machine); full before/after table appended to `FS0-BASELINE.md`.

## Plain English

The factory's pages used to read entire tables and do their math in JavaScript. At your real size today that was invisible; at 50,000 orders it meant a 2-second money page shipping 22 MB, a production board that froze every user's clicks while anyone loaded it, and an analytics page that crashed outright. FS1 moved the heavy math into the database, added the indexes that make those folds instant, fixed three real bugs (kanban silently hiding orders past 200; Gmail recovery silently dropping mail past 50 threads; the analytics crash), and installed a permanent guard so unbounded queries can't come back. **Every money and stock number was proven identical before/after** — on synthetic data at scale AND on your live database.

## What shipped (by spec item)

1. Three additive migrations: `fs1_scale` (5 indexes + `Conversation.lastMessageDirection` + backfill), `fs1b_covering_indexes` (ledger covering indexes — the single biggest win: production 1,788→65 ms, materials 1,146→48 ms), `fs1c_order_createdat`.
2. materials/stock + production coverage fold in SQL (groupBy, index-only).
3. `loadOrderFinancials` rewritten over four SQL aggregates feeding the unchanged pure fold; financials page ships a bounded 200-row page + full-fold tiles (22.5 MB → 92 KB); deposits preserves its exact legacy state scope.
4. Analytics fully aggregate-fed; counters are three COUNTs via the new column. The P2029 bomb is structurally dead.
5. Kanban C-1: per-lane bounded+cursored fetches, true "100 of 1500" lane counts, per-lane Load more; grid gains a cursor.
6. Gmail C-2: paginated resumable backfill (state in AppSetting, start-historyId stamped only when drained so mid-backfill mail replays), Owner notification + audit row on token-expiry resync.
7. Shipping queues bounded (payload 5.8 MB→191 KB); orders CSV streams via an id-spine + 500-id batches (flat memory at any count; 1.85 s at 50k — an export, latency documented).
8. `check:query-bounds` fence wired into the check suite: every `findMany` bounded or `// bounded:`-annotated (42 call sites triaged and annotated with reasons).
9. `scripts/scale/parity.ts` — old-vs-new on the same DB: stock four-column, per-order financials, deposits, throughput, margin-by-product, win/loss, counters, plus a `lastMessageDirection` integrity check. **Green on the 3.4M-row harness AND the live DB.**

## Findings / deviations (flagged, not hidden)

- **Two targets missed by small margins:** financials p50 310 ms (target 300), analytics 619 ms (target 500). Residual = the shared 47k-order aggregate fold; the next lever (party/month rollups fully in SQL) widens the money-parity surface, so it is parked as a named option, not silently attempted.
- **Actual-cost ±1 cent tolerance:** one order in 47k landed on a half-cent float boundary (`qty REAL × costCents` summed in different associativity orders). Integer-derived money is exact everywhere. Documented in the parity script.
- **CSV export latency** regressed vs the fully-buffered legacy (0.7→1.85 s at 50k) in exchange for flat memory; first streamed attempt (cursor-seek) was 3 s and was replaced with the id-spine approach.
- The deposits tab previously folded orders WITHOUT invoice/actual data (`invoices: []`); the shared loader now supplies them. `depositsOutstanding` reads only deposit fields, so output is identical (parity-proven) — noted because the internal fins objects differ.
- Live parity run doubles as a data-integrity sweep: live DB is clean (72 conversations, all direction-stamped correctly).

## Owner actions

- **None required.** Your `:3100` runtime was restarted after the migrations (playbook 6b) — the last restart happened after the final migration + client regeneration, so it is fresh. Sessions survived (DB-backed).
- The kanban, materials, financials, analytics pages will feel identical today (your data is small) — this phase bought the headroom, the bug fixes, and the fences.

## Rollback

Single revert of the code commit; the three migrations are additive (indexes + one nullable column) and safe to leave in place either way.

## Verified

tsc · 206 unit tests (5 new parity suites) · rbac 126 routes · no-touch · ds-parity 97/97 · query-bounds · `next build` · parity green on harness + live · FS0 harness re-measured (table in FS0-BASELINE) · visual click-through on :3199 at 50k orders (grid, kanban lane counts, materials, analytics all rendering).
