# FS + FC — Scale Hardening & Order Spaces (chat): the proposal

Written 2026-07-11 at the Owner's request: *"make sure it's absolutely scalable"* + *"embed Google Chat so each order has its own isolated conversation, same structure and interface as Google Chat."* This document is the gate-1 artifact for BOTH workstreams: **FS (Factory Scale)** and **FC (Factory Chat / Order Spaces)**. Nothing here is built; every phase below re-gates individually per the playbook's double-gate rule. Facts come from a full three-way audit (data/runtime layer, UI layer, external research) run 2026-07-11; file:line references are current at commit `11e9280a`.

---

## 0. Honest verdicts first

**The foundation is bigger and better-built than "4k-ish".** The factory app is **~22,400 lines** of factory-specific code (excluding the copied design system and generated client), 43 models, and the schema is *well-indexed on almost every hot path* (Message, Conversation, Order, AuditLog, Notification, Session all carry the right compound indexes). This is not a prototype; it is a lean production system with a small number of enumerable scale cliffs.

**"Thousands of orders" is achievable on the current stack.** SQLite/WAL with correct indexes and bounded queries comfortably serves tens of thousands of orders and hundreds of thousands of messages for a small concurrent team. Every cliff that prevents this today is listed in §1 with file:line, and phases FS1–FS5 remove them one by one, proven against a load harness (FS0) rather than asserted.

**"Thousands of workers" (concurrent users) is a different physics problem.** Two structural ceilings can't be fixed by tuning: (a) the single-writer SQLite file on the Owner's machine, and (b) the SSE bridge that makes every connected browser poll the DB every 3 s. FS2 fixes (b). For (a): hundreds of *total* users with tens *concurrently active* is realistic post-FS; genuinely large concurrent headcount requires the hosted-Postgres path (FS6) — which is deliberately **Owner-gated because it re-opens FD2** ($0 / local-first). The right move now is to make FS6 a *proven, rehearsed option* (schema runs on Postgres, cutover runbook tested), so scale becomes a decision, never a rewrite.

**Google Chat cannot be embedded — by anyone, in any app.** Research verdict (all points verified against Google's own docs, 2026-07-11):

| Fact | Consequence |
|---|---|
| Chat API (spaces.create, messages.*, memberships) requires a **Google Workspace** account; the factory Google account is consumer `@gmail.com` | We cannot even *configure* a Chat app, let alone create a space per order |
| Google ships **no embeddable Chat UI** (no iframe/widget/SDK); chat.google.com blocks framing; even Google's AppSheet only does the reverse (your app *inside* Chat) | "Embed Google Chat" is impossible for every developer, not just us |
| Incoming webhooks are Workspace-only AND write-only (can post into a space, can never read) | No webhook workaround exists |
| Workspace would cost per-user/month licenses; per-space write quota is 1 msg/sec | Even the paid path is quota-tight for bot-heavy order feeds and violates $0 |

**Therefore FC = build Order Spaces natively, faithful to Google Chat's structure and interface** (its 2026 anatomy is fully documented in §3), on our own substrate: the polymorphic `Comment` model, the SSE bus, per-user `Notification` rows, and the H10 design system. This keeps $0, keeps the data local and owned, keeps Workers license-free, and lets the customer-facing Gmail thread (Inbox) remain the *external* channel while each order gets its *internal* team space — the same split Google Chat itself draws between email and Chat. FD5 already made `Conversation.channel` pluggable in anticipation of exactly this kind of channel. If the Owner ever buys Workspace, a real Google-Chat *bridge* becomes an additive later phase (FC-B, listed in the backlog), not a rework.

---

## 1. The audited scale cliffs (what actually breaks, with evidence)

Ranked by severity. **C-x = correctness bug, S-x = scale cliff.** Each is claimed by exactly one FS phase below.

| # | Finding | Evidence | Fixed in |
|---|---|---|---|
| C-1 | **Orders kanban silently drops orders past 200** — `take: 200` feeds the board; cards past the cap vanish without any indication | `api/orders/route.ts:33`, `OrdersClient.tsx:76`, `KanbanBoard.tsx:78` | FS1 |
| C-2 | **Gmail historyId expiry loses mail** — expired historyId falls back to a backfill hard-capped at 50 threads; older unsynced mail silently never arrives | `gmail-sync.ts:36,165-169,249-253` | FS1 |
| C-3 | **Multi-step writes are not transactional** — Gmail upsert sequences, snooze-wake, order mutations run as separate autocommit statements; partial application possible | `db.ts` (no `$transaction` wrappers), `worker/index.ts:72-135` | FS4 |
| S-1 | **SSE fan-out is O(clients) DB polling** — every connected browser gets its own 3 s `FactoryEventOutbox.findMany` interval; 100 tabs ≈ 33 queries/s of pure polling against the single writer | `api/events/route.ts:53-67` | FS2 |
| S-2 | **materials/stock loads the ENTIRE append-only MovementLedger on every page view** — the worst unbounded query; the ledger only grows, forever | `api/materials/stock/route.ts:19` | FS1 |
| S-3 | **Analytics fetches whole tables and reduces in JS; the date range is applied AFTER the fetch** — all WOs+stages, all order lines, all quotes | `api/analytics/route.ts:29-58` | FS1 |
| S-4 | **ThreadPane loads a conversation's entire message+comment history un-windowed** with a JS merge-sort per open | `api/inbox/[id]/route.ts:35-48`, `ThreadPane.tsx:50-60` | FS3 |
| S-5 | **DataGrid renders every row, no virtualization anywhere**; full-array sort per render | `DataGrid.tsx:63,161` | FS3 |
| S-6 | **Production board: uncapped WO fetch + full ledger/coverage recompute, re-polled every 15 s per open tab** + one 1 s timer per card | `api/production/route.ts:26-50`, `ProductionClient.tsx:45`, `StageTimer.tsx:18` | FS1+FS2 |
| S-7 | **Worker full-scans Conversation every 60 s** — `snoozeUntil` / `followUpAt` are unindexed | `worker/index.ts:75,92`, schema:256-277 | FS1 |
| S-8 | **Missing indexes**: `Attachment.messageId`, `WorkOrder.orderId`, `MovementLedger.createdAt` (solo) | schema:305-319, prod routes | FS1 |
| S-9 | **Session = uncached 3-level join on every authenticated request** + sliding-expiry write per user per minute | `session.ts:52-68`, `guard.ts:44-46` | FS4 |
| S-10 | **Mention resolution loads ALL active users per comment** (O(handles × users) in JS) | `comments.ts:17-34` | FS4 |
| S-11 | **Notification fan-out amplification** — K mentions → K outbox rows → read by every client's 3 s poll (K×N) | `notifications.ts:33-36` + S-1 | FS2 |
| S-12 | **Unbounded findMany on 13+ routes** (financials, exports/*, team, pricelists, certificates, analytics/counters "unanswered"…) | audit table, e.g. `lib/financials/load.ts:13` | FS1 |
| S-13 | **Search is leading-wildcard LIKE, no FTS** — inbox `q` even correlates a subquery over all messages | `api/inbox/route.ts:26-34`, `api/search/route.ts` | FS5 |
| S-14 | **Attachments + PDFs are fully buffered in RAM** (`readFileSync`, `Buffer.concat`); attachments live on local disk only | `attachments/[attId]/route.ts:37-44`, `render-pdf.ts:14-18` | FS5 |
| S-15 | **Nightly `VACUUM INTO` copies the whole DB, ×14 retained** — a long single-writer stall once the file is GBs | `worker/index.ts:155-186` | FS5 |
| S-16 | **Whole-list pickers** — users-lite / parties-lite / production workers load entire tables into plain dropdowns | `api/users-lite/route.ts:10`, `api/parties-lite/route.ts:10` | FS3 |
| S-17 | **WAL/synchronous pragmas applied fire-and-forget** (failure silently swallowed); no busy_timeout/cache/mmap tuning beyond adapter default | `db.ts:24-27` | FS4 |

Also noted for honesty: consumer-Gmail API quotas are generous per-user (the 10 s incremental historyId poll is the right design) — the mail-volume ceiling is C-2's backfill cap, not the quota.

---

## 2. FS — the scale workstream (phases, each gated + tested alone)

Design targets, to be *proven* not asserted: **50,000 orders · 500,000 messages · 2,000,000 ledger/audit rows · 500 registered users · 30 concurrently active** on the current local stack; a rehearsed path beyond that via FS6. No time estimates (playbook rule 3).

### FS0 — Measure: load harness + baseline (read-only; nothing user-visible changes)
Synthetic-scale generator writing to an **isolated copy** of the DB (never the live file; clearly-fake data, `:3199` verify server only — playbook rule 5 honored: fake data never enters the Owner's instance). Seeds the design-target volumes. A scripted load driver hits every page's API route mix and records p50/p95/max + query counts; a timing wrapper logs slow queries. **Exit:** a baseline table (route × latency × volume), the ranked cliff list re-validated empirically, committed as `FS0-BASELINE.md`. Every later phase re-runs this harness to prove its claim.

### FS1 — Query hygiene + the two correctness bugs (biggest win, lowest risk)
Additive-migration indexes (pre-approved category): `Attachment.messageId`, `WorkOrder.orderId`, `Conversation.snoozeUntil`, `Conversation.followUpAt`, `MovementLedger.createdAt`. Bound or aggregate every unbounded route: materials/stock becomes an SQL fold (SUM/GROUP BY, or an incrementally-maintained stock row per material) instead of a whole-ledger scan; analytics pushes date ranges + GROUP BY into SQL; financials/deposits/exports get real bounds + streamed CSV; counters "unanswered" becomes SQL. Fix **C-1** (kanban: per-lane query + per-lane "load more"; never silently drop) and **C-2** (paginated, alerting backfill — never cap at 50 and shrug). Index the worker's due-scans (S-7). **Exit:** harness shows every route sub-second at design volumes; zero unbounded findMany left (greppable invariant, enforced by a new `check:query-bounds` script in CI).

### FS2 — Real-time that scales with clients
One shared outbox poller per process (or SQLite `data_version`/update-hook push) fanning to all SSE subscribers in-memory — DB cost becomes O(1) per 3 s regardless of client count (kills S-1, S-11's read side). Event payloads gain targeting (userId/entity scope) so clients stop refetching on irrelevant events; analytics counters go SQL-count. Production board moves from 15 s blind poll to event-driven refresh + one shared ticking clock context (kills S-6's client half). **Exit:** harness with 50 simulated SSE clients shows flat DB query rate; per-event wake-ups only on subscribed scopes.

### FS3 — UI truthful at volume
Virtualized DataGrid (windowing; DS-wide, benefits every page — the DS copy rule means we change our copy and upstream the pattern to apps/web separately if wanted). Windowed ThreadPane with a paged thread API (newest page first, "load earlier"); windowed inbox "Load more" accumulation. Searchable, paginated combobox for every whole-list picker (assignee, party, workers — S-16) + @mention autocomplete (feeds FC). **Exit:** harness pages with 10k-row datasets scroll at 60 fps; DOM node counts bounded; thread with 5,000 messages opens instantly.

### FS4 — Write integrity + hot-path auth
`$transaction` around every multi-step write (C-3); explicit pragma verification at boot (fail loudly if WAL didn't take — S-17) + busy_timeout/cache/mmap tuning; short-TTL session cache keyed on `permissionsVersion` (revocation-safe — S-9); indexed mention lookup (handle column, kills S-10); optimistic-concurrency guard (updatedAt check) on hot mutations (two users editing the same order); login rate-limiting. **Exit:** concurrent-writer harness (web+worker hammering simultaneously) completes with zero SQLITE_BUSY surfacing to users and zero partial writes; per-request DB queries for an authed GET drops to ≤1.

### FS5 — Storage lifecycle
Streamed attachment downloads + streamed PDF generation (S-14); FTS5 virtual tables for inbox/global search (S-13, kills leading-wildcard scans); snapshot strategy for large DBs (measured `VACUUM INTO` budget, plus WAL-checkpoint-aware scheduling — S-15); archival/export policy for the ever-growing ledger + audit tables (export-then-window views; append-only rule untouched — corrections stay compensating entries). **Exit:** harness at 2M ledger rows: search sub-100ms, snapshot within a measured budget, no full-buffer allocations over a set threshold.

### FS6 — The horizon option (OWNER-GATED: re-opens FD2, costs money)
Prove the whole schema + code on Postgres (Prisma adapter swap; enums become real; the `check:*` suite must pass both engines), a rehearsed SQLite→Postgres cutover runbook (tested on the harness DB), a hosted deployment recipe (same shape as the Nexus commerce side: Railway/Neon), and SSE via LISTEN/NOTIFY when multi-instance. **This phase ships documents + CI proof, not a migration** — the Owner flips it only if/when real concurrency demands it. **Exit:** green test suite on both engines + a dry-run cutover log; a written capacity statement per engine.

### FS7 — Capacity statement (closes the workstream)
Re-run the full FS0 harness at design targets on the final code; publish `FS-CAPACITY.md`: measured limits, the dial positions (what to do at 2×, 10×), and the standing invariants (`check:query-bounds` in the pre-push ratchet). **Exit:** the Owner can answer "will it hold?" with a number, not a feeling.

---

## 3. FC — Order Spaces: Google Chat's structure & interface, natively (phases gated + tested alone)

Scope stance: Spaces are the **internal** channel (Owner + workers per order); the **external** customer thread remains the Gmail-backed Inbox conversation. This mirrors Google's own email/Chat split and keeps Workers out of customer mail. Cost-blind rule carries over: Workers see no prices in system messages (reuses the FP6/FP7 grain-gating).

**Faithful anatomy to clone** (verified against Google's 2026 UI): left rail with **Home / DMs / Spaces**; named spaces with description + members + managers; **in-line threading** — hover any message → "Reply in thread" opens a right-side thread panel; followed threads surface on Home; thread replies notify only participants/followers/@mentioned; @mention **smart chips** with hover cards; `@all`; emoji **reactions**; **read-receipt avatars** under the last-read message; edit/delete own messages; unread bolding + per-space notification settings. (Huddles are Meet-powered and out of scope; noted in backlog.)

### FC1 — Substrate: schema + service + API (no UI)
Additive migration: `ChatSpace` (kind: ORDER | CUSTOM | DM, entityType/entityId for order-bound spaces), `ChatMessage` (spaceId, threadRootId for in-line threads, body, authorId, editedAt/deletedAt), `ChatMember` (role, lastReadMessageId → read receipts + unread counts, notification level, followed threads), `ChatReaction`. One sanctioned `chat-service.ts` (the team-service pattern): post/edit/delete/react/read-cursor/membership, permission-guarded routes, `publishEventDurable` events, AuditLog stamps. **Auto-create the space when an Order is created; auto-membership = Owner + anyone assigned to the order/its stages.** Existing polymorphic `Comment` stays for non-order entities; order-space history begins at FC1 (no risky comment migration; the old order comments remain visible in the timeline). **Exit:** full unit-tested service + routes; FS0 harness gains chat-volume seeding (spaces × messages at design targets).

### FC2 — The Chat shell (the page)
`/chat` (nav: "Chat"): Google-Chat layout — left rail (Home, Spaces list with unread bolding + badge counts, search), main message stream (author groups, day dividers, hover action bar), bottom composer (Shift+Enter newline, edit-last-message on ↑). Resizable partitions from day one (the Inbox lesson). Also the **order-detail hook**: a "Space" tab/button on each order deep-linking to its space. Empty states per zero-training rule. **Exit:** click-through on :3199 with harness data — a 5,000-message space scrolls windowed (FS3's virtualization reused); Owner gate.

### FC3 — Threads + mentions (the heart of the Google Chat model)
In-line threading: "Reply in thread" → right-side panel, reply counts + participant facepiles on the root message, followed-threads surfacing on Home, thread-scoped notifications. @mention autocomplete (FS3's combobox) rendering smart-chip pills with hover cards; `@all` per space; Notification rows + bell integration (MENTION kind exists already). **Exit:** thread panel behavior matches the documented Google model (reply-notify scope: participants/followers/mentioned only); tested alone.

### FC4 — Presence & message affordances
Reactions (emoji picker + reaction pills), edit/delete own messages (audit-stamped, "edited" label), read-receipt avatar row under last-read position, typing indicators + lightweight presence (SSE, ephemeral — no DB writes per keystroke), per-space notification settings (All / @mentions / Off). **Exit:** two-browser click-through: receipts, typing, reactions live-update via the FS2 event path.

### FC5 — The order feed: system messages + files
Lifecycle events post structured system messages into the order's space (stage transitions, QC pass/fail, payment recorded, label bought, tracking updates, DELIVERED) — each a deep-link chip to the source page; grain-gated (Workers never see money lines). File sharing in composer reusing the Attachment substrate + Drive save-through; files chip-rendered. This is where a space becomes the order's *live control room* rather than a chat box. **Exit:** golden-flow run on :3199 — quote→order→production→ship — narrates itself in the space correctly for both an Owner and a Worker session.

### FC6 — Home, DMs, search (completes the Google anatomy)
Home aggregation (unreads + followed threads across spaces), 1:1 and group DMs (same substrate, kind: DM), FTS chat search (FS5's FTS5). CUSTOM spaces (non-order rooms, e.g. "Cutting room"). **Exit:** full-anatomy click-through vs a Google Chat side-by-side; parity checklist committed.

**FC backlog (named, not scheduled):** FC-B Google Chat *bridge* if Workspace is ever purchased (space↔space sync via Chat API); huddles/calls (Meet links as a poor-man's version); customer-visible spaces (would re-open the external-channel decision); WhatsApp channel (FD5) into the same shell.

---

## 4. Decisions the Owner is being asked to make

| # | Decision | Recommendation |
|---|---|---|
| D1 | Chat approach: native Order Spaces vs buy Workspace + build a bridge vs third-party SDK | **Native** (embedding is impossible for everyone; Workspace re-opens $0 and adds per-user licenses + 1 msg/s/space quota; third-party SDKs cost $399+/mo or per-user) |
| D2 | Workstream order | **FS0→FS1→FS2 first** (they fix live correctness bugs C-1/C-2 and make the substrate chat-ready), then **FC1→FC6 as the main build**, FS3 folded in where FC needs it (virtualization, comboboxes), FS4/FS5 after FC2, FS6/FS7 last |
| D3 | FS6 horizon (Postgres/hosted proof) | Build the *proof + runbook* when reached; actual migration stays a future Owner flip with real cost numbers in front of it |
| D4 | Scope confirmation: Spaces are internal-only; customers stay in Gmail Inbox | Confirm (changing this later is additive, not a rework) |

Per the double gate: on approval of this proposal, each phase still gets its own `FSn-`/`FCn-SPEC.md` → Owner approval → build → click-through → Owner approval. Every phase is testable alone on :3199 against the FS0 harness, and nothing touches the live instance until its gate passes.
