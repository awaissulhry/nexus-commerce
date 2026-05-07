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

type Listener = (event: OutboundEvent) => void

const listeners = new Set<Listener>()

export function publishOutboundEvent(event: OutboundEvent): void {
  for (const listener of listeners) {
    try {
      listener(event)
    } catch {
      // A misbehaving listener mustn't break the bus for others.
    }
  }
}

export function subscribeOutboundEvents(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getOutboundListenerCount(): number {
  return listeners.size
}
