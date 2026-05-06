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

type Listener = (event: InboundEvent) => void

const listeners = new Set<Listener>()

export function publishInboundEvent(event: InboundEvent): void {
  for (const listener of listeners) {
    try {
      listener(event)
    } catch {
      // A misbehaving listener mustn't break the bus for others.
    }
  }
}

export function subscribeInboundEvents(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getListenerCount(): number {
  return listeners.size
}
