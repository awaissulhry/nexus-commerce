// S.4 — In-process event bus for listing + product mutations.
//
// P-RT.1 — bus also carries product.* events (product.updated /
// created / deleted), published by productEventService so the
// /products workspace receives sub-200ms updates from any mutation
// path (operator edit, webhook, bulk job). Same SSE endpoint
// (/api/listings/events) — adding a parallel route would have meant
// a second EventSource per tab for no benefit.
//
// Mirrors apps/api/src/services/inbound-events.service.ts. SSE
// subscribers convert these events to writes on the response stream;
// frontend consumers dispatch them to the existing invalidation
// channel so usePolledList et al. refresh in <200ms instead of
// waiting for the next 30s polling tick.
//
// Single-process design — fine for current Railway scale (one API
// instance). Horizontal scaling adds Redis pub/sub or BullMQ events
// later without changing the public API (publishListingEvent /
// subscribeListingEvents / getListenerCount).
//
// Event payloads stay lightweight ({ type, listingId, ts, ... }):
// subscribers fetch fresh state on receipt. Sending full DB rows
// through SSE would couple the wire format to the schema and force
// the client to apply deltas — refresh-on-event is simpler and
// always correct.

export type ListingEvent =
  | { type: 'listing.synced'; listingId: string; status: 'SUCCESS' | 'FAILED' | 'TIMEOUT' | 'NOT_IMPLEMENTED'; durationMs?: number; ts: number }
  | { type: 'listing.syncing'; listingId: string; ts: number } // emitted at start so cells can flip to amber instantly
  | { type: 'listing.updated'; listingId: string; reason?: string; ts: number }
  | { type: 'listing.created'; listingId: string; ts: number }
  | { type: 'listing.deleted'; listingId: string; ts: number }
  // DR-C.3 — wizard.submitted fires when ListingWizard.status leaves
  // DRAFT (→ SUBMITTED/LIVE/FAILED). Step9Submit also broadcasts the
  // same event over BroadcastChannel for same-browser tabs, but if
  // the operator closes the source tab mid-submit those tabs never
  // hear about it — only the SSE path closes that gap.
  | { type: 'wizard.submitted'; wizardId: string; productId: string; status: 'SUBMITTED' | 'LIVE' | 'FAILED'; ts: number }
  | { type: 'bulk.progress'; jobId: string; processed: number; total: number; succeeded: number; failed: number; ts: number }
  | { type: 'bulk.completed'; jobId: string; status: string; ts: number }
  // P-RT.1 — product aggregate events. Emitted by productEventService
  // after the underlying mutation commits. The web client dispatches
  // these into the existing invalidation channel so ProductsWorkspace
  // + DraftsClient + the edit page tabs refresh within ~250ms of any
  // mutation path (operator save, Shopify webhook, bullmq sync worker,
  // flat-file import). Payload stays minimal — subscribers refetch.
  | { type: 'product.updated'; productId: string; reason?: string; ts: number }
  | { type: 'product.created'; productId: string; ts: number }
  | { type: 'product.deleted'; productId: string; ts: number }
  // EV.3 — raised by the API on every stock movement and fanned out here, so
  // an open grid's stock column can move for a change made anywhere. Payload
  // mirrors the catalogue's inventory.stock_changed.
  | {
      type: 'inventory.stock_changed'
      productId: string
      locationId: string
      movementId: string
      change: number
      quantityBefore: number
      quantityAfter: number
      available: number
      poolTotal: number
      reason: string
      orderId?: string | null
      ts: number
    }
  | { type: 'ping'; ts: number }

type Listener = (event: ListingEvent) => void

// ── EV.3 — the same bus, from the shared factory ────────────────────────────
//
// The three exported functions below are UNCHANGED in signature and in
// synchronous behaviour: all 20 publish call sites (across 5 files) and both
// subscribers are untouched, and a local subscriber still receives an event in
// the same tick it was published.
//
// EV.1 rewired this bus by hand for cross-replica delivery. That hand-written
// version is now lib/events/bus.ts, shared by every bus — this file was the
// template and is the first consumer, which is deliberate: it is the one
// already running in production, so if the factory reproduces it exactly the
// abstraction is proven against something real rather than something new.
//
// This is the EPHEMERAL lane. These are refresh hints: a dropped one costs a
// grid a few seconds until its next poll. Domain facts — anything stock, money
// or state-machine shaped — go through publishEvent(tx, …) and the outbox.

import { createCrossReplicaBus } from '../lib/events/bus.js'
import type { EventType } from '@nexus/events'

/**
 * The catalogue types this bus carries. A remote event outside this set
 * belongs to another bus and must not be delivered here, or an SSE client
 * subscribed to listings would start receiving purchase orders.
 *
 * `inventory.stock_changed` is on the list even though it is raised on the
 * DURABLE lane: the SSE fan-out is how a stock change reaches an open grid,
 * and /products/next already subscribes to a stock invalidation that nothing
 * server-side had ever raised.
 */
const LISTING_BUS_TYPES_LIST = [
  'listing.synced', 'listing.syncing', 'listing.updated', 'listing.created', 'listing.deleted',
  'wizard.submitted', 'product.updated', 'product.created', 'product.deleted',
  'bulk.progress', 'bulk.completed', 'inventory.stock_changed',
] as const satisfies readonly EventType[]

const bus = createCrossReplicaBus<ListingEvent>({
  name: 'listing-sse',
  types: LISTING_BUS_TYPES_LIST,
})

export function publishListingEvent(event: ListingEvent): void {
  bus.publish(event)
}

export function subscribeListingEvents(listener: Listener): () => void {
  return bus.subscribe(listener)
}

export function getListenerCount(): number {
  return bus.listenerCount()
}

/** Attach this process to listing events raised on OTHER replicas. */
export async function startListingEventIntake(): Promise<void> {
  await bus.startIntake()
}

export async function stopListingEventIntake(): Promise<void> {
  await bus.stopIntake()
}
