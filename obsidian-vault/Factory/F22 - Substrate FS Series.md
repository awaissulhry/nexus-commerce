# F22 - Substrate FS Series

> Shared infrastructure owned by workstreams, **not pages** — pages DEPEND on it, never build it ([[F06 - Enterprise Program (EP)]] rule 4). Canonical: `FS0-SPEC/BASELINE`, `FS1-SPEC/REPORT`, `FS2-SPEC/REPORT`, `FS3-SPEC`, `FS-FC-PROPOSAL.md`.

Hub: [[F00 - Factory OS MOC]]

## FS0 + FS1 — Load harness + query hygiene ✅ SHIPPED (live)

The 50k-order harness + parity scripts + `check:query-bounds` fence. FS1 SQL-ified the money loads (22.5MB→92KB pages), fixed all cliffs 10-30×, killed the N+1 classes. **Every EP page must re-run the harness before its gate closes.** Two flagged residuals, parked deliberately: financials p50 310ms vs 300 target, analytics 619 vs 500 (fixing them would fork the pure money folds — declined; see [[F04 - Domain Model & Money Invariants]]).

## FS2 — SSE fan-out ✅ SHIPPED 2026-07-11 (`FS2-REPORT.md`)

ONE outbox + ONE shared poller per web process (1s, PK-indexed) fanning to all SSE clients → **DB cost flat at 1 query/s regardless of client count**. Gap-free id-based resume (Last-Event-ID + `?sinceId=`), targeted delivery (`scope:{userId}`), one multiplexed EventSource per tab, backpressure closes stuck clients. 50-client proof PASS: 1,000/1,000 delivered, p95 1.05s, mid-storm API 200 in 21ms. ~30 formerly silent mutations now publish. Handoff: `import.finished` subscriber = claimed pages' scope. Multi-process web tier = FS6 (Postgres LISTEN/NOTIFY, Owner-gated).

## FS3 — UI truthful at volume ✅ components SHIPPED 2026-07-11

Factory-local (`apps/factory/src/components/` — DS copy stays byte-identical): **VirtualDataGrid** (drop-in for the 9 heavy grids) · **WindowedList** · **AsyncCombobox** (server-search pickers) · **MentionTextarea** · **PaneHandle/useResizablePanes**. One new dep: `@tanstack/react-virtual`. Adopted on unclaimed pages already; **pending adoptions owned by page sessions:** EPI (list/thread windowing, composer, panes) · EPO (orders grid + party filter) · EPQ (matrix pickers, EPQ.3) · EPF (financials grids ×3). Config-sized pickers (templates/price-lists) deliberately stay plain Listboxes.

## FS4 — Write integrity + hot-path auth ⚪ QUEUED

`$transaction` around every multi-step write · boot pragma verification (fail loudly if WAL didn't take) · short-TTL session cache keyed on `permissionsVersion` · optimistic-concurrency `updatedAt` guards · login rate-limiting. Exit: concurrent-writer harness with zero SQLITE_BUSY surfaced, authed GET ≤1 DB query. *(EPO D-6 and EPF EPF.1 lean on these patterns — coordinate when FS4 claims.)*

## FS5 — Storage lifecycle ✅ SHIPPED 2026-07-17 (⚠ migration `fs5_fts` authored NOT applied)

**FTS5 substrate** (S-13): virtual tables + sync triggers for conversations/messages/parties/quotes/orders, backfilled in-migration; tables declared **externally-managed in prisma.config.ts** so `migrate dev` never proposes dropping them (verified trap). `search-fts.ts` = escaped MATCH builder + bounded id helpers; ⌘K rewired (same response shape) with a LIKE fallback until the migration lands. Measured on the 1.2 GB harness clone: backfill 3.9 s, message-body search 0.02–0.3 ms vs 128–173 ms LIKE. **Streaming** (S-14): quote PDF route streams pdfkit + fs; ledger + NEW audit exports are full-table streamed CSVs (id-cursor batches — take-5000 truncation gone). **Snapshots** (S-15): `wal_checkpoint(TRUNCATE)` before `VACUUM INTO` (measured 5.5 s at 1.2 GB), hour/keep via AppSetting `snapshot.config`, duration/sizes stamped on `snapshot.last`. **Retention** = `FS5-RETENTION.md`: append-only forever, export is the archive, snapshots are copies; after a snapshot restore run `fts:rebuild`. **Pending adoptions:** EPI inbox `?q=` + attachment streaming · EPF invoice PDF stream · FC6 chat search (helpers ready). Exit met: search sub-100ms at 2M+ rows.

## Also standing substrate

- **Notifications** — single write path `notify()` + bell + durable outbox (F1/FP1, live).
- **Approval-gate / margin-floor pattern** — owned by [[F11 - Quotes (EPQ)]], consumed house-wide.
- **transition-service single-write-path** — to be defined by [[F12 - Orders (EPO)]] EPO.1.
- **The money node** — `orderFinancials` fold served by [[F18 - Financials (EPF)]].
