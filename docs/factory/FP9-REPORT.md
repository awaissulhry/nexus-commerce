# FP9 — Financials: build report (gate 2, awaiting Owner click-through)

Shipped 2026-07-05 against the approved `FP9-SPEC.md`. Four build commits (FP9.1 rollup core + tiles + by-order → FP9.2 invoices + Fattura → FP9.3 payments + bank import + deposits → FP9.4 by-party/by-month + export). **`/financials` is live — the money page.** Every figure is a fold of records that already exist (order lines, payments, invoices, and the FP6 consumed-material cost), never a re-type. Built on Opus 4.8. **Migration-free** (Order / OrderLine / Payment / Invoice all shipped in F1); no new dependency; **+1 permission** `invoices.manage` (OWNER only), **+1 counter** `INV-`.

## The boundary (as specified)

**NOT accounting.** No general ledger, no double-entry, no tax filing, no VAT engine, no bank reconciliation beyond matching a payment to an order. VAT (IVA) is a **display** figure at one configurable rate; the money model stays **net**. FP9's deliverable to the commercialista is a clean CSV, not a bookkeeping module.

## Eng trans

Open **Financials** and three tiles answer the daily question — **how much is owed**, **how much deposit is stuck** on the floor, and **this month's** invoiced/paid. Below, every order shows **quoted → invoiced → paid → balance** and its **margin sliding from estimate to actual** as production consumes material (that "actual" is the real hide cost, from FP6). Click an order for its **money drawer**: raise a **Fattura** (Italian invoice PDF, no costs on it), mark it **sent** then **paid** (which drops the balance to zero), or **record a payment**. Reconcile the bank by **pasting a statement** — the app proposes which order each line pays and writes nothing until you tick and apply. A **Deposits-outstanding** tab lists the orders whose work is BLOCKED waiting on money. Roll it all up **by customer** and **by month**, and **export the period** as a CSV for your accountant.

## What was verified (headless, isolated `:3199`)

| Check | Result |
|---|---|
| **Per-order rollup** | net/paid/**balance** exact; **invoiced** sums; **est margin** shown, flagged pending until consumed ✓ |
| **Tiles** | outstanding / deposits-due / month-invoiced / month-paid all exact ✓ |
| **Invoice** | `INV-1` created, **Fattura %PDF** (cost-free), amount = net total ✓ |
| **Mark paid** | drops a BALANCE payment → **balance zeroes**; double-pay refused ✓ |
| **Deposits (FD13)** | shortfall + **blocked-WO count**; recording the deposit **unblocks the WO** and the order leaves the list ✓ |
| **Bank import** | reference match (whole-token, ORD-1 ≠ ORD-12, any numbering) → **high**; unknown row **unmatched**; apply records BALANCE payments ✓ |
| **By customer / by month** | revenue / paid / outstanding / actual-margin aggregate correctly ✓ |
| **Period export** | CSV with net / **VAT / gross** (22% → €500 net = €610 gross); margin columns **grain-gated** ✓ |
| **Grain strip** | a prices-but-not-margin caller keeps net/paid, **loses cost + margin** — pinned by test ✓ |

Battery: **194/194 unit tests · 117/117 routes RBAC-covered · DS parity byte-identical · no-touch clean · tsc + build green · 30 headless assertions across FP9.1–9.4 · zero page errors.** Tiles, by-order/customer/month grids, the money drawer, deposits tab, and the bank-import dry-run were each reviewed at native resolution — clean, full-width, on-token. Test data swept; the **invoice counter was reset** so your first real invoice is INV-1; your real data (ORD-1) is untouched.

The risk lives in the pure core and is pinned: `orderFinancials` / `tiles` / `partyRollup` / `periodRollup` / `depositsOutstanding` / `vatDisplay` (6 tests), `bank-match` (7 — token boundary + Italian CSV), `financials-strip` (2 — margin-blind).

## Deviations from spec (flagged)

1. **VAT is display-only** — a single configurable rate (`financials.defaults.vatRatePct`, default 22) shown on the Fattura and in the export; there is **no tax engine** (exemptions, reverse-charge, intrastat). By design (not accounting).
2. **The money model is net** — payments and balances are net; the customer's gross (net + IVA) shows only on the Fattura. Marking an invoice paid records the **net** amount, so the balance zeroes cleanly. The IVA to remit is the accountant's, out of scope.
3. **Bank import matches to orders, isn't reconciliation** — reference-or-amount matching with a human confirm; no statement-reconciliation ledger, and per-bank CSV format adapters are a follow-up (the neutral `date, amount, description` shape is what's parsed).
4. **No credit-note document / dunning** — a negative payment records a refund; a formal credit note and automated reminders are later concerns.
5. **Invoice defaults to the order's full net** — partial/progress invoicing accepts an explicit amount but the Fattura's line detail is the order's lines; true progress-billing schedules are a follow-up.

## What lives where

| Surface | Path |
|---|---|
| Pure core (tested) | `src/lib/financials/rollup.ts` · `bank-match.ts` · (helpers: `actual-cost.ts` · `load.ts` · `render-invoice.ts`) |
| API | `src/app/api/financials/*` (root · order/[id] · deposits · party · period) · `invoices` (+[id]) · `imports/payments` · `exports/financials` (payments reuse the FP4 `orders/[id]/payments`) |
| UI | `src/app/(app)/financials/_components/*` (FinancialsClient — tiles + 4 tabs + money drawer + payment/import modals) |

## Your click-through (the FP9 gate)

Open `/financials` → the tiles → a bit-by-bit order in **By order** → click it → the **money drawer** → **New invoice** (a Fattura PDF opens) → **Mark paid** (balance → €0, a payment appears) → **Record payment** on another order → **Deposits outstanding** tab → record a deposit and watch it leave the list (the floor unblocks) → **Import bank CSV** (paste a line with an order number, see it match, apply) → **By customer** + **By month** → **Export period** (CSV for the commercialista). Everything money is behind the page itself — a Worker never sees it.

## Rollback

`git revert` the four FP9 commits (factory-scoped). No migration; the `invoices.manage` permission + `INV-` counter are additive and harmless to leave.

## Deferred (PLAYBOOK backlog)

VAT/tax engine; full bank reconciliation + per-bank CSV adapters; credit notes / refund workflow; dunning; progress-billing schedules; multi-currency rollup.

**Next on approval: FP10 — Analytics (`/analytics`): the factory's rhythm — throughput, stage lead times + bottleneck, on-time-vs-promise, margin by product/party/period, quote win/loss — every metric a decision, every aggregate drilling to its source.**
