// O.32 — In-process event bus for outbound shipment mutations.
//
// Mirrors listing-events.service.ts (S.4) and inbound-events.service.ts.
// SSE subscribers convert these into writes on the response stream;
// the frontend hook (use-outbound-events.ts) re-emits them through the
// existing invalidation channel so the Pending tab + drawer + sidebar
// auto-refresh within ~200ms of a Sendcloud webhook firing — no
// manual Refresh.
//
// Single-process design (fine for current Railway scale). Horizontal
// scaling later adds Redis pub/sub without changing the public API.
//
// Event payloads stay lightweight: subscribers re-fetch on receipt
// rather than apply deltas.

export type OutboundEvent =
  | { type: 'shipment.created'; shipmentId: string; orderId?: string | null; ts: number }
  | { type: 'shipment.updated'; shipmentId: string; status?: string; ts: number }
  | { type: 'shipment.deleted'; shipmentId: string; ts: number }
  | { type: 'order.shipped'; orderId: string; shipmentId?: string; channel?: string; ts: number }
  | { type: 'tracking.event'; shipmentId: string; code: string; ts: number }
  | { type: 'ping'; ts: number }


// ── EV.3 — cross-replica via the shared bus factory ─────────────────────────
//
// Signatures and synchronous behaviour are UNCHANGED: every call site is
// untouched, and a local subscriber still receives an event in the same tick.
// What changed is that a publish now also fans out to other replicas, and this
// process receives theirs — the ceiling that made a second API instance unsafe.
//
// The bus logic is lib/events/bus.ts, shared by every bus rather than copied
// into each. EPHEMERAL lane: these are refresh hints, not durable facts.

import { createCrossReplicaBus } from '../lib/events/bus.js'
import type { EventType } from '@nexus/events'

type Listener = (event: OutboundEvent) => void

/** The catalogue types this bus carries. A remote event outside this set
 *  belongs to another bus and must not be delivered here. */
const CARRIED = ['shipment.created', 'shipment.updated', 'shipment.deleted', 'order.shipped', 'tracking.event'] as const satisfies readonly EventType[]

const bus = createCrossReplicaBus<OutboundEvent>({ name: 'outbound-sse', types: CARRIED })

export function publishOutboundEvent(event: OutboundEvent): void {
  bus.publish(event)
}

export function subscribeOutboundEvents(listener: Listener): () => void {
  return bus.subscribe(listener)
}

export function getOutboundListenerCount(): number {
  return bus.listenerCount()
}

/** Attach this process to events raised on OTHER replicas. Call once at boot. */
export async function startOutboundEventIntake(): Promise<void> {
  await bus.startIntake()
}

export async function stopOutboundEventIntake(): Promise<void> {
  await bus.stopIntake()
}
