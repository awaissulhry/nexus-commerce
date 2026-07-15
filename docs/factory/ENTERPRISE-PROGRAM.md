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

## Page registry (EP series codes)

| Page | Code | Status | Proposal | Notes |
|---|---|---|---|---|
| Quotes | **EPQ** | **CLAIMED 2026-07-11 — EPQ.1 SHIPPED (report `EPQ1-REPORT.md`); EPQ.2 next** | `EPQ-PROPOSAL.md` + `EPQ-UI-INVENTORY.md` | Phases EPQ.1→.6; D-1..D-5 per recommendations (Stripe env-gated with bank-transfer fallback until account exists) |
| Inbox | EPI | **CLAIMED 2026-07-11 (this session) — PROPOSAL + UI INVENTORY delivered, awaiting Owner gate** | `EPI-PROPOSAL.md` ✅ (incl. §5 design dossier) + `EPI-UI-INVENTORY.md` ✅ (17-gap ledger, 2 live bugs) | 6 phases: perfection sweep (incl. gaps ledger) → files/previews/lightbox → query-backed views+routing → composer/send pipeline (undo/scheduled/templates) → triage/collision/read-state → rail Orders card + FC seam; FS2/FS3 shipped — EPI adopts pane hook + windowing + MentionTextarea at call-sites |
| Orders | EPO | **CLAIMED 2026-07-11 (this session) — research in flight** | `EPO-PROPOSAL.md` (pending) | FS1 already fixed kanban truncation; scope incl. one-timeline depth, order↔financials linkage, brand/party-scoped views, cross-page hop-links (thread/quote/WO/shipment/invoice) |
| Production | EPP | open | — | |
| Materials | EPM | open | — | |
| Products & Pricing | EPD | open | — | |
| Contacts | EPC | open | — | |
| Shipping | EPS | open | — | |
| Financials | EPF | **CLAIMED 2026-07-11 (this session) — research in flight** | `EPF-PROPOSAL.md` (pending) | scope incl. Owner's AWA 2026 workbook automation (workbook is a LOCAL-ONLY source — structure may be described in docs, figures never committed), brand-adaptive dynamic money views, invoice/AR depth (credit notes, dunning, reconciliation), consumes EPO order↔financials hop-links + EPQ approval-gate pattern (never re-implements) |
| Analytics | EPA | open | — | |
| Settings & Team | EPT | open | — | |

## Shared-substrate ownership (pages consume, never build)

| Substrate | Owner workstream | Status |
|---|---|---|
| Real-time/SSE fan-out (O(1) poller, targeted events) | **FS2** | **SHIPPED 2026-07-11 (`FS2-REPORT.md`): 50-client proof PASS, gap-free resume, scoped bells; `import.finished` subscriber = EP handoff** |
| Virtualized DataGrid, windowed lists, paged/searchable comboboxes, @mention autocomplete | **FS3** | **components SHIPPED 2026-07-11 (`src/components/`: VirtualDataGrid, WindowedList, AsyncCombobox, MentionTextarea, PaneHandle/useResizablePanes) + adopted on unclaimed pages. PENDING ADOPTIONS by page owners — EPI: ConversationList/ThreadPane windowing, composer MentionTextarea, InboxClient pane hook, ContextRail picker; EPO: orders grid + party filter; EPQ: quotes grid + party picker (EPQ.3); EPF: financials grids ×3** |
| Write transactions, session-cache, optimistic concurrency, login rate-limit | **FS4** | queued |
| FTS search, attachment/PDF streaming, snapshot & archival | **FS5** | queued |
| Per-order internal chat (Order Spaces), system-message feed, presence/read receipts | **FC1–FC6** | approved, after FS2 |
| Notifications (single write path `notify()`), bell, outbox | F1/FP1 (exists) | live |
| Load harness + parity + `check:query-bounds` fence | FS0/FS1 (exists) | live — every EP page re-runs it |
| Approval-gate / margin-floor governance patterns | EPQ defines the house pattern (first consumer) | — |

## Standing cross-page invariants (program-wide)

- Money truth lives in the pure folds (`rollup.ts`, `money.ts`, quote engine) — pages feed them, never fork them; parity script guards every rewrite.
- Every list bounded (`check:query-bounds`), every heavy page proven on the FS0 harness before its gate closes.
- Communication events (send/accept/state changes) must land in BOTH the Gmail thread (external) and — once FC ships — the order/quote's internal feed; no silent state changes, ever. "No communication gap" is an exit criterion for every EP page.
- Playbook rules unchanged: no-touch, scoped commits, no time estimates, honest gate reports.
