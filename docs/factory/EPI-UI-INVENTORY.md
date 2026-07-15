# EPI — Total UI Inventory: Factory OS `/inbox`

As-built inventory of the FP1 inbox page (`apps/factory/src/app/(app)/inbox/`), read from code on 2026-07-11 for the Enterprise Program EPI gate (ENTERPRISE-PROGRAM.md rule 2). Every surface, control, wiring chain, and navigation edge below was traced from source — file paths are relative to `apps/factory/` unless absolute; line numbers are as of commit tree at inventory time. The page is a single client workspace (`page.tsx:4` renders `InboxClient`) of three resizable panes: ConversationList | ThreadPane | ContextRail, deep-linked via `?focus=<conversationId>`.

## 1. Surface census

| # | Surface | Kind | Component file | Shown when |
|---|---------|------|----------------|------------|
| 1 | Workspace grid (3 panes + 2 handles) | pane container | `src/app/(app)/inbox/_components/InboxClient.tsx:290-333` | always (Suspense fallback `null` during first params read, `InboxClient.tsx:339`) |
| 2 | Conversation list pane | pane | `ConversationList.tsx:68-234` | always |
| 3 | State tab bar (Open / Snoozed / Closed / All, live counts) | tab bar | `ConversationList.tsx:71-98` | always (count badge only when count > 0; "All" never shows a count) |
| 4 | Search + Mine + Unmatched filter row | toolbar | `ConversationList.tsx:99-136` | always |
| 5 | Conversation row (subject, ago, snippet, party/unmatched pill, assignee, snooze hint, follow-up hint, checkbox) | list row | `ConversationList.tsx:149-208` | per item; focus wash when `id === focusId`, cursor inset bar when `id === cursorId` |
| 6 | List skeleton (4× `Skeleton`) | skeleton | `ConversationList.tsx:140-143` | `loading && !items.length` |
| 7 | List empty state | empty-state | `ConversationList.tsx:144-147` | zero items; copy variant A "Nothing matches these filters." when `q || mine || unmatched`, variant B "Synced and quiet — new mail lands here within ~10s." otherwise |
| 8 | Load more button row | button row | `ConversationList.tsx:210-214` | `data.nextCursor != null` (server returned page of 60 with more) |
| 9 | Freshness line (sync footer) | banner (footer line) | `ConversationList.tsx:217-221` | always; variant A "Mail synced \<ago\> ago · label \<name\>" when `sync.status === "connected"`, variant B "Gmail not connected — Settings › Integrations" (plain text, NOT a link) |
| 10 | Bulk action bar | bulk bar (`BulkActionBar` pattern) | `ConversationList.tsx:223-232` | `selected.size > 0` |
| 11 | Pane handle ×2 (list/thread and thread/rail separators) | drag handle | `InboxClient.tsx:30-95` (rendered `:325`, `:329`) | always; highlight bar widens while dragging |
| 12 | Thread pane | pane | `ThreadPane.tsx:118-267` | always (occupies middle column) |
| 13 | Thread header (subject + state Pill + images toggle) | header bar | `ThreadPane.tsx:120-157` | thread loaded |
| 14 | "Load remote images" / "Images loaded" toggle pair | toggle button (2 visual states) | `ThreadPane.tsx:135-156` | `hasHtml` — any message `bodyHtml` matches `/<img/i` (`ThreadPane.tsx:116`); resets to blocked on conversation switch (`ThreadPane.tsx:43-48`) |
| 15 | Timeline (merged messages + comments + audit events) | scroll region | `ThreadPane.tsx:159-193` | thread loaded; auto-scrolls to bottom on length/conversation change (`ThreadPane.tsx:62-64`) |
| 16 | Message bubble (header, sandboxed iframe or plain text body, attachment chip row) | timeline card | `MessageBubble.tsx:65-149` | per message; outbound = primary wash + "You", inbound = surface + fromAddress; attachment row only when `attachments.length > 0` |
| 17 | Internal comment bubble (amber, Lock icon, "Internal — never sent") | timeline card | `ThreadPane.tsx:168-186` | per comment on the conversation |
| 18 | Audit event line (centered grey "actor did X · ago") | timeline line | `ThreadPane.tsx:187-191` | per audit row, except actions `comment.created` and `replied` which are filtered out (`ThreadPane.tsx:56`) |
| 19 | Thread skeleton (3× `Skeleton`) | skeleton | `ThreadPane.tsx:99-107` | `loading && !thread` |
| 20 | Thread empty state ("Select a conversation — j/k to move, Enter to open.") | empty-state | `ThreadPane.tsx:108-114` | no `?focus=` / thread null |
| 21 | Composer (Reply \| Internal comment segmented control, amber tint + hint in comment mode, textarea, attached-file chips, Attach, ⌘⏎ hint, Send/Add note) | composer | `ThreadPane.tsx:195-266` | thread loaded; whole block background flips amber in comment mode (`ThreadPane.tsx:195`); clears on conversation switch (`ThreadPane.tsx:43-48`) |
| 22 | Context rail | pane | `ContextRail.tsx:87-214` | thread loaded; **returns `null` when no conversation** (`ContextRail.tsx:48`) — right column renders empty |
| 23 | Contact card — matched state (name, kind pill, emails ± "matches @domain", Terms, Price list, notes) | card | `ContextRail.tsx:89-113` | `conversation.party != null`; Terms row grain-gated (see §2) |
| 24 | Contact card — unmatched state (info Banner "Unmatched sender" + create button) | card + banner | `ContextRail.tsx:139-161` | no party, not creating |
| 25 | Contact card — create-contact flow (INLINE form, not a modal: sender line, Name input, Kind listbox, Match-domain checkbox, Create & link / Cancel) | inline form | `ContextRail.tsx:114-138` | no party and `creating === true`; resets on conversation switch (`ContextRail.tsx:42-46`) |
| 26 | Conversation card (Assignee listbox, Close/Reopen, Snooze-until DateField + helper text, Follow-up DateField + helper text) | card | `ContextRail.tsx:164-208` | always (when rail shown) |
| 27 | Quotes card (linked quote rows, New quote / Another quote, or match-first hint) | card | `ContextRail.tsx:210-212`, `ContextRail.tsx:238-263` | always (when rail shown); rows only when quotes exist |
| 28 | Toasts (full census) | toast | via `useToast()` | ① thread load failure — danger (`InboxClient.tsx:203`); ② bulk result "N closed/reopened · M failed" — success/warning (`InboxClient.tsx:239`); ③ bulk error — danger (`InboxClient.tsx:243`); ④ "Snoozed until tomorrow 08:00 — replies un-snooze it" — info, keyboard `s` (`InboxClient.tsx:278`); ⑤ "Sent — it threads in Gmail too" — success (`ThreadPane.tsx:87`); ⑥ composer submit error — danger (`ThreadPane.tsx:93`); ⑦ rail patch error — danger (`ContextRail.tsx:58`); ⑧ "Contact created — N threads linked"/"Contact created and linked" — success (`ContextRail.tsx:71-75`); ⑨ contact create error — danger (`ContextRail.tsx:79`); ⑩ "Saved to Drive"/"Saved" — success (`MessageBubble.tsx:57`); ⑪ save-to-drive error — danger (`MessageBubble.tsx:59`); ⑫ new-quote error — danger (`ContextRail.tsx:232` via `onToast`) |

No modals or drawers exist on this page. The create-contact flow is inline in the rail card (surface 25).

## 2. Control census

Wire-chain format: `handler → METHOD /api/path (permission) → service/lib fn → DB writes → events published → notifications → audit action`.

### 2a. Conversation list pane

| Control | Kind | Handler | Wire chain |
|---|---|---|---|
| Tab: Open/Snoozed/Closed/All | button ×4 | `ConversationList.tsx:79` → `setState` prop (`InboxClient.tsx:308`) | client state → re-derives `listUrl` → GET `/api/inbox?state=…` (pages.inbox) → Prisma reads only (Conversation+party+assignee+last message, groupBy counts, GoogleConnection) → no writes/events |
| Search input | field | `ConversationList.tsx:115` → `setQ`; debounced 250 ms (`InboxClient.tsx:160-163`) | GET `/api/inbox?…&q=` (pages.inbox) — LIKE on subject / party.name / message fromAddress (`api/inbox/route.ts:26-34`); read-only |
| Mine | toggle button | `ConversationList.tsx:122` | GET `/api/inbox?mine=1` — filters `assigneeId = actor.id` (`api/inbox/route.ts:24`); read-only |
| Unmatched | toggle button | `ConversationList.tsx:130` | GET `/api/inbox?unmatched=1` — filters `partyId: null`; read-only |
| Row click (open thread) | row/link | `ConversationList.tsx:156` → `onOpen` → `open()` `InboxClient.tsx:228-230` | client-only: `history.replaceState` to `/inbox?focus=<id>` → effect `InboxClient.tsx:211-214` → GET `/api/inbox/<id>` (pages.inbox) → **GET has writes**: `ensureBodies()` (`api/inbox/[id]/route.ts:30`) → Gmail `messages.get format=full` → Message.bodyHtml/bodyText/rfcMessageId update + Attachment create/update (`gmail-body.ts:68-89`); no events/notifications/audit |
| Row checkbox | checkbox | `ConversationList.tsx:170` (`stopPropagation` wrapper `:169`) | client-only (selection Set) |
| Load more | button | `ConversationList.tsx:212` → `onLoadMore` → `loadList({append})` `InboxClient.tsx:321` | GET `/api/inbox?…&cursor=<lastId>` (pages.inbox); read-only (60/page, `api/inbox/route.ts:12`) |
| Bulk: Close | button (disabled while `busyBulk`) | `ConversationList.tsx:225` → `bulk("close")` `InboxClient.tsx:232-247` | POST `/api/inbox/bulk` (inbox.assign) → per-id `Conversation.update {state:CLOSED, snoozeUntil:null}` → `publishEventDurable("conversation.updated",{bulk:true})` once (`api/inbox/bulk/route.ts:47`) → no notifications → audit `state.changed` per id (`:36-40`) |
| Bulk: Reopen | button (disabled while `busyBulk`) | `ConversationList.tsx:228` | same as Close with `{state:OPEN, snoozeUntil:null}` |
| Bulk: clear selection (✕ on bar) | button | `ConversationList.tsx:224` `onClear` | client-only (empties Set) |

### 2b. Pane handles (InboxClient)

| Control | Kind | Handler | Wire chain |
|---|---|---|---|
| Drag list/thread handle | pointer drag | `PaneHandle` `InboxClient.tsx:50-74` → `resizeList` `:140-143` | client-only; commit persists `localStorage["factory.inbox.paneWidths"]` (`:132-138`); clamp 280–640 px |
| Drag thread/rail handle | pointer drag | `resizeRail` `InboxClient.tsx:145-149` (delta inverted) | client-only; same persistence; clamp 240–520 px |
| Double-click either handle | dblclick | `onReset` → `resetWidths` `InboxClient.tsx:151-156` | client-only; resets 360/300 and persists |

### 2c. Keyboard shortcuts (global listener `InboxClient.tsx:250-288`; inert while typing in input/textarea/select/contentEditable or with meta/ctrl/alt)

| Key | Kind | Handler | Wire chain |
|---|---|---|---|
| `j` / `k` | key | `InboxClient.tsx:256-262` | client-only: moves cursor index, `scrollIntoView` on `[data-row]` |
| `Enter` | key | `InboxClient.tsx:263-265` | client-only: `open(items[cursorIdx].id)` → replaceState `?focus=` → thread GET as above |
| `Escape` | key | `InboxClient.tsx:266-267` | client-only: replaceState to `/inbox` (closes thread; effect nulls thread state) |
| `e` (toggle closed) | key | `InboxClient.tsx:268-270` | PATCH `/api/inbox/<focusId>` `{state: CLOSED↔OPEN}` (inbox.assign) → `Conversation.update` → event `conversation.updated` → audit `state.changed` → no notification. **No `.catch`** — failure (e.g. 403) is a silent unhandled rejection; no success toast |
| `s` (snooze tomorrow 08:00) | key | `InboxClient.tsx:271-280` | PATCH `/api/inbox/<focusId>` `{snoozeUntil}` (inbox.assign) → sets `state=SNOOZED` implicitly (`api/inbox/[id]/route.ts:94-97`) → `Conversation.update` → event `conversation.updated` → audit `state.changed` → toast ④. **No `.catch`** |
| `r` (focus composer) | key | `InboxClient.tsx:281-284` | client-only: `composerRef.current?.focus()` |
| `⌘/Ctrl+Enter` (in composer textarea) | key | `ThreadPane.tsx:215-220` | invokes `submit()` — same chain as Send button below |

(⌘K opens the app-wide command palette — an inbound nav edge, listed in §3b, not an inbox-owned control.)

### 2d. Thread pane

| Control | Kind | Handler | Wire chain |
|---|---|---|---|
| Load remote images / Images loaded | toggle button | `ThreadPane.tsx:138` | client-only: flips `allowImages` → `MessageBubble` rebuilds iframe `srcDoc` with CSP `img-src https: data: cid:` instead of `'none'` (`MessageBubble.tsx:18-27`) |
| Reply \| Internal comment | segmented control | `ThreadPane.tsx:197-204` | client-only (mode state; recolors composer, swaps placeholder/button label, hides Attach in comment mode) |
| Composer textarea | field | `ThreadPane.tsx:211-233` | client-only until submit |
| Attach | button (reply mode only) | `ThreadPane.tsx:256` → opens hidden `<input type=file multiple>` `:249-255` | client-only (appends to `files` state) |
| File chip ✕ (remove attachment) | button | `ThreadPane.tsx:239` | client-only (filters `files`) |
| Send reply | button — **disabled until `text.trim()` non-empty and not `busy`** (`ThreadPane.tsx:262`) | `submit()` `ThreadPane.tsx:66-97` (reply branch) | `apiFetch` → POST `/api/inbox/<id>/reply` multipart (inbox.send) → `ensureBodies` (rfcMessageId), `buildReplyMime`/`replySubject` (`google/mime.ts:36,29`), Gmail `users.messages.send{threadId}` → `Message.create` (OUTBOUND, `textToHtml` body — `sanitize-email.ts:92`), `Conversation.update {lastMessageAt, lastMessageDirection:OUTBOUND}` (`api/inbox/[id]/reply/route.ts:85-99`) → event `conversation.updated` → no notification → audit `replied`. 400 if no body / not a Gmail conversation / nothing inbound to reply to; 413 over 15 MB total (`:21,35-39`) |
| Add note (comment mode) | button — same disabled rule | `submit()` `ThreadPane.tsx:70-79` (comment branch) | POST `/api/comments` `{entityType:"conversation", entityId, body, href:"/inbox?focus=<id>"}` (comments.create) → `createComment` (`lib/comments.ts:38-77`) → `Comment.create` (mentions resolved via `resolveMentions` `:14-36`) → event `comment.created` → notification `MENTION` per mentioned user ≠ author (`:63-74`) → audit `comment.created` |

### 2e. Message bubble (per message)

| Control | Kind | Handler | Wire chain |
|---|---|---|---|
| Attachment download link | link (`<a href>`) | `MessageBubble.tsx:119-127` | browser GET `/api/inbox/<convId>/attachments/<attId>` (pages.inbox) → ownership check → serve `Attachment.localPath` or fetch bytes from Gmail (`fetchAttachmentBytes`, volatile-id retry `gmail-body.ts:102-139`) → **writes**: file cached under `data/attachments/<attId>/` + `Attachment.update {localPath}` (`api/inbox/[id]/attachments/[attId]/route.ts:27-35`); streams with `Content-Disposition: attachment`; no events/audit |
| "Drive" (save to Drive) | button (disabled while saving; only when `att.webViewLink == null`) | `saveToDrive` `MessageBubble.tsx:50-63,133-143` | POST `…/attachments/<attId>/save-to-drive` (pages.inbox) → Drive folder ensure (per-party, cached in `AppSetting["drive.folders"]`), Drive file upload → `Attachment.update {driveFileId, webViewLink}` (`api/inbox/[id]/attachments/[attId]/save-to-drive/route.ts:44-76`) → no event → no notification → audit `attachment.saved_to_drive` (`:77-80`). Short-circuits `{existing:true}` without audit if already saved (`:29-31`). 400 when Google not connected / Drive root missing |
| "in Drive" | link (only when `att.webViewLink` set) | `MessageBubble.tsx:128-131` | client-only nav: `window` target `_blank` to Google Drive `webViewLink` |
| Links inside email HTML | link (inside sandboxed iframe) | sanitizer forces `target="_blank" rel="noopener noreferrer"` (`sanitize-email.ts:83`); iframe sandbox `allow-popups allow-popups-to-escape-sandbox` (`MessageBubble.tsx:93`) | client-only nav to external URL in new tab; scripts/forms stripped at write time |

### 2f. Context rail — Contact card

| Control | Kind | Handler | Wire chain |
|---|---|---|---|
| Create contact from sender | button — **disabled when no inbound sender** (`ContextRail.tsx:155`) | `ContextRail.tsx:148-154` | client-only: pre-fills Name from email local-part (title-cased), enters inline create flow |
| Name | field | `ContextRail.tsx:117` | client-only until submit |
| Kind (Customer / Brand (B2B) / Supplier) | listbox | `ContextRail.tsx:118-127` | client-only until submit |
| Match everyone @domain | checkbox | `ContextRail.tsx:128-131` | client-only until submit |
| Create & link | button — **disabled until `name.trim()` or while busy** (`ContextRail.tsx:133`) | `createParty` `ContextRail.tsx:64-83` | POST `/api/inbox/<id>/link-party` `{create:{name,kind,matchDomain}}` (contacts.manage) → `Party.create` + `PartyEmail.create {email, matchDomain}` → `Conversation.update {partyId}` → back-match: `Conversation.updateMany` on every other unmatched conversation whose last inbound sender matches email/domain (`api/inbox/[id]/link-party/route.ts:84-112`) → `clearPartyEmailCache()` (sync matcher cache) → event `conversation.updated` → no notification → audit `created` (party) + `party.linked` (conversation) → toast ⑧ with linked count |
| Cancel | button | `ContextRail.tsx:136` | client-only (exits create flow) |
| Terms row (`paymentTerms`) | display (grain-gated) | `ContextRail.tsx:102-106` | field stripped server-side by `jsonStripped`/`stripFinancials` for callers without `financials.suppliers.view` (`lib/auth/strip-financials.ts:16`); UI tests `"paymentTerms" in party` and the row simply vanishes |

(The API also accepts `{partyId}` to link an *existing* party and teach it the sender email — `api/inbox/[id]/link-party/route.ts:49-60` — but no control on this page sends that shape; see §6.)

### 2g. Context rail — Conversation card

All four controls call `patch()` (`ContextRail.tsx:52-62`) → PATCH `/api/inbox/<id>` (**inbox.assign** for every field) → `Conversation.update` → event `conversation.updated` (`api/inbox/[id]/route.ts:140`) → error toast ⑦ on failure.

| Control | Kind | Handler | Wire chain specifics |
|---|---|---|---|
| Assignee | listbox (options from `/api/users-lite`; disabled while busy) | `ContextRail.tsx:168-174` | `{assigneeId | null}` → audit `assigned` → notification `ASSIGNMENT` to new assignee when set and ≠ actor (`api/inbox/[id]/route.ts:112-125`), href `/inbox?focus=<id>` |
| Close — work done / Reopen | button pair (Close when state ≠ CLOSED, Reopen when CLOSED; disabled while busy) | `ContextRail.tsx:177-185` | `{state}` → also nulls `snoozeUntil` (`:100`) → audit `state.changed` → no notification |
| Snooze until | date field (min = tomorrow) | `ContextRail.tsx:189-194` | set: `{snoozeUntil: <date>T08:00 local}` → forces `state=SNOOZED` (`:96`) → audit `state.changed`; clear: `{snoozeUntil: null}` → **state is NOT reset** (see §5/§6) |
| Follow-up reminder | date field (min = tomorrow) | `ContextRail.tsx:199-204` | `{followUpAt | null}` → audit `followup.set` / `followup.cleared` → no notification (the worker fires the reminder later) |

### 2h. Context rail — Quotes card

| Control | Kind | Handler | Wire chain |
|---|---|---|---|
| Quote row | button | `ContextRail.tsx:243` | client-only nav: `router.push("/quotes?q=<quoteId>")`; margin % suffix rendered only when `usePermission("financials.margins.view")` (`ContextRail.tsx:220,249`) |
| New quote / Another quote | button — **rendered only with `quotes.create` permission** (`ContextRail.tsx:219,255`); **replaced by hint text "Match this thread to a contact first, then quote them." when no party** (`:259`); disabled while busy | `newQuote` `ContextRail.tsx:226-236` | POST `/api/quotes` `{partyId, conversationId}` (quotes.create) → `Quote.create` (number via `nextNumber`, deposit/validity/promise defaults) (`api/quotes/route.ts:58-80`) → **no event published** → no notification → audit `created` (quote) → then `router.push("/quotes?q=<id>")` |

## 3. Navigation edges

### 3a. OUT of /inbox

| Trigger | Target + param grammar | Mechanism | Source |
|---|---|---|---|
| Quote row click | `/quotes?q=<quoteId>` | `router.push` | `ContextRail.tsx:243` |
| New quote success | `/quotes?q=<newQuoteId>` | `router.push` | `ContextRail.tsx:231` |
| Attachment filename/icon | `/api/inbox/<convId>/attachments/<attId>` (file download, same tab, `Content-Disposition: attachment`) | `<a href>` | `MessageBubble.tsx:120` |
| "in Drive" | Google Drive `webViewLink` (external, `_blank`) | `<a target="_blank">` | `MessageBubble.tsx:129` |
| Links inside email bodies | arbitrary external URL (`_blank`, noopener; sandbox-escaping popup) | sanitizer-transformed `<a>` inside iframe | `sanitize-email.ts:83`, `MessageBubble.tsx:93` |
| (Not an edge) Escape / row open | `history.replaceState` within `/inbox` — no router navigation; browser Back leaves the page entirely | `InboxClient.tsx:229,267` | — |

App-shell chrome (rail nav, palette, bell) is present on the page and leads anywhere, but is shared chrome, not inbox-owned.

### 3b. IN to /inbox (every `"/inbox"` / `?focus=` reference in `src/`)

| Origin | Link | Source |
|---|---|---|
| Root redirect | `/` → `/inbox` | `src/app/page.tsx:5` |
| Login success (default) | `?next=` param or `/inbox` | `src/app/login/page.tsx:37` |
| Shell rail nav item "Inbox" (permission-filtered on `pages.inbox`) | `/inbox` | `src/lib/nav.ts:35` via `FactoryShell.tsx:62-69` |
| Command palette (⌘K/Ctrl+K): pages group | `/inbox` | `CommandPalette.tsx:29,53` |
| Command palette: conversation search hits | `/inbox?focus=<conversationId>` | `src/app/api/search/route.ts:101` (consumed `CommandPalette.tsx:64`) |
| Notification bell drawer items (href from Notification.href) | `/inbox?focus=<id>` | `NotificationBell.tsx:108`; hrefs minted at `api/inbox/[id]/route.ts:122` (assignment), `lib/google/gmail-sync.ts:144` (new reply/reopen), `worker/index.ts:85,118` (snooze wake, follow-up), `ThreadPane.tsx:77` → `lib/comments.ts:70` (mention) |
| Analytics "Unanswered threads" counter | `/inbox` | `analytics/_components/AnalyticsClient.tsx:76` (count = OPEN + `lastMessageDirection: INBOUND`, `api/analytics/counters/route.ts:20`) |
| Contact detail → Conversations tab rows | `/inbox?focus=<id>` | `contacts/_components/ContactHistory.tsx:52` |
| Order detail header "thread" link | `/inbox?focus=<id>` | `orders/_components/OrderDetail.tsx:131` |
| Order timeline "Email —" entry | `/inbox?focus=<id>` | `lib/orders/timeline.ts:50` |

## 4. Data & event wiring

### 4a. API routes the page calls

| Route | Method | Permission | Reads | Writes | Events published |
|---|---|---|---|---|---|
| `/api/inbox` | GET | `pages.inbox` | Conversation (+party, assignee, last message), groupBy state counts, GoogleConnection sync status | — | — |
| `/api/inbox/[id]` | GET | `pages.inbox` | Conversation (+party.emails, priceList), Message+Attachment, Comment, AuditLog (≤200), Quote (+lines, per-conversation) | side effect via `ensureBodies`: Message.bodyHtml/bodyText/rfcMessageId, Attachment create/update | — |
| `/api/inbox/[id]` | PATCH | `inbox.assign` | Conversation | Conversation.assigneeId/state/snoozeUntil/followUpAt | `conversation.updated`; notify `ASSIGNMENT`; audit `assigned`/`state.changed`/`followup.set|cleared` |
| `/api/inbox/[id]/reply` | POST | `inbox.send` | Conversation, last inbound Message, GoogleConnection | Gmail send (external); Message.create; Conversation.lastMessageAt+lastMessageDirection | `conversation.updated`; audit `replied` |
| `/api/inbox/bulk` | POST | `inbox.assign` | — | Conversation.state/snoozeUntil (or assigneeId) per id, ≤200 ids | `conversation.updated {bulk:true}` once; audit per id |
| `/api/inbox/[id]/link-party` | POST | `contacts.manage` | Conversation, last inbound Message, Party, unmatched Conversations | Party.create / PartyEmail.upsert; Conversation.partyId (+updateMany back-match) | `conversation.updated`; audit `created`(party), `party.linked` |
| `/api/inbox/[id]/attachments/[attId]` | GET | `pages.inbox` | Attachment (+message ownership) | file cache + Attachment.localPath | — |
| `…/save-to-drive` | POST | `pages.inbox` | Attachment, GoogleConnection, AppSetting `drive.folders` | Drive folder/file (external); AppSetting upsert; Attachment.driveFileId/webViewLink | audit `attachment.saved_to_drive` |
| `/api/comments` | POST | `comments.create` | User (mention resolution) | Comment.create | `comment.created`; notify `MENTION` per mention; audit `comment.created` |
| `/api/users-lite` | GET | `comments.create` | active Users | — | — |
| `/api/quotes` | POST | `quotes.create` | Party, AppSetting lead time | Quote.create | — (no event); audit `created` |
| `/api/events` | GET (SSE) | `pages.production` | FactoryEventOutbox (shared 1 s poller + id-based replay) | — | — |

All list/thread GET responses pass through `jsonStripped` → `stripFinancials` (`lib/auth/guard.ts:76-77`), which deletes cost/margin/`paymentTerms` fields per the caller's grains.

### 4b. SSE events consumed

| Hook call | Types | Debounce | Refresh action |
|---|---|---|---|
| `InboxClient.tsx:221-223` `useFactoryEvents` | `conversation.synced`, `conversation.updated`, `comment.created` (plus implicit `resync` — every subscriber fires, `use-factory-events.ts:45`) | 1500 ms | `refresh()`: quiet list reload + quiet thread reload of current focus (`InboxClient.tsx:216-219`) |

One multiplexed `EventSource` per tab (`use-factory-events.ts:57-81`), resume via `?sinceId=` from `localStorage["factory.events.lastId.v2"]` + native Last-Event-ID.

### 4c. Events PUBLISHED that affect this page

| Event | Publisher(s) |
|---|---|
| `conversation.updated` | PATCH thread (`api/inbox/[id]/route.ts:140`), reply (`reply/route.ts:108`), bulk (`bulk/route.ts:47`), link-party (`link-party/route.ts:115`) |
| `conversation.synced` | worker sync: `backfillLabel` `{backfill:true, more}` (`gmail-sync.ts:238`), `incrementalSync` `{synced}` when > 0 (`gmail-sync.ts:289`) |
| `comment.created` | `createComment` (`lib/comments.ts:75`) |
| `notification.created` (bell, not inbox panes) | every `notify()` (`lib/notifications.ts:21`) — user-scoped delivery |

All publishing goes through the durable outbox (`lib/events.ts:174-189`; `publishEvent` is a durable alias `:195-197`), so worker-process events reach web SSE clients.

### 4d. Worker ticks that mutate inbox state (`worker/index.ts`)

| Tick | Cadence | Mutation | Events / notifications / audit |
|---|---|---|---|
| Gmail poll → `incrementalSync` | 10 s (`:22,183`) | `upsertMessage`: Conversation upsert (subject, lastMessageAt, lastMessageDirection, party auto-match), Message.create; on NEW inbound: CLOSED→OPEN, SNOOZED/snoozeUntil→OPEN+null, followUpAt→null (`gmail-sync.ts:111-132`) | event `conversation.synced`; audit `reopened`/`unsnoozed`/`followup.autocancelled` (`:129-131`); notify assignee `STATE_CHANGE` "Reopened by a reply"/"New reply" (`:133-146`); on historyId 404: audit `gmail.resync.triggered` + `SYSTEM` notify to OWNERs (`:297-311`) |
| Inbox tick — snooze wake | 60 s (`:21,183`) | SNOOZED with `snoozeUntil <= now` → `{state:OPEN, snoozeUntil:null}` (`:69-77`) | **no event, no audit**; notify assignee `REMINDER` "Back from snooze" (`:78-88`) — `notify()` publishes only `notification.created` |
| Inbox tick — follow-up due | 60 s | `followUpAt <= now` → `{followUpAt:null}` (`:90-96`) | **no event, no audit**; notify assignee `REMINDER` "Follow up:", falling back to first OWNER when unassigned (`:97-121`) |
| Inbox tick — outbox prune | 60 s | `FactoryEventOutbox.deleteMany` older than 10 min (`:123-125`) | — |

### 4e. localStorage / sessionStorage keys

| Key | Store | Written by | Content |
|---|---|---|---|
| `factory.inbox.paneWidths` | localStorage | `InboxClient.tsx:21,132-138` | `{list:number, rail:number}` px, clamped on read |
| `factory.events.lastId.v2` | localStorage (app-wide, used here) | `use-factory-events.ts:15,33-41` | last delivered outbox id (SSE resume cursor) |

No sessionStorage use in the inbox tree.

### 4f. URL param grammar

| Param | Grammar | Behavior |
|---|---|---|
| `?focus=<conversationId>` | cuid | opens the thread; set/cleared via `history.replaceState` (`InboxClient.tsx:229,267`), read via `useSearchParams` (`:158`); minted by 6 external origins (§3b) |
| `/api/inbox` query | `state=open|snoozed|closed|all`, `mine=1`, `unmatched=1`, `q=<text>`, `cursor=<id>` | list filters — never mirrored into the page URL (filter state is not deep-linkable) |
| `/login?next=/inbox…` | any path | post-login destination |

## 5. State machines

### Conversation state (`ConversationState`: OPEN / SNOOZED / CLOSED — `prisma/schema.prisma:250-254`)

| Edge | Trigger(s) |
|---|---|
| OPEN → CLOSED | rail "Close — work done" (`ContextRail.tsx:178`); keyboard `e` (`InboxClient.tsx:268`); bulk Close (`bulk/route.ts:31`) — all null `snoozeUntil` |
| CLOSED → OPEN | rail "Reopen" (`ContextRail.tsx:182`); keyboard `e`; bulk Reopen; **sync reopen-on-inbound-reply** (`gmail-sync.ts:114-117`, audit `reopened`, assignee notified) |
| OPEN → SNOOZED | rail Snooze DateField (PATCH `snoozeUntil` forces state, `api/inbox/[id]/route.ts:94-97`); keyboard `s` (tomorrow 08:00). PATCH `{state:SNOOZED}` without a date is rejected 400 "Snoozing needs a wake date" (`:101-103`) |
| SNOOZED → OPEN | worker wake when `snoozeUntil <= now` (`worker/index.ts:69-77`, no audit/event); **inbound reply un-snoozes** (`gmail-sync.ts:118-122`, audit `unsnoozed`); rail Close then Reopen; bulk open |
| SNOOZED → CLOSED | rail Close / keyboard `e` / bulk Close (snoozeUntil nulled) |
| (stuck edge) SNOOZED → SNOOZED, no wake date | clearing the Snooze DateField sends `{snoozeUntil:null}` which nulls the date but does NOT change state (`api/inbox/[id]/route.ts:94-97` has no else-branch) — the worker's wake query (`state:SNOOZED AND snoozeUntil <= now`) never matches null, so only a reply or manual Close/Reopen rescues it |

Follow-up sub-machine: set/cleared by rail DateField (audit `followup.set`/`followup.cleared`); auto-cancelled by any new inbound message (`followup.autocancelled`, `gmail-sync.ts:123-126`); consumed (nulled) by the worker when due, with `REMINDER` notification.

### Timeline ordering rule

ONE merged timeline (`ThreadPane.tsx:50-60`): messages keyed by `sentAt`, comments by `createdAt`, conversation AuditLog rows by `createdAt`, sorted ascending by epoch; audit actions `comment.created` and `replied` are excluded (their message/comment card is the record). Message direction renders as bubble alignment/wash only ("You" vs fromAddress, `MessageBubble.tsx:43,84`); comments render amber with "Internal — never sent"; remaining audit rows render as centered system lines labeled via `EVENT_LABELS` (`types.ts:104-116`).

## 6. Gaps ledger (facts observed while reading; no proposals)

1. **Worker mutations are invisible to open tabs and to the timeline.** Snooze wake and follow-up firing (`worker/index.ts:69-121`) write no AuditLog row and publish no `conversation.updated` — the list/thread do not live-refresh on wake, and the `EVENT_LABELS` entry `unsnoozed` can only ever come from the sync path.
2. **Clearing a snooze date strands the conversation in SNOOZED with no wake date** (`api/inbox/[id]/route.ts:94-97`; UI sends `snoozeUntil:null` from `ContextRail.tsx:193`). It disappears from Open and the worker can never wake it.
3. **Bulk `assign` is server-wired but unreachable** — `bulk/route.ts:14` accepts `action:"assign"`; the bulk bar exposes only Close/Reopen (`ConversationList.tsx:225-230`).
4. **Link-existing-party is server-wired but unreachable** — `link-party/route.ts:49-60` handles `{partyId}` (and teaches the party the sender email); the rail only offers the create flow.
5. **Keyboard `e` and `s` have no error handling** (`InboxClient.tsx:270,276`) — a 403 for a `pages.inbox`-only user (both PATCH paths require `inbox.assign`) or any failure is an unhandled promise rejection with no toast; `e` also has no success feedback.
6. **`e` can mis-toggle before the thread loads** — it reads `thread?.conversation.state` (`InboxClient.tsx:270`); if the fetch hasn't resolved, the expression evaluates to CLOSED regardless of the actual state.
7. **Rail mutation controls are not permission-gated client-side** — Assignee/Close/Snooze/Follow-up render for users lacking `inbox.assign`, Send reply for users lacking `inbox.send`, the comment composer for users lacking `comments.create`; only the Quotes card checks `usePermission` (`ContextRail.tsx:219-220`). Server 403s surface as danger toasts (or silently, per gap 5).
8. **Tab counts ignore active filters** — `groupBy(["state"])` with no `where` (`api/inbox/route.ts:59`), so Mine/Unmatched/search show global per-state counts; the "All" tab shows no count by construction (`ConversationList.tsx:74`).
9. **List load failures are swallowed** — `loadList` catch keeps the last page silently (`InboxClient.tsx:182-184`); no error surface exists for the list pane.
10. **"Gmail not connected — Settings › Integrations" is plain text, not a link** (`ConversationList.tsx:220`); the empty-state copy "new mail lands here within ~10s" (`:146`) shows even when Gmail is disconnected.
11. **Quote creation publishes no SSE event** (`api/quotes/route.ts:58-81`) — other viewers' Quotes cards stay stale until a `conversation.*` event or manual reload.
12. **Dead code in the inbox tree**: `Banner` imported but unused in `ThreadPane.tsx:11`; `EVENT_LABELS["replied"]` and `["comment.created"]` are unreachable (filtered at `ThreadPane.tsx:56`); `Message.bodyRef` is a schema leftover documented as unused (`schema.prisma:302`).
13. **GET endpoints perform writes**: thread GET runs `ensureBodies` (Message/Attachment updates, `api/inbox/[id]/route.ts:30`); attachment GET writes a disk cache + `Attachment.localPath` (`attachments/[attId]/route.ts:27-35`).
14. **Reply addresses only the last inbound sender** (`reply/route.ts:57-72`) — no CC/multi-recipient despite `buildReplyMime` supporting `cc` (`mime.ts:13`).
15. **Re-saving an already-Drive-saved attachment returns `{existing:true}` without an audit row** (`save-to-drive/route.ts:29-31`).
16. **Filter state is not in the URL** — tab/Mine/Unmatched/search reset on reload or when following a `?focus=` deep link; only `focus` survives.
17. **`history.replaceState` navigation means browser Back never closes the thread** — it leaves `/inbox` entirely (deliberate per comment `InboxClient.tsx:225-227`, Escape is the in-page back).

---

Completeness note: verified by reading every file in `src/app/(app)/inbox/` and every `src/app/api/inbox/**`, `comments`, `users-lite`, `events`, `quotes` (POST) route end-to-end, then grepping the inbox component tree for `onClick|onChange|onKeyDown|onPointer|onDoubleClick|toast(|apiJson|apiFetch|router.|href=|localStorage` and reconciling every hit against §1–§2, and grepping all of `src/` for `"/inbox"` and `focus=` to reconcile §3b — no unlisted control or edge remained.
