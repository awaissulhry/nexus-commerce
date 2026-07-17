# F10 - Inbox (EPI)

> **Route:** `/inbox` · **EP code:** EPI · **Status:** 🔨 **EPI.1 + EPI.2 SHIPPED** (`EPI1-REPORT.md` 2026-07-16 · `EPI2-REPORT.md` 2026-07-17 — lightbox/previews/cid/Files-panel/comment-attachments live; a pre-existing FormData P0 caught+fixed) · ⏳ Owner: click-throughs + **restart :3100** · **EPI.3 Views & Routing next**.
> Canonical docs: `docs/factory/EPI-PROPOSAL.md` (incl. §5 design dossier) · `EPI-UI-INVENTORY.md` (17-gap ledger) · base: `FP1-SPEC.md`/`FP1-REPORT.md`

Part of [[F00 - Factory OS MOC]] · flow position: [[F01 - Mission & Golden Flow]] step 1 — **the golden flow starts here** · program: [[F06 - Enterprise Program (EP)]]

## Purpose

The factory's external Gmail channel and origin of everything: inbound customer email lands, threads, auto-matches to a party, gets triaged (assign/close/snooze/follow-up), and becomes quotes and orders. Three resizable panes (ConversationList | ThreadPane | ContextRail), deep-linked `?focus=`. The verified competitive edge: **no manufacturing platform (Fulcrum, Katana, JobBOSS²) captures inbound customer email against jobs at all.** Everything ships INSIDE `/inbox` — no new nav items.

## Two live bugs (called out in the ledger)

1. **Stranded-SNOOZED** — clearing the snooze date nulls `snoozeUntil` but leaves `state=SNOOZED`; the worker wake query never matches null → conversation vanishes from Open until an inbound reply rescues it.
2. **Silent worker wakes** — snooze-wake/follow-up firing write no audit row and publish no event → open tabs never live-refresh on wake.

Plus 15 more gaps: dark-but-wired routes (bulk assign, link-existing-party), keyboard fragility (`e`/`s` uncaught), tab counts ignoring filters, filter state not in URL, GETs that write, reply ignoring CC, and more — all folded into EPI.1.

## Phases

| Phase | Delivers |
|---|---|
| EPI.1 ✅ | Perfection sweep SHIPPED 2026-07-16 — 10 visual defects + gaps ledger closed, APG pane keyboard grammar, rail collapse <1280px, filters-in-URL, bulk Assign, link-existing-contact |
| EPI.2 ✅ | Files & previews SHIPPED 2026-07-17 — inline-allowlist route, lightbox (`?focus=&file=`), thumbnails, `cid:` resolver (migration-free), rail Files panel, drag/paste attach, comment attachments, MentionTextarea |
| EPI.3 | Views & routing — query-backed `InboxView` tabs w/ live counts, builder-on-search, ordered ingest rules w/ dry-run |
| EPI.4 | Composer & send pipeline — `#` templates ({{party.name}} + placeholder guard, IT/EN), OutboundQueue = undo-send + scheduled-send + Send & Snooze, OOO detection |
| EPI.5 | Triage & collaboration — per-user read/unread, claim semantics, send-time collision pause, quoted-text collapse, in-thread find, export |
| EPI.6 | Rail & seams — **Orders card** (fills FP1's reserved slot; consumes [[F12 - Orders (EPO)]] summary shape), party history, FC seam contract |

## Owner decisions — RESOLVED 2026-07-16 (approved as recommended)

Six phases in order 1→6 · undo-send default 10s (5/10/20/30 configurable) · views = Owner-defined shared (personal later) · DeepL translation stays slotted in EPI.4 but **dormant until the Owner provides a free DeepL API key**.

## Owns / Consumes

**EPI owns:** InboxView/InboxRule/MessageTemplate/OutboundQueue/ConversationRead schema (additive), collision-pause fail-safe, views/rules/routing, `inbox.views.manage` + `inbox.templates.manage` permissions.
**Consumes, never builds:** [[F21 - Chat & Order Spaces (FC)]] owns all chat (EPI.6 only defines the seam: "Open order space" + `?focus=&msg=` anchors FC cards use) · FS2 SSE + FS3 windowing/panes/MentionTextarea ([[F22 - Substrate FS Series]]) — adoption handed to EPI at call-sites · FS5 FTS/streaming later · notifications as-is.

## Edges

**Out:** rail → `/contacts?id=`, `/orders?focus=`, `/quotes?q=`; Drive links; new deep links `?view=`, `?focus=&file=`, `?focus=&msg=`.
**In:** root redirect + login default + rail + ⌘K + **notification bell** + analytics unanswered counter + contact Conversations tab + order thread link. The whole app converges here — which is why [[F01 - Mission & Golden Flow]] names it the origin.
