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
  // RT.13 — fired by the SQS poller when an ANY_OFFER_CHANGED
  // notification shows our seller is no longer holding the buy box.
  // Surfaces in the global competitive banner + (opt-in) browser
  // notification so the operator can decide whether to reprice
  // manually. (Auto-reprice lives in CE-series.)
  | {
      type: 'competitive.buyBoxLost'
      asin: string
      marketplaceId: string
      ourPrice: number | null
      winnerPrice: number | null
      currency: string
      winnerSellerId: string | null
      winnerFulfillmentType: string | null
      ts: number
    }
  | { type: 'ping'; ts: number }

type Listener = (event: OrderEvent) => void

const listeners = new Set<Listener>()

// RT.8 — replay ring buffer. Browser tabs that disconnect (laptop
// suspend, mobile network blip, idle tab pruning) silently miss
// events; on reconnect they'd previously fall back to a full refetch
// which is laggy + heavy. The ring buffer lets the client pass
// ?since=<ts> on /api/orders/events and get the missed events
// replayed before live streaming resumes.
//
// 100 events / 5 min was chosen so:
//   * a 5-min disconnect (laptop closed during lunch) almost always
//     finds its events still in the buffer
//   * a 10-min disconnect or a high-volume burst falls back gracefully
//     — the client just re-fetches (existing behaviour)
//   * memory cost is negligible (~5KB)
const REPLAY_BUFFER_MAX = 100
const REPLAY_BUFFER_TTL_MS = 5 * 60_000
const replayBuffer: OrderEvent[] = []

function trimReplayBuffer(): void {
  const cutoff = Date.now() - REPLAY_BUFFER_TTL_MS
  // Drop events older than the TTL OR beyond the size cap. We trim
  // by age first (cheaper, common case) then by size (defensive).
  while (replayBuffer.length > 0 && replayBuffer[0]!.ts < cutoff) {
    replayBuffer.shift()
  }
  while (replayBuffer.length > REPLAY_BUFFER_MAX) {
    replayBuffer.shift()
  }
}

export function publishOrderEvent(event: OrderEvent): void {
  // Don't buffer ping events — they're heartbeats, no replay value.
  if (event.type !== 'ping') {
    replayBuffer.push(event)
    trimReplayBuffer()
  }
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

/**
 * RT.8 — return events from the ring buffer with ts > sinceMs. Used
 * by /api/orders/events?since=<ts> on reconnect. Returns an empty
 * array (not throw) when the buffer is empty or sinceMs is in the
 * future — the SSE endpoint handles that as "nothing to replay,
 * resume live streaming".
 */
export function replayOrderEventsSince(sinceMs: number): OrderEvent[] {
  trimReplayBuffer()
  return replayBuffer.filter((e) => e.ts > sinceMs)
}

/**
 * RT.8 — exposed for diagnostics (push-health could surface the
 * current buffer depth in a future phase).
 */
export function getReplayBufferDepth(): number {
  trimReplayBuffer()
  return replayBuffer.length
}
