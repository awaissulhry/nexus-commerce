# F11 - Quotes (EPQ)

> **Route:** `/quotes` · **EP code:** EPQ · **Status:** 🔨 EPQ.1 **SHIPPED** (merge `bd091df8`, report `EPQ1-REPORT.md`) — EPQ.2 next. First page of the program; its proposal is Owner-approved ("proceed with all of it").
> Canonical docs: `docs/factory/EPQ-PROPOSAL.md` · `EPQ-UI-INVENTORY.md` · `EPQ1-REPORT.md` · base: `FP3-SPEC.md`/`FP3-REPORT.md`

Part of [[F00 - Factory OS MOC]] · flow position: [[F01 - Mission & Golden Flow]] step 2 · program: [[F06 - Enterprise Program (EP)]]

## Purpose

The factory's **money mouth**: turns a matched [[F10 - Inbox (EPI)]] conversation into a priced, margin-guarded, versioned offer; carries the negotiation; captures acceptance with evidence; hands production a complete frozen spec. Three loyalties in order: (1) never quote money the factory regrets, (2) never let an offer die of silence, (3) never make production guess what was sold.

## Phases

| Phase | Delivers | Status |
|---|---|---|
| EPQ.1 | Lifecycle closed & audited — server-enforced transition map (422+audit), auto-EXPIRE tick + Expired tab, supersede tokens, SENT field-guard, persisted floor-ack, before/after money audit, 4-row waterfall, bulk mark-lost | ✅ SHIPPED (kills S1-S5, S8) |
| EPQ.2 ✅ 2026-07-16 | No offer dies of silence — public view tracking, accept/reject/convert notifications, follow-up **Owner task queue** (Italian one-click nudges into the Gmail thread) | ⚪ next |
| EPQ.3 | Pricing discipline — goal-seek in rail (net⇄margin), qty-break/MOQ surcharges, repeat-order pricing, discount reason codes, size-run matrix | ⚪ |
| EPQ.4 | Cost truth & honest promises — structured cost model (leather m² + wastage, labor, overhead), quote-vs-actual loop from FP6 ledger, CTP-lite promise, convert freezes FULL config spec | ⚪ |
| EPQ.5 | Acceptance that stands up (Italy/EU) — B2C gross-price fix, tax modes, VIES-gated zero-rating, SDI fields, deposit legal enum, acceptance-evidence bundle, Stripe deposit-on-accept | ⚪ |
| EPQ.6 | Pipeline command center — revision diff, clone-as-draft, per-quote KPIs, saved views | ⚪ |

Recommended order: .1 → .2 → .3 → .5 → .4 → .6.

## Decisions (approved unless noted)

D-1 Stripe deposit on acceptance page ✅ (env-gated, bank-transfer fallback) · D-2 follow-ups = Owner task queue ✅ · D-3 margin floor = speed bump + persisted ack ✅ (built in EPQ.1) · D-4 acconto vs caparra default — **deferred to EPQ.5** · D-5 lapsed SENT sweep ✅ executed.

## Substrate EPQ owns (the whole house consumes — see [[F06 - Enterprise Program (EP)]])

- **Approval/margin-floor-ack pattern** — send-time floor gate, persisted `marginFloorBreached` + `floor.acknowledged` audit. Consumed by [[F18 - Financials (EPF)]] (credit notes, overpayment confirms) and [[F12 - Orders (EPO)]] (amendment re-approval).
- **Acceptance-evidence pattern** (EPQ.5) — hash-chained token→email binding, timestamp, IP, PDF SHA-256, event log.
- **Tax-mode / SDI fields per party** (EPQ.5) — B2C gross / IT-B2B net+IVA / EU-B2B art.41 VIES-gated / extra-EU art.8; Natura + codice destinatario/PEC/CF. Downstream invoicing ([[F18 - Financials (EPF)]] EPF.7) becomes mechanical.
- **Deposit legal enum** `acconto | caparra_confirmatoria` — forks cancellation law AND invoicing.
- **Stripe posture** — env-gated on keys, fallback always on.

## Known gaps still open (from the 16-gap UI inventory)

⌘K `?focus=` deep-link broken (→ EPO fixes search route) · converted-order dead end (no quote→order nav) · silent successes on line edits · deposit 0% unrepresentable · re-sends omit accept link · grid non-sortable · overdue counter inert · public page acts on stale state · ⚠ live compliance bug: B2C prices displayed VAT-silent read as VAT-inclusive against the seller (Cod. Consumo artt. 49/22) — EPQ.5.

## Edges

**Consumes:** notifications, SavedView, worker tick, FS3 comboboxes ([[F22 - Substrate FS Series]]), Gmail thread APIs (via existing endpoints only — Inbox is EPI's), FP6 cost ledger ([[F13 - Production (EPP)]]).
**Hands out:** convert → Order (`bornFromQuoteId`, promise date, frozen spec) to [[F12 - Orders (EPO)]] · pipeline aggregates to [[F19 - Analytics (EPA)]] · quote feed to [[F21 - Chat & Order Spaces (FC)]] (deferred to FC5) · ConvertBar backlink task (from EPO D-1 split).
