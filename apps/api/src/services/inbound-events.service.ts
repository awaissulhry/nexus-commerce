/**
 * H.14 — In-process event bus for inbound shipment mutations.
 *
 * Emits structured events when inbound shipments change so SSE
 * subscribers can react without polling. Single-process design;
 * good enough for Xavia's scale (one operator, occasional second
 * user). If we ever scale horizontally on Railway, swap this for
 * Redis pub/sub or BullMQ events — the public API (publish /
 * subscribe / unsubscribe) doesn't change.
 *
 * Listener model: each subscriber gets a callback that fires on
 * every event. SSE handler converts that to a write on the
 * response stream. Caller is responsible for cleaning up via the
 * returned unsubscribe function on disconnect.
 *
 * Events are intentionally lightweight — { type, shipmentId, ts }
 * — because subscribers fetch fresh state on receipt anyway.
 * Sending the full new state through SSE would couple the wire
 * format to the DB shape and force every client to handle delta
 * application; refresh-on-event is simpler and correct.
 */

export type InboundEvent =
  | { type: 'inbound.created'; shipmentId: string; ts: number }
  | { type: 'inbound.updated'; shipmentId: string; reason?: string; ts: number }
  | { type: 'inbound.received'; shipmentId: string; ts: number }
  | { type: 'inbound.discrepancy'; shipmentId: string; ts: number }
  | { type: 'inbound.cancelled'; shipmentId: string; ts: number }
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

type Listener = (event: InboundEvent) => void

/** The catalogue types this bus carries. A remote event outside this set
 *  belongs to another bus and must not be delivered here. */
const CARRIED = ['inbound.created', 'inbound.updated', 'inbound.received', 'inbound.discrepancy', 'inbound.cancelled'] as const satisfies readonly EventType[]

const bus = createCrossReplicaBus<InboundEvent>({ name: 'inbound-sse', types: CARRIED })

export function publishInboundEvent(event: InboundEvent): void {
  bus.publish(event)
}

export function subscribeInboundEvents(listener: Listener): () => void {
  return bus.subscribe(listener)
}

export function getListenerCount(): number {
  return bus.listenerCount()
}

/** Attach this process to events raised on OTHER replicas. Call once at boot. */
export async function startInboundEventIntake(): Promise<void> {
  await bus.startIntake()
}

export async function stopInboundEventIntake(): Promise<void> {
  await bus.stopIntake()
}
