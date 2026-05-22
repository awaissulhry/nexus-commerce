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
  | { type: 'ping'; ts: number }

type Listener = (event: ListingEvent) => void

const listeners = new Set<Listener>()

export function publishListingEvent(event: ListingEvent): void {
  for (const listener of listeners) {
    try {
      listener(event)
    } catch {
      // A misbehaving listener mustn't break the bus for others.
    }
  }
}

export function subscribeListingEvents(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getListenerCount(): number {
  return listeners.size
}
