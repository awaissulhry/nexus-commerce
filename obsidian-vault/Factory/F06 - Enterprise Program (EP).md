# F06 - Enterprise Program (EP)

> **The control tower for the page-by-page enterprise hardening of Factory OS.** Canonical file (binding, always current): `docs/factory/ENTERPRISE-PROGRAM.md` — this note mirrors it for the map; **the repo doc wins on any conflict.**
> Started 2026-07-11 at the Owner's direction: *"absolutely enterprise level … no communication gap … complete control … no duplicate features."*

Hub: [[F00 - Factory OS MOC]] · coordination model: [[F07 - Sessions & Coordination]] · research state: [[F08 - Research Map & Gaps]]

## The protocol (binding on every session)

1. **Claim before you work** — set the page's registry row to CLAIMED + `git commit --only` the file. A claimed row = hands off for everyone else.
2. **Double gate per page:** research (external bar + internal audit) → `EPx-PROPOSAL.md` → Owner approval → phase specs → build → click-through → Owner approval.
   **Research completeness standard:** a TOTAL UI inventory (`EPx-UI-INVENTORY.md`) — every surface, every control, full wiring chain (handler → route → service → DB → events), every nav edge.
3. **No feature leaves its home page** — capabilities belong to the page that owns the entity; other pages consume its API/components, never re-implement.
4. **Substrate is owned by workstreams, not pages** ([[F22 - Substrate FS Series]]) — pages DEPEND, never BUILD.
5. **Navigation law** — the 11-page IA is fixed (+ `/chat` signed off as 12th); new surfaces live INSIDE their page.
6. **Design law** — DS-only ([[F03 - Design Law]]); resizable panes + windowed lists standard on heavy surfaces.

## Page registry (status snapshot 2026-07-16 — check the repo doc for live state)

| Page | Code | Note | Status |
|---|---|---|---|
| Inbox | EPI | [[F10 - Inbox (EPI)]] | 🔨 proposal APPROVED 2026-07-16; EPI.1 building |
| Quotes | EPQ | [[F11 - Quotes (EPQ)]] | 🔨 EPQ.1 SHIPPED; EPQ.2 next |
| Orders | EPO | [[F12 - Orders (EPO)]] | 🟡 proposal delivered, awaiting gate |
| Production | EPP | [[F13 - Production (EPP)]] | ⚪ open (unclaimed) |
| Materials | EPM | [[F14 - Materials (EPM)]] | ⚪ open |
| Products & Pricing | EPD | [[F15 - Products & Pricing (EPD)]] | ⚪ open |
| Contacts | EPC | [[F16 - Contacts (EPC)]] | ⚪ open |
| Shipping | EPS | [[F17 - Shipping (EPS)]] | ⚪ open |
| Financials | EPF | [[F18 - Financials (EPF)]] | 🟡 proposal delivered, awaiting gate |
| Analytics | EPA | [[F19 - Analytics (EPA)]] | ⚪ open |
| Settings & Team | EPT | [[F20 - Settings & Team (EPT)]] | ⚪ open |
| Chat | FC | [[F21 - Chat & Order Spaces (FC)]] | ⚪ approved, builds after FS2 (FC1 spec next) |

## Cross-page substrate ownership (consume, never rebuild)

- **EPQ defines:** approval/margin-floor-ack pattern · acceptance evidence · tax-mode/SDI fields · deposit legal enum · Stripe posture → [[F11 - Quotes (EPQ)]]
- **EPO defines:** transition-service single-write-path · one-timeline · `?o=`/`?party=` URL law → [[F12 - Orders (EPO)]]
- **EPF defines:** the money node (`orderFinancials`) · party ledger + reconciliation · credit notes → [[F18 - Financials (EPF)]]
- **FS2/FS3/FS4/FS5 + FC:** [[F22 - Substrate FS Series]] and [[F21 - Chat & Order Spaces (FC)]]
- **F1/FP1 (live):** notifications single write path `notify()`, bell, outbox.

## Cross-review 2026-07-16 (binding coordination rows)

The four proposals were adversarially reviewed against each other (`docs/factory/EP-CROSSREVIEW.md`): verdict **conditionally approvable** — 3 blockers + 12 seam issues, all resolved by ownership rows now in the control tower: MessageTemplate + ONE shared cadence engine → EPI · URL open-param table (`?o=/?c=/?q=/?focus= inbox-only/?party=/?from=&to=`) → EPO · money-event notifications + CreditNote API + SavedView stewardship → EPF · exception-queue split EPO(fulfillment)/EPF(billing) · OrderDetail tab host → EPO.6 · **EPF.1 gates EPO.2**. Per-session one-liners owed: EPI param fix (B2), EPO `import.finished`+order-summary, EPQ grid+backlink in EPQ.6.

## Standing invariants (program-wide)

- Money truth lives in the pure folds (`rollup.ts`, `money.ts`, quote engine) — pages feed them, never fork; parity script guards rewrites ([[F04 - Domain Model & Money Invariants]]).
- Every list bounded (`check:query-bounds`); every heavy page re-proven on the FS0 harness.
- **No communication gap** — money/state events land in the Gmail thread AND (once FC ships) the internal feed; no silent state changes. This is an exit criterion for every page.
- Playbook rules: no-touch outside `apps/factory` + `docs/factory`, scoped commits, no time estimates, honest gate reports.
