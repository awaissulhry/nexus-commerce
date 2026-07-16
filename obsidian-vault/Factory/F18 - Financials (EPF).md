# F18 - Financials (EPF)

> **Route:** `/financials` · **EP code:** EPF · **Status:** 🟡 research COMPLETE, proposal delivered 2026-07-16 (`bf8560c0`) — **awaiting Owner gate** on scope + decisions D-1…D-12.
> Canonical docs: `docs/factory/EPF-PROPOSAL.md` · `docs/factory/EPF-UI-INVENTORY.md` · shipped base: `docs/factory/FP9-SPEC.md` + `FP9-REPORT.md`

Part of [[F00 - Factory OS MOC]] · flow position: [[F01 - Mission & Golden Flow]] step 8 · program: [[F06 - Enterprise Program (EP)]]

## Purpose

Order-level **money truth** — quoted → invoiced → paid → balance per order, rolled up to customer and period, est-vs-actual margin closed by production actuals, deposits outstanding (FD13). Explicitly **NOT accounting**: no general ledger, no tax engine — the commercialista gets a clean export ([[F05 - Decision Register (FD1-14)]], Fishbowl "own ops, delegate the ledger"). The page is the money face of the [[F01 - Mission & Golden Flow]]; field-gating IS the page (workers never see it).

## What exists today (FP9, shipped)

4 tiles + 4 tabs (By order / By customer / By month / Deposits outstanding) · money drawer (invoice create/send/mark-paid, payment capture) · bank-CSV dry-run import · period CSV export · pure folds `rollup.ts`/`load.ts`/`bank-match.ts` (FS1-optimized, parity-guarded). Total wiring map: `EPF-UI-INVENTORY.md` — every control, handler → route → service → DB → events chain, every nav edge.

## Verified defects (live on the Owner's instance)

Three P0s **hand-verified in code** (of 9 P0 + 9 P1 in the register, `EPF-PROPOSAL.md §2`):
1. **Export VAT basis wrong** — accountant CSV computes IVA on *quoted* net of every order created in the window, incl. never-invoiced (`exports/financials/route.ts:29`); can't reconcile with actual Fatture.
2. **Mark-paid double-counts deposits** — unconditional full-amount BALANCE payment → negative balances on deposit orders (`invoices/[id]/route.ts:42-45`).
3. **Invoice numbering not per-year sequential** (Italian law), non-atomic mint burns numbers; no credit-note path (`counters.ts`).
Also: money page emits **zero notifications**, no SSE, no URL state, no date filter; customer/month rows dead-end; bank re-import duplicates payments; all month math UTC not Rome.

## The 7 proposed phases

| Phase | Delivers |
|---|---|
| EPF.1 | Money-truth repairs — all P0/P1 defects, per-year atomic `INV-2026-n`, deposit-aware invoicing, idempotent bank import |
| EPF.2 | Page at design law — DS primitives, URL state, filters, drill-through, skeletons, FS3 grid adoption (×3), SSE freshness, consequence confirms |
| EPF.3 | **Party ledger + two-sided reconciliation** — the [[F26 - AWA Workbook (structure)]] killer feature: opening balances, counterparty figures, EQUAL/NOT-EQUAL queue, payment→order allocation, statements |
| EPF.4 | AR depth — credit notes (`NC-YYYY-n`, reason codes, approval via [[F11 - Quotes (EPQ)]] gate pattern), dunning task-queue riding Gmail threads, aging buckets, days-to-pay |
| EPF.5 | Owner control room — exception queues (shipped-not-invoiced…), tie-out integrity panel, close checklist + lock date, `notify()` on money events, weekly digest |
| EPF.6 | Dynamic views — saved views + group-by-lite (NO formula language — Panko + workbook evidence), per-brand money workspace, period selector |
| EPF.7 | Italian e-invoice posture (decision-gated) — recommend A: courtesy-copy relabel now, SDI XML later; consumes EPQ tax-mode/SDI fields |

## Decisions awaiting the Owner (D-1…D-12)

Compliance posture A/B/C · invoice-deadline timers · credit notes formal vs negative payments · dunning task-queue vs auto-send · reconciliation grain · counterparty-figure entry · opening balances per year · **price-list effective-dating (needs [[F15 - Products & Pricing (EPD)]] registry grant)** · **Order fields clientRef/URGENT/remakeOf (needs [[F12 - Orders (EPO)]] grant)** · OFFICE read-only role (FD9) · FD13 deposit defaults · multi-currency (recommend EUR-canonical).

## Owns / Consumes

**EPF owns:** Invoice + numbering, credit notes (future), party ledger + reconciliation + allocation folds, money exception queues, the money node API (`/api/financials/order/[id]`) that [[F12 - Orders (EPO)]] hops into.
**EPF consumes, never builds:** approval-gate + tax-mode/SDI fields + Stripe ([[F11 - Quotes (EPQ)]]) · one-timeline + hop-links ([[F12 - Orders (EPO)]]) · SSE ([[F22 - Substrate FS Series]] FS2) · virtualized grids (FS3) · chat feed ([[F21 - Chat & Order Spaces (FC)]]; money in system messages only via structured `*Cents` fields).

## Research base & gaps

Internal: dual audits + total UI inventory + canon/collision register. External: SAP B1, Business Central, O2C cross-cutting (incl. Italy/SDI), JobBOSS²/Craftybase, saved-views/pivot-lite/formula-columns/trust-UX. **Compliance ⚠ flags RESOLVED 2026-07-16** — all 12 legal claims primary-source verified in `docs/factory/EPF-COMPLIANCE.md` (two corrections: per-year gapless numbering is practice not law — the D-05 P0 stands for the non-atomic mint + missing credit notes; bollo exempts intra-EU/export lines). Cross-review amendments applied in `EPF-PROPOSAL.md` §9: EPF.4 dunning rides the shared EPI-owned template/cadence engine (B1), **EPF.1 gates EPO.2** (B3), EPF owns money-event notifications + the CreditNote API + SavedView stewardship, billing/AR exceptions only (fulfillment ones are EPO.4's).
