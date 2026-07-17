# EP — the Enterprise Program (page-by-page hardening · multi-session control tower)

Started 2026-07-11 at the Owner's direction: *"work page by page to make sure it's absolutely enterprise level … no communication gap at all … complete control over each and everything … no duplicate features … keep control of each and everything."* This file is the **coordination contract for every session** working on Factory OS from now on. Read it right after `PLAYBOOK.md`, before touching any page.

## The protocol (binding on every session)

1. **Claim before you work.** Before starting a page, set its row below to `CLAIMED (date)` and commit this file (`git commit --only docs/factory/ENTERPRISE-PROGRAM.md`) — parallel sessions on main make unclaimed parallel work a collision risk. If a row is already CLAIMED, do not touch that page; coordinate through the Owner.
2. **Per-page cycle (double gate, unchanged):** research (external bar + internal audit) → `EPx-PROPOSAL.md` → Owner approval → phase specs → build → click-through → Owner approval → update the row.
   **Research completeness standard (Owner directive 2026-07-11):** the internal audit must include a TOTAL UI inventory — every surface (page, tab, modal, drawer, banner, empty state, toast), every control (button, link, menu item, field, keyboard shortcut) with its full wiring chain (handler → API route → service → DB writes → events/notifications emitted), and every navigation edge in and out of the page. Deliverable: `EPx-UI-INVENTORY.md` committed beside the proposal. "The wiring, the links, the buttons — each and everything."
3. **No feature leaves its home page.** A capability belongs to the page that owns its entity (registry below). If a page needs something another page owns, it consumes that page's API/components — it never re-implements. New cross-page capabilities get an owner ROW here first.
4. **Shared substrate is owned by workstreams, not pages** (table below). A page proposal may DEPEND on substrate; it may not BUILD it.
5. **Navigation law:** the 11-page IA (F0-IA.md) is fixed; new surfaces live INSIDE their page (tabs/drawers/sub-routes like `/quotes/...`). Adding a top-level nav item requires Owner sign-off recorded here. **Signed off: `/chat` (12th item) — approved by the Owner via FS-FC-PROPOSAL, 2026-07-11 ("proceed with your recommendation"); built in FC2.**
6. **Design law:** DS-only UI (F0-DESIGN-BRIDGE.md); resizable panes + windowed lists are the standing expectations for any new heavy surface.
7. **Shared visual map (Obsidian, added 2026-07-16 at the Owner's direction):** `obsidian-vault/Factory/` — `F00 - Factory OS MOC` hub, one note per page/substrate, `Factory OS Map.canvas` (wiring) + `EP Status Board.canvas` (status columns). When your page's registry row changes, update YOUR page note + move your card on the status board in the same commit (`git add obsidian-vault/Factory && git commit --only obsidian-vault/Factory --only <your docs>`). The vault is a MAP for the Owner; this file and `docs/factory/` remain the canon and win on any conflict. The AWA workbook privacy rule applies in the vault too: structure only, never figures.

## Page registry (EP series codes)

| Page | Code | Status | Proposal | Notes |
|---|---|---|---|---|
| Quotes | **EPQ** | **CLAIMED 2026-07-11 — EPQ.1+EPQ.2+EPQ.3 SHIPPED (`EPQ1-REPORT.md`, `EPQ2-REPORT.md`, `EPQ3-REPORT.md`); EPQ.5 next (recommended order). ⚠ Owner: restart :3100 + `db:migrate` (epq3_pricing_discipline authored, NOT applied)** | `EPQ-PROPOSAL.md` + `EPQ-UI-INVENTORY.md` | Phases EPQ.1→.6; D-1..D-5 per recommendations (Stripe env-gated with bank-transfer fallback until account exists). EPQ.3 handoffs: **EPD** tier/MOQ editor + measurementSurcharge setting surface · **EPA** win/loss by-reason-code tally (needs a line join). FS3 quotes-grid + party-picker adoption DONE (M7 satisfied; M8 ConvertBar backlink stays EPQ.6) |
| Inbox | EPI | **CLAIMED 2026-07-11 — EPI.1 SHIPPED 2026-07-16 (report `EPI1-REPORT.md`; 16/16 headless targets + 2 regressions found→fixed→re-verified); EPI.2 Files & Previews next** | `EPI-PROPOSAL.md` ✅ + `EPI-UI-INVENTORY.md` ✅ | Both live bugs dead (stranded-SNOOZED, silent worker wakes); FS3 pane-hook adopted + APG keyboard grammar added to shared PaneHandle; undo 10s / shared views / DeepL-dormant decisions logged; ⚠ Owner: restart :3100 dev to load the new worker code |
| Orders | EPO | **CLAIMED 2026-07-11 — approved 2026-07-16; EPO.1 + .3 + .2 SHIPPED (reports `EPO1/EPO3/EPO2-REPORT.md`); ⚠ B3 SEQUENCING FLAG (owned by EPO session): EPO.2 landed before EPF.1 — it is fold-referencing per B3's resolution (no baked figures; EPF.1's rewrite flows through automatically) but the board mirrors the live D-02 negative-balance bug until EPF.1 ships; deposit-met bell ceded to EPF per M3 (lifecycle bells stay EPO's); ⚠ :3100 restart still pending — trap 6b; EPO.4 next (scope per M2: fulfillment/promise exceptions only; billing/AR = EPF.5)** | `EPO-PROPOSAL.md` ✅ + `EPO-UI-INVENTORY.md` ✅ + reports .1/.3/.2 | Build order EPO.1→.3→.2→.4→.6→.7→.5; D-1..D-6 per recommendations (cross-page split: search route+production ?wo= reader = EPO; financials ?o= reader = EPF; ConvertBar backlink = EPQ; inbox order card = EPI ph.6; partials = payload+badge no new state; notifications = draft-confirm w/ logged skip; re-approval only on net change; ?party= URL law + party-360 stays EPC; concurrency = updatedAt guard) |
| Production | EPP | open | — | |
| Materials | EPM | open | — | |
| Products & Pricing | EPD | open | — | |
| Contacts | EPC | open | — | |
| Shipping | EPS | open | — | |
| Financials | EPF | **CLAIMED 2026-07-11 — proposal APPROVED 2026-07-17 ("proceed however you recommend"); EPF.1 building** | `EPF-PROPOSAL.md` ✅ (incl. §9 addendum) + `EPF-UI-INVENTORY.md` ✅ + `EPF-COMPLIANCE.md` ✅ + `EPF1-SPEC.md` | D-1..D-12 per recommendations: D-1 **posture A** (courtesy-copy relabel; SDI deferred) · D-2 timers deferred · D-3 formal credit notes (EPF.4) · D-4 dunning = Owner task-queue on the SHARED cadence engine (B1) · D-5 three-level reconciliation · D-6 manual+CSV counterparty figures · D-7 per-year opening balances · **D-8 price-list effective-dating GRANTED to EPF.3 scope (EPD-territory grant recorded here; EPD inherits on claim)** · **D-9 Order fields (clientRef/URGENT/remakeOf) routed to EPO as a field request** · D-10 OFFICE read-only role · D-11 FD13 defaults = still Owner input (EPF.4 stats will inform) · D-12 EUR-canonical. EPF.1 ships first (3 live P0s); **EPF.1 gates EPO.2** per cross-review B3 |
| Analytics | EPA | open | — | |
| Settings & Team | EPT | open | — | |

## Shared-substrate ownership (pages consume, never build)

| Substrate | Owner workstream | Status |
|---|---|---|
| Real-time/SSE fan-out (O(1) poller, targeted events) | **FS2** | **SHIPPED 2026-07-11 (`FS2-REPORT.md`): 50-client proof PASS, gap-free resume, scoped bells; `import.finished` subscriber = EP handoff** |
| Virtualized DataGrid, windowed lists, paged/searchable comboboxes, @mention autocomplete | **FS3** | **components SHIPPED 2026-07-11 (`src/components/`: VirtualDataGrid, WindowedList, AsyncCombobox, MentionTextarea, PaneHandle/useResizablePanes) + adopted on unclaimed pages. PENDING ADOPTIONS by page owners — EPI: ConversationList/ThreadPane windowing, composer MentionTextarea, InboxClient pane hook, ContextRail picker; EPO: orders grid + party filter; EPQ: ✅ DONE 2026-07-17 (EPQ.3 — pipeline VirtualDataGrid + AsyncCombobox party picker); EPF: financials grids ×3** |
| Write transactions, session-cache, optimistic concurrency, login rate-limit | **FS4** | **FS4 APPROVED 2026-07-17 — building; stale-guard adoption on EPO/EPF-claimed files recorded as handoffs** |
| FTS search, attachment/PDF streaming, snapshot & archival | **FS5** | queued |
| Per-order internal chat (Order Spaces), system-message feed, presence/read receipts | **FC1–FC6** | **FC1 APPROVED 2026-07-16 ("however you recommend") — building (worktree); FC2 shell next after its gate** |
| Notifications (single write path `notify()`), bell, outbox | F1/FP1 (exists) | live |
| Load harness + parity + `check:query-bounds` fence | FS0/FS1 (exists) | live — every EP page re-runs it |
| Approval-gate / margin-floor governance patterns | EPQ defines the house pattern (first consumer) | — |

## Cross-review 2026-07-16 (`EP-CROSSREVIEW.md`) — coordination rows + amendments attached to the open gates

First adversarial review of the four proposals against each other (EPF session, program coordination). Verdict: conditionally approvable — no phase re-scoping, but these ownership rows are now BINDING and the per-session one-liners must land in the respective specs:

| Capability | Owner | Consumers / condition |
|---|---|---|
| `MessageTemplate` store (variables incl. `{{quote.number}}`/`{{order.number}}`, IT/EN) | **EPI** (EPI.4) | EPQ.2 follow-ups, EPF.4 dunning, EPO.6 transition drafts — configured instances of ONE shared cadence/`FollowUpTask` engine; nobody builds a second template store or queue (B1) |
| Per-entity open-param table (URL law, extends EPO D-5) | **EPO** | `?o=` /orders · `?c=` /contacts · `?q=` /quotes · `?focus=` /inbox ONLY · `?party=` cross-page · `?from=&to=` (Rome TZ) house date-range. EPI must fix its `/contacts?id=` + `/orders?focus=` links (B2, code-verified broken) |
| Money-event notifications (payment/invoice `notify()`) | **EPF** | added ONCE in shared FP9/payments routes; EPO owns lifecycle-state notifications (M3) |
| Exception-queue split | **EPO** = fulfillment/promise (late, at-risk, stalled WO, production-blocking deposit) · **EPF** = billing/AR (deposit terms absent, margin-floor, unbilled, unapplied, money-on-cancelled) | each links to the other, no duplicate predicates (M2) |
| OrderDetail tab host | **EPO.6 scaffolds** | FC2 mounts into it — FC1 spec must not re-claim it (M4) |
| Return credits | **EPF's CreditNote API** mints the document | EPO.5 calls it, records only return linkage (M10) |
| `SavedView` schema steward | **EPF** (richest tuple: filters+group-by+sort+columns+aggregate+default) | EPQ.6/EPO.7 consume (M12) |
| Interim concurrency/idempotency guards (`updatedAt` 409, idempotency keys, collision-pause) | granted per-page **pending FS4** | FS4 consolidates on claim (M1) |

**Sequencing (binding): EPF.1 gates EPO.2** — the order-board money strip embeds the fold only after EPF.1's semantics fixes (B3). **Per-session one-liners still owed:** EPI — fix outbound params (B2); EPO — `import.finished` in EPO.7 + publish `order-summary` for EPI.6 or bless its read (M6/M9); EPQ — quotes-grid VirtualDataGrid ✅ shipped in EPQ.3 (M7); ConvertBar backlink named in EPQ.6 (M8). EPF's amendments are applied (`EPF-PROPOSAL.md` §9; compliance ⚠ flags superseded by `EPF-COMPLIANCE.md`).

## Standing cross-page invariants (program-wide)

- Money truth lives in the pure folds (`rollup.ts`, `money.ts`, quote engine) — pages feed them, never fork them; parity script guards every rewrite.
- Every list bounded (`check:query-bounds`), every heavy page proven on the FS0 harness before its gate closes.
- Communication events (send/accept/state changes) must land in BOTH the Gmail thread (external) and — once FC ships — the order/quote's internal feed; no silent state changes, ever. "No communication gap" is an exit criterion for every EP page.
- Playbook rules unchanged: no-touch, scoped commits, no time estimates, honest gate reports.
