# FP1 — Inbox: page-cycle spec (awaiting Owner approval)

Written 2026-07-05 against the F1 foundation (50 real conversations already syncing). This is gate 1 of the FP1 double gate: nothing below is built until the Owner approves. Layout, verdicts and scope come from `F0-IA.md` §1 and `F0-TEARDOWN.md` (Front/Missive + Odoo chatter sections). Canonical once approved.

## Purpose (one sentence)

Turn the already-syncing Gmail threads into the factory's front door: read full conversations, reply from the same thread, assign, comment internally with @mentions, match senders to parties, and run the day from a three-pane workspace that beats Front/Missive for THIS factory.

## Scope

**IN (FP1):** full message bodies + attachments · reply/compose (correct Gmail threading) · assignment · Open/Snoozed/Closed lifecycle with reopen-on-reply · interleaved internal comments (mounts the F1 comment service) · snooze + follow-up reminder that auto-cancels on customer reply · party auto-match + one-click create-party-from-sender + domain matching · context rail with the party card · list filters, search, bulk assign/close · live SSE updates + freshness line · keyboard shortcuts.

**OUT (named, so nobody wonders):** reply-with-quote (FP3 — the configurator doesn't exist yet), linked Quote/Order chips in the rail (FP3/FP4 — the rail reserves the slot), WhatsApp (FD5, FP11), rules engine beyond sender/domain matching (revisit after FP4 with real volume), send-later/sequences/SLA timers (teardown verdicts: IGNORE), templates/snippets (arrives with quoting), FTS5 search upgrade (LIKE is fine at ~50–500 threads).

## Layout (the Front/Missive anatomy, minus their nav pane — our shell rail already is one)

```text
┌─ shell rail ─┬─ CONVERSATION LIST (~360px) ─┬─ THREAD PANE (flex) ──────────┬─ CONTEXT RAIL (300px) ─┐
│ (F1 AppShell)│ toolbar: state tabs          │ subject + state/assignee bar  │ PARTY CARD             │
│              │ (Open·Snoozed·Closed·All)    │ ┌───────────────────────────┐ │  name · kind chip      │
│              │ + filter (Mine·Unmatched)    │ │ message bubbles (sanitized│ │  emails, terms*,       │
│              │ + search                     │ │ HTML, remote images       │ │  price list*, notes    │
│              │ ─────────────────────────    │ │ blocked by default)       │ │  [Create party] when   │
│              │ rows: sender · subject ·     │ │ ● internal comments       │ │  unmatched             │
│              │ snippet · age · chips        │ │   interleaved as visually │ │ ────────────────────   │
│              │ (party/unmatched, assignee,  │ │   distinct bubbles        │ │ CONVERSATION           │
│              │ snooze-until)                │ │ └───────────────────────┘ │ │  assignee picker       │
│              │ bulk bar on selection        │ │ composer: [Reply|Comment] │ │  state + snooze        │
│              │ freshness line (mail synced) │ │ toggle · attach · ⌘Enter  │ │  follow-up reminder    │
│              │                              │                               │ │ LINKED (reserved:     │
│              │                              │                               │ │  "Quotes arrive FP3")  │
└──────────────┴──────────────────────────────┴───────────────────────────────┴────────────────────────┘
```

`*` = financial-grain-gated fields (terms, price list) — absent for roles without `financials.*`.

## Component reuse (design system + F1 primitives — nothing hand-rolled that exists)

| Region | Components |
|---|---|
| List toolbar | DS `Tabs` (states), `Input` (search), `Listbox` (filter), `Pill` (counts) |
| List rows | Custom row on tokens (13px base, hover wash, selected `--h10-wash-primary`) + DS `Checkbox` + `Skeleton` rows while loading |
| Bulk bar | DS `BulkActionBar` (count + Assign/Close/Clear) |
| Thread bubbles | Custom on tokens; sanitized HTML in a sandboxed `<iframe>`; DS `Banner` for blocked-images notice |
| Comments | F1 comment service + new `CommentBubble` (amber-washed, "Internal" tag — Missive's unmistakable-distinction rule) |
| Composer | DS `SegmentedControl` (Reply / Internal comment), `Textarea`, `Button`, `FileDropzone` (attach), `Kbd` hint |
| Context rail | DS `Card`, `Pill`, `Listbox` (assignee), `DateField` (snooze until), `Banner` |
| Empty/error | DS `EmptyState`, `Banner`; freshness = the F1 "mail synced Xs ago" line |
| Live updates | F1 `useFactoryEvents(["conversation.synced","comment.created"])` — debounced list/thread refresh |
| Toasts/confirm | DS `ToastProvider`; destructive-free page (close is reversible) so no confirm modals |

## Data & API

**Schema migration (`fp1_inbox`):**
- `Message.bodyHtml String?` + `Message.bodyText String?` — fetched lazily on first thread open (Gmail `messages.get format=full`), sanitized at WRITE time, cached forever after.
- `PartyEmail.matchDomain Boolean @default(false)` — B2B reality: orders@, sales@, and three humans @brand.it are all the same party. Matcher tries exact email, then domain where flagged.
- `Conversation.followUpAt DateTime?` — the quote-chasing reminder (auto-cancelled by an inbound reply; fired by the worker into the notification bell).

**New/extended API routes (all `guarded()`, all in the coverage script):**

| Route | Permission | Does |
|---|---|---|
| `GET /api/inbox` | `pages.inbox` | List conversations: state/assignee/unmatched filters, LIKE search, cursor pagination |
| `GET /api/inbox/:id` | `pages.inbox` | Thread: messages (bodies lazy-fetched+cached on this call), comments interleaved by timestamp, attachments meta |
| `POST /api/inbox/:id/reply` | `inbox.send` | Send via Gmail (`threadId` + `In-Reply-To`/`References` + Subject — the three threading requirements), attach files, optimistic OUTBOUND insert |
| `PATCH /api/inbox/:id` | `inbox.assign` | Assign / state / snoozeUntil / followUpAt (audited; assignment → notification) |
| `POST /api/inbox/:id/link-party` | `contacts.manage` | Link existing party, or create CUSTOMER/BRAND from sender (+ optional matchDomain) and back-match their other unmatched threads |
| `POST /api/inbox/bulk` | `inbox.assign` | Bulk assign/close (per-row results, the F1 idiom) |
| `GET /api/inbox/:id/attachments/:attId` | `pages.inbox` | Download (Gmail fetch → local cache `data/attachments/`) |
| `POST /api/inbox/:id/attachments/:attId/save-to-drive` | `pages.inbox` | Upload into the party/order folder under the Nexus Factory root (exists ✓) |

**Worker additions:** snooze wake + follow-up firing (minute tick, notification via the F1 service); inbound-on-assigned-thread → notify the assignee.

## Interactions (the ones that make it feel like Missive, cited)

- **Reply vs Internal comment is one composer with a hard toggle** — comments render amber with an "Internal" tag; a mis-send to a brand is unrecoverable, so the two modes look nothing alike (TEARDOWN: Missive ADOPT).
- **Close ≠ archive:** closing marks the WORK done for everyone; an inbound reply reopens to the previous assignee (Missive close-vs-archive ADOPT). No per-person archive state.
- **Snooze hides from Open until a date; any inbound reply un-snoozes AND cancels the follow-up reminder** (Front/Missive discard-on-reply ADOPT — kills the double-chase).
- **Unmatched sender → one click:** "Create party" pre-filled from the From header (name guess + email), kind picker CUSTOMER/BRAND, optional "match everyone @domain"; on save, every other unmatched thread from that sender/domain links instantly.
- **Odoo chatter timeline:** domain events (assigned, closed, snoozed, party-linked) render inline between messages/comments as one-line entries — one narrative, not two silos (Odoo `tracking=True` ADOPT + monday ADAPT).
- **Keyboard:** `j/k` next/prev conversation · `Enter` open · `e` close · `s` snooze · `r` focus reply · `⌘Enter` send · `Esc` back to list. (⌘K global palette already exists.)
- **Remote images blocked by default** with a per-conversation "Load images" button (tracking-pixel hygiene; sanitized HTML in a sandboxed iframe, scripts/forms stripped at ingest — this is the page's security boundary and gets tests).

## States

- **Loading:** skeleton rows (list) + skeleton bubbles (thread) — never spinners, no layout shift.
- **Empty (no label scoped):** EmptyState pointing at Settings › Integrations.
- **Empty (scoped, zero threads):** "Synced and quiet — new mail lands here within ~10s."
- **Sync error:** amber Banner with the stored `lastError` + link to Settings (the connection row already carries it).
- **Send failure:** the optimistic bubble flips to a red "not sent — retry" state; nothing is silently lost.

## RBAC

Page `pages.inbox`; actions `inbox.send`, `inbox.assign`, `contacts.manage` (party creation), `comments.create`. OWNER has all; WORKER has none of these (nav unchanged — inbox is office space per FD9). Financial strip: the party card calls the F1 filter, so `paymentTerms`/price-list assignment vanish for future roles without grains. New permissions to registry: none needed (all exist).

## Bulk / import-export

Bulk assign/close via `BulkActionBar` with per-row results. Export: conversations METADATA CSV (subject, party, state, assignee, ages) — bodies never leave via export in FP1. Party import (F1) is the companion: import contacts → matching lights up.

## Teardown verdicts applied (traceability)

| Verdict (F0-TEARDOWN) | Where it lands |
|---|---|
| Front/Missive four-pane anatomy — ADOPT | The three-pane layout (+ shell rail = pane one) |
| Missive interleaved internal comments — ADOPT | Amber comment bubbles in-thread, composer toggle |
| Missive close-vs-archive — ADOPT | State machine + reopen-to-assignee |
| Snooze/follow-up discard-on-reply — ADOPT | `followUpAt` + worker + auto-cancel |
| Gmail two-way fidelity — ADOPT | All sends via the user's Gmail; threads stay intact in Gmail itself |
| Front contact sidebar → real party card — ADAPT/BEAT | Context rail: factory-schema'd card, not a URL chip; linked-objects slot reserved for FP3/FP4 |
| Odoo chatter (events inline) — ADOPT | The unified timeline |
| Front Links (stateless chips) — BEAT | Deferred to FP3 where the thread literally *gives birth* to the quote |
| Sequences/SLA suites — IGNORE | Follow-up reminder only |

## Acceptance targets (the click-through I'll hand you at gate 2)

Open Inbox → see your real threads with skeletons-then-content → open *AWA ORDER 652/2026* → full body renders (images blocked until you allow) → create the customer from the sender in one click → their other threads auto-link → write an internal comment @mentioning yourself → bell rings → toggle to Reply, send a line → it threads correctly in Gmail's own UI → close the thread → reply to it from another mailbox → it reopens assigned to you within ~10s → snooze one → bulk-close two → export the metadata CSV. All keyboard paths work; zero dead links; strip verified on the party card.

## Build plan (no time estimates, per protocol)

FP1.1 schema migration + body fetch/sanitize + reply/send backend → FP1.2 list pane + filters + bulk → FP1.3 thread pane + composer → FP1.4 comments/timeline + assignment/states + worker reminders → FP1.5 party matching + context rail → FP1.6 keyboard + polish + tests (sanitizer, threading headers, matcher, state machine) + click-through. Each lands as its own commit; gate 2 review at the end.
