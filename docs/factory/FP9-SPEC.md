# FP9 — Financials: page-cycle spec (awaiting Owner approval)

Written 2026-07-05 on FP8's approval. Gate 1 of the FP9 double gate — nothing below is built until the Owner approves. Seeds: `F0-IA.md` §2, PLAYBOOK §11-FP9, `FD13` (deposit gating), and the "order-level money truth, not accounting" boundary. **This is the money page.** Every order already carries lines (net/cost), payments, and — after FP6 — a *real* consumed-material cost; FP9 folds those into per-order **quoted / invoiced / paid / balance** and **est-vs-actual margin**, rolls them up by party and by month, surfaces the deposits still owed (FD13), and hands the commercialista a clean period export. It is **not** an accounting system.

## Purpose (one sentence)

Give the Owner the one screen that answers "who owes me what, what did each order really make, and what does my accountant need" — per-order quoted/invoiced/paid/balance and estimated-vs-actual margin, party and monthly rollups, a deposits-outstanding list, lightweight invoices and payment capture (incl. a bank-CSV match), and a period export — all drilling back to the orders, all behind the financial gate.

## The boundary (say it once, loudly)

**NOT accounting.** No general ledger, no double-entry, no tax filing, no VAT engine, no bank reconciliation beyond matching a payment to an order. Numbers are **order-level rollups** of records that already exist. Tax/filing is the commercialista's job — FP9's deliverable to them is a **clean CSV export**, not a bookkeeping system. VAT appears as a **display** figure only (a configurable default rate applied for the invoice/gross line), never a computed liability.

## Scope

**IN (FP9):**
- **The `/financials` workspace** — headline tiles (**Outstanding balance**, **Deposits due** (FD13), **This month invoiced/paid**) over a per-order money grid: **order · party · quoted (net) · invoiced · paid · balance · margin (est → actual)**, each row drilling to `/orders/[id]`. Filter by state/date; the numbers are the truth, not a re-type.
- **Per-order rollup (the tested core)** — `orderFinancials(order)`: quoted net (`orderTotals`), Σ invoices, Σ payments, balance (net − paid), deposit required/paid (FD13), **estimated cost** (from lines) vs **actual cost** (Σ OUT movements × material cost across the order's work orders — the FP6 number), and **est-vs-actual margin** with a flag when production hasn't consumed yet (actual = est until then).
- **By-party and by-month rollups** — aggregate revenue / paid / outstanding / margin per party and per calendar month, each drilling to the filtered order list.
- **Deposits outstanding** — the FD13 view: orders with an unmet deposit (and the work orders BLOCKED on it), so the Owner can chase money that's holding up the floor.
- **Invoices (lightweight)** — create an `Invoice` from an order (number `INV-n`, net amount, VAT-display, Italian **Fattura** PDF — customer-facing, so **no cost/margin by construction**), mark **sent** / **paid**; a paid invoice records a BALANCE payment. No line-item tax engine.
- **Payment capture** — record a payment against an order (kind/amount/method/date, reusing FP4's `payments.record`), **plus a bank-CSV import** (dry-run idiom): parse `date, amount, description`, **propose matches** to open balances (by invoice/order number in the description, or an exact amount), the Owner confirms, and BALANCE payments are created. Never auto-applies without confirmation.
- **Period export** — a strip-called CSV of the period's orders/invoices/payments (the accountant interface): every money field, party, dates, net/VAT/gross. The commercialista opens it in Excel.

**OUT (named, so the boundary is explicit):**
- **Accounting / GL / double-entry / tax filing** — the whole point; exports feed the commercialista.
- **A VAT/tax engine** — VAT is a single configurable display rate, not per-line tax logic, exemptions, reverse-charge, or intrastat.
- **Full bank reconciliation** — the CSV import *matches to orders*; it is not a statement-reconciliation ledger.
- **Multi-currency accounting** — amounts are the order's currency; no FX rollup (a party's currency is shown, not converted).
- **Credit notes / refunds workflow** — a negative payment records a refund; a formal credit-note document is a later concern.
- **Dunning / automated reminders** — the deposits-outstanding list surfaces who to chase; automated emails are not this cycle.

## Layout

```text
/financials:
  tiles: [Outstanding balance] [Deposits due (FD13)] [This month — invoiced / paid]
  tabs:  By order · By party · By month · Deposits outstanding
  By order grid:  order · party · quoted · invoiced · paid · balance · margin (est→actual) · [drill]
  toolbar: date range · state filter · [Export period]
ORDER MONEY (drawer/inline on drill):  the rollup + [+ Invoice] [+ Payment]  (or open /orders/[id])
INVOICE modal:  net · VAT% (default) · gross → create INV-n + Fattura PDF · [Send] [Mark paid]
PAYMENT modal:  kind · amount · method · date   |   IMPORT: bank CSV → dry-run matches → confirm
```
Everything on this page is money — it lives behind `pages.financials`, absent from the worker nav entirely (FD13). Grain-strip still runs (defence in depth), but the page's audience is the Owner.

## Component reuse

| Region | Components |
|---|---|
| Tiles | the FP4/insight tile look (`Card`), SSE-fresh where cheap |
| Grids | `DataGrid`, `Pill` (paid/partial/overdue chips), the FP4 tab pattern, `.factory-page` fill |
| Rollup (pure, tested) | `src/lib/financials/rollup.ts` — `orderFinancials`, `periodRollup`, `partyRollup`, `depositsOutstanding` (builds on `orderTotals` + the FP6 actual-cost fold) |
| Invoice PDF | `pdfkit` (the quote-PDF pattern) — Italian Fattura, cost-free by construction |
| Payment / import | `Modal`, the CSV dry-run idiom (FP2/materials imports), `toCsv` for export |
| States | `Skeleton`, `EmptyState`, `useToast` |

## Data & API

**No migration** — `Order` / `OrderLine` / `Payment` / `Invoice` / `WorkOrder` / `MovementLedger` all exist (Invoice + Payment shipped in F1; FP9 is the first to populate Invoice). VAT is display-only (AppSetting `financials.defaults` → `vatRatePct`, default 22), so no invoice schema change. **+1 counter** (`invoice: "INV-"`). **+1 permission** `invoices.manage` (minted + seeded to OWNER; WORKER never gets it) for invoice create/send/mark-paid; `payments.record` / `imports.run` / `exports.run` already exist.

**Pure module (tested — the risk):** `orderFinancials(o)` → `{ quotedNetCents, invoicedCents, paidCents, balanceCents, depositRequiredCents, depositPaidCents, estCostCents, actualCostCents, estMarginCents, actualMarginCents, actualIsPending }`; `periodRollup(orders, month)`; `partyRollup(orders)`; `depositsOutstanding(orders)`. All cents, all pure — no Prisma, no dates-from-now.

**Routes** (all `guarded()` + coverage-checked; money via `jsonStripped` for defence in depth):

| Route | Methods | Permission |
|---|---|---|
| `/api/financials` | GET (tiles + by-order rollup, date/state filtered) | `pages.financials` |
| `/api/financials/party` | GET (by-party aggregate) | `pages.financials` |
| `/api/financials/period` | GET (by-month aggregate) | `pages.financials` |
| `/api/financials/deposits` | GET (unmet deposits + blocked WOs) | `pages.financials` |
| `/api/invoices` | POST (create INV-n from an order → Fattura PDF) | `invoices.manage` |
| `/api/invoices/[id]` | PATCH (send / mark paid → BALANCE payment), GET (PDF) | `invoices.manage` |
| `/api/payments` | POST (record against an order) | `payments.record` |
| `/api/imports/payments` | POST (bank CSV → dry-run matches → confirm) | `imports.run` |
| `/api/exports/financials` | GET (period CSV — the accountant interface) | `exports.run` |

Invoice contract: `POST /api/invoices {orderId, netCents?}` → next `INV-n`, `amountCents` = net (default = order balance), `pdfRef` = the stored Fattura; `PATCH {action:"send"|"paid"}` sets `sentAt` / `paidAt` (+ a BALANCE `Payment` on paid). Bank-CSV: `POST /api/imports/payments {rows, dryRun}` → for each row, propose `{orderId, invoiceId?, amountCents, confidence, reason}`; `dryRun:false` with confirmed matches creates payments. Every invoice/payment write is audited; nothing money-moving is silent.

## Interactions

- **Land on `/financials`:** three tiles answer "how much is owed / how much deposit is stuck / how'd this month do"; the by-order grid shows each order's quoted→invoiced→paid→balance and its margin sliding from **estimate to actual** as the floor consumes material.
- **Chase a deposit:** the Deposits-outstanding tab lists orders whose BLOCKED work orders are waiting on money — click through to the order, record the deposit (FP4 already unblocks the floor).
- **Invoice:** on an order, **+ Invoice** → INV-n + a Fattura PDF (net/IVA/gross, no cost) → **Send** → **Mark paid** drops a BALANCE payment and the balance goes to zero.
- **Reconcile the bank:** **Import** a bank CSV → the app proposes which order each line pays (by number in the description or exact amount) → confirm → payments land, balances update.
- **Hand off to the accountant:** pick a month → **Export period** → a CSV of every order/invoice/payment with net/VAT/gross.

## States

Skeletons on tiles + grids; EmptyState ("no orders in this period"); paid/partial/overdue chips; an "estimate" badge on margins where production hasn't consumed yet; the bank-import dry-run diff (matched / unmatched / low-confidence); export streams a CSV.

## RBAC

**The page is the gate** (FD13): `pages.financials` — absent from the worker nav, so a WORKER never reaches money. Invoice mutations behind **`invoices.manage`** (new, OWNER only); payments behind `payments.record`; import behind `imports.run`; export behind `exports.run`. `jsonStripped` still runs on every response (defence in depth) but the audience here is financial by definition. All amounts are cents, grain-stripped at the edge.

## Bulk / import-export

Bank-CSV **payment import** (dry-run, match-then-confirm); **period export** CSV (the accountant interface); bulk **mark-paid** across selected invoices. No bulk invoice-delete (each is audited; a void is a compensating action).

## Teardown verdicts applied (traceability)

| Verdict (F0-TEARDOWN / FD) | Where it lands |
|---|---|
| Order-level money truth, not an ERP GL — BEAT (depth-not-breadth) | Rollups over existing records; exports for the accountant |
| Deposit gating drives the floor — FD13 | Deposits-outstanding tab ↔ FP4 unblock ↔ FP6 BLOCKED WOs |
| Est-vs-actual margin (the factory's real question) — ADAPT | `orderFinancials` folds line est vs FP6 consumed-material actual |
| Every code is a link (drill to source) — SAP "Price Source" lineage | Every rollup cell drills to `/orders/[id]` |
| The accountant interface is an export, not a module — local-first | `/api/exports/financials` CSV |

## Acceptance targets (gate-2 click-through)

Open `/financials` → the tiles show outstanding / deposits-due / this-month → the by-order grid shows an order's quoted → invoiced → paid → balance and its **est→actual** margin → **+ Invoice** on an order creates **INV-1** + a Fattura PDF (200, `%PDF`, **no cost/margin in it**) → **Mark paid** zeroes the balance (a BALANCE payment appears on the order timeline) → the **Deposits outstanding** tab lists an order with an unmet deposit → **Import** a small bank CSV → dry-run proposes a match → confirm → the payment lands → **By month** + **By party** aggregate correctly → **Export period** streams a CSV. Plus: `orderFinancials` / `periodRollup` / `depositsOutstanding` unit-tested (balance, est-vs-actual with and without consumption, deposit math, VAT display); a test proves the Fattura PDF and the rollup API carry **no margin** to a margin-blind caller; 179+ existing tests stay green; rbac / no-touch / parity / build green.

## Build plan (no time estimates)

FP9.1 — `orderFinancials` + `periodRollup` + `partyRollup` + `depositsOutstanding` pure core (+ tests) + `/api/financials` + the `/financials` page (tiles + by-order grid, drill-through) + `invoices.manage` permission + `INV-` counter. → FP9.2 — Invoices (create → Fattura PDF → send/mark-paid → BALANCE payment) + the order money drawer. → FP9.3 — payment recording + bank-CSV import (dry-run match-then-confirm) + deposits-outstanding tab. → FP9.4 — by-party + by-month rollups + period export CSV + headless verify on isolated `:3199` + `FP9-REPORT.md`. Each sub-phase a scoped commit; push at cycle end; STOP for gate 2.
