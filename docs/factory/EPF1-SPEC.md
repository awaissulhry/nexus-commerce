# EPF1-SPEC — Money-truth repairs (binding build spec)

Approved via EPF-PROPOSAL gate 2026-07-17 ("proceed however you recommend"). Fixes the verified defect register (`EPF-PROPOSAL.md §2`, IDs cited below) as amended by `EPF-COMPLIANCE.md` and `EP-CROSSREVIEW.md`. Server/fold layer only — the UI rebuild is EPF.2; this phase touches UI **only** where a changed API contract would otherwise break the existing page. **EPF.1 shipping unblocks EPO.2 (cross-review B3).**

## Scope IN

**1. Invoice numbering + atomicity (D-05, D-17 — legality note: per Ris. 1/E/2013 the change is best-practice + posture-B/C readiness, not a legal repair).**
- `counters.ts`: add `nextNumberTx(tx, kind, year?)` composable inside a caller's transaction; invoice counter becomes year-keyed (`counter.invoice.2026`) minting `INV-2026-001` (zero-padded 3+). Existing `INV-n` invoices untouched (uniqueness preserved — numbering restart at year boundary is expressly allowed).
- `POST /api/invoices`: ONE `$transaction` = mint + `invoice.create` (+ audit write). PDF renders AFTER commit; on render failure the invoice row stands with `pdfRef=null` and `GET /api/invoices/[id]` re-renders on demand (repair path). Kills burned numbers + collision 500s.

**2. Deposit-aware invoicing + overpayment guards (D-02, D-03).**
- Invoice default amount = `orderTotals(lines).netCents − paidCents` (floor 0, 400 if nothing left to invoice) instead of full net; explicit `netCents` still accepted but capped so `Σ invoices ≤ net` (400 with the remaining-invoiceable amount in the error).
- Mark-paid: guard `Σ payments + inv.amountCents ≤ net`; if it would overpay, 409 with `{overpayCents}` unless body carries `allowOverpay: true` (the UI confirm arrives in EPF.2; the drawer's existing error toast surfaces the 409 meanwhile).
- `POST /api/orders/[id]/payments`: same `Σ ≤ net` check → 409 + `allowOverpay` escape (overpayments become explicit, never silent).

**3. Refunds interim path (D-11-defect).**
- Payments schema: allow negative `amountCents` ONLY when `kind: "REFUND"` (new enum value, additive) + mandatory `notes`; audited `payment/refund-recorded`; folds already sum signed values correctly (`rollup.ts:54`). Formal credit notes remain EPF.4.

**4. Fold semantics (D-04, D-13, D-14) — intentional changes, tests updated, parity re-baselined.**
- `load.ts`: expose invoice dates + payment dates to the fold; add `actualComplete` derived from the order's WOs all DONE (one extra grouped query), replacing the first-movement heuristic: `actualIsPending = !actualComplete` (partial consumption reports as pending est→actual).
- `rollup.ts` `tiles`: "Invoiced this month" = Σ invoices **issued** this month; "Paid this month" = Σ payments **received** this month — both bucketed in **Europe/Rome** (a pure `romeMonthKey(dateISO)` helper; no `Date` locale tricks in folds).
- `periodRollup`: month key from invoice/payment dates for the invoiced/paid columns; quoted stays by order-creation (each column labeled by its basis in the export header).
- Cancelled orders with money (paid ≠ 0 or invoiced ≠ 0): included in a distinct `cancelledWithMoney` bucket returned beside tiles + a `includeCancelledMoney` load option; aggregates and the drawer stop disagreeing.

**5. Export rewrite (D-01, D-12-strip, D-15-audit).**
- `/api/exports/financials`: two sections (or two files zipped — implementer's choice, simplest wins): **per-invoice rows** (invoice number/date/order/customer/net/VAT-display/gross — VAT on INVOICED amounts) + **per-order rollup** (current shape, columns labeled by date basis). Rome-TZ window on invoice/payment dates; `stripFinancials` applied via an explicit column-grain map (prices grain for money columns, margins grain for margin columns); `audit exports/financials-run` with the window + row counts.

**6. Bank import rebuilt on the shared loader (D-10, D-15).**
- Dry-run: match targets built from `loadOrderFinancials` (kills the full-hydration `findMany` + the hand-forked balance calc); proposals annotated when a ref-matched row's balance is already 0 (rule-1 balance blindness).
- Apply: per-row `importKey = sha256(date|amountCents|description)` stored on Payment (`Payment.importKey String? @unique`, additive migration `epf1_money`); duplicate key → row skipped with `{skipped: "duplicate"}`; bank `date` → `receivedAt`; amount ≤ live balance validated (else row errored, not applied); the whole apply in one `$transaction`; deposit-gate/WO-unblock logic invoked exactly as the FP4 payments route does (extract the shared piece into `lib/orders/deposit-gate.ts` so the two routes call ONE function).

**7. Hygiene (P2 + D-18 partial).**
- `invoices` POST response via `jsonStripped`; money-mutation audits awaited inside their transactions (no more fire-and-forget on invoice/payment writes); `exports/ledger` also audited; `notify()` on `payment.recorded` + `invoice.paid` to the OWNER (M3: EPF owns money-event notifications — the calls land in the shared routes, deep-linking `/orders?o=`).

## Scope OUT (later phases)
UI rebuild/filters/URL state/confirm dialogs (EPF.2) · party ledger + reconciliation + allocation (EPF.3) · credit notes/dunning/aging (EPF.4) · exceptions/close/lock (EPF.5) · saved views (EPF.6) · courtesy-copy relabel + external-number reconciliation field (EPF.7 posture-A work, batched with EPF.4 doc changes) · rendering any EPQ.5 field (M5).

## Data & API deltas
Migration `epf1_money` (additive, pre-approved class): `Payment.importKey String? @unique`. Enum extension `PaymentKind + REFUND` (SQLite enums are runtime-enforced — zod + checks only, no migration). New AppSetting keys `counter.invoice.<year>`. No route added; contracts extended as above (all changes backward-tolerant for the current client except the deliberate 409s).

## Tests (all pure cores + routes)
Year-rollover + atomic mint (failure mid-tx burns nothing) · deposit-aware default + Σinvoices cap · mark-paid overpay 409/allowOverpay · REFUND negative flow · `romeMonthKey` DST/boundary cases (31 Dec 23:30Z → Jan Rome) · actualIsPending vs WO states · cancelledWithMoney bucket · export VAT-basis on invoiced + strip-by-grain matrix · import idempotency (same CSV twice → 0 new payments) + balance validation + unblock parity with FP4 route · notify targets. Existing rollup/bank-match/strip suites updated where semantics intentionally changed — each change asserted, none silently absorbed.

## Acceptance targets
`npm test` green (new + updated) · `check:rbac`/`check:no-touch`/`check:ds-parity`/`check:query-bounds` green · `FACTORY_BUILD_DIR=.next-verify` build + `:3199` runtime smoke: create invoice → number `INV-2026-…`, mark-paid on a deposit order zeroes (not negative), re-import same CSV = 0 duplicates, export reconciles to drawer for the same window · FS0 harness re-run: by-order p50 ≤ 310ms (no regression) · Owner's `:3100` restart flagged in the gate report (new `importKey` column + stale-client trap 6b).
