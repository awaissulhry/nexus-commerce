# EPO2 — Money on the order (gate report)

> Shipped 2026-07-17 against `EPO-PROPOSAL.md` §5 EPO.2. Kills **E1 C7**. Verification green: 373 tests (incl. the new payment-badge suite), rbac 135 routes, no-touch, ds-parity 97/97, query-bounds 137 files, isolated `.next-verify` build, :3199 probes, and a live-data fold probe (`balance = quoted − paid` identity holds; same pure fold as the Financials drawer, so parity is by construction).

## Plain English

The money you already computed for the Financials page now lives where the work happens. Every order's detail shows the full picture — Quoted · Invoiced · Paid · **Balance** — plus the margin that upgrades itself from *estimated* to *actual* the moment production consumes real material. Invoices sit on the order (open the PDF, send it, mark it paid — the same Financials actions, reachable without leaving the board). The list gets one coarse payment word per row (paid / invoiced / deposit due / deposit paid / unpaid) and a Balance column that turns red when goods are delivered but unpaid. Orders whose estimated margin is below your configured floor get a red margin pill. And when you open an order for a customer who still owes money on other delivered orders, a banner says so — information, never a block.

## What shipped

| Item | Detail |
|---|---|
| **Money strip (detail)** | Quoted / Invoiced / Paid / Balance rows + Cost and Margin flip `(est)` → `(actual)` when the FP6 ledger has consumed material (`actualIsPending` from the fold). Source: `orderFinancials()` + `actualCostByOrder()` — the FP9 fold consumed, never forked |
| **Invoices on the order** | Rail card listing each invoice (number → PDF, amount, draft/sent/paid pill) with Send / Mark-paid via the existing `PATCH /api/invoices/[id]` (gated `invoices.manage`) |
| **Payment badge + Balance (list)** | New pure fold `paymentBadge()` in `lib/orders/money.ts` — deposit-due outranks invoiced (the gate is the actionable fact); derived client-side from `*Cents` fields so the grain strip automatically hides it from money-blind viewers; Balance red only when DELIVERED/CLOSED and unpaid |
| **Low-margin flag** | Margin pill goes danger below `pricing.defaults.marginFloorPct` (response key starts with `margin` → auto-stripped for margin-blind callers) |
| **Credit awareness (D-rec)** | Detail banner "{party} has €X outstanding on N delivered orders" from one bounded SQL aggregate over the party's other DELIVERED/CLOSED orders — links to their contact history; never blocks anything |
| **C7 closed** | Stripped money renders "—" everywhere on the grid — never a misleading €0,00 |

## Files

`lib/orders/money.ts` (+`paymentBadge`) · `api/orders/route.ts` (per-row paid/invoiced/balance + margin floor) · `api/orders/[id]/route.ts` (fold merge + party-outstanding aggregate) · orders `OrderDetail/OrdersClient/types` · `__tests__/epo2-payment-badge.test.ts` (new)

## Click-through (Owner)

1. Open any order with payments → the Money card now reads Quoted/Invoiced/Paid/Balance; on an order where cutting has consumed leather, the margin row says "(actual)".
2. The board: new Payment and Balance columns — find a delivered order with balance open: red.
3. On an order with invoices: click the invoice number (PDF opens), Send a draft, Mark paid — the strip and badge update live.
4. Open an order for a party owing on other delivered orders → the amber banner, linking to their history.

## Findings / deviations

1. **"Overdue" payment tier deferred by design** — FP9 has no invoice due dates; red-when-delivered-unpaid is the honest proxy. EPF's dunning/due-date work (their proposal) supplies the real thing; the badge gains one branch when it lands.
2. **List-row figures use Σ-aggregation identical to the fold's arithmetic** (Σ payments, Σ invoices, net − paid) rather than calling `orderFinancials` per row — same numbers (the fold itself reduces the same sums; probed live), one less allocation per row at 200 rows.
3. Deposit tracker stays payment-kind-based (FP4/FP9 model); "deposit invoiced" as a distinct step needs EPF's invoice-typing — noted for their cycle.

## Rollback

Revert the commit — no migration, additive payload fields only.
