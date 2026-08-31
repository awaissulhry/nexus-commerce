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
  // P4 — fired hourly by the latency-watchdog cron when a channel's
  // p95 outbound latency exceeds the configured threshold
  // (NEXUS_LATENCY_P95_BREACH_MS, default 60000ms). Surfaces a
  // persistent operator alert so prolonged sync degradation is never
  // silent. Read-only + emit-only — the watchdog never blocks a push.
  | { type: 'sync.latency.breach'; channel: string; p95Ms: number; thresholdMs: number; window: string; ts: number }
  // P4 — fired by the latency-watchdog cron when the dispatch path
  // is cron-60s-only (queue workers off or Redis absent) OR an active
  // eBay connection has no notification token. Signals that real-time
  // inventory sync is not wired correctly.
  | { type: 'sync.realtime.degraded'; reason: string; ts: number }
  // P2 — an outbound push was clamped to the backing pool (oversell prevented).
  // Surfaced via RT alerting so a clamp is never silent.
  | {
      type: 'sync.oversell.clamped'
      sku: string
      channel: string
      marketplace?: string | null
      requested: number
      clampedTo: number
      available: number
      ts: number
    }
  // P5.1 — fired by the reconciliation cron when per-channel inventory
  // drift exceeds the configured percentage threshold. Surfaces an
  // operator alert so stock discrepancies don't accumulate silently.
  | { type: 'sync.reconcile.drift'; channel: string; marketplace?: string | null; metric: string; driftPct: number; ts: number }
  // P5.1 — fired by the cumulative-drift watchdog when the absolute
  // unit drift across a rolling window breaches the configured limit.
  | { type: 'sync.drift.cumulative'; channel: string; absDriftUnits: number; windowHours: number; ts: number }
  // P5.1 — fired by the stale-conflict sweeper when unresolved
  // channel-stock conflicts older than the configured age threshold
  // are detected. Count + age surface in the operator alert banner.
  | { type: 'sync.conflict.stale'; count: number; olderThanDays: number; ts: number }
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
  // RT.14 — fired by the SQS poller when LISTINGS_ITEM_STATUS_CHANGE
  // shows one of our listings entered a suppressed / non-buyable
  // state. Surfaces as an urgent alert + (opt-in) browser
  // notification so the operator can investigate the cause (image
  // / brand-restriction / pricing-violation / etc.) before it
  // drags on sales for hours.
  | {
      type: 'listing.suppressed'
      asin: string
      sku: string
      marketplaceId: string
      status: string
      ts: number
    }
  // RT.15 — fired by the SQS poller when FEED_PROCESSING_FINISHED
  // resolves. Image-tab feed-status polling can stop polling that
  // jobId and refresh from the push instead.
  | {
      type: 'feed.processing.finished'
      feedId: string
      processingStatus: string
      jobId: string | null
      productId: string | null
      ts: number
    }
  // FFS.4 — a flat-file (JSON_LISTINGS_FEED) submission changed status. Any open
  // /products/amazon-flat-file tab refreshes its badges + per-SKU summary live
  // instead of waiting for a manual "Check".
  | {
      type: 'flat_file_feed.status_changed'
      feedId: string
      processingStatus: string
      marketplace: string | null
      productType: string | null
      messagesWithError: number | null
      terminal: boolean
      ts: number
    }
  // H.5 — eBay feed-mode push job resolved. Any open eBay flat-file tab
  // refreshes its push-status badge live instead of waiting for a manual poll.
  | {
      type: 'ebay_push.status_changed'
      jobId: string
      taskId: string
      status: string   // DONE | PARTIAL | FATAL
      pushed: number
      failed: number
      ts: number
    }
  // RT.16 — CRITICAL alert. ACCOUNT_STATUS_CHANGED from Amazon —
  // suspension / warning / policy violation. Surfaces as a
  // persistent red banner + browser notification + console.error
  // because account-level outages mean nothing else matters
  // until the operator addresses them.
  | {
      type: 'account.health.changed'
      accountStatus: string
      marketplaceId: string
      message?: string
      ts: number
    }
  // DA-RT.5 / DA-RT.10 — fired by the nightly sales-drift detector
  // cron when per-(day, marketplace) sums in any of the 3 stores
  // disagree beyond tolerance:
  //   Order.totalPrice sum (live DB)
  //   DailySalesAggregate.grossRevenue (cron-materialised)
  //   FinancialTransaction.grossRevenue (Amazon-confirmed)
  // Surfaces in operator alerts so the gap doesn't accumulate
  // invisibly. payload carries the delta + which pair disagrees +
  // which day + which marketplace so operator can drill into the
  // specific drift.
  | {
      type: 'sales.drift.detected'
      day: string                    // 'YYYY-MM-DD' (Europe/Rome)
      marketplace: string | null     // null = global (no marketplace breakdown for this day)
      // DA-RT.5 legacy fields (Order vs Aggregate). Kept for
      // backwards compat with frontend consumers that subscribed
      // before DA-RT.10 added the 3-way comparison.
      orderSumCents: number
      aggregateSumCents: number
      deltaCents: number             // orderSumCents - aggregateSumCents
      deltaPct: number               // relative to max(orderSumCents, aggregateSumCents)
      // DA-RT.10 — third store + per-pair breakdown.
      financialSumCents?: number     // null when no FinancialTransaction rows yet (e.g. recent days)
      driftPairs?: Array<{
        a: 'order' | 'aggregate' | 'financial'
        b: 'order' | 'aggregate' | 'financial'
        deltaCents: number
        deltaPct: number
      }>
      ts: number
    }
  | { type: 'ping'; ts: number }


// ── EV.3 — cross-replica via the shared bus factory ─────────────────────────
//
// Signatures, synchronous behaviour AND the replay buffer are unchanged: every
// call site is untouched, a local subscriber still receives an event in the
// same tick, and a briefly-disconnected tab still replays. What changed is
// that a publish also fans out to other replicas, and this process receives
// theirs — so a reconnecting tab replays what happened on ANY instance, not
// just the one it happens to be attached to.
//
// The bus logic is lib/events/bus.ts, shared rather than copied.

import { createCrossReplicaBus } from '../lib/events/bus.js'
import type { EventType } from '@nexus/events'

type Listener = (event: OrderEvent) => void

/** The catalogue types this bus carries. A remote event outside this set
 *  belongs to another bus and must not be delivered here. */
const CARRIED = [
  'order.created',
  'order.updated',
  'order.cancelled',
  'return.created',
  'analytics.salesReport.refreshed',
  'sales.drift.detected',
  'sync.dlq.threshold',
  'sync.latency.breach',
  'sync.realtime.degraded',
  'sync.oversell.clamped',
  'sync.reconcile.drift',
  'sync.drift.cumulative',
  'sync.conflict.stale',
  'competitive.buyBoxLost',
  'listing.suppressed',
  'feed.processing.finished',
  'flat_file_feed.status_changed',
  'ebay_push.status_changed',
  'account.health.changed',
] as const satisfies readonly EventType[]

const bus = createCrossReplicaBus<OrderEvent>({
  name: 'order-sse',
  types: CARRIED,
  // Replay ring buffer: a briefly-closed tab reconnects without a full refetch.
  replay: { max: 100, ttlMs: 5 * 60_000 },
})

export function publishOrderEvent(event: OrderEvent): void {
  bus.publish(event)
}

export function subscribeOrderEvents(listener: Listener): () => void {
  return bus.subscribe(listener)
}

export function getOrderListenerCount(): number {
  return bus.listenerCount()
}

export function replayOrderEventsSince(sinceMs: number): OrderEvent[] {
  return bus.replaySince(sinceMs)
}

export function getReplayBufferDepth(): number {
  return bus.bufferDepth()
}

/** Attach this process to events raised on OTHER replicas. Call once at boot. */
export async function startOrderEventIntake(): Promise<void> {
  await bus.startIntake()
}

export async function stopOrderEventIntake(): Promise<void> {
  await bus.stopIntake()
}
