# EP-CROSSREVIEW — adversarial consistency review of the four EP proposals (2026-07-16)

First cross-session review of `EPQ-PROPOSAL` / `EPI-PROPOSAL` / `EPO-PROPOSAL` / `EPF-PROPOSAL` against each other, the registry, the invariants, shipped EPQ.1, and the FS2/FS3/FC1 handoffs. Load-bearing URL conventions were **code-verified** (`OrdersClient.tsx:69` reads `?o=`; `ContactsClient.tsx:44` reads `?c=`; `QuotesClient.tsx:63` reads `?q=`; `FinancialsClient` reads no params). Produced by the EPF session as program coordination; amendments below attach to the open Owner gates.

## Verdict

**Conditionally approvable.** The cores are complementary and ownership discipline mostly holds — and nothing contradicts what EPQ.1 already shipped. But there are two genuine duplicate-builds, one convention contradiction that ships broken links, one money-correctness sequencing trap, and a cluster of orphaned handoffs. None require re-scoping a phase; all are registry rows or one-line proposal edits.

## BLOCKERS

**B1 — Four sessions plan the same "templated message + cadence task-queue" machinery.** EPQ.2 quote follow-ups · EPF.4 AR dunning · EPI.4 MessageTemplate + OutboundQueue (+ if-no-reply follow-ups) · EPO.6 transition-triggered drafts — all are scheduled, template-rendered messages posted into a Gmail thread with stop conditions. EPI's template model already carries `{{quote.number}}`/`{{order.number}}` variables (designed general, scoped inbox-only). **Resolution:** registry rows — `MessageTemplate` store **owned by EPI** (consumed by EPQ.2/EPF.4/EPO.6); ONE shared cadence/`FollowUpTask` engine (EPI.4's queue generalizes; EPQ.2 and EPF.4 become configured instances differing only in trigger predicate).

**B2 — EPI's outbound deep-links use wrong param names (code-verified) and contradict EPO's URL law.** EPI §5.6/§5.13 emit `/contacts?id=` and `/orders?focus=`; the honored params are `?c=` and `?o=` (`?focus=` is inbox-only — EPO C5). As written, EPI.6's Orders card and Contact links land on the page without opening the record. **Resolution:** EPI amendment — `/contacts?c=`, `/orders?o=`; delete the false "orders honors `?focus=`" claim. Register the per-entity open-param table: `?o=` /orders · `?c=` /contacts · `?q=` /quotes · `?focus=` /inbox only · `?party=` per EPO D-5 · `?from=&to=` (Rome TZ) as the house date-range convention.

**B3 — EPF.1 must gate EPO.2.** EPO.2 embeds `orderFinancials` (money strip + list Balance) "parity-tested" against today's fold; EPF.1 fixes the live mark-paid deposit double-count (D-02) and changes fold semantics (cancelled-order money D-04, `actualIsPending` D-14, date bucketing D-13). If EPO.2 lands first it broadcasts the negative-balance bug onto the board and its parity baseline breaks when EPF.1 rewrites the fold. **Resolution:** registry note "EPF.1 gates EPO.2"; EPO.2's parity assertion references the fold, not fixed figures.

## MAJOR (one-line amendments)

- **M1** Concurrency/idempotency guards built thrice (EPO D-6, EPF.1, EPI.5 collision-pause) while FS4 owns the domain (queued). → Registry: FS4 grants interim per-page guards; FS4 consolidates later.
- **M2** Exception-queue overlap: deposit + margin-floor predicates appear in BOTH EPO.4 and EPF.5. → Boundary: EPO owns fulfillment/promise exceptions (late, at-risk, stalled WO, production-blocking deposit → links to money); EPF owns billing/AR exceptions (absent deposit terms, margin-floor, unbilled, unapplied cash).
- **M3** Money-event notification owner unassigned (double-bell risk on payments). → EPF owns money-event `notify()` (payment/invoice — added ONCE in the shared FP9 route); EPO owns lifecycle-state notifications.
- **M4** OrderDetail tab-host claimed by both EPO.6 and FC1's missing-list. → EPO.6 scaffolds; FC consumes (FC1 spec must reflect this).
- **M5** EPF consumes EPQ.5 fields (tax mode, SDI, deposit enum) that are unbuilt and 4th in EPQ's queue. → EPF renders no EPQ.5 field until EPQ.5 ships; EPF.1 deposit-awareness is arithmetic only. *(Applied in EPF-PROPOSAL §9.)*
- **M6** FS2's `import.finished` handoff orphaned. → Add to EPO.7 and EPF.2 SSE subscriptions. *(EPF side applied in §9.)*
- **M7** Quotes-grid VirtualDataGrid adoption (registry FS3 row) missing from any EPQ phase. → Add to EPQ.6.
- **M8** ConvertBar backlink handed to EPQ but named in no EPQ phase. → Name it in EPQ.6.
- **M9** EPI.6 self-joins Order data instead of consuming EPO's offered order-summary shape. → Pick one: EPO publishes `order-summary` and EPI consumes (recommended), or registry blesses EPI's grain-gated read.
- **M10** EPO.5 says it records a return credit "EPF consumes"; EPF owns the CreditNote document. → EPO.5 credit outcomes CALL EPF's credit-note API; EPO records only the return linkage. *(Acknowledged in EPF-PROPOSAL §9.)*
- **M11** Date-range URL params undefined under EPO's URL law. → `?from=&to=` (Rome TZ) registered house-wide; EPO.4 + EPF.2 both use it.
- **M12** `SavedView` schema extended by two pages, no steward. → EPF stewards the SavedView tuple (it needs the richest shape); EPQ/EPO consume.

## MINOR

Keyboard `e` means close/edit/export on three pages — a house shortcut grammar is worth a line when EPT claims · `OutboundQueue` undo/scheduled-send applies only to inbox sends (EPQ/EPF/EPO thread sends bypass it — consistency gap to revisit at B1's shared engine) · `InboxView` vs `SavedView` = two views models (justified by routing semantics; noted) · EPQ.2/EPF.4/EPO.6 thread-writes must ride the FP1 reply path and be treated as our-outbound by EPI's read/follow-up semantics · EPQ.3 tier tables + EPF D-8 effective-dating both touch EPD-territory pricing (flag for EPD's future claim) · registry FS3 row says financials grids ×3, EPF.2 adopts all four (month grid included — reconciled in EPF §9).

## Amendment checklist to attach to the gates

| # | Action | Owner of the edit |
|---|---|---|
| B1 | Registry rows: MessageTemplate → EPI; shared cadence engine | registry (done) + EPI/EPQ/EPF/EPO specs honor it |
| B2 | Fix EPI outbound params; register open-param table | EPI session; registry (done) |
| B3 | "EPF.1 gates EPO.2" | registry (done); EPO.2 spec |
| M1 | FS4 interim-guard grant | registry (done) |
| M2/M3/M4/M10/M11/M12 | Boundary/ownership lines | registry (done) |
| M5/M6(EPF) | EPF proposal §9 addendum | EPF (done) |
| M6(EPO)/M7/M8/M9 | One-line phase additions | EPO / EPQ sessions |
