# EPI.1 — Perfection Sweep (binding spec)

First build phase of the approved `EPI-PROPOSAL.md` (Owner: "Approved, proceed with your recommendations", 2026-07-16). EPI.1 makes the existing inbox flawless before any new capability lands: it closes the ten measured visual defects (proposal §1c), the actionable items of the 17-gap ledger (`EPI-UI-INVENTORY.md` §6), adopts the FS3 pane substrate, and gives the page a responsive floor. No new features from phases 2–6 sneak in.

## Purpose

Zero-defect baseline: every control wired, every failure surfaced, every state reachable and escapable, one type scale, symmetric insets, panes fully keyboard-accessible — so later phases build on ground that doesn't wobble.

## Scope IN (numbered; each maps to a defect D1–D10 or gap G1–G17)

**Correctness (routes/worker/events)**
1. **G2 stranded-SNOOZED:** PATCH clearing `snoozeUntil` while `state=SNOOZED` also sets `state=OPEN` (audit `state.changed`). Pure helper `resolveConversationPatch(current, patch)` extracted + unit-tested.
2. **G1 silent worker wakes:** snooze-wake writes audit `unsnoozed` (system actor) and follow-up firing writes audit `followup.fired` (new `EVENT_LABELS` entry); both publish `conversation.updated` through the outbox so open tabs refresh.
3. **G11:** quote creation publishes a durable event (existing union type if one fits, else additive union member) so rail Quotes cards refresh.
4. **G5/G6 keyboard fragility:** `e`/`s` get `.catch` → danger toast; `e` refuses to act until the focused thread is loaded and matches `focusId`; `e` gets a success toast ("Closed"/"Reopened").
5. **G12 dead code sweep:** unused `Banner` import, unreachable `EVENT_LABELS` entries.

**List pane**
6. **G8 + D9 tab counts:** counts computed with the active filters (same WHERE minus `state`); every tab renders a count including `0`; "All" gets one. Shared `buildListWhere()` between list + counts, unit-tested.
7. **G16 filters in URL:** `?state=&mine=1&unmatched=1&q=` merged with `?focus=` via `history.replaceState`; restored on load; deep-linkable.
8. **G9 list failure surface:** load error renders an inline danger banner row with Retry (no more silent stale page).
9. **G10:** "Gmail not connected" becomes a real link to `/settings`; quiet-inbox empty-state copy only when actually connected.
10. **G3 bulk Assign:** BulkActionBar gains Assign (users from `/api/users-lite`) → existing `bulk {action:"assign"}`.
11. **D2/D3 typography:** all raw buttons/controls in the inbox tree inherit Inter; type scale normalized to 13/12.5/11.5/11 (list rows, tabs, meta); the stray native-font control eliminated.
12. **D5 symmetric padding:** list header `10/12/10/12`.

**Thread pane**
13. **D1 blocked images:** when images are blocked, remote `img` is hidden inside the srcDoc (no broken boxes) and the bubble shows a styled placeholder line "🖼 n remote images hidden — Load remote images above"; count from the sanitized HTML.
14. **D4 header wrap:** images-toggle no-wrap; subject truncation with `title` tooltip; header stays one line ≥1200px.
15. **D6 attachment dedupe:** chips repeated from an earlier message (same filename+size) collapse to "N files repeated from earlier · show" (expandable). Pure `markRepeatedAttachments()` + unit test.

**Context rail**
16. **D7 rail empty state:** EmptyState card ("Select a conversation — j/k to move, Enter to open") instead of a blank column.
17. **D8 quote zero-state:** DRAFT quotes with no priced lines show "Draft — not priced yet" instead of "€0.00 · 0%".
18. **G4 link existing contact:** unmatched card gains "Link existing contact" via the FS3 `AsyncCombobox` (party search) → existing `link-party {partyId}` (teaches the sender email, back-matches).
19. **G7 permission gating:** `inbox.assign` gates the Conversation card controls (read-only rows otherwise); `inbox.send`/`comments.create` gate composer modes — a user with neither sees a purpose hint, not dead controls.

**Panes & responsive**
20. **FS3 adoption (registry handoff):** `InboxClient` swaps its local `PaneHandle` for the shared `src/components/PaneHandle` + `useResizablePanes` — keyboard arrows/Enter/Home/End per APG, drag-past-min snap-collapse, persisted widths+collapsed state (existing `factory.inbox.paneWidths` migrates).
21. **Composer vertical resize** (drag handle, persisted `factory.inbox.composerHeight`).
22. **D10 responsive floor:** below 1280px the rail collapses to an icon strip (Contact/Conversation/Files-slot/Quotes) that expands as an overlay; no horizontal overflow at 1200px.

## Scope OUT (later phases own these)
Previews/lightbox/thumbnails/cid (EPI.2) · views/rules (EPI.3) · templates/queue/CC/OOO/spam (EPI.4) · read-unread/collision/find/export + list/thread windowing (EPI.5) · Orders card/party history (EPI.6) · G13 GET-side hydration writes (by design) · G15 idempotent Drive re-save audit (accepted) · G17 replaceState/Back behavior (deliberate, documented).

## Data & API deltas
No schema migration. Route changes: PATCH `/api/inbox/[id]` snooze-clear semantics (1); `/api/inbox` counts honor filters (6); no new routes, no permission changes (bulk assign + link-existing ride existing `inbox.assign`/`contacts.manage`).

## RBAC
Unchanged registry. Client-side gating added (19) mirrors existing server guards — server remains the boundary.

## Acceptance targets
- All ten §1c defects measurably closed (headless verify at 1512/1728/1920 + 1200): single type scale, Inter everywhere in the tree, symmetric insets, no broken-image boxes, no wrap, counts on every tab, populated-or-empty rail always intentional.
- Ledger items G1–G12+G16 verified by behavior: snooze-clear reopens; worker wake refreshes an open tab (SSE) and appears in the timeline; `e` before load is inert; failed PATCH toasts; filters survive reload; bulk-assign works on 3 rows; link-existing matches and back-matches.
- `npm test` (new: resolveConversationPatch, buildListWhere, markRepeatedAttachments) · `check:rbac` · `check:no-touch` · `check:ds-parity` · `check:query-bounds` · isolated `next build` green; runtime smoke on :3199 only; zero live sends (reply path untouched).
- Keyboard: pane separators respond to ←→/Enter/Home/End; all existing shortcuts unchanged.

## Build plan (scoped commits)
EPI1.1 correctness core (1–5 + tests) → EPI1.2 list pane (6–12) → EPI1.3 thread+rail (13–19) → EPI1.4 panes+responsive (20–22) → EPI1.5 headless verify + `EPI1-REPORT.md` gate appendix.
