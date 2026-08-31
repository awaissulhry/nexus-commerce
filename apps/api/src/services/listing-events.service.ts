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

// ── EV.1 — the same bus, now across replicas ────────────────────────────────
//
// The three exported functions below are UNCHANGED in signature and in
// synchronous behaviour: all 20 publish call sites (across 5 files) and both
// subscribers are untouched, and a local subscriber still receives an event in
// the same tick it was published.
//
// What changed is that publishing also fans the event out through the broker,
// and this process subscribes to it. On one instance that is a no-op. On two,
// it is the difference between an SSE client seeing every mutation and seeing
// only the ones that happened to land on its own box — which is why the header
// above says single-process, and why a second replica was never safe to start.
//
// This is the EPHEMERAL lane, deliberately. These are refresh hints: a dropped
// one costs a grid a few seconds until its next poll. Domain facts — anything
// stock, money or state-machine shaped — go through publishEvent(tx, …) and
// the outbox instead, where they survive a crash. See lib/events/ephemeral.ts.

import { isSelfPublished, publishEphemeralDynamic, subscribeBroadcastEvents, getBroker } from '../lib/events/index.js'
import { isEventType, type EventEnvelope, type EventType } from '@nexus/events'
import { logger } from '../utils/logger.js'

/** Deliver to this process's listeners. The original publish path, verbatim. */
function deliverLocally(event: ListingEvent): void {
  for (const listener of listeners) {
    try {
      listener(event)
    } catch {
      // A misbehaving listener mustn't break the bus for others.
    }
  }
}

/**
 * Split a bus event into the catalogue's (type, payload). The bus carries `ts`
 * inside the event; the envelope carries it as `occurredAt`, so it is stripped
 * here and restored on the way back — subscribers never see the difference.
 */
function toCatalogue(event: ListingEvent): { type: string; payload: Record<string, unknown>; ts: number } | null {
  const { type, ts, ...payload } = event as ListingEvent & { ts: number }
  // `ping` is an SSE keepalive, not a domain fact. It stays local: putting a
  // per-connection heartbeat on a shared bus would multiply it by every replica.
  if (type === 'ping' || !isEventType(type)) return null
  return { type, payload: payload as Record<string, unknown>, ts }
}

function fromEnvelope(envelope: EventEnvelope): ListingEvent | null {
  if (!LISTING_BUS_TYPES.has(envelope.type)) return null
  return {
    type: envelope.type,
    ...(envelope.payload as Record<string, unknown>),
    ts: Date.parse(envelope.occurredAt),
  } as ListingEvent
}

/**
 * The types this bus carries. A remote event outside this set belongs to some
 * other subscriber — the listing bus must not deliver it, or an SSE client
 * would start receiving purchase orders.
 */
const LISTING_BUS_TYPES_LIST = [
  'listing.synced', 'listing.syncing', 'listing.updated', 'listing.created', 'listing.deleted',
  'wizard.submitted', 'product.updated', 'product.created', 'product.deleted',
  'bulk.progress', 'bulk.completed',
] as const satisfies readonly EventType[]

const LISTING_BUS_TYPES: ReadonlySet<string> = new Set<string>(LISTING_BUS_TYPES_LIST)

export function publishListingEvent(event: ListingEvent): void {
  // Local first and synchronously — same-process subscribers must not wait on
  // a network round trip to learn about a mutation this process just made.
  deliverLocally(event)

  const mapped = toCatalogue(event)
  if (!mapped) return
  publishEphemeralDynamic(mapped.type as EventType, mapped.payload, { occurredAt: new Date(mapped.ts) })
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

// ── remote intake ───────────────────────────────────────────────────────────

let stopRemote: (() => Promise<void>) | null = null

/**
 * Subscribe this process to listing events raised on OTHER replicas. Called
 * once at boot. Idempotent.
 *
 * BROADCAST, not a consumer group. Every replica needs its OWN copy of every
 * event because each holds different SSE connections — a shared group would
 * split the stream between replicas and each browser would see a random half
 * of the mutations, which is worse than the single-process behaviour this
 * replaces and would read as flakiness rather than a design error. A group
 * per replica would fix that and leak a group into Redis on every restart.
 * Broadcast is the primitive that matches the requirement.
 */
export async function startListingEventIntake(): Promise<void> {
  if (stopRemote) return
  try {
    stopRemote = await subscribeBroadcastEvents(getBroker(), {
      name: 'listing-sse',
      types: LISTING_BUS_TYPES_LIST,
      handler: (envelope) => {
        // Our own publish already went to the local listeners synchronously.
        if (isSelfPublished(envelope)) return
        const event = fromEnvelope(envelope)
        if (event) deliverLocally(event)
      },
    })
  } catch (error) {
    logger.warn('listing bus: remote intake unavailable, staying single-process', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

export async function stopListingEventIntake(): Promise<void> {
  await stopRemote?.()
  stopRemote = null
}
