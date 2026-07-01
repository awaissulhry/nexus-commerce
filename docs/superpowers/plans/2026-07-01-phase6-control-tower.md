# Phase 6 — Inventory Sync Control Tower (UI) — Implementation Plan

> **STATUS: AWAITING USER APPROVAL — do not implement until approved.**
> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. UI tasks additionally follow the project's UI self-verify rule (screenshot-diff at native res before showing).

**Goal:** One Nexus surface to **see and operate** cross-channel inventory sync per SKU: which channels are in-sync / pending / failed / clamped, one-click resync, bulk-retry of failures, per-marketplace suppress/hold, a delta preview of what a channel will receive, and a live banner for oversell-clamp / negative-available / drift / degraded-realtime. This is the "manage it all from Nexus" surface.

**Architecture:** Reuse-first. The data and actions **mostly already exist** but are scattered — this phase adds (1) one **aggregation endpoint** that rolls up per-SKU × per-channel sync state, and (2) a **control-tower page** built on the existing design system that renders that roll-up and wires the **existing** action endpoints (`/api/outbound-queue/:id/retry` + `/bulk-retry`, `/listings/:id/resync`), plus (3) a live events banner over the existing SSE order-events bus. New backend is thin; the weight is the UI.

**Tech Stack:** Fastify + Prisma (aggregation endpoint), Next.js app (`apps/web/src/app`), the design system (`apps/web/src/design-system` primitives/components/patterns — **mandatory, no hand-rolled UI**), the SSE order-events stream, Vitest (backend), the project's screenshot self-verify workflow (UI).

## Global Constraints

- **Reuse existing endpoints for actions.** Resync = `POST /listings/:id/resync` (or `/dashboard/stock-drift/:id/resync`); bulk-retry = `POST /api/outbound-queue/bulk-retry`; per-row retry = `POST /api/outbound-queue/:id/retry`. Do NOT build parallel action logic — wire what exists. The only NEW backend is the read aggregation + the delta-preview computation + (if needed) a suppress/hold toggle.
- **Design system is mandatory.** All UI from `apps/web/src/design-system` (primitives/components/patterns). No bespoke components; match the density/visibility standard (Salesforce/Airtable, not Linear-minimal). Follow the existing grid-lens patterns used by `/fulfillment/stock` + `/listings`.
- **UI self-verify before showing.** Every rendered surface is screenshot-diffed at native @2x against the design reference, with alignment/border/spacing measured numerically, before it's presented. (Requires the app runnable — see Execution Note.)
- **No new stock mutation.** The control tower triggers existing resync/retry paths and reads state; it performs no direct stock writes. Suppress/hold uses existing suppression rails.
- **Real-time is additive.** The banner subscribes to the existing order-events SSE; it does not change event production.
- **No schema migration** unless a suppress/hold flag is genuinely absent (confirm first; prefer the existing `listingStatus`/suppression rails). If a migration is required, it is surfaced for explicit approval before applying.
- Branch only (`worktree-inventory-col`); isolate into the inventory-sync PR set at consolidation. Commit + push per task.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `apps/api/src/services/control-tower.service.ts` (create) | Pure-ish roll-up: given per-listing sync state + queue rows + recent events → per-SKU × per-channel status model. Unit-tested pure shaper. |
| `apps/api/src/services/control-tower.vitest.test.ts` (create) | Tests for the status roll-up shaper. |
| `apps/api/src/routes/control-tower.routes.ts` (create) | `GET /api/inventory-sync/control-tower` (roll-up) + `GET /api/inventory-sync/control-tower/:sku/delta` (delta preview). |
| `apps/api/src/index.ts` (modify) | Register the routes. |
| `apps/web/src/app/fulfillment/stock/control-tower/page.tsx` (+ client) (create) | The control-tower grid page (design system). |
| `apps/web/src/app/fulfillment/stock/control-tower/*` (create) | Row/status-chip components, action bar, delta-preview modal, live banner — all design-system based. |

---

### Task 1: control-tower roll-up shaper (pure) + tests

Pure function `buildControlTowerRows(input)` that, given for each SKU its channel listings (`{ channel, marketplace, lastSyncStatus, lastSyncedAt, quantity }`) + its open `OutboundSyncQueue` rows (`{ channel, syncStatus, isDead }`) + recent flags (clamped/negative-available), returns a per-SKU row with a per-channel status enum: `IN_SYNC | PENDING | FAILED | DEAD | CLAMPED | UNKNOWN`. Precedence (worst-wins): `DEAD > FAILED > CLAMPED > PENDING > IN_SYNC`. Fully unit-tested (the precedence + edge cases). No IO.

- [ ] Write failing tests for the precedence + mapping; implement the pure shaper; verify; commit `feat(inventory-sync): P6.1 control-tower status roll-up shaper`.

### Task 2: aggregation endpoint + delta preview

`GET /api/inventory-sync/control-tower?filter=…&page=…` — query active `ChannelListing`s (+ their product SKU) and open `OutboundSyncQueue` rows, feed `buildControlTowerRows`, return the paged roll-up + per-channel summary counts. `GET /api/inventory-sync/control-tower/:sku/delta?channel=&marketplace=` — compute the payload the next outbound push WOULD send for that listing (reuse `buildAmazonListingPatch` / the eBay/Shopify payload builders + `resolveDispatchQuantity`/`applyOversellClamp`) so the operator sees "what the channel will receive" without pushing. Read-only. Register in `index.ts`.

- [ ] Implement both endpoints (thin over Task 1 + existing payload builders); typecheck; commit `feat(inventory-sync): P6.2 control-tower aggregation + delta-preview endpoints`.

### Task 3: control-tower page — read-only grid (design system)

`/fulfillment/stock/control-tower` — a grid: one row per SKU, columns per channel×marketplace showing the status chip (colour-coded, worst-wins), last-synced age, and current published qty. Built on the design system's grid-lens/table patterns (mirror `/fulfillment/stock`). Filters (channel, status), sort, density. **Screenshot self-verify at @2x before presenting.**

- [ ] Build the page + row/chip components (design system), wire to the Task 2 endpoint; self-verify (screenshot-diff + numeric alignment); commit `feat(inventory-sync): P6.3 control-tower grid (read-only)`.

### Task 4: actions — resync, bulk-retry, suppress/hold, delta preview

Wire the existing endpoints into the grid: per-row **one-click resync** (`/listings/:id/resync`), **bulk-retry** selected failed/dead rows (`/api/outbound-queue/bulk-retry`), **per-marketplace suppress/hold** (existing suppression rails; confirm the toggle endpoint or add a thin one), and a **delta-preview modal** (Task 2's delta endpoint) shown before a manual push. Optimistic UI + toast on the existing event stream. Self-verify.

- [ ] Wire actions + delta modal; self-verify; commit `feat(inventory-sync): P6.4 control-tower actions (resync/bulk-retry/suppress/delta)`.

### Task 5: live banner + DLQ escalation surfacing

A banner/toast layer subscribing to the existing order-events SSE for the Phase 1–5 events — `sync.oversell.clamped`, negative-available, `sync.latency.breach`, `sync.realtime.degraded`, `sync.reconcile.drift`, `sync.drift.cumulative`, `sync.conflict.stale` — plus a DLQ depth indicator (from the outbound-queue stats). Click-through to the affected SKUs/rows. Self-verify.

- [ ] Build the banner (design system) + SSE wiring + DLQ indicator; self-verify; commit + push `feat(inventory-sync): P6.5 control-tower live banner + DLQ surfacing`.

---

## Execution Note (important)
Phase 6 is the largest phase and is **UI-heavy**. Two realities shape execution:
1. **It benefits from the backend being deployed** — the grid + banner are most meaningful once the Phase 0–5 signals (events, queue state, latency) are flowing from prod. Building against an undeployed backend means synthetic/empty data.
2. **The project's UI self-verify standard** (screenshot-diff at native res before showing) needs the app runnable + browser screenshots. That is best done in an environment where `npm run dev` + the browser render reliably (headless auth/i18n has known gotchas).

For these reasons Phase 6 is a strong candidate to execute as its **own focused push** (after the Phases 0–5 PR is merged/deployed), rather than blind at the tail of a long session. The plan is structured so Tasks 1–2 (backend, testable now) can land independently of Tasks 3–5 (UI).

## Self-Review
- **Spec coverage:** per-SKU×channel status (T1–T3), one-click resync + bulk-retry + suppress/hold (T4), delta preview (T2+T4), live negative-available/oversell/drift banner + DLQ (T5). All reuse existing action endpoints; new backend is read-only aggregation + delta.
- **Placeholder scan:** the UI tasks are described at structure level (not fake-complete React) because components are built against the design-system catalog at implementation time under the screenshot-verify workflow — this is deliberate for a UI phase, not a placeholder. Backend tasks (T1–T2) are concretely specified + testable.
- **Risk:** no new stock mutation; actions reuse audited endpoints; the only new backend is read-only. The main risk is UI-quality/verification, mitigated by the design-system mandate + screenshot self-verify.
