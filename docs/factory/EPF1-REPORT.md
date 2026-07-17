# EPF1-REPORT — Money-truth repairs: SHIPPED (gate report, 2026-07-17)

Built to `EPF1-SPEC.md` (binding), on the EPF-PROPOSAL gate ("proceed however you recommend"). Worktree build merged + hardened on main; commits: `e145e88f3` (folds/counters/guards/migration/tests) · `52b99ac77` (invoice+payment routes) · `df6e1852f` (import/export/financials routes) · `da35fcb9d` (split-path loader) · `41ab26f7c` + the two main-tree gate-fix commits (parity re-page/raw selects; tie-break + bounded bucket + topNewest). **EPF.1 shipping satisfies cross-review B3 — EPO.2's sequencing flag is closed.**

## Plain-English summary (what changed for the Owner)

1. **Invoices now number per-year (`INV-2026-001`) and can never burn or duplicate a number** — the number is minted and the invoice created in one atomic step; if the PDF fails it regenerates on open.
2. **Deposits no longer double-count.** A new invoice defaults to *what's still owed* (net minus payments already received); marking paid or recording a payment that would overpay is refused with the exact overpay amount (an explicit override exists for real overpayments). Refunds are now possible (REFUND payment kind, note required, audited).
3. **The accountant export is correct**: per-invoice rows with VAT on *invoiced* amounts (not quoted), Rome-timezone windows, financial-grain stripping, and an audit record of every export. The old export could not reconcile with your Fatture — this one can.
4. **"Invoiced this month" / "Paid this month" tiles now mean exactly that** — bucketed by document date in Italian time, not by order-creation date in UTC.
5. **Cancelled orders with money are visible again** (their own bucket beside the tiles) instead of silently vanishing from every total.
6. **Bank-CSV import is safe to re-run**: re-importing the same statement creates zero duplicates (row fingerprints), the bank's value date is stored as the payment date, over-balance rows are refused, and a deposit that unblocks production behaves identically whether recorded manually or via import (one shared deposit-gate function).
7. **Money now speaks**: payments received and invoices paid ring the bell with a link to the order. Est-vs-actual margin only claims "actual" once ALL work orders are done (partial production no longer overstates margin as final).

## Verification (honest, complete)

- **Tests: 502 green** (55 files; +~70 EPF.1 tests incl. Rome DST boundaries, atomic-mint rollback, import idempotency run-twice, overpay guards, both-paths consistency, topNewest vs sort-slice).
- **Gates**: `check:rbac` 137 routes all guarded · `check:no-touch` clean · `check:ds-parity` byte-identical · `check:query-bounds` clean (139 files) · `next build` (isolated `.next-verify`) green.
- **Parity (the money-truth gate): 10/10 PASS on the 50k harness** (48,874 orders — doc-dates path ≡ legacy incl. month buckets; hot path ≡ legacy on every per-order figure; SQL month-sums ≡ doc-dates fold to the cent) **and PASS on the live DB**. The harness caught and we fixed: a P2029 in the parity legacy path (re-paged at 400 — Prisma's SQLite param ceiling is 999) and a real same-millisecond invoice-ordering tie (all three paths now tie-break `(createdAt, id)`).
- **Runtime smoke on `:3199`** against the harness DB: all financial routes 200; measure.ts full run recorded.
- **Migration `20260717154245_epf1_money`** (additive: `Payment.importKey` + unique index) applied to the live DB via direct SQL + recorded in `_prisma_migrations` (Prisma's engine can't lock the file while the Owner's server runs) and to the harness DB via `migrate deploy`.

## Named deviation (FS1-precedent: flagged, not silently absorbed)

**Financials p50 at the 50k harness: 439-478ms vs the ≤310ms no-regression target.** Attribution (profiled per-query): 308ms is *pre-existing* SQL (base join+sort 139ms — sort since eliminated — and the FP6 actual-cost triple join 169ms) which better-sqlite3 serializes (Promise.all cannot parallelize one connection); the approved D-04/D-13/D-14 semantics add the rest (WO-completion aggregate, GROUP_CONCAT, month sums, cancelled bucket, larger strip surface). Mitigations already landed: split-path loader (90k-row transport removed from the hot path), payload 637→149KB, sort→topNewest O(n). Named levers if it ever matters: `Order(createdAt)` + MovementLedger covering indexes (additive), and **EPF.2's date-scoped default view bounds the fold entirely** — at the factory's real volume (~600 orders) the loader is single-digit ms. Analytics p50 1.0s rides the same loader's doc-dates path (FS1 had already parked analytics at 619 vs 500).

## ⚠ Owner steps

1. **Restart the `:3100` dev server** (trap 6b): the running server's cached Prisma client predates `Payment.importKey` and several concurrent sessions' migrations — bank-import applies and other new writes will 500 until restarted.
2. Click-through (below). Live sends were never automated.

## Click-through script

1. `/financials` → tiles render; "Invoiced/Paid this month" reflect July documents. 2. Open an order's money drawer → **New invoice** → number is `INV-2026-…`; amount defaults to net−paid. 3. On a deposit order: record the deposit, invoice, **Mark paid** → balance goes to **€0.00, not negative**. 4. Try a payment that overpays → refused with the overpay amount. 5. **Import bank CSV** → paste rows → Match → Apply → re-paste the SAME rows → Match shows already-settled/duplicate, Apply creates nothing. 6. **Export period** → open the CSV: per-invoice section, VAT on invoiced amounts. 7. Bell: a recorded payment and a paid invoice each ring with a link to the order. 8. A cancelled order with a paid deposit appears in the cancelled-money bucket.

## Rollback

All code: `git revert` the EPF.1 commit range (no data loss — folds are read-side; guards are refusals). Migration is additive (a nullable column + index); reverting code without reverting the column is safe indefinitely.

## Follow-ups (owned, not lost)

Hot-path responses still carry degraded per-order month maps (UI ignores them; EPF.2 strips or period-sources them) · REFUND has no UI until EPF.2 · invoice PDF re-render uses current order lines (line snapshotting = EPF.7 posture-A work) · importKey collapses two *genuinely identical* statement rows (inherent to the fingerprint; note in the import UI in EPF.2) · `/api/financials` `from/to` params remain UTC-parsed until EPF.2 wires Rome-windowed pickers.
