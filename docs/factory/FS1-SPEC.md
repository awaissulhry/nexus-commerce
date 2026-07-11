# FS1 — Query hygiene + correctness (binding spec)

Fixes every red row in `FS0-BASELINE.md` plus the three correctness bugs (C-1 kanban truncation, C-2 backfill mail-loss, N-1 P2029 include bomb) — by making one rule true everywhere: **no route reads unbounded row sets; folds happen in SQL**. UI virtualization is FS3; SSE is FS2; FTS is FS5 — not here. No time estimates.

## Changes (each with its measured target)

### 1. Additive migration `fs1_scale` (pre-approved category)
- Indexes: `Attachment.messageId` · `WorkOrder.orderId` · `Conversation.snoozeUntil` · `Conversation.followUpAt` · `MovementLedger.createdAt`.
- New column `Conversation.lastMessageDirection String?` — maintained at the two message write points (`gmail-sync.ts upsertMessage`, inbox reply route), backfilled in-migration via one correlated-subquery UPDATE. Kills the counters include-bomb structurally: the "unanswered" counter becomes `count(state=OPEN AND lastMessageDirection='INBOUND')`.
- ⚠ Playbook 6b: after `migrate dev` + generate, the Owner's `:3100` server must be restarted — will be called out at ship time.

### 2. `materials/stock` — SQL fold (S-2) · target p50 ≤ 250 ms (from 1,146)
Replace the 1.2M-row `findMany` with `movementLedger.groupBy([materialId, type], _sum.qty)`; PO-expected via a second `groupBy` bounded to open-PO ids. The pure `materialStock()` fold keeps working — it's fed aggregate pseudo-movements, so FP7's four-column math is untouched and parity-testable.

### 3. `financials` + `loadOrderFinancials` — SQL rollup + pagination (S-12) · target p50 ≤ 300 ms, payload ≤ 500 KB (from 2,021 ms / 22.5 MB)
Per-order money via raw-SQL aggregates (`SUM(netPriceCents*qty)`, `SUM(costCents*qty)` by orderId; payments `groupBy(orderId, kind)`; invoices `groupBy(orderId)` + paid split; actual cost `groupBy` over ledger by WO ref). The pure `rollup.ts` functions stay the single money truth — they receive aggregates instead of 50k hydrated orders. By-order table becomes cursor-paged (take 200); party/month rollups + tiles compute from the aggregate rows. Deposits route same treatment.

### 4. `analytics` + `counters` — SQL aggregation, range in WHERE, N-1 dead · target: HTTP 200 with p50 ≤ 500 ms / counters ≤ 30 ms (from HTTP 500)
Throughput/lead-time: raw SQL over `WorkOrderStage` (per-WO `MAX(finishedAt)`/unfinished-count, stage duration sums) with the date range in the WHERE clause, feeding the existing pure fns. Margin-by-product: SQL `SUM` by description. Win/loss: `quote.groupBy(state)` + lostReason groupBy. Counters: three `count()`s via the new column. Zero relation-includes over unbounded sets remain.

### 5. Orders + kanban — C-1 fixed · target list p50 ≤ 250 ms (from 751)
API already returns per-state `groupBy` counts — extend `/api/orders` with `lane` + cursor params (per-lane take 100). KanbanBoard: per-lane true count in the header, "Load more" per lane, nothing silently dropped; grid gets the same cursor. Board switch stops forcing `state=all` hydration of 200 full rows.

### 6. Production board — bounded + SQL coverage (S-6 server half) · target p50 ≤ 300 ms (from 1,788), 10-way burst wall ≤ 3 s (from 18.4 s)
Board query `take 300` by priority (+ total count surfaced in UI); demand via `groupBy(refId, materialId, type)` and stock via `groupBy(materialId, type)` bounded to involved materials — no row-level ledger loads, no giant `IN` lists (the board had its own latent P2029). `allocateByPriority` unchanged.

### 7. Gmail backfill — C-2 fixed
`backfillLabel` paginates with `pageToken` under a per-run budget (500 threads), persisting the token on `GoogleConnection` to resume next worker tick until drained; a resync fallback writes an AuditLog row + Owner notification ("Gmail resync triggered — recovering N threads") instead of silently capping at 50.

### 8. Payload diet + export streaming
Shipping route: `select`-narrowed fields, events capped (take 3 latest per shipment via separate bounded query) · target payload ≤ 500 KB (from 5.8 MB). Orders CSV export: paged loop (1,000/page) into a streamed response — flat memory at any order count.

### 9. The regression fence: `check:query-bounds`
New script (wired as `npm run check:query-bounds`, added to the verify checklist alongside rbac/no-touch/ds-parity): fails on any `findMany(` in `src/app/api/**` or `worker/**` without `take`/`cursor`/`groupBy`, unless annotated `// bounded: <reason>` (e.g. per-entity child reads). FS0's harness stays the empirical fence; this is the static one.

## Test plan (each unit alone, then the whole)
1. **Parity tests** (the money/stock rule: numbers may never change, only speed): fixture dataset → old fold vs new SQL fold byte-equal for materials stock, financials rollup, analytics panels, counters.
2. Unit tests: lane cursoring, backfill pagination + resume (mocked Gmail pages), lastMessageDirection maintenance on both write paths, query-bounds script self-test.
3. Full suite + rbac/no-touch/ds-parity/query-bounds green; `next build` green.
4. **Harness re-run** (same seed, same machine): every target above met; baseline table appended to `FS0-BASELINE.md` as the FS1 column.
5. **Live read-only parity**: before shipping, a script compares old-vs-new stock + financials outputs on the Owner's real DB (read-only); any diff blocks ship.
6. Click-through on `:3199` at scale volumes: kanban lanes with counts + load-more; materials page; financials page; analytics renders (currently it 500s at volume).

## Rollback
Single revert (code); indexes + nullable column are harmless to leave. No data rewrites anywhere; ledger/audit untouched (append-only preserved).
