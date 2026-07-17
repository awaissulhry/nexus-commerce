# EPI.3 — Views & Automated Routing (binding spec)

Third build phase of the approved `EPI-PROPOSAL.md` (Owner 2026-07-17: "Continue and proceed however you recommend"). The Owner's sections ask: divide the one inbox into self-routing sections — "if we receive the order from this email address, it straight goes to a specific section… isolate the work by each brand… automated… I select all the criteria… maybe in a header." Design source: proposal §5.1 (views row), §5.7 (builder), §5.8 (manage), §5.9 (rules). Verdicts: Superhuman splits + Front views (ADOPT+BEAT), Gmail builder-IS-the-search (ADAPT), Gmail-tabs route-prompt (ADOPT), explicit order + stop-processing — never Missive's alphabetical wart.

## Purpose

Header tabs that ARE saved queries: a conversation appears in its section the moment it matches — automatic and retroactive **by construction**, nothing materialized, nothing to backfill. Views are Owner-defined and shared (approved decision); a light ordered rules layer covers ingest side-effects queries can't express (auto-assign, auto-close).

## Scope IN

**1. Schema (the cycle's first migration — additive `epi3_views`):** `InboxView` (name, emoji, color, sortOrder, `exclusive` default ON, `showElsewhere` default OFF, criteria Json) · `InboxViewOverride` (viewId+conversationId unique, mode `pin|exclude`, cascade) · `InboxRule` (name, sortOrder, enabled, criteria Json, actions Json, stopProcessing). Live-DB protocol per FS1: stop `:3100` → migrate → generate → restart via nohup → health-check (this also delivers the restart owed by the EPI.1 worker + EPI2.5 api-client fixes).

**2. Pure core `src/lib/inbox/views.ts` (unit-tested):** zod `Criteria` schema — `{ all: Criterion[], any: Criterion[] }` over fields `senderEmail/senderDomain/subject/body/partyId/partyKind/hasAttachment/attachmentExt/unmatched/assigneeId`; `criteriaWhere(criteria)` → Prisma fragment; `viewListWhere(view, earlierExclusiveViews, overrides)` → full membership where (matches − earlier exclusive claims − excludes + pins); `defaultTabWhere(exclusiveViews)` → the plain Inbox minus claimed-elsewhere (showElsewhere honored). Precedence law: **tab order = claim priority** (Superhuman), overrides always win.

**3. API:** `GET/POST /api/inbox/views` + `PATCH/DELETE /api/inbox/views/[id]` + `POST /api/inbox/views/reorder` (mutations `inbox.views.manage` — **+1 permission**, consumption rides `pages.inbox`) · `POST /api/inbox/views/preview` (criteria → count + first rows, via the SAME builder — Gmail's form-IS-the-search) · `POST /api/inbox/[id]/view-override` (pin/exclude/clear) · list route gains `view=<id>` (membership where composed with the state/mine/unmatched/q filters) and returns per-view counts for the header row (bounded: one count per view, views ≤ ~20) · `GET/POST/PATCH/DELETE /api/inbox/rules` + `POST /api/inbox/rules/run` (`{dryRun}` → per-conversation from/to diff, apply subset — the CSV dry-run idiom; `inbox.views.manage`).

**4. Views header row (proposal §5.1):** pills between PageHeader and the panes: `[Inbox n] [view… n] … [+]`; active view scopes the list; counts live (ride the existing SSE refresh); `Tab`/`Shift+Tab` cycles (inert while typing/dialog); right-click a pill → Edit / Reorder ←→ / Delete (DS Menu); `+` opens the builder. Deep link `?view=<id>` joins the URL composer (filters/focus/file preserved).

**5. View builder (Drawer, §5.7):** name/emoji/color; ALL-of + ANY-of condition rows (field picker → op → value; party via AsyncCombobox, kind via Listbox, free text for sender/subject/body/ext); **live preview** (count + first 5 matches as real rows, debounced through /preview); `Exclusive` + `Also show in Inbox` toggles; save/delete with consequence copy ("conversations return to Inbox; nothing is deleted").

**6. Create-from-message + pin (§5.2/§5.7):** row right-click context menu (Open · Add to view ▸ [existing views + "New view from sender…"] · Pin to current view). "New view from sender" opens the builder pre-filled with sender email + domain. Pinning while a view can't match offers the Gmail-tabs prompt: "Route future mail from @domain here?" → **appends a visible criterion** (never a hidden rule).

**7. Ingest rules (§5.9):** Rules drawer (opened from the header `⚙` menu next to `+`): ordered rows "WHEN mail arrives IF <criteria summary> THEN <assign X / close / stop>", enable toggles, ↑↓ reorder; **Run now** → dry-run diff modal (rows: conversation · action · current → after) → apply-selected. Worker applies enabled rules **once, at conversation creation** (first inbound), in order, honoring stopProcessing; every application audited (`rule.applied`) + durable event. Actions v1: assign, close, stop — auto-link-party stays out (matching already owns that path).

## Scope OUT
Templates/queue/OOO/spam (EPI.4) · read-state/collision (EPI.5) · personal (non-shared) views (approved: later) · ML anything · rule triggers beyond arrival (Front's snooze-expiry etc.) · attachment-content criteria (FS5 FTS).

## Acceptance targets
- An Owner-built "brand" view (sender domain) captures its threads instantly AND retroactively; exclusive claim removes them from Inbox; `showElsewhere` restores them; pin + exclude override both directions; counts agree with the lists they label (filter-honest).
- Tab cycling, deep link `?view=`, builder live-preview parity (preview count == open-the-view count), reorder changes claim priority observably.
- Rules: dry-run shows the exact diff, apply audits + refreshes; a new inbound conversation gets rule actions applied exactly once; disabled rules skip.
- Migration additive-only, verified against a COPY first; `:3100` stopped→migrated→restarted healthy (worker heartbeat fresh, page 200); trap 6b honored.
- All fences green (+1 permission registered); harness re-run for the list route (view wheres bounded/indexed); headless verify on :3199; no live sends.

## Build plan (scoped commits)
EPI3.1 schema+core+tests + live migration dance → EPI3.2 API (views/preview/override/rules + list-route view param + counts) → EPI3.3 header row + builder + manage + context menu + pin/prompt → EPI3.4 rules drawer + worker hook + dry-run → EPI3.5 headless verify + `EPI3-REPORT.md`.
