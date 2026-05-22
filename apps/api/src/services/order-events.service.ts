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
  // AR.4 — order.created carries enough payload for the Global Snapshot
  // to optimistically increment its tile total without waiting for the
  // server fetch. fetchSnapshot still runs in background to reconcile.
  | {
      type: 'order.created'
      orderId: string
      channel: string
      channelOrderId?: string
      marketplace?: string | null
      fulfillmentMethod?: string | null
      totalPriceCents?: number
      currencyCode?: string | null
      ts: number
    }
  | { type: 'order.updated'; orderId: string; channel: string; status?: string; marketplace?: string | null; ts: number }
  | { type: 'order.cancelled'; orderId: string; channel?: string; marketplace?: string | null; totalPriceCents?: number; ts: number }
  | { type: 'return.created'; returnId: string; orderId?: string | null; channel: string; ts: number }
  // AL.4 — fired when the nightly Amazon T+1 sales-report ingest
  // completes. Analytics surfaces that read from DailySalesAggregate
  // (e.g. /analytics/products portfolio) listen and auto-reload so
  // operators see the official numbers without manual refresh.
  | { type: 'analytics.salesReport.refreshed'; day: string; marketplacesProcessed: number; ts: number }
  // RT.2 — fired by the 5-min dlq-monitor cron whenever the Amazon
  // SP-API SQS dead-letter-queue depth meets or exceeds the
  // configured threshold (NEXUS_DLQ_THRESHOLD, default 1). A
  // non-empty DLQ means push notifications are silently bouncing —
  // GlobalDlqBanner subscribes via /api/orders/events and rings a
  // top-of-page alert + an opt-in browser notification.
  | {
      type: 'sync.dlq.threshold'
      depth: number
      threshold: number
      queueArn: string | null
      ts: number
    }
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
