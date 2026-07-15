# EPF-PROPOSAL — Financials `/financials`: enterprise hardening (research → proposal, awaiting Owner gate)

Delivered 2026-07-16 under the EP double gate. Research base: two independent internal code audits (UI + API/money-core, every claim `file:line`-cited), the committed **`EPF-UI-INVENTORY.md`** (total wiring map per the completeness standard), a canon/collision register over all F0/FP/FS/EPQ docs, a full local-only structural decode of the Owner's **AWA 2026 workbook** (structure and semantics only — figures never leave the machine and never enter these docs), and external research: SAP Business One O2C, Dynamics 365 Business Central O2C, cross-cutting order-to-cash patterns (exception queues, close discipline, dunning, payment matching, DSO, **Italy/SDI specifics**), JobBOSS² + Craftybase, saved-view anatomy (Airtable/Notion/Linear/monday/HubSpot), pivot-lite grouping (Metabase/Stripe/Retool/AG Grid), end-user formula columns (incl. Panko spreadsheet-error research), and trust/tie-out UX (FloQast/BC cues/dbt health tiles). *Honesty note: four research agents (dedicated Italian-compliance deep-dive, AR-automation tooling, dimension systems, owner digests) were cut short by a spend limit; their ground is substantially covered by the surviving reports, and every externally sourced claim below that the agents could not fetch-verify is marked ⚠. The three highest-stakes internal defects were re-verified by hand against the code before inclusion.*

**Charter (unchanged):** order-level money truth — explicitly NOT accounting (FP9-SPEC boundary; F0-IA §9; Fishbowl "own ops, delegate the ledger" ADAPT). EPF hardens and extends this page to the enterprise bar; it does not turn it into a general ledger.

---

## 1. What `/financials` is today (see `EPF-UI-INVENTORY.md` for the total map)

One 376-line client (`FinancialsClient.tsx`) hand-rolling tiles/tabs/drawer/modals with zero DS workspace primitives; 4 tiles + 4 tabs (By order capped at 200 rows, By customer/By month/Deposits unbounded full-renders); a money drawer (invoice create/send/mark-paid, payment capture, `/orders?o=` hop); paste-only bank-CSV dry-run import; an all-time CSV export. No URL state, no SSE, no keyboard shortcuts, no notifications from any money mutation, no date filter anywhere in the UI. The pure folds (`rollup.ts`, `load.ts`, `bank-match.ts`) are sound and FS1-optimized; the page around them is not at the bar.

## 2. Verified defect register (fix before anything new is built)

Re-verified by hand: D-01, D-02, D-05 ✓. All others carry two-audit agreement + `file:line`.

### P0 — money correctness / trust
| # | Defect | Evidence |
|---|---|---|
| D-01 ✓ | **Accountant CSV computes VAT on `quotedNetCents` of every order created in the window — including never-invoiced orders — keyed by order-creation month.** It cannot reconcile with the actual Fatture; wrong basis for any VAT-adjacent use. | `exports/financials/route.ts:29-30` |
| D-02 ✓ | **Mark-paid double-counts deposits.** Invoice defaults to full order net (`invoices/route.ts:35`); mark-paid unconditionally creates a BALANCE payment of the full invoice amount → an order with a recorded deposit ends `paid > net`, balance negative. FD13 flow and FP9 flow silently conflict. | `invoices/[id]/route.ts:42-45` |
| D-03 | **Over-invoicing unguarded**: multiple full-net invoices per order, each markable paid → Σpayments up to N×net. No Σinvoices ≤ net or Σpaid ≤ net check anywhere. | `rollup.ts:53`, `invoices/route.ts:50` |
| D-04 | **Cancelled orders with money vanish from every aggregate** (`excludeStates:["CANCELLED"]` default) while the drawer still shows them — a paid deposit on a cancelled order is invisible in tiles, rollups, deposits, and the export. | `load.ts:37` |
| D-05 ✓ | **Invoice numbering violates Italian sequential-per-year law**: single global `INV-n`, no year segment, no reset; mint is a separate transaction from create (PDF render in between) → failures burn numbers permanently; no void/credit path exists to correct a wrong invoice. | `counters.ts:8-19`, `invoices/route.ts:43-53` |
| D-06 | **"Export period" exports everything, all-time** — static `<a>` with no params, and no date-range UI exists anywhere on the page (backend accepts `from/to`; the client never sends them). | `FinancialsClient.tsx:81`; `route.ts:16-18` |
| D-07 | **By-customer / By-month rows are dead ends** — no drill-through, violating the "every rollup cell drills to source" law (F0-IA §9, SAP golden-arrow ADOPT). | `FinancialsClient.tsx:99-127` |
| D-08 | **Loading state renders the empty state** ("No orders yet…") on every visit before data lands — a false "no data" flash on the money page. | `FinancialsClient.tsx:140-142` |
| D-09 | **Money actions fire with no consequence step**: New invoice and Mark-paid write immediately (mark-paid silently creates a Payment). Violates the escalation ladder (PLAYBOOK §6). | `FinancialsClient.tsx:204,230` |

### P1 — robustness / control
| # | Defect | Evidence |
|---|---|---|
| D-10 | Bank re-import **duplicates payments** (no idempotency key); the bank row's **date is discarded** (`receivedAt` defaults to now); ref-matched rows re-propose after the balance drops; apply loop non-transactional, no amount ≤ balance validation; the import path never runs the deposit-gate/WO-unblock logic the FP4 route runs. | `imports/payments/route.ts:34-41`, `bank-match.ts:31-34` |
| D-11 | **Refunds are impossible** despite being the documented mechanism (both payment entry points enforce `positive()`); no credit-note document exists. | `orders/[id]/payments/route.ts:20`, `imports/payments/route.ts:23` |
| D-12 | **CSV export bypasses `stripFinancials`** — price-grain columns emitted to any `exports.run` holder; export also not audited. Violates PLAYBOOK §8.4. | `exports/financials/route.ts:27-31` |
| D-13 | **All month math is UTC** for a Rome-based factory (order near month boundary lands in the wrong month) and **tiles/rollups bucket by order-creation date, not invoice/payment date** — "Invoiced this month" actually means "invoiced ever, on orders created this month". | `rollup.ts:69,98-101,124-136`; `financials/route.ts:21`; `load.ts:41-43` |
| D-14 | **`actualIsPending` flips on the first material movement** — partial consumption is presented as final actual margin (overstated). Should stay pending until the order's WOs are done. | `rollup.ts:59-60`, `load.ts:87` |
| D-15 | Bank-import dry-run **hydrates every open order** with full relations (mislabeled `// bounded:`) and hand-forks the balance fold; invisible to the query-bounds fence ($queryRaw paths also unfenced — accepted FS1 residual, but this route must move to the shared loader). | `imports/payments/route.ts:49-56` |
| D-16 | By-order cap 200 with **no pager/Load-more** (FS3 components now shipped — adoption pending, handed to EPF); customer/month/deposits grids unbounded full-DOM renders. | `route.ts:25-26`; registry FS3 row |
| D-17 | Concurrency: invoice-number mint read-then-upsert can collide across web+worker processes (unique violation + burned number); `audit()` is fire-and-forget everywhere (money mutation commits even if audit write fails). | `counters.ts:12-17`; e.g. `invoices/[id]/route.ts:39,46` |
| D-18 | **No notifications from any money event** (`notify()` never called), no SSE subscription, no URL state, no keyboard map, one nav edge out. "No communication gap" is an EP exit criterion — money is currently the quietest page in the app. | `EPF-UI-INVENTORY.md` §7 |

### P2 — hygiene (fixed in passing)
Invoice-POST response unstripped (`invoices/route.ts:58`) · PaymentModal: kind always defaults DEPOSIT, first-comma-only amount parse breaks `1.234,56`, no date field, non-DS inputs (`FinancialsClient.tsx:267-289`) · VAT/gross never visible on-screen (PDF/CSV only) · deposits "N blocked" pill has no link to the floor · tabs non-semantic (no tablist ARIA) · paste-only import (no `FileDropzone`) · vatDisplay per-order rounding drifts pennies when the export sums rows · no currency field on any money model (implicit EUR — acceptable, but must be stated on the page).

## 3. The external bar, distilled (what "enterprise" means for this page)

From SAP B1 + Business Central + the cross-cutting O2C research, five properties define the bar, all scale-appropriate for one owner + a few workers:

1. **Documents are stateful one-way doors** (BC posting model; B1 cancellation *documents*): drafts free, issued docs immutable, every correction is itself a numbered document (credit note), nothing deleted, everything navigable. FP9's send/paid flags are close; the correction half is missing entirely.
2. **Money-in is tooling**: leveled dunning with stop conditions (SAP 9-level / BC reminder terms / Odoo follow-ups), tiered payment auto-match with confidence + tolerance write-offs (BC Payment Reconciliation Journal), deposit lifecycle with auto-deduction at final invoice (BC prepayments — the exact fix shape for D-02).
3. **Margin is self-healing**: expected cost at sale converges to actual production cost without reposting (BC Adjust-Cost → adjusted profit per invoice; JobBOSS² live est-vs-actual reports). FP9 already has the skeleton (est vs actual + `actualIsPending`); D-14 fixes the semantics.
4. **Exceptions are standing queues, not reports**: shipped-not-invoiced is *the* flagship leakage queue (Celonis/NetSuite "Pending Billing"/B1 Open Items List/BC `Qty. Shipped Not Invoiced`); plus delivered-no-payment, unapplied cash ("the silent killer"), no-deposit-where-required, margin-below-floor. Completeness is the guarantee: every order is in exactly one billing state at all times.
5. **Trust is visible**: every tile opens into rows whose sum equals the tile *by shared query definition* (BC cues); tie-out equations rendered as passing checks (FloQast); freshness stamps that can go red (dbt health tile); month-end close checklist with soft lock dates (NetSuite/Odoo).

And from the tooling research, the **dynamism recipe** (Owner directive "super dynamic, adapts to each brand") that stops short of a BI engine: saved views = `{name, filters, group-by (+optional second level), sort, visible columns, per-column aggregate from a fixed menu, default flag}` (the cross-tool canonical tuple); group-by-lite with drill-through instead of a pivot builder (Metabase/AG Grid both quarantine pivot as a phase change); **no user formula language** (Panko: ~90%+ of audited operational spreadsheets contain errors; the workbook itself is the proof — see §4); brand slicing via the party dimension that already exists, not a new tagging system.

## 4. The AWA 2026 workbook → what EPF must automate (structure only; no figures here, ever)

The workbook is a **dual-entry reconciliation ledger between the factory and one B2B client**: every money concept exists twice — the client's stated figure and the factory's computed figure — reconciled cell-by-cell with EQUAL/NOT-EQUAL flags at order level (~600 rows), payment level (~110 receipts), and grand-balance level (with a prior-year opening balance hard-coded inside a formula). Pricing is a hand-copied ~30-line IFS rate-matrix formula in ~590 copies across two rate generations (a contract change mid-year), with ad-hoc supplements typed into formula tails and silent numeric overrides; a latent column-drift bug multiplies a rate by a comments column. Statuses are overwritten in place (no history); payments are account-level, unallocatable to orders; a separate 500-row sheet mirrors the client's own rider-facing pipeline with zero keys linking it to the factory ledger.

| Workbook concept | ERP home today | EPF action |
|---|---|---|
| Rate matrix / Allegato-A contract | `PriceList` + entries (FD7) | already right — **effective-dated price lists** is the missing piece (playbook backlog; see D-8 decision) |
| Factory-computed order value | pricing engine → `OrderLine` | already automated — the single biggest manual-labor kill |
| Client's stated figure (per order, per payment) | **missing** | EPF.3: counterparty-figure records + reconciliation fold |
| EQUAL/NOT-EQUAL flags + dispute chase | **missing** | EPF.3: reconciliation queue (the workbook's raison d'être) |
| Account-level payments, receiver name | `Payment` requires `orderId` | EPF.3: party-level payments + allocation |
| Opening balance / prior-year carry-over | **missing** | EPF.3: per-party opening balance record |
| Running party balance | derivable | EPF.3: party ledger fold (statement view) |
| Discounts/concessions ledger | **missing** | EPF.4: credit notes with reason codes |
| Client's own order ref, URGENT flag, remake (BIS) links | **missing on Order** | field requests routed through EPO (they own Order surfaces) — registry note, not an EPF build |
| Client-facing pipeline mirror | **missing** | OUT of EPF scope; noted for the Owner as a future brand-portal decision (own row required) |

The workbook also proves the anti-formula decision (§3): two coexisting rate generations, a reference-drift bug, disagreeing duplicate totals, and books that currently disagree at all three levels are precisely Panko's error classes. EPF gives the Owner *typed* configuration (price lists, deposit %, reconciliation records) — never a formula box.

## 5. Proposed phases

Every phase: DS-only UI, `*Cents` naming, `guarded()` + permission, audited + event-published mutations, strip on every exporter, bounded queries, tests for every new pure fold, FS0 harness + parity re-run at the gate. No phase builds substrate (FS2/FS3 shipped — EPF adopts at call-sites; approval-gate pattern consumed from EPQ; hop-links/timeline consumed from EPO).

**EPF.1 — Money-truth repairs.** Fix D-01…D-05, D-10…D-15, D-17, P2 hygiene. Highlights: per-year atomic invoice numbering `INV-2026-001` (counter keyed by year, mint+create+PDF-ref in ONE transaction, PDF rendered after commit with a repair path); invoice-create becomes deposit-aware (default amount = net − payments already received, editable; partial invoices land here since the API already accepts `netCents`); mark-paid records the invoice's amount only after a Σpaid ≤ net guard with an explicit overpayment confirm; export rewritten on invoice/payment dates with VAT on invoiced amounts, Rome-timezone bucketing, `stripFinancials`, and an audit entry; "money on cancelled orders" becomes a visible bucket instead of a hole; bank import gets an idempotency key (statement-row hash), stores the bank date as `receivedAt`, validates against live balances, applies transactionally through the shared loader, and runs the same deposit-gate logic as the FP4 route; `actualIsPending` derives from WO completion; refunds enabled as negative payments gated behind the EPQ approval pattern (interim until D-3 credit notes). Additive migration expected: `Invoice.year`, `Invoice.voidedAt?`, `Payment.importKey?` (nullable, additive — pre-approved class).

**EPF.2 — The page at design law + FS3 adoption.** Rebuild the client on DS primitives (PageHeader/MetricStrip/Tabs/FilterBar/DateField/Skeleton/Pagination/FileDropzone); URL state (`?tab=&o=&from=&to=&party=`) making every view deep-linkable; date-range + state + customer filters wired to the params the backend already reads; skeletons everywhere (kill the false empty state); drill-through from every customer/month row into the filtered by-order view and from every deposit row to the blocked WOs on `/production`; Load-more + `VirtualDataGrid` on all four grids (the FS3 handoff); SSE freshness via `useFactoryEvents` (`payment.recorded`, `order.updated`) with a freshness line; consequence-stating confirms on New invoice / Mark-paid / import-apply; PaymentModal fixed (context-sensitive kind default, date field, EU-safe amount parse, DS inputs); VAT/gross line visible in the drawer; proper tablist semantics + a keyboard map (`1-4` tabs, `e` export, `i` import).

**EPF.3 — Party ledger & two-sided reconciliation (the workbook killer feature).** New EPF-owned entities (additive): `PartyOpeningBalance` (party, year, cents, note — replaces the formula-embedded constant), `CounterpartyFigure` (party, subject order|payment|period, statedCents, source note — "what they say"), `PaymentAllocation` (payment → order splits, enabling account-level receipts; `Payment.orderId` stays for direct payments, allocation covers the rest), `Payment.receivedBy?`. New pure folds beside (never inside) `rollup.ts`, parity-scripted: `partyLedger` (opening + billed − paid − credited = running balance, statement-ordered) and `reconcile` (ours vs theirs at order/payment/balance grain → EQUAL / NOT-EQUAL / UNSTATED). UI: a **Party ledger** tab (per-brand statement: opening balance, every order/invoice/payment/credit in sequence, closing balance, aging strip) + a **Reconciliation** queue (every NOT-EQUAL row with both figures, delta, dispute note, resolve action — resolution is always a *documented* record, never an edit); printable/exportable customer statement (strip-called). This deletes the workbook's manual core: both CALCULATION columns, every EQUAL flag, the balance chain, and the red-cell hunt.

**EPF.4 — AR depth: credit notes, dunning, aging.** `CreditNote` document (per-year sequential `NC-2026-001`, reason code required, order/party linkage, PDF, approval via the EPQ gate pattern; the formal correction path D-05/D-11 need). Dunning as an **Owner task queue riding the existing Gmail threads** (consumes the FP1 reply pipeline; never auto-sends — mirrors EPQ's D-2 posture, Owner confirms in D-4): configurable ladder (pre-due nudge / +7 / +30 / +60 ⚠ exact defaults Owner's), per-level template, stop conditions (payment recorded, dispute open, promise-to-pay note), every reminder landing in the thread AND the audit trail. Aging buckets (0-30/31-60/61-90/90+) on the party ledger and as tiles; per-party payment behavior (average days-to-pay, computed from history) shown on the party ledger and feeding the deposit-% suggestion on quotes (read-only surface EPQ may consume).

**EPF.5 — Owner control room.** An **Exceptions** tab of standing queues, each with its exact predicate and count, every row actionable, tile↔list agreeing by shared query definition: shipped-not-invoiced · delivered N days-no-payment · invoiced-not-shipped · deposit-required-but-absent (FD13 scope) · unapplied/unallocated payments · reconciliation NOT-EQUAL · margin-below-floor (floor from EPQ's setting) · money-on-cancelled-orders · invoice-issuance-deadline timers (only if D-2 chooses an e-invoice posture; ⚠ legal deadlines verified against primary sources before build). An **Integrity panel**: named tie-out checks (tiles = Σtabs; ledger balances = Σ entries; Σallocations ≤ payment; drawer = aggregate for the same order) run on demand + nightly, each row expandable to the offending records, honest reds. **Close discipline**: month-end checklist (all shipped invoiced? all payments allocated? reconciliation clean? export sent? snapshot taken?) + a soft **lock date** (money writes dated into a locked month require an Owner-confirmed override, audited — order-level analog of the Odoo/NetSuite pattern). **Communication**: `notify()` on payment received, invoice sent/paid, reminder due, reconciliation mismatch, exception threshold crossings — the bell finally learns about money; a weekly Monday digest (in-app card; email optional later).

**EPF.6 — Dynamic money views ("adapts to each brand").** Saved views on the by-order grid using the existing `SavedView` model with the canonical tuple (filters + group-by + optional second level + sort + visible columns + per-column aggregate from a fixed menu: sum/count/avg/min/max — no formula language, per §3/§4); group-by customer/brand/month/product/state with subtotal rows and drill-through ("see these orders") from any aggregate; period selector (month/quarter/year/custom, Rome TZ) scoping tiles+tabs+export together; a per-brand money workspace assembled from existing blocks (ledger + aging + open items + reconciliation + margin trend for that party); export always honors the current view (and says so). Default views ship for the Owner's known shapes (per-brand ledger, monthly totals, deposits outstanding) so day one looks like the workbook — then better.

**EPF.7 — Italian compliance posture (decision-gated, built last).** The research is unambiguous that the current labeling is risky: since 2019 (forfettario since 2024) Italian B2B invoices are **legally issued only as FatturaPA XML accepted by SDI** — a PDF labeled "Fattura" is at best a courtesy copy ⚠ (cross-cutting O2C report, EC/Avalara/AdE-derived; the dedicated compliance agent was cut short, so **every legal parameter is re-verified against primary sources and the commercialista before this phase builds**). Options: **(A)** stay pre-accounting — relabel the PDF ("Riepilogo ordine / copia di cortesia"), keep per-year numbering + credit notes + the accountant export as the legal handoff, commercialista/external tool issues XML; **(B)** generate FatturaPA XML for manual upload/commercialista submission; **(C)** integrate an SDI gateway API (FattureInCloud/Aruba/A-Cube class ⚠ pricing unverified). Recommendation: **A now** (zero legal risk, zero new infra, EPF.1's numbering/credit-note work is prerequisite for all three), revisit B/C once volume justifies. EPQ already owns quote-time tax mode + party SDI fields (Natura, codice destinatario/PEC) — EPF consumes them whenever B/C activates.

## 6. Decisions for the Owner (D-numbers; recommendation first)

1. **D-1 Compliance posture (EPF.7):** A / B / C — recommend **A** now.
2. **D-2 Invoice-deadline timers:** only meaningful under B/C — recommend defer with D-1=A.
3. **D-3 Credit notes:** formal document with approval + reason codes (recommended) vs staying with gated negative payments.
4. **D-4 Dunning posture:** Owner task-queue with one-click thread reply (recommended, matches EPQ D-2) vs auto-send.
5. **D-5 Reconciliation grain:** order+payment+balance three-level (recommended — mirrors the workbook exactly) vs balance-only.
6. **D-6 Counterparty figures entry:** manual entry + CSV import of "their statement" (recommended) vs manual only.
7. **D-7 Opening balances:** one per party per fiscal year (recommended) vs single all-time.
8. **D-8 Price-list effective-dating:** in-scope for EPF.3 (recommended — the workbook's two-rate-generation problem) vs stays backlog. *Note: price lists belong to Products (EPD, unclaimed) — if approved, this lands as a registry-recorded substrate grant, not a silent cross-page build.*
9. **D-9 Order fields (client ref, URGENT, remake-of):** route to EPO now (recommended) vs defer.
10. **D-10 Finance role:** mint the FD9-anticipated read-only `OFFICE` role with `pages.financials` minus mutations (recommended: cheap, real control) vs Owner-only.
11. **D-11 FD13 defaults:** deposit % default + which segment bypasses the gate — still the open FD13 Owner input; EPF.4's behavior stats will inform it.
12. **D-12 Multi-currency:** stay EUR-canonical with explicit "all figures EUR" labeling (recommended) vs FX now.

## 7. Collision & consumption map (binding)

| Capability | Owner | EPF's posture |
|---|---|---|
| Approval gates / margin floor / reason codes / acceptance evidence | EPQ (house pattern) | consume for credit notes, overpayment confirms, refunds |
| Stripe/payment links on acceptance page | EPQ D-1 | never rebuilt; party ledger just displays resulting payments |
| Quote-time tax mode, Natura/SDI party fields, deposit legal enum (acconto/caparra) | EPQ.5 | consume; EPF renders, never re-derives |
| One-timeline, order↔financials hop-links, Order entity surfaces | EPO | EPF publishes the money node (`/api/financials/order/[id]`, invoice/ledger deep-links); field requests (D-9) routed to EPO |
| SSE fan-out | FS2 (shipped) | adopt `useFactoryEvents` |
| VirtualDataGrid/WindowedList/pickers | FS3 (shipped; EPF grids ×3 named in registry) | adopt at call-sites |
| Internal chat / system feed | FC1-6 | money system-messages only via structured `*Cents` fields (FC trap #1); integrate when FC lands |
| Money folds `rollup.ts`/`money.ts` | canon | new folds live beside, parity-scripted; never forked (D-15 removes the one existing fork) |

## 8. Acceptance targets (every phase gate)

- All defects of §2 closed with a test each; the three hand-verified P0s get regression tests first.
- New pure folds (`partyLedger`, `reconcile`, aging, allocation) ship with exhaustive unit tests; parity script extended to cover them; `npm test` / `check:rbac` / `check:no-touch` / `check:ds-parity` / query-bounds green; FS0 harness re-run — by-order p50 must not regress from FS1's 310 ms (target: beat it via the date-scoped default view).
- Tie-outs green on the live DB: tiles = Σ their drill lists; party ledger closing balance = Σ entries; export totals = on-screen totals for the same window.
- Every money mutation: audited, event-published, notification where §EPF.5 says so, visible in the Gmail thread where a customer-facing action occurred. Zero silent state changes.
- Runtime smoke on `:3199` (never `:3100`); no automated live sends; Owner click-through script delivered per phase.
- The workbook parallel-run test: one month of real orders entered in both systems must reconcile to the cent (structure-level comparison on the Owner's machine only — no workbook data in the repo, ever).

---

*Nothing in this proposal is built. Per the double gate: Owner approval of scope + decisions D-1…D-12 turns this into per-phase specs (EPF.1 first). The three P0 money defects (D-01, D-02, D-05) are live today on the running instance; if the Owner wants, EPF.1 can be specced and gated first, alone, ahead of the rest.*
