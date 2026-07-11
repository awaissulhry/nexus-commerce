# FS0 — Baseline: the factory measured at design-target volume

Measured 2026-07-11 on `:3199` (`.next-verify`, `FACTORY_RBAC_MODE=enforce`, production build) against the synthetic harness DB (`data/scale.db`, **0.99 GB**, ~3.4M rows — volumes exactly per `FS0-SPEC.md`: 50k orders · 60k conversations · ~500k messages · 1.2M ledger · 800k audit · 500 users). Method: 2 warm-ups + 20 timed samples per route, sequential, real OWNER session; then 10-way concurrent bursts on the three hottest routes. Live instance untouched throughout.

## Route baseline (the before-picture every FS/FC phase must beat)

| Route | p50 | p95 | payload | Verdict |
|---|---|---|---|---|
| inbox list (open) | 25 ms | 28 ms | 22 KB | ✅ cursor pagination works — FP1's design vindicated |
| inbox list + search | 239 ms | 243 ms | ~0 KB | ⚠ LIKE scan cost even for zero hits (S-13) |
| inbox thread (typical) | 4 ms | 7 ms | 7 KB | ✅ |
| inbox thread (5,000 msgs) | 40 ms | 43 ms | **2.0 MB** | ⚠ whole history shipped + rendered (S-4) — server fast, browser pays |
| orders (all states) | 751 ms | 774 ms | 78 KB | ❌ and kanban silently shows only 200 of 50k (C-1 confirmed live) |
| orders search | 768 ms | 774 ms | 78 KB | ❌ LIKE + join scan |
| production board | **1,788 ms** | 2,334 ms | 857 KB | ❌ uncapped WOs + full ledger fold per request (S-6) |
| materials stock | **1,146 ms** | 1,349 ms | 46 KB | ❌ whole 1.2M-row ledger folded per view (S-2) |
| financials | **2,021 ms** | 2,164 ms | **22.5 MB** | ❌ all orders + a 22 MB JSON response (S-12) |
| financials deposits | 166 ms | 170 ms | ~0 KB | ⚠ |
| analytics | — | — | — | **💥 HTTP 500** (see N-1) |
| analytics counters | — | — | — | **💥 HTTP 500** (see N-1) |
| quotes | 15 ms | 18 ms | 68 KB | ✅ (take 200) |
| contacts search | 4 ms | 5 ms | 23 KB | ✅ |
| shipping | 162 ms | 182 ms | **5.8 MB** | ⚠ workflow-bounded but payload huge |
| global search | 37 ms | 38 ms | ~0 KB | ✅-ish (take 6 caps output; scan cost stays) |
| notifications | 1 ms | 1 ms | 7 KB | ✅ |
| users-lite | 1 ms | 1 ms | 43 KB | ✅ server-side; the dropdown UI is the S-16 issue |
| export orders CSV | 686 ms | 719 ms | 4.6 MB | ⚠ fully buffered |

## Concurrency bursts (10 simultaneous clients)

| Route | 1-client p50 | 10-client wall | Meaning |
|---|---|---|---|
| inbox list | 25 ms | 290 ms | healthy |
| production board | 1.8 s | **18.4 s** | requests fully serialize |
| materials stock | 1.1 s | **11.5 s** | requests fully serialize |

## New findings FS0 surfaced (not in the proposal's audit)

- **N-1 · NEW CORRECTNESS BUG — analytics is a time bomb.** Both `/api/analytics` and `/api/analytics/counters` return **HTTP 500** at volume: Prisma error **P2029** ("query parameter limit supported by your database is exceeded") on `conversation.findMany` — a relation `include` over ≥~1,000 OPEN conversations expands to an SQL `IN (…)` list beyond SQLite's bound-parameter limit. The live instance survives only because it has ~50 conversations. **Any** unbounded `findMany`+`include` in the codebase carries the same failure mode as row counts grow. → joins C-1/C-2 as a correctness fix in **FS1** (bounded queries kill it structurally; a `relationLoadStrategy`/chunking guard covers the rest).
- **N-2 · One slow route freezes the whole server for everyone.** better-sqlite3 is a synchronous driver on Node's single thread: the 10-way bursts show wall-time ≈ sum of individual requests. While one worker opens the production board (~1.8 s), **every other user's every request waits**. Fixing the slow routes (FS1) fixes the freeze; FS4 adds the pragma/driver hardening.
- **N-3 · Payload cliffs are real:** financials ships 22.5 MB of JSON per page view, shipping 5.8 MB, the 5k thread 2 MB. Server latency is only half the story — parse/render cost lands on every browser (FS1 aggregates server-side; FS3 windows the UI).
- **N-4 · Confirmations:** everything cursor-/take-bounded (inbox list, quotes, contacts, notifications) stays fast at 60k+ rows — the FS1 prescription ("bound everything") is empirically the right one. Typical thread opens in 4 ms; the substrate is healthy where it was built with discipline.

## Measured pain ranking (FS1 execution order)

1. Analytics 500s (N-1 — correctness) → SQL aggregation + bounds
2. Financials 2.0 s / 22.5 MB → SQL fold, paged response
3. Production board 1.8 s + N-2 freeze → capped board query + incremental coverage
4. Materials stock 1.1 s → SQL SUM/GROUP BY (or maintained stock row)
5. Orders 0.75 s + C-1 kanban truncation → per-lane bounded queries
6. Exports buffering, LIKE search cost → FS1 bounds now, FS5 FTS later

Artifacts: harness scripts `scripts/scale/seed-scale.ts` + `measure.ts` (re-runnable; raw JSON at `data/scale-baseline.json`, gitignored with the DB). Baseline machine: the Owner's dev machine, Node 20, darwin.

---

## FS1 re-measurement (same harness, same volumes, same machine — 2026-07-11)

| Route | FS0 p50 | FS1 p50 | Target | Verdict |
|---|---|---|---|---|
| orders (all states) | 751 ms | **23 ms** | ≤250 | ✅ 33× |
| orders search | 768 ms | **31 ms** | — | ✅ 25× |
| production board | 1,788 ms | **65 ms** | ≤300 | ✅ 27× |
| materials stock | 1,146 ms | **48 ms** | ≤250 | ✅ 24× |
| financials | 2,021 ms · 22.5 MB | **310 ms · 92 KB** | ≤300 · ≤500 KB | ⚠ p50 3% over target; payload 245× smaller |
| financials deposits | 166 ms | 219 ms | — | ✅ (now folds ALL live orders via aggregates; was a partial fold) |
| analytics | **HTTP 500** | **619 ms** | 200 + ≤500 | ⚠ alive at scale; 24% over the latency target |
| analytics counters | **HTTP 500** | **7 ms** | ≤30 | ✅ |
| shipping | 162 ms · 5.8 MB | **23 ms · 191 KB** | ≤500 KB | ✅ 30× payload |
| export orders CSV | 686 ms (fully buffered) | 1,849 ms (streamed) | flat memory | ✅ goal was memory, not latency — documented trade |
| burst×10 production | 18.4 s wall | **0.68 s** | ≤3 s | ✅ 27× |
| burst×10 materials | 11.5 s wall | **0.49 s** | — | ✅ 23× |
| kanban truncation (C-1) | drops past 200 | true lane counts + per-lane load-more | fixed | ✅ verified visually at 50k |
| Gmail backfill cap (C-2) | 50 threads, silent | paginated + resumable + Owner alert | fixed | ✅ |
| P2029 include bomb (N-1) | analytics dead ≥1k open threads | zero unbounded includes + `check:query-bounds` fence | fixed | ✅ |

Two honest misses, both flagged rather than chased: **financials 310 vs 300** and **analytics 619 vs 500** — the residual is the shared per-order aggregate fold over 47k live orders (already SQL-side; the next lever is moving party/month rollups fully into SQL, which widens the money-parity surface and belongs to a later phase if the Owner wants it). Every number parity-proven: integer money exact; actual-cost family ±1 cent (float summation associativity on qty×cost, seen once in 47k orders — documented in `scripts/scale/parity.ts`).
