# FC1 — Order Spaces substrate: schema + service + API (binding spec)

First chat phase of the approved FS-FC plan (FS2 prerequisite shipped 2026-07-11). FC1 is **plumbing only** — no UI beyond nothing (FC2 builds the /chat shell). Grounded in `FC1-SUBSTRATE.md`; this spec answers its five open questions. No time estimates.

## Schema (additive migration `fc1_chat`)

- **ChatSpace** — id, kind `ORDER | CUSTOM | DM`, name, entityType/entityId (the order binding; `@@unique([entityType, entityId])` so an order has exactly one space), createdById, archivedAt, timestamps. ORDER spaces are system-named (`ORD-214 · Party`).
- **ChatMessage** — id, spaceId (cascade), authorId nullable (**null = system-authored**, the poll-tracking precedent), kind `MESSAGE | SYSTEM`, body, `threadRootId` self-reference (in-line threading data model now, thread UI in FC3), **`moneyCents Int?` + `moneyLabel String?`** — the cost-blind answer: money NEVER interpolated into body; the client formats `moneyCents` after the grain strip deletes it for Workers (substrate trap #1 closed by construction), meta Json (system-event refs: entity type/id for deep-link chips), editedAt, deletedAt (soft — audit keeps truth), createdAt. Indexes: `[spaceId, createdAt]`, `[threadRootId]`.
- **ChatMember** — spaceId+userId unique, role `MEMBER | MANAGER`, lastReadMessageId (read cursors + unread counts), notifyLevel `ALL | MENTIONS | OFF`, joinedAt.
- **ChatReaction** — messageId+userId+emoji unique.
- Attachments reuse the existing polymorphic host: `Attachment{entityType:"chatMessage", entityId}` — zero schema change (substrate map confirmed the fields are provisioned and unused).

## Service — `src/lib/chat/chat-service.ts` (the only mutation path)

team-service doctrine, but **audits INSIDE the service** (comments.ts precedent; substrate question #2 → new entities, Comment untouched — inbox amber notes keep working, no migration risk). Functions: `ensureOrderSpace(orderId)` (idempotent; auto-membership = active OWNER users; called from convert→order and start-production paths), `postMessage` (membership required; mention resolve → notify, reusing `resolveMentions`), `postSystemMessage` (service-only entry, authorId null — FC5 will be its only caller), `editMessage`/`deleteMessage` (own messages; audit before/after), `setReadCursor`, `react`/`unreact`, `createCustomSpace`, `addMember`/`removeMember` (MANAGER or Owner).

## Permissions + nav + events

`pages.chat` (nav sign-off already recorded in the registry) + FEATURES `chat.post`, `chat.spaces.create`, `chat.spaces.manage`. WORKER grants: `pages.chat` + `chat.post` (explicit — substrate question #4). New FS2 event types `chat.message`, `chat.space` — **broadcast, client-side filtered** for now; per-space `scope.spaceId` is a named FS2 extension if chat volume ever warrants it (question #3: FC5 subscribes to the FS2 bus, which is now durable + gap-free, NOT the 15 route taps). Deep links (question #5): `/chat?space=<id>` and `/orders?o=<id>&tab=space` (tab scaffold is FC2 work, coordinated with EPO in the registry).

## API routes (all guarded, all bounded)

`GET /api/chat/spaces` (member's spaces + unread counts, bounded), `POST /api/chat/spaces` (CUSTOM), `GET /api/chat/spaces/[id]/messages?before=&take=100` (windowed newest-first — FS3 WindowedList consumes it in FC2), `POST .../messages`, `PATCH|DELETE /api/chat/messages/[id]`, `POST .../read`, `POST|DELETE .../reactions`, `POST|DELETE .../members`.

## Test plan
Service unit tests (membership guardrails, system-message money rule — asserting body NEVER contains a € pattern when moneyCents set, read-cursor math, idempotent ensureOrderSpace); check:rbac on every route; harness gains chat seeding (spaces × messages at scale) for FC2's windowing proof; grain-strip test: a Worker-resolved response provably drops moneyCents. No click-through (no UI yet) — FC2's gate carries the visual proof.

## Non-goals (recorded)
UI shell (FC2) · thread panel + @mention UI (FC3) · presence/receipts/reactions UI (FC4) · lifecycle system messages (FC5, via the FS2 bus) · DMs/search (FC6) · customer-visible spaces (out of scope per D-4).
