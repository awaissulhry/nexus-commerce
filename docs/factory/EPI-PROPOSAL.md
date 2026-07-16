# EPI — Inbox Enterprise Proposal (research gate · AWAITING OWNER APPROVAL)

EP-series page cycle for `/inbox` (registry: `ENTERPRISE-PROGRAM.md`, claimed 2026-07-11). Research ran on three tracks: (1) full code audit of the shipped FP1 inbox, (2) headless visual/UX audit of the live UI on an isolated `:3199` build (measured geometry, 14 annotated screenshots, zero mutations, audit session revoked), (3) external bar — verified feature research across Front, Missive, Help Scout, Zendesk, Intercom, Superhuman, Gmail, Slack, Linear, Notion, plus manufacturing tools (Fulcrum, Katana, JobBOSS², Odoo, Gorgias, Shopify). **§5 is the full design dossier — every surface, drawer, button, link, and wire — per the Owner's direction.** Nothing below is built. Per the double gate: Owner approval → per-phase specs → build.

**The one-paragraph verdict:** FP1's skeleton is genuinely good (sandboxed rendering, threading, party matching, resizable list/rail panes, keyboard grammar, SSE) — but it stops at "functional". The bar products win on five things the inbox lacks: **files you can see** (previews/lightbox/thumbnails — today attachments are download-only text chips), **views that route themselves** (Superhuman splits / Front rules — today: one flat list), **a composer with a memory** (templates, scheduled send, undo, follow-up semantics), **collaboration safety** (collision pause, read state), and **order context in the rail** (the reserved Orders slot was never filled). Verified competitive fact: **no manufacturing platform captures inbound customer email against jobs at all** (Fulcrum punts to a view-only portal, Katana's integration makes agents re-type order IDs, JobBOSS² only logs outbound) — finishing this page makes the inbox categorically better than every tool the factory could buy.

---

## §1 Internal audit — what exists vs what's missing

> Per the program's research-completeness standard, the exhaustive as-built inventory (every surface, control, wiring chain, and navigation edge of today's inbox) lives in **`EPI-UI-INVENTORY.md`** beside this proposal. This section is the summary view.

### 1a. Exists and works (keep; extend, don't rebuild)

| Capability | State | Where |
|---|---|---|
| Three-pane grid, list+rail drag-resizable, persisted, dbl-click reset | ✅ hand-rolled `PaneHandle`, clamps 280–640 / 240–520 | `InboxClient.tsx:21-95,290-302` |
| Sanitized HTML in sandboxed iframe + CSP image gate | ✅ per-conversation "Load remote images" toggle | `MessageBubble.tsx`, `ThreadPane.tsx:135-156` |
| Gmail-threaded reply (In-Reply-To/References), 15MB cap | ✅ | `api/inbox/[id]/reply/route.ts` |
| Internal comments (amber) + mention notifications | ✅ typed handles only, no autocomplete UI | `comments.ts`, `ThreadPane.tsx:71-79` |
| Assign / close / snooze / follow-up, reopen-on-reply | ✅ | `api/inbox/[id]/route.ts`, gmail-sync |
| Party auto-match + create-from-sender + domain back-match | ✅ | `ContextRail.tsx:89-162`, link-party route |
| Attachment download + save-to-Drive per-party folders | ✅ download-only (`Content-Disposition: attachment`) | attachments routes |
| State tabs + Mine/Unmatched + LIKE search + cursor pagination + bulk | ✅ | `ConversationList.tsx`, `api/inbox/route.ts` |
| Keyboard `j/k/Enter/Esc/e/s/r/⌘Enter` | ✅ | `InboxClient.tsx:250-288` |
| SSE live refresh + freshness line | ✅ | `use-factory-events`, outbox bridge |
| Linked-quotes rail card + New quote wiring | ✅ | `ContextRail.tsx:210-264` |

### 1b. Missing (the enterprise gap)

- **No attachment preview of any kind** — no thumbnails, no lightbox, no PDF view; `cid:` inline images are gray placeholders (FP1 deferred).
- **No views/sections/routing** — one flat list; a rules engine was explicitly out of FP1 scope.
- **Composer is bare** — plain textarea; no templates, no CC/BCC/subject, no scheduled send, no undo send, raw `<input type=file>` (FileDropzone was spec'd, not built), no drag-drop/paste attach, comments can't attach files.
- **No per-user read/unread** (FP1 deferral), no collision safety, no claim semantics.
- **Snooze/follow-up are timers without semantics** — no "if-no-reply vs regardless", no Send & Snooze.
- **Rail has no Orders card** (slot reserved since FP1, never filled), no per-party thread history, no per-conversation files panel.
- **No OOO/auto-reply detection, no spam surfacing** (Gmail API `messages.list` excludes SPAM by default — false-positive order mail is invisible), no print/export, no in-thread find, no quoted-text collapsing.

### 1c. Visual defects (measured on the live build — all fixed in EPI.1)

| # | Defect | Measured |
|---|---|---|
| 1 | Blocked remote images = raw broken-image boxes, no styled placeholder | screenshots 03/06 |
| 2 | Typography sprawl: 11 font sizes on one screen, bulk below the 13px law; one 13.33px native control | computed styles |
| 3 | Raw `<button>`s (state tabs etc.) fall back to Arial, not Inter | computed styles |
| 4 | "Load remote images" wraps to 2 lines at 1200px; header subject truncates hard | screenshot 13 |
| 5 | List-header padding asymmetric `10/12/8/12` | computed |
| 6 | Forwarded messages duplicate attachment chips (2 files → 4 chips), no dedupe | screenshot 03 |
| 7 | Blank bordered 300px rail when nothing selected (renders `null`) | screenshot 01 |
| 8 | Quotes card leaks "€0.00 · 0%" zero-state on drafts | screenshot 08 |
| 9 | Tab count pill only when >0 → inconsistent tab anatomy | screenshot 02 |
| 10 | No breakpoint: at 1200px thread squashes to 400px (966px hard floor) | measured grid |

Also: no keyboard resize on the pane handles (APG window-splitter pattern absent), no collapse/snap, list renders all 60 rows (fine now; windowing is FS3's).

---

## §2 External bar — verdicts (F0-TEARDOWN style)

| Capability | Best in class | Verdict | Key mechanics we take |
|---|---|---|---|
| Attachment lightbox | Gmail actions + Linear zoom | **BEAT** (Front has none) | Esc closes (resets zoom first, never navigates — Linear shipped a fix for this), ←/→ across all conversation files, click/`0`/`space` fit↔100%, zoom+pan, download/print; `role=dialog`, focus trap+restore |
| PDF preview | pdf.js standard | **ADOPT** | Native `<iframe>` blob first ($0, no dep); pdf.js later if chrome consistency demands |
| Office docs | (all convert server-side) | **ADAPT** | Metadata card + Download + "Save to Drive → open in Docs" (we already have Drive) — never a public-URL converter |
| Thumbnails/galleries | Gmail chips + Missive rail Files | **ADOPT** | Image thumbs on chips; per-conversation Files panel with "show in conversation" |
| Drag/paste attach | Gmail two-zone + GitHub paste | **ADOPT** | Drop-to-attach vs drop-inline zones; paste starts upload immediately with placeholder |
| Views / split inbox | Superhuman splits + Front views | **ADOPT+BEAT** | Header sections = saved queries; create-from-message; Tab/Shift+Tab cycling; exclusive-with-toggle; tab order = match priority |
| Rules engine | Front (when/if/then) + Gmail (search=filter) | **ADAPT** | Builder ON TOP of the search engine → preview/dry-run for free; retroactive checkbox + per-rule Run-now; explicit order + stop-processing (never Missive's alphabetical wart) |
| Manual override | Gmail tabs drag-prompt | **ADOPT** | Pin sticks; "route future mail from X here?" writes an ordinary visible rule — learning-feel, no ML |
| Collision safety | Help Scout (fail-safe) > Front (live) | **ADAPT** | Send-time conflict pause (thread changed since draft start → Send/Edit/Discard banner) is pure local; live presence rides FS2 targeted events later |
| Assignment | Missive | **ADOPT** | Close only when assigned ("Assign to me" otherwise); reply-claims-ownership |
| Snooze semantics | Help Scout + Front | **ADOPT** | Explicit "if no reply / regardless"; inbound auto-cancels; **Send & Snooze** in composer |
| Templates | Missive (Liquid) + Superhuman (`;`) | **ADOPT** | `#` trigger in composer; `{{party.name|default}}` from matched party; unfilled-placeholder blocks send; IT/EN pairs per template |
| Undo send | Gmail | **ADOPT** | Delayed dispatch (hold N s server-side, Undo cancels) — exactly how incumbents do it |
| Scheduled send | Gmail UX | **ADAPT** | **Gmail API has no scheduled-send endpoint (verified)** → local queue table, worker fires `messages.send` when due |
| Remind-if-no-reply | Superhuman | **ADOPT** | Follow-up defaults to "if no reply"; toggle "regardless"; auto-replies don't count as replies |
| Read receipts / open pixels | Superhuman | **IGNORE** | Needs a public pixel server; Apple MPP poisons it. Substitute reply-tracking (local, honest) |
| Contact sidebar | Front + Gorgias order card | **ADOPT+BEAT** | Party card + **order/quote context cards with in-card actions** + per-party past threads. No manufacturing tool does this at all |
| Email+chat unification | Missive interleave; mis-send bug class documented (Jira JSDCLOUD-10478, Zammad #1135) | **ADAPT via FC** | FC owns chat. EPI hardens the existing toggle composer with the convergent safeguards (persistent amber editor bg ✅ exists, explicit labels, per-mode draft preservation) and defines the FC seam (§3) |
| OOO/auto-reply detection | Zendesk + RFC 3834 | **ADOPT** | `Auto-Submitted`/`X-Auto-Response-Suppress`/`Precedence` headers at ingest; don't clear follow-ups; badge "OOO" |
| Spam surfacing | Help Scout | **ADAPT** | Poll SPAM label for known-party senders → "possible order mail in spam" chip (`includeSpamTrash` trap, verified) |
| In-thread find | nobody does it well | **BEAT** | Client-side find across the loaded thread, auto-expand + scroll to hit |
| Thread export / print | nobody exports whole threads | **BEAT** | `@media print` view + "thread → PDF / zip of .eml" via `format=raw` |
| Translation IT↔EN | Gmail banner (not in API) | **OWNER DECISION** | DeepL API Free (500k chars/mo) — needs a key; banner + per-contact remembered preference |
| Resizable panes | VS Code + W3C APG | **ADOPT** | FS3 shipped the shared `PaneHandle`/`useResizablePanes` substrate (2026-07-11) — EPI.1 adopts it at the inbox call-site and completes the APG grammar: arrow-key resize + Enter collapse, drag-past-min snap-close, persisted collapsed state. No new dep (react-resizable-panels evaluated and passed over; v4 renamed its whole API — pin if ever adopted) |
| SLA timers | Intercom countdown chips | **DEFER** | FP1's IGNORE stands for now; views + follow-ups cover the need at this team size; revisit post-EPI |

---

## §3 Coordination contract (what EPI consumes but must NOT build)

| Owned elsewhere | Owner | EPI's relationship |
|---|---|---|
| O(1) SSE fan-out, targeted events, presence transport | **FS2** | **SHIPPED 2026-07-11** — live "teammate viewing/replying" indicators are unblocked for EPI.5; EPI still ships the send-time conflict pause as the fail-safe layer |
| Windowed thread (S-4), virtualized lists, @mention autocomplete combobox | **FS3** | **components SHIPPED 2026-07-11** — call-site adoption handed to EPI per the registry: ConversationList/ThreadPane windowing, composer `MentionTextarea`, `useResizablePanes` in InboxClient, rail `AsyncCombobox`; folded into EPI.1/EPI.5 specs |
| FTS search (S-13), streamed attachments (S-14), archival | **FS5** | Views/rules are query-backed on the existing WHERE builder — FS5 upgrading LIKE→FTS is transparent to them; preview route reuses today's cache mechanics, FS5 makes it streaming |
| Order Spaces chat, system feed, presence/read receipts, reactions, DMs | **FC1–FC6** | The inbox stays the external Gmail channel + conversation comments (per D4: customers never in chat). EPI.6 defines the seam: order-linked threads expose "Open order space"; email events can render as cards in the space (FC5 ingests, EPI provides deep links). No chat UI is built here |
| Notifications single write path | F1 (live) | consumed as-is |

Nav law: everything ships INSIDE `/inbox` (header sections, drawers, lightbox overlay) — no new nav items.

---

## §4 The build — six phases (each re-gates: spec → approval → build → click-through → approval)

| Phase | Theme | Headline scope | Migration |
|---|---|---|---|
| **EPI.1** | Perfection sweep | All ten §1c defects **+ the `EPI-UI-INVENTORY.md` §6 gaps ledger (17 items — incl. the stranded-SNOOZED bug, worker wakes invisible to open tabs/timeline, silent `e`/`s` keyboard failures, unreachable bulk-assign & link-existing-party wiring, filter-blind tab counts, filters not URL-persisted, client-side permission gating on rail controls)** · pane keyboard resize + snap-collapse via the FS3 `useResizablePanes`/`PaneHandle` substrate (shipped 2026-07-11) + composer resize · <1280px rail collapse | none |
| **EPI.2** | Files & previews | Inline preview route (image/PDF allowlist) · lightbox · thumbnails · `cid:` fix · rail Files panel · FileDropzone + drag/paste attach · comment attachments · forwarded-dedupe | none (maybe nullable dim cache) |
| **EPI.3** | Views & routing | `InboxView` header sections (query-backed = auto + retroactive) · builder-on-search with live preview · create-from-message · pin/exclude override + route-prompt · ordered ingest rules with dry-run/Run-now | `InboxView`, `InboxViewOverride`, `InboxRule` |
| **EPI.4** | Composer & send pipeline | Templates (`#`, `{{party.name}}`, placeholder guard, IT/EN pairs) · OutboundQueue → undo send + scheduled send + Send & Snooze · CC/BCC/subject · new-thread compose · if-no-reply follow-ups · OOO detection · spam surfacing | `MessageTemplate`, `OutboundQueue`, follow-up mode col |
| **EPI.5** | Triage & collaboration | Per-user read/unread · claim semantics (close needs assignee, reply-claims) · send-time collision pause · quoted-text collapse · in-thread find · print + thread export | `ConversationRead` |
| **EPI.6** | Rail & seams | Orders card (fills the FP1 slot) · party history + per-party files · in-card actions consuming FP4/FP9 routes · FC seam contract (deep links + email events for the order space feed) | none |

**Recommended order:** 1 → 2 → 3 → 4 → 5 → 6. Phases 2 and 3 swap cleanly if the Owner wants sections before previews.

---

## §5 DESIGN DOSSIER — every surface, drawer, button, link, and wire

Convention: **★NEW** = does not exist today. Routes marked (exists) are reused untouched. All new mutating routes: `export const permission` + `guarded()` + audit + `publishEventDurable`. All drawers/modals are DS `Drawer`/`Modal`; all menus DS `Menu`; tokens only.

### 5.1 Page frame

```
┌ PageHeader ─ Inbox · freshness "Mail synced 8s ago · INBOX" · [⚙ Inbox settings ▾]★ ─┐
│ VIEWS ROW ★  [ Inbox 12 ][ AWA Racing 3 ][ Suppliers 1 ][ Newsletters ][ + ]          │
├──────────────┬─┬────────────────────────────────────────────┬─┬─────────────────────┤
│ LIST (280-   │‖│ THREAD (flex, min 520px)                   │‖│ RAIL (240-520px,    │
│ 640px)       │ │                                            │ │ collapsible ★)      │
└──────────────┴─┴────────────────────────────────────────────┴─┴─────────────────────┘
```

| Control | Behavior | Wire |
|---|---|---|
| `⚙ Inbox settings ▾` ★ (header, right) | DS Menu: **Manage views…** / **Manage rules…** / **Templates…** / **Outbox (n)…** / **Undo-send window ▸** (5/10/20/30s) | opens drawers 5.7–5.10; window pref → `AppSetting inbox.defaults` via ★`PATCH /api/inbox/settings` |
| Views row ★ | one active view scopes the list; Tab/Shift+Tab cycles; counts live (refresh on existing SSE events); `+` opens View builder pre-blank; right-click view → Menu: Edit / Reorder ←→ / Delete | `GET /api/inbox?view=<id>` (list route gains `view` param); deep link `?view=<id>` |
| Pane handles | existing drag + dbl-click reset, **+ ★ arrow-key resize, Enter = collapse/restore, Home/End = min/max** (APG separator); drag-past-min snaps closed; collapsed state persisted | `localStorage factory.inbox.paneWidths` (exists) + ★`factory.inbox.collapsed` |
| <1280px ★ | rail auto-collapses to a 36px strip of icon buttons (Contact/Conversation/Files/Orders) — click expands as overlay | pure CSS/state |

### 5.2 List pane

```
┌ [Open|Snoozed|Closed|All]  🔍 search ─────────┐   ← state Segmented + search (exists)
│ [Mine] [Unmatched] [📎 Has files ★] [⚠ Spam 1 ★]│   ← filter pills
│ ✉ ROW: ●unread★ PartyChip subject 12.5px       │
│        snippet 11.5px  · ⏰ 🔁 📎 OOO★ badges  │
│ … BulkActionBar on select (exists, + Assign ★) │
└ Load more (exists) ───────────────────────────┘
```

| Element | Behavior | Wire |
|---|---|---|
| Unread dot ★ | bold row + dot until this user opens it; `Shift+U` toggles | ★`ConversationRead` upsert on thread open, `POST /api/inbox/[id]/read` |
| `⚠ Spam n` pill ★ | only renders when worker found known-party mail under Gmail SPAM label; click → filtered list with per-row "Not spam" (removes SPAM label via existing modify scope) | worker tick → ★`GET /api/inbox/spam`, `POST /api/inbox/spam/[msgId]/rescue` |
| Row context menu ★ (right-click) | Open · Assign ▸ · Close/Reopen · Snooze ▸ · **Add to view ▸** · Pin to current view · Export ▸ | reuses PATCH/bulk routes; Add-to-view → 5.7 prefilled |
| OOO badge ★ | "OOO until 18 Jul" when auto-reply headers parsed | ingest flag on Message (additive col) |
| Bulk bar | exists (Close/Reopen) **+ ★ Assign, Add to view, Mark read** | `POST /api/inbox/bulk` gains actions |

### 5.3 Thread pane

```
┌ Subject 15px · PartyChip · state Pill ────────────────────────────────┐
│ [Load remote images] [🔍 Find ★] [⋯ ★: Print · Export PDF · Export    │
│                                    .eml zip · Copy link]              │
├ MESSAGE CARD (inbound/outbound) ──────────────────────────────────────┤
│  From · date · [collapse ▾ ★]                                         │
│  sanitized iframe body … [— show quoted text ★]                       │
│  FILE GALLERY ★: image thumbs (72px, click→lightbox) + file chips     │
│   chip hover: [Preview★|Download|Drive]; forwarded dupes → one row    │
│   "same 2 files as above" ★                                           │
├ amber internal note (exists) · audit event line (exists) ─────────────┤
└ COMPOSER (5.5) ───────────────────────────────────────────────────────┘
```

| Control | Behavior | Wire |
|---|---|---|
| `🔍 Find` ★ (`/` or `⌘F` when thread focused) | inline find bar; client-side match over loaded bodies/comments; N/N counter; Enter/Shift+Enter next/prev; auto-expands collapsed messages + scrolls; Esc closes bar first | pure client |
| `⋯ → Print` ★ | print stylesheet: all messages expanded, chrome stripped, full timestamps → `window.print()` | client |
| `⋯ → Export PDF / .eml zip` ★ | whole thread; strip-called on any metadata | ★`GET /api/inbox/[id]/export?format=pdf\|eml` (`pages.inbox`) |
| Collapse / quoted-text ★ | per-message chevron; quoted blocks auto-folded behind "— show quoted text" | client (sanitizer already isolates blockquotes) |
| Blocked-image placeholder ★ | styled card "🖼 n remote images hidden · [Load]" replaces raw broken boxes | CSS in srcDoc builder |
| Thumbnail click | opens Lightbox 5.4 | ★`GET .../attachments/[attId]?inline=1` — allowlist raster+PDF, correct Content-Type; SVG/HTML/other stay download-only |

### 5.4 Lightbox ★ (full-screen overlay, DS-composed)

```
┌ filename.jpeg · 2 of 7 ──────────── [Drive] [⬇] [🖨] [✕] ┐
│                                                           │
│                 ‹        image / PDF iframe        ›      │
│                                                           │
└ zoom: [-] 100% [+] [Fit]  ·  (Office/other: type·size card + Download + "Drive → open in Docs") ┘
```

Keys: `Esc` close (resets zoom first, NEVER navigates back — Linear's lesson) · `←/→` prev/next across **all** attachments in the conversation · `+/-`/scroll zoom · click or `0` fit↔100% · `space` fit toggle · `⌘S` download · `⌘P` print. A11y: `role="dialog"` `aria-modal`, focus trap, focus restored to the triggering thumbnail. Images: CSS-transform zoom/pan. PDFs: iframe blob (native viewer). Deep-linkable: `?focus=<conv>&file=<attId>`.

### 5.5 Composer

```
┌ [ Reply | Internal note ] (exists; amber bg in note mode — kept)        ┐
│ To: party@brand.com  [CC][BCC]★  Subject: Re: … (click to edit)★        │
│ ┌ textarea (★ vertical resize handle) ─────────────────────────────┐    │
│ │  #  → template picker ★  ·  @ → mention (FS3 later)              │    │
│ └───────────────────────────────────────────────────────────────────┘    │
│ [📎 Attach(FileDropzone★ + drag/paste★)] chips…                          │
│ ⚠ COLLISION BANNER ★ (only if thread advanced since draft start):        │
│   "Giulia replied 2 min ago — [Review thread] [Send anyway] [Discard]"   │
│                       [Send ▾ ★: Send now · Send later… · Send & Snooze…]│
└ after send: Toast "Sending in 10s — [Undo]" ★                            ┘
```

| Control | Behavior | Wire |
|---|---|---|
| `#` template picker ★ | popover Combobox; arrow/Enter inserts; `{{party.name\|default}}` resolved from matched party; unresolved `{{…}}` left highlighted and **Send disabled** with hint; per-template EN/IT toggle | ★`GET /api/inbox/templates` |
| CC/BCC/Subject ★ | collapsed links expand fields; subject prefilled `Re:` (idempotent, threading preserved) | reply route accepts cc/bcc/subject |
| Send ▾ ★ | **Send now** = enqueue `sendAt=now+undoWindow`; **Send later…** = Menu presets (Tomorrow 08:00 · Monday 08:00 · Custom → DateField); **Send & Snooze…** = send + snooze picker in one | ★`OutboundQueue` row; worker fires `messages.send` when due; Undo toast → ★`POST /api/inbox/outbound/[id]/cancel` |
| Collision pause ★ | compare thread's latest message id at send vs draft-start; mismatch pauses send with banner | pure client + one `GET` recheck |
| Per-mode drafts ★ | Reply and Note drafts preserved independently (Intercom pattern) — toggling never destroys either | client state |
| New thread ★ | "✉ New email" button in list header → Modal: party picker → To prefilled; sends via `messages.send` (no threadId), creates Conversation | ★`POST /api/inbox/compose` |

### 5.6 Context rail (cards top→bottom; each collapsible ★)

| Card | Contents & buttons | Wire |
|---|---|---|
| **Contact** (exists) | + ★ link "View contact →" `/contacts?id=` · ★ "Past conversations (n)" expandable list, each row → `?focus=` | party data in thread GET (exists) + ★`recentConversations` |
| **Conversation** (exists) | assignee Listbox · Close/Reopen (★ disabled until assigned → shows "Assign to me") · Snooze (★ Menu presets + custom + "clears on reply" note) · Follow-up (★ SegmentedControl `if no reply | regardless` + DateField) | PATCH route (exists) + mode col |
| **Orders** ★ (fills FP1's reserved slot) | linked orders: `ORD-12 · IN_PRODUCTION · €1,240 (grain-gated) · promise 24 Jul` → `/orders?focus=`; buttons: **Record payment** (FP9 modal, consumes existing route) · **Open order space** (FC — renders when FC2 ships, hidden until) | orders joined on `Order.conversationId` in thread GET |
| **Quotes** (exists) | ★ zero-state fix ("Draft — not priced yet"); New quote (exists) | exists |
| **Files** ★ | every attachment in this conversation: thumb grid + chips, type filter pills, "show in conversation" scroll-jump; footer "All files with AWA Racing →" (party-wide gallery drawer) | thread GET already carries attachments; party-wide: ★`GET /api/inbox/files?partyId=` |
| Rail empty state ★ | nothing selected → EmptyState card "Select a conversation · j/k to move, Enter to open" | client |

### 5.7 View builder (Drawer, right, 520px) ★

```
Name [AWA Racing]  Emoji [🏍]  Colour (Pill palette)
MATCH ALL of: [Party ▾][is ▾][AWA Racing ×]          [+ condition]
MATCH ANY of: [Sender domain ▾][contains ▾][awa.it ×] [+ condition]
Fields: sender email/domain · party · party kind · subject/body keyword ·
        has attachment (+extension) · state · assignee · unmatched
[✓] Exclusive (claims conversations out of Inbox; tab order = priority)
[ ] Also show matches in Inbox
LIVE PREVIEW (Gmail pattern: the form IS the search) — first 20 matches
   render below as real rows, count updates per keystroke
[Save view]  [Cancel]                    (edit mode: [Delete view])
```

Wire: ★`POST/PATCH/DELETE /api/inbox/views` (`inbox.views.manage`); preview = the list route with `criteria` param — no second engine. **Create-from-message** (row context menu / thread `⋯`): opens this drawer with sender/domain/party pre-filled. **Route prompt**: pinning a conversation to a view offers "Route future mail from @awa.it here?" — accepting appends a visible criterion (never a hidden rule).

### 5.8 Manage views (Drawer) ★ — reorderable list (↑↓, order = match priority), per-row: name/emoji/count · Exclusive toggle · Edit → 5.7 · Delete (confirm w/ consequence: "conversations return to Inbox; nothing is deleted").

### 5.9 Rules (Drawer) ★ — ingest side-effects views can't express

Ordered rows: `WHEN mail arrives IF sender domain = awa.it THEN assign Giulia, stop-processing [✓]` · toggle enabled · **Run now** → Modal dry-run diff (reuses the CSV import idiom: per-row from/to, apply-valid) · loop-safe: each rule fires once per conversation. Wire: ★`/api/inbox/rules` CRUD + `POST /api/inbox/rules/[id]/run {dryRun}` (`inbox.views.manage`); worker applies on sync ingest.

### 5.10 Templates (Drawer) ★ — list + editor: name · EN body · IT body · variables palette (`{{party.name}} {{party.contactName}} {{quote.number}} {{order.number}} {{user.name}}`) · "insert-confirm" flag per variable. Wire: ★`/api/inbox/templates` CRUD (`inbox.templates.manage`).

### 5.11 Outbox (Drawer) ★ — queued sends: recipient · subject · fires-at countdown · [Cancel → back to draft] [Edit]; badge count on the ⚙ menu. Wire: ★`GET /api/inbox/outbound`, cancel route above. Undo-send and scheduled-send are the SAME table — one mechanism, no special cases.

### 5.12 Keyboard map (final; `?` opens an in-app overlay ★)

| Key | Action | | Key | Action |
|---|---|---|---|---|
| `j/k` | move row (exists) | | `Tab/⇧Tab` | cycle views ★ |
| `Enter/Esc` | open / back (exists) | | `e` | close-or-claim ★ semantics |
| `s` | snooze menu ★ (was: silent tomorrow-08:00) | | `⇧U` | read/unread ★ |
| `r` | focus composer (exists) | | `/` or `⌘F` | in-thread find ★ |
| `⌘Enter` | send (exists) | | `#` | template picker ★ (composer) |
| `?` | shortcut overlay ★ | | lightbox | `←→ + - 0 space ⌘S ⌘P Esc` ★ |
| pane handles | `←→` resize · `Enter` collapse · `Home/End` min/max ★ | | | |

### 5.13 Event & deep-link wiring (complete)

- **SSE consumed** (exists): `conversation.synced` / `conversation.updated` / `comment.created` → list+thread refresh; view counts ride the same refresh (no new event types until FS2's targeted events).
- **SSE published** by new mutations: every view/rule/template/outbound mutation → `publishEventDurable("conversation.updated" | "inbox.config.changed"★)`.
- **Deep links**: `?focus=<conv>` (exists) · ★`?view=<id>` · ★`?focus=<conv>&file=<attId>` (lightbox) · ★`?focus=<conv>&msg=<id>` (scroll-to-message — the anchor FC chat cards will use).
- **Cross-page links out**: rail → `/contacts?id=` · `/orders?focus=` · `/quotes?q=` (all existing pages' own deep-link grammar; nothing re-implemented).
- **Links in**: quotes/orders pages already deep-link back via `conversationId` → `?focus=` (exists); FC spaces will use the same.
- **localStorage**: `factory.inbox.paneWidths` (exists) · ★`.collapsed` · ★`.composerHeight` · sessionStorage SSE cursor (exists).

---

## §6 Schema & RBAC summary

All additive (live-server rule): `InboxView`, `InboxViewOverride`, `InboxRule`, `MessageTemplate`, `OutboundQueue`, `ConversationRead`, + nullable cols (Message OOO flag, follow-up mode, attachment dims). New permissions: `inbox.views.manage`, `inbox.templates.manage` (WORKER gets neither; consumption rides `pages.inbox`). Money in rail cards grain-gated; thread export calls `stripFinancials` explicitly (exporter rule).

## §7 Acceptance targets (page gate, on top of per-phase specs)

- FS0 harness re-run: list + thread + every view bounded and fast at 50k-order scale (`check:query-bounds` green; views add no unbounded query).
- Design law: single type scale (13/12.5/11.5), Inter everywhere, symmetric insets — verified numerically headless at 1512/1728/1920 + the 1280 collapse.
- Zero-defect visuals: §1c fully closed; screenshot-diff pass before the Owner sees anything.
- Keyboard: full 5.12 grammar works; `?` overlay documents it.
- No live sends in automation (outbound queue tested with a fake transport, like FP8's FakeCarrier); MIME builder unit-tested; Owner exercises one real send per gate.

## §8 Owner decisions — RESOLVED 2026-07-16 ("Approved, proceed with your recommendations")

1. Six-phase plan **approved**; phases run 1→6 as recommended.
2. Undo-send default **10s** (5/10/20/30 configurable in Settings).
3. Views = **Owner-defined shared** (workers consume; personal views later).
4. Translation: slot stays in EPI.4 but **dormant until the Owner provides a DeepL API Free key** — no external account is created on the Owner's behalf.

## §9 Out of scope (named, not silent)

SLA countdown chips (defer; revisit post-EPI) · open-tracking pixels (IGNORE — MPP-poisoned, needs public infra) · in-app Office rendering (card + Drive path instead) · WhatsApp channel (FD5/FP11 decision stands) · thread split/merge (backlog; irreversible in every product surveyed — wants its own spec) · multi-channel timeline (schema stays open) · live co-edited shared drafts (FS2+FS4 territory) · Gmail Pub/Sub push (backlog stands) · @mention autocomplete (FS3 delivers; inbox consumes).
