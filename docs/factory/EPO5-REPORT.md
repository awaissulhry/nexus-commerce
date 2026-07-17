# EPO5 — Lifecycle depth: amendments + returns (gate report)

> Shipped 2026-07-17 against `EPO-PROPOSAL.md` §5 EPO.5. Kills **E5 E7**; **E6 (partial shipment) deliberately deferred with a coordination flag** — see Findings. Verification green: 606 tests (64 files, incl. the new amendment-fold suite), rbac 145 routes, no-touch, ds-parity, query-bounds 147, isolated build, :3199 probes (new routes 403 unauthenticated), EPO.1 transition smoke re-run 10/10 live.

## Plain English

**Confirmed orders can finally change — without ever changing silently.** "Amend" on an active order lets you adjust quantities and prices with a required reason; the system freezes the lines exactly as they were into an audited revision (rev 1, 2, …), shows the change and its money delta on the timeline, and — when the total changed — voids the customer's acceptance with a banner until you record their re-approval (D-4: date-only or neutral edits don't re-approve). Amending mid-production says out loud that work orders were NOT re-exploded.

**Returns are first-class.** On a shipped/delivered order, "Record return" takes per-line outcomes — **repair**, **remake**, or **credit**. Repairs and remakes put a rework work order (`ORD-n/R1`) on the production floor through the full normal stage flow, QC gate and cert check included — repairs as a brand asset, exactly the research verdict. Credits point you to the REFUND payment (Financials' own mechanism) so the balance stays true. Returns get house numbers (`RET-1`) and live on the timeline.

## What shipped

| Item | Detail |
|---|---|
| **Migration `epo5_amendments_returns`** | Additive: `OrderRevision` (rev, before-snapshot, field diff, netDelta, reason), `OrderReturn` + `OrderReturnLine` (outcome REPAIR/REMAKE/CREDIT, rework-WO link), `Order.reapprovalNeededAt`. Applied via busy-timeout + **ISO-8601-Z ledger row per FS4's rule** — and `migrate status` now verifies clean itself |
| **Amendment fold** | `lib/orders/amend.ts` pure `applyAmendment()` — field diffs, net delta, size-run⇒qty coupling; unit-proven |
| **Amend route** | `POST /api/orders/[id]/amend` — one transaction: revision freeze → line updates → acceptance void on net change; unknown lines 400; non-amendable states 422 ("record a return instead"); `PATCH` records re-approval (audited). Mid-production qty changes flagged `workOrdersUntouched` in response, audit, and toast |
| **Returns route** | `POST /api/orders/[id]/returns` — one transaction: `RET-n` minted via the house counter (`return` kind added to `counters.ts`, additive), per-line outcomes, rework WOs (`/R1…`) with the configured stage pipeline at zero est-cost (actuals via the ledger as usual), per-WO audits, `workorder.created` event |
| **Timeline** | New `amendment` (rev + reason, delta as grain-safe `amountCents`) and `return` (outcome summary) kinds |
| **UI** | Amend + Record-return header buttons (state-gated); amend modal (per-line qty/price + required reason + floor-reconcile warning); return modal (per-line qty/outcome/note); re-approval warning Banner with "Mark re-approved" |

## Click-through (Owner)

1. **⚠ Restart `npm run dev -w @nexus/factory`** — third migration this program (trap 6b).
2. On an in-production order → Amend → change a qty, give a reason → the timeline gains "Amended (rev 1) — …" with the € delta; if the total moved, the amber re-approval banner appears; confirm with the customer, Mark re-approved.
3. On your delivered order → Record return → 1 × Repair → `RET-1` appears on the timeline and `ORD-n/R1` shows on the production board, full stage flow.
4. A Credit-outcome line → the toast tells you to record the refund payment; do it from the Money card (kind Refund, negative, note required).

## Findings / deviations

1. **Partial shipment (E6) deferred with a flag** — the per-size ship-partial flow lives inside the Shipping page's buy drawer (EPS, unclaimed). D-2's data shape (shipment line payload + derived badge, no new state) stands; building it means editing `ShippingClient`/buy route beyond a hop-link. Recorded in the registry as EPO→EPS coordination: either EPS's future session builds it against D-2, or the Owner grants EPO the touch.
2. **Re-approval request isn't auto-sent** — voiding + banner + audited manual confirmation ship now; the templated thread-send is EPO.6 (blocked on EPI.4's shared template store per B1). The banner says exactly this.
3. **Amendments don't re-explode WOs** — flagged loudly everywhere (response, audit, toast, modal) rather than guessed at; floor reconciliation is the Owner's call today. An auto-reconcile proposal would be EPP territory.
4. **Rework WOs carry zero est-cost** — the estimate lives on the original WO; rework actuals land via the FP6 ledger as usual (est-vs-actual on reworks reads actual-only).
5. `counters.ts` gained the `return` kind — 2-line additive touch on a shared lib (EPF co-uses it); non-breaking.

## Rollback

Revert the commit; migration is additive — safe to leave.
