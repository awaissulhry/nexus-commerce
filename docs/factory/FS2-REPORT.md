# FS2 — Gate report: real-time that scales with clients

Built to `FS2-SPEC.md`. Main-tree build by the EPQ session + one worktree agent (silent-mutation sweep, merged `7a855f79`).

## Plain English
Before: every open browser tab asked the database "anything new?" every 3 seconds — 100 tabs = 33 questions a second — and any event that happened while a tab was closed was lost forever unless a page refetched. Notifications woke every user's browser, not just the person notified. After: the server asks ONCE a second no matter how many tabs are open, every event has a serial number so a reconnecting tab replays exactly what it missed (including events from the background worker), notifications reach only their target user, and a stuck client can no longer make the server hoard memory. ~30 actions that used to change data silently (QC checks, price-list edits, contact edits, team changes, settings…) now announce themselves, so every screen stays live.

## Measured (50-client storm on :3199 + scale DB)
- **1,000/1,000 deliveries** (50 clients × 20 events), latency p50 597 ms / p95 1,047 ms (target ≤1.5 s ✓) — DB read load flat at ~1 query/s regardless of client count (by construction: one shared poller).
- Mid-storm API probe: 200 in 21 ms (no event-loop starvation).
- Offline-resume: 5/5 worker-side events injected during a disconnect replayed on reconnect (`sse-load.ts`, repeatable).

## Shipped
Shared-poller hub with per-connection lastId dedupe + userId scoping (`events.ts`); SSE `id:` frames → native Last-Event-ID resume + `?sinceId=` + `resync` overflow signal (`api/events`); ONE multiplexed EventSource per tab, hook signature unchanged (`use-factory-events.ts`); backpressure drop-and-resume via heartbeat `desiredSize` probe; outbox retention 10→60 min; scoped `notification.created`; production board event-driven (15 s poll → 120 s safety net); ~30 publishes added across 29 routes (13 by this session incl. four NEW types `party/certificate/team/settings.updated`; 16 by the sweep agent); dead type `audit.written` removed; 8 new unit tests (delivery semantics, scope smuggling through the Json outbox column).

## Deviations / notes
- Legacy `publishEvent` kept as a deprecated durable alias (5 call sites keep compiling; all events durable now — the spec's intent, implemented as a wrapper).
- `import.finished` subscriber (imports UI refresh) NOT wired — the imports pages are inside claimed EP pages' scope; recorded as a handoff, not silently done.
- The 2-browser interactive click-through (two users, bell scoping, live board) is folded into the next :3199 click-through session alongside EPQ.1's — the 50-client probe already exercises the full wire path end-to-end.
- FS6 note: multi-process web tier still unsupported by design (poller-per-process); Postgres LISTEN/NOTIFY replaces this when FS6's gate opens.

## Verified
tsc · 225 tests · rbac 126 · query-bounds · no-touch · ds-parity 97/97 · `next build` · sse-load PASS · dev runtime restarted post-generate (trap 6b).
