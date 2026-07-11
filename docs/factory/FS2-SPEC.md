# FS2 — Real-time that scales with clients (binding spec)

Kills S-1/S-11 from `FS0-BASELINE.md` (per-client 3 s DB polling; K×N notification read amplification) and the FS1-deferred client half of S-6 (production board 15 s blind poll). Grounded in the 2026-07-11 substrate audit: 14 event types, ~50 publish sites, 4 subscriber surfaces, per-connection outbox cursors seeded at connect-time MAX(id), ts-based ring replay that never carries worker events, no backpressure. No time estimates.

## Design (one model, no special cases)

1. **One outbox, one shared poller per web process.** ALL events become durable (the three non-durable types — `comment.created`, `integration.changed`, `import.finished` — are low-frequency; they gain outbox writes). A single module-level poller (1 s interval, PK-indexed `id > cursor`, `take 200`) reads new rows once and fans them to every SSE connection through the in-process bus. DB cost: **1 query/second/process, flat in client count** (was: clients ÷ 3 s). The ts-based replay ring is retired.
2. **Gap-free, id-based resume.** The SSE wire protocol carries the outbox id per event; clients persist `lastOutboxId` and reconnect with `?sinceId=`. The server replays `id > sinceId` from the OUTBOX (bounded `take 500`; if the client is further behind than the outbox retention, it receives `resync` and hard-refetches). Worker events that occurred while offline are finally replayed. Outbox retention rises 10 min → 60 min (prune tick unchanged; ~rows are tiny).
3. **Targeted delivery.** Event envelope gains optional `scope: { userId? }`. `notification.created` carries its target user; the server delivers it ONLY to that user's connections (session identity is already on the guard). Everything else stays broadcast (volumes are small once silent mutations are evented; type-filtering happens client-side). K mentions no longer wake N clients.
4. **One EventSource per browser tab.** A module-level client manager multiplexes: hooks register `(types, cb, debounce)`; the manager holds ONE connection, dispatches by type, keeps each hook's debounce semantics. `useFactoryEvents` keeps its exact signature — zero call-site churn.
5. **Backpressure.** `send()` checks `controller.desiredSize`; a connection that stays negative across 2 heartbeats is closed (client auto-reconnects via `sinceId`, losing nothing). Bounded server memory under stalled clients, by construction.
6. **No more silent mutations.** Every state-bearing mutation the audit flagged gains a publish — QC updates (`workorder.updated`), order-line edits (`order.updated`), quote create/line edits (`pricing.updated`), PO create (`workorder.updated`), price-list CRUD + tier membership (`pricing.updated`), product-config CRUD (`pricing.updated`), contacts CRUD (**new type `party.updated`**), certificates (**new `certificate.updated`**), team/role changes (**new `team.updated`**), settings config (**new `settings.updated`**). Dead type `audit.written` is removed; `import.finished` gets its subscriber (imports UI refresh). The spec's event table (audit §3 + these additions) becomes the canonical registry, kept in `events.ts` as the single typed source.
7. **Production board goes event-driven:** subscribes to `workorder.created/updated`, `order.updated`, `pricing.updated` (materials/coverage) with the existing debounce; the 15 s poll becomes a 120 s safety-net fallback. Analytics/inbox/bell/integrations keep their subscriptions, now on the shared pipe.

Explicitly out of scope (recorded): multi-process web tier (FS6 replaces the poller with Postgres LISTEN/NOTIFY when that gate opens); per-entity scoping beyond userId (FC may add space-scoping when chat lands); WebSockets (SSE suffices).

## Test plan

- Unit: poller cursor advance/fan-out, sinceId replay windows incl. `resync` boundary, scope filtering, client manager multiplexing (N hooks → 1 connection), backpressure close.
- Harness (FS0, new SSE scenario): 50 concurrent EventSource clients + worker publishing — assert flat DB query rate (~1/s), p95 event latency ≤ 1.5 s, offline-60 s reconnect delivers every missed worker event, stalled client bounded.
- Silent-mutation sweep: scripted check that every route in the audit's §5(b) list now publishes (grep-based, part of the gate report).
- Click-through on :3199: two browsers — production board updates on stage actions without its poll; bell only rings the mentioned user; inbox live-updates on Gmail sync.
- Full gates: tsc · tests · rbac · no-touch · ds-parity · query-bounds · build; live parity untouched (no money paths).

## Rollback

Single revert; outbox schema untouched (retention is a worker constant). The old per-connection poller remains in git history; no migration in this phase.
