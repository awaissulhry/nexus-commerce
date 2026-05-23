/**
 * PO.4 — In-process event bus for purchase-order mutations.
 *
 * Mirrors inbound-events.service.ts (H.14) so subscribers can react
 * to PO state changes without polling. SSE handler in
 * fulfillment.routes.ts converts each event to a wire write.
 *
 * Listener model: single-process, in-memory. Good for Xavia's scale.
 * If we ever scale horizontally on Railway, swap for Redis pub/sub —
 * the publish/subscribe API stays the same.
 *
 * Events are intentionally lean — { type, poId, ts, optional context }
 * — because subscribers refetch fresh state on receipt. Sending the
 * full PO would couple wire format to the DB shape.
 */

export type PoEvent =
  | { type: 'po.created'; poId: string; poNumber: string; ts: number }
  | {
      type: 'po.transitioned'
      poId: string
      poNumber: string
      fromStatus: string
      toStatus: string
      ts: number
    }
  | { type: 'po.updated'; poId: string; reason?: string; ts: number }
  | { type: 'po.deleted'; poId: string; ts: number }
  | { type: 'po.restored'; poId: string; ts: number }
  | { type: 'po.received'; poId: string; shipmentId: string; ts: number }
  | { type: 'ping'; ts: number }

type Listener = (event: PoEvent) => void

const listeners = new Set<Listener>()

export function publishPoEvent(event: PoEvent): void {
  for (const listener of listeners) {
    try {
      listener(event)
    } catch {
      // A misbehaving listener mustn't break the bus for others.
    }
  }
}

export function subscribePoEvents(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getPoListenerCount(): number {
  return listeners.size
}
