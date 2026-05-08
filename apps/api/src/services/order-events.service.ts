// O.6 — In-process event bus for Order/Return mutations.
//
// Mirrors outbound-events.service.ts (O.32) and inbound-events.service.ts.
// SSE subscribers convert these into writes on the response stream;
// /api/orders/events is the long-lived endpoint OrdersWorkspace
// subscribes to. Pre-O.6 the bus only carried shipment.* + tracking.*
// events, so /orders couldn't auto-refresh when:
//
//   • a new Amazon/eBay/Shopify order arrived via the ingestion cron
//     or webhook (operator had to F5 to see it)
//   • an order was cancelled (channel-driven or operator-driven)
//   • a Shopify refunds/create webhook materialised a new Return
//
// Single-process design (fine for current Railway scale). Horizontal
// scaling later adds Redis pub/sub without changing the public API.
//
// Event payloads stay lightweight: subscribers re-fetch on receipt
// rather than apply deltas. This keeps the wire format stable across
// schema changes — the only contract is "an order/return changed,
// invalidate your view."

export type OrderEvent =
  | { type: 'order.created'; orderId: string; channel: string; channelOrderId?: string; ts: number }
  | { type: 'order.updated'; orderId: string; channel: string; status?: string; ts: number }
  | { type: 'order.cancelled'; orderId: string; channel?: string; ts: number }
  | { type: 'return.created'; returnId: string; orderId?: string | null; channel: string; ts: number }
  | { type: 'ping'; ts: number }

type Listener = (event: OrderEvent) => void

const listeners = new Set<Listener>()

export function publishOrderEvent(event: OrderEvent): void {
  for (const listener of listeners) {
    try {
      listener(event)
    } catch {
      // A misbehaving listener mustn't break the bus for others.
    }
  }
}

export function subscribeOrderEvents(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getOrderListenerCount(): number {
  return listeners.size
}
