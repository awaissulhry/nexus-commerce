// EV.0 — the event catalogue.
//
// This file is the platform's event contract. Every event that crosses a
// process boundary is declared here, once, with a schema and an owning
// context. Nothing may be published that is not in this list — the pre-push
// guard (scripts/check-event-contract.mjs) fails a push that tries.
//
// ── What this catalogue IS ──────────────────────────────────────────────────
// A transcription. These events are not invented: they are the events the
// platform ALREADY raises, across nine in-process buses that were written
// independently and never shared a vocabulary (the `inventory` context is the
// one exception — it was EMPTY, and EV.2 added its seven events):
//
//   listing-events · inbound-events · outbound-events · order-events
//   marketing-events · ads-execution-events · po-events · review-events
//   sync-logs-events
//
// Writing them down in one place is what turns nine private EventEmitters into
// one published contract. It also surfaced something none of the nine could
// show on its own: `order-events` alone carries events from FIVE different
// bounded contexts (orders, analytics, observability, channel, fulfilment).
// That is a seam, and it is recorded here in `context` so a later extraction
// can cut along it instead of guessing.
//
// ── Two normalisations applied on the way in ────────────────────────────────
// 1. `ts` is gone from every payload. It is `occurredAt` on the envelope now.
//    A payload that carries its own timestamp invites two answers to one
//    question, and they drift.
// 2. `ping` is gone. It was an SSE keepalive — a transport concern, never a
//    domain fact. The SSE layer keeps emitting it; the bus does not carry it.
//
// Payload schemas are STRICT: an unknown key is a hard parse failure, not a
// silent strip. A publisher with a typo'd field should fail loudly at the
// boundary rather than ship an event that quietly lost data.

import { z } from 'zod'

/**
 * The bounded contexts. These are the intended service boundaries — the units
 * that may one day deploy independently — and, for now, the Postgres schema
 * names that own the corresponding tables.
 */
export type EventContext =
  | 'catalog'
  | 'inventory'
  | 'orders'
  | 'channel'
  | 'fulfillment'
  | 'purchasing'
  | 'advertising'
  | 'reviews'
  | 'analytics'
  | 'observability'
  | 'operations'

export interface EventDefinition<S extends z.ZodType = z.ZodType> {
  /** Wire type string. Unique across the catalogue. */
  readonly type: string
  /** Payload contract version. A breaking payload change ships as a new version. */
  readonly version: number
  /** Which bounded context owns (and may publish) this event. */
  readonly context: EventContext
  /** One line: what real-world fact this records. */
  readonly description: string
  /** Strict payload schema. */
  readonly schema: S
  /**
   * Derives the envelope `subject` — the aggregate id, and therefore the
   * partition key that ordering is guaranteed against. Living on the
   * definition rather than at each call site is what stops two publishers of
   * the same event from disagreeing about how it partitions.
   */
  readonly subject: (payload: z.infer<S>) => string
}

function defineEvent<S extends z.ZodType>(def: {
  type: string
  version?: number
  context: EventContext
  description: string
  schema: S
  subject: (payload: z.infer<S>) => string
}): EventDefinition<S> {
  return { version: 1, ...def }
}

// A note on versioning: the registry below is keyed by type string, and each
// definition carries `version: 1`. When a genuinely breaking payload change is
// first needed, that key gains a sibling holding both versions. Building the
// multi-version machinery before a single second version exists would be
// guessing at a shape we have no example of.

export const EVENTS = {
  // ── catalog ───────────────────────────────────────────────────────────────
  // Source: listing-events.service.ts
  'product.created': defineEvent({
    type: 'product.created',
    context: 'catalog',
    description: 'A product was created in the PIM.',
    schema: z.strictObject({ productId: z.string().min(1) }),
    subject: (p) => p.productId,
  }),
  'product.updated': defineEvent({
    type: 'product.updated',
    context: 'catalog',
    description: 'A product aggregate changed; subscribers refetch rather than apply a delta.',
    schema: z.strictObject({ productId: z.string().min(1), reason: z.string().optional() }),
    subject: (p) => p.productId,
  }),
  'product.deleted': defineEvent({
    type: 'product.deleted',
    context: 'catalog',
    description: 'A product was deleted.',
    schema: z.strictObject({ productId: z.string().min(1) }),
    subject: (p) => p.productId,
  }),
  'listing.created': defineEvent({
    type: 'listing.created',
    context: 'catalog',
    description: 'A channel listing was created.',
    schema: z.strictObject({ listingId: z.string().min(1) }),
    subject: (p) => p.listingId,
  }),
  'listing.updated': defineEvent({
    type: 'listing.updated',
    context: 'catalog',
    description: 'A channel listing changed.',
    schema: z.strictObject({ listingId: z.string().min(1), reason: z.string().optional() }),
    subject: (p) => p.listingId,
  }),
  'listing.deleted': defineEvent({
    type: 'listing.deleted',
    context: 'catalog',
    description: 'A channel listing was deleted.',
    schema: z.strictObject({ listingId: z.string().min(1) }),
    subject: (p) => p.listingId,
  }),
  'listing.syncing': defineEvent({
    type: 'listing.syncing',
    context: 'catalog',
    description: 'A listing sync started; emitted so status cells can flip to amber immediately.',
    schema: z.strictObject({ listingId: z.string().min(1) }),
    subject: (p) => p.listingId,
  }),
  'listing.synced': defineEvent({
    type: 'listing.synced',
    context: 'catalog',
    description: 'A listing sync finished, successfully or not.',
    schema: z.strictObject({
      listingId: z.string().min(1),
      status: z.enum(['SUCCESS', 'FAILED', 'TIMEOUT', 'NOT_IMPLEMENTED']),
      durationMs: z.number().int().nonnegative().optional(),
    }),
    subject: (p) => p.listingId,
  }),
  'wizard.submitted': defineEvent({
    type: 'wizard.submitted',
    context: 'catalog',
    description: 'A listing wizard left DRAFT. Partitioned by product, not wizard: the product is the aggregate.',
    schema: z.strictObject({
      wizardId: z.string().min(1),
      productId: z.string().min(1),
      status: z.enum(['SUBMITTED', 'LIVE', 'FAILED']),
    }),
    subject: (p) => p.productId,
  }),

  // ── inventory ─────────────────────────────────────────────────────────────
  // EV.2. This context was EMPTY: the platform moved stock constantly and
  // published nothing about it. Everything that needed to react had to be
  // wired into cascadeQuantityToListings by hand, which is why there is one
  // push path and no second consumer. `sync.oversell.clamped` existed only as
  // an observability symptom raised at push time, per channel, after the fact.
  'inventory.stock_changed': defineEvent({
    type: 'inventory.stock_changed',
    context: 'inventory',
    description: 'Stock moved at a location. The atomic fact behind every quantity change.',
    schema: z.strictObject({
      productId: z.string().min(1),
      locationId: z.string().min(1),
      movementId: z.string().min(1),
      change: z.number().int(),
      quantityBefore: z.number().int().nonnegative(),
      quantityAfter: z.number().int().nonnegative(),
      /** quantityAfter minus reservations at this location. */
      available: z.number().int(),
      /** Product.totalStock after the move: SUM over WAREHOUSE locations — the
       *  merchant pool. FBA and channel-mirror locations are NOT in it. */
      poolTotal: z.number().int().nonnegative(),
      reason: z.string().min(1),
      orderId: z.string().min(1).nullable().optional(),
    }),
    subject: (p) => p.productId,
  }),
  'inventory.reserved': defineEvent({
    type: 'inventory.reserved',
    context: 'inventory',
    description: 'Stock was reserved against a location. HARD reservations reduce available; SOFT are advisory.',
    schema: z.strictObject({
      productId: z.string().min(1),
      reservationId: z.string().min(1),
      locationId: z.string().min(1),
      quantity: z.number().int().positive(),
      kind: z.enum(['HARD', 'SOFT']),
      availableAfter: z.number().int(),
      orderId: z.string().min(1).nullable().optional(),
    }),
    subject: (p) => p.productId,
  }),
  'inventory.reservation_released': defineEvent({
    type: 'inventory.reservation_released',
    context: 'inventory',
    description: 'A reservation was released back to available stock, by an operator or by TTL expiry.',
    schema: z.strictObject({
      productId: z.string().min(1),
      reservationId: z.string().min(1),
      quantity: z.number().int().positive(),
      kind: z.enum(['HARD', 'SOFT']),
      availableAfter: z.number().int(),
      reason: z.string().nullable().optional(),
    }),
    subject: (p) => p.productId,
  }),
  'inventory.reservation_consumed': defineEvent({
    type: 'inventory.reservation_consumed',
    context: 'inventory',
    description: 'A reservation was consumed — the stock it held actually left.',
    schema: z.strictObject({
      productId: z.string().min(1),
      reservationId: z.string().min(1),
      quantity: z.number().int().positive(),
      kind: z.enum(['HARD', 'SOFT']),
      orderId: z.string().min(1).nullable().optional(),
    }),
    subject: (p) => p.productId,
  }),
  'inventory.stockout': defineEvent({
    type: 'inventory.stockout',
    context: 'inventory',
    description: 'Available stock at a location crossed to zero. Detected before EV.2; never published until now.',
    schema: z.strictObject({
      productId: z.string().min(1),
      sku: z.string().min(1),
      // Nullable because the detector's own hook accepts a null location —
      // matching the real shape rather than inventing a value to satisfy a
      // schema. A fabricated id would partition wrongly and read as truth.
      locationId: z.string().min(1).nullable(),
      previousAvailable: z.number().int(),
      availableNow: z.number().int(),
    }),
    subject: (p) => p.productId,
  }),
  'inventory.stockout_cleared': defineEvent({
    type: 'inventory.stockout_cleared',
    context: 'inventory',
    description: 'Available stock rose above zero again, closing an open stockout.',
    schema: z.strictObject({
      productId: z.string().min(1),
      sku: z.string().min(1),
      locationId: z.string().min(1).nullable(),
      availableNow: z.number().int().positive(),
    }),
    subject: (p) => p.productId,
  }),
  'inventory.oversell_risk_detected': defineEvent({
    type: 'inventory.oversell_risk_detected',
    context: 'inventory',
    description:
      'A single channel is publishing more units than the merchant pool can cover. NOT the sum across ' +
      'channels — listing one pool on several channels is the intended model, so a sum would flag every ' +
      'healthy multi-channel product. The real risk is one listing promising more than exists, which is ' +
      'the window between stock dropping and that channel\'s push landing.',
    schema: z.strictObject({
      productId: z.string().min(1),
      sku: z.string().min(1),
      /** The merchant pool: Product.totalStock (WAREHOUSE locations only). */
      poolAvailable: z.number().int(),
      /** The largest single-channel promise, Amazon EU counted ONCE. */
      maxChannelCommitment: z.number().int().nonnegative(),
      /** maxChannelCommitment - poolAvailable. Always > 0 when this fires. */
      excessUnits: z.number().int().positive(),
      /** ONLY the listings that individually exceed the pool. */
      commitments: z.array(
        z.strictObject({
          listingId: z.string().min(1),
          channel: z.string().min(1),
          /** Null when several marketplaces share one commitment (Amazon EU). */
          marketplace: z.string().nullable(),
          quantity: z.number().int().nonnegative(),
          /** Marketplaces folded into this one commitment, for the operator. */
          sharedWith: z.array(z.string()).optional(),
        }),
      ),
    }),
    subject: (p) => p.productId,
  }),

  // ── operations ────────────────────────────────────────────────────────────
  // Source: listing-events.service.ts (bulk job progress rides the same bus today)
  'bulk.progress': defineEvent({
    type: 'bulk.progress',
    context: 'operations',
    description: 'Progress tick for a long-running bulk job.',
    schema: z.strictObject({
      jobId: z.string().min(1),
      processed: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
      succeeded: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
    }),
    subject: (p) => p.jobId,
  }),
  'bulk.completed': defineEvent({
    type: 'bulk.completed',
    context: 'operations',
    description: 'A bulk job reached a terminal state.',
    schema: z.strictObject({ jobId: z.string().min(1), status: z.string().min(1) }),
    subject: (p) => p.jobId,
  }),

  // ── fulfillment ───────────────────────────────────────────────────────────
  // Source: inbound-events.service.ts
  'inbound.created': defineEvent({
    type: 'inbound.created',
    context: 'fulfillment',
    description: 'An inbound shipment was created.',
    schema: z.strictObject({ shipmentId: z.string().min(1) }),
    subject: (p) => p.shipmentId,
  }),
  'inbound.updated': defineEvent({
    type: 'inbound.updated',
    context: 'fulfillment',
    description: 'An inbound shipment changed.',
    schema: z.strictObject({ shipmentId: z.string().min(1), reason: z.string().optional() }),
    subject: (p) => p.shipmentId,
  }),
  'inbound.received': defineEvent({
    type: 'inbound.received',
    context: 'fulfillment',
    description: 'An inbound shipment was received into stock.',
    schema: z.strictObject({ shipmentId: z.string().min(1) }),
    subject: (p) => p.shipmentId,
  }),
  'inbound.discrepancy': defineEvent({
    type: 'inbound.discrepancy',
    context: 'fulfillment',
    description: 'A received inbound shipment did not match what was expected.',
    schema: z.strictObject({ shipmentId: z.string().min(1) }),
    subject: (p) => p.shipmentId,
  }),
  'inbound.cancelled': defineEvent({
    type: 'inbound.cancelled',
    context: 'fulfillment',
    description: 'An inbound shipment was cancelled.',
    schema: z.strictObject({ shipmentId: z.string().min(1) }),
    subject: (p) => p.shipmentId,
  }),
  // Source: outbound-events.service.ts
  'shipment.created': defineEvent({
    type: 'shipment.created',
    context: 'fulfillment',
    description: 'An outbound shipment was created.',
    schema: z.strictObject({ shipmentId: z.string().min(1), orderId: z.string().min(1).nullable().optional() }),
    subject: (p) => p.shipmentId,
  }),
  'shipment.updated': defineEvent({
    type: 'shipment.updated',
    context: 'fulfillment',
    description: 'An outbound shipment changed status.',
    schema: z.strictObject({ shipmentId: z.string().min(1), status: z.string().optional() }),
    subject: (p) => p.shipmentId,
  }),
  'shipment.deleted': defineEvent({
    type: 'shipment.deleted',
    context: 'fulfillment',
    description: 'An outbound shipment was deleted.',
    schema: z.strictObject({ shipmentId: z.string().min(1) }),
    subject: (p) => p.shipmentId,
  }),
  'tracking.event': defineEvent({
    type: 'tracking.event',
    context: 'fulfillment',
    description: 'A carrier tracking event landed for a shipment.',
    schema: z.strictObject({ shipmentId: z.string().min(1), code: z.string().min(1) }),
    subject: (p) => p.shipmentId,
  }),
  'order.shipped': defineEvent({
    type: 'order.shipped',
    context: 'fulfillment',
    description: 'An order was shipped. Partitioned by order so it stays ordered against the order lifecycle.',
    schema: z.strictObject({
      orderId: z.string().min(1),
      shipmentId: z.string().min(1).optional(),
      channel: z.string().optional(),
    }),
    subject: (p) => p.orderId,
  }),

  // ── orders ────────────────────────────────────────────────────────────────
  // Source: order-events.service.ts
  'order.created': defineEvent({
    type: 'order.created',
    context: 'orders',
    description: 'An order was created on any channel. Carries enough to increment a tile optimistically.',
    schema: z.strictObject({
      orderId: z.string().min(1),
      channel: z.string().min(1),
      channelOrderId: z.string().optional(),
      marketplace: z.string().nullable().optional(),
      fulfillmentMethod: z.string().nullable().optional(),
      totalPriceCents: z.number().int().optional(),
      currencyCode: z.string().nullable().optional(),
    }),
    subject: (p) => p.orderId,
  }),
  'order.updated': defineEvent({
    type: 'order.updated',
    context: 'orders',
    description: 'An order changed.',
    schema: z.strictObject({
      orderId: z.string().min(1),
      channel: z.string().min(1),
      status: z.string().optional(),
      marketplace: z.string().nullable().optional(),
    }),
    subject: (p) => p.orderId,
  }),
  'order.cancelled': defineEvent({
    type: 'order.cancelled',
    context: 'orders',
    description: 'An order was cancelled.',
    schema: z.strictObject({
      orderId: z.string().min(1),
      channel: z.string().optional(),
      marketplace: z.string().nullable().optional(),
      totalPriceCents: z.number().int().optional(),
    }),
    subject: (p) => p.orderId,
  }),
  'return.created': defineEvent({
    type: 'return.created',
    context: 'orders',
    description: 'A return was opened against an order.',
    schema: z.strictObject({
      returnId: z.string().min(1),
      orderId: z.string().min(1).nullable().optional(),
      channel: z.string().min(1),
    }),
    subject: (p) => p.returnId,
  }),

  // ── analytics ─────────────────────────────────────────────────────────────
  // Source: order-events.service.ts — a different context sharing one bus.
  'analytics.salesReport.refreshed': defineEvent({
    type: 'analytics.salesReport.refreshed',
    context: 'analytics',
    description: 'The Amazon T+1 sales-report ingest finished for a day.',
    schema: z.strictObject({
      day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      marketplacesProcessed: z.number().int().nonnegative(),
    }),
    subject: (p) => p.day,
  }),
  'sales.drift.detected': defineEvent({
    type: 'sales.drift.detected',
    context: 'analytics',
    description: 'Per-day revenue disagrees beyond tolerance across the order / aggregate / financial stores.',
    schema: z.strictObject({
      day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      marketplace: z.string().nullable(),
      orderSumCents: z.number().int(),
      aggregateSumCents: z.number().int(),
      deltaCents: z.number().int(),
      deltaPct: z.number(),
      financialSumCents: z.number().int().optional(),
      driftPairs: z
        .array(
          z.strictObject({
            a: z.enum(['order', 'aggregate', 'financial']),
            b: z.enum(['order', 'aggregate', 'financial']),
            deltaCents: z.number().int(),
            deltaPct: z.number(),
          }),
        )
        .optional(),
    }),
    subject: (p) => p.day,
  }),

  // ── observability ─────────────────────────────────────────────────────────
  // Source: order-events.service.ts (sync.*) and sync-logs-events.service.ts
  'sync.dlq.threshold': defineEvent({
    type: 'sync.dlq.threshold',
    context: 'observability',
    description: 'The SP-API dead-letter queue met or exceeded its depth threshold — pushes are bouncing.',
    schema: z.strictObject({
      depth: z.number().int().nonnegative(),
      threshold: z.number().int().nonnegative(),
      queueArn: z.string().nullable(),
    }),
    subject: (p) => p.queueArn ?? 'dlq',
  }),
  'sync.latency.breach': defineEvent({
    type: 'sync.latency.breach',
    context: 'observability',
    description: "A channel's p95 outbound latency exceeded its threshold.",
    schema: z.strictObject({
      channel: z.string().min(1),
      p95Ms: z.number().nonnegative(),
      thresholdMs: z.number().nonnegative(),
      window: z.string().min(1),
    }),
    subject: (p) => p.channel,
  }),
  'sync.realtime.degraded': defineEvent({
    type: 'sync.realtime.degraded',
    context: 'observability',
    description: 'The dispatch path fell back to cron-only, or a channel lost its notification token.',
    schema: z.strictObject({ reason: z.string().min(1) }),
    subject: () => 'realtime',
  }),
  'sync.oversell.clamped': defineEvent({
    type: 'sync.oversell.clamped',
    context: 'observability',
    description: 'An outbound quantity push was clamped to the backing pool — an oversell was prevented.',
    schema: z.strictObject({
      sku: z.string().min(1),
      channel: z.string().min(1),
      marketplace: z.string().nullable().optional(),
      requested: z.number().int(),
      clampedTo: z.number().int(),
      available: z.number().int(),
    }),
    subject: (p) => p.sku,
  }),
  'sync.reconcile.drift': defineEvent({
    type: 'sync.reconcile.drift',
    context: 'observability',
    description: 'Per-channel inventory drift exceeded its percentage threshold.',
    schema: z.strictObject({
      channel: z.string().min(1),
      marketplace: z.string().nullable().optional(),
      metric: z.string().min(1),
      driftPct: z.number(),
    }),
    subject: (p) => p.channel,
  }),
  'sync.drift.cumulative': defineEvent({
    type: 'sync.drift.cumulative',
    context: 'observability',
    description: 'Absolute unit drift across a rolling window breached its limit.',
    schema: z.strictObject({
      channel: z.string().min(1),
      absDriftUnits: z.number().int().nonnegative(),
      windowHours: z.number().int().positive(),
    }),
    subject: (p) => p.channel,
  }),
  'sync.conflict.stale': defineEvent({
    type: 'sync.conflict.stale',
    context: 'observability',
    description: 'Unresolved channel-stock conflicts older than the age threshold were detected.',
    schema: z.strictObject({
      count: z.number().int().nonnegative(),
      olderThanDays: z.number().int().nonnegative(),
    }),
    subject: () => 'conflicts',
  }),
  'api-call.recorded': defineEvent({
    type: 'api-call.recorded',
    context: 'observability',
    description: 'One outbound marketplace API call was recorded, with its latency and outcome.',
    schema: z.strictObject({
      id: z.string().min(1),
      channel: z.string().min(1),
      marketplace: z.string().nullable(),
      operation: z.string().min(1),
      statusCode: z.number().int().nullable(),
      success: z.boolean(),
      latencyMs: z.number().nonnegative(),
      errorType: z.string().nullable(),
      errorMessage: z.string().nullable(),
    }),
    subject: (p) => p.channel,
  }),

  // ── channel ───────────────────────────────────────────────────────────────
  // Source: order-events.service.ts — marketplace-side facts, a third context on that bus.
  'competitive.buyBoxLost': defineEvent({
    type: 'competitive.buyBoxLost',
    context: 'channel',
    description: 'ANY_OFFER_CHANGED showed our seller no longer holds the buy box.',
    schema: z.strictObject({
      asin: z.string().min(1),
      marketplaceId: z.string().min(1),
      ourPrice: z.number().nullable(),
      winnerPrice: z.number().nullable(),
      currency: z.string().min(1),
      winnerSellerId: z.string().nullable(),
      winnerFulfillmentType: z.string().nullable(),
    }),
    subject: (p) => p.asin,
  }),
  'listing.suppressed': defineEvent({
    type: 'listing.suppressed',
    context: 'channel',
    description: 'LISTINGS_ITEM_STATUS_CHANGE showed one of our listings became non-buyable.',
    schema: z.strictObject({
      asin: z.string().min(1),
      sku: z.string().min(1),
      marketplaceId: z.string().min(1),
      status: z.string().min(1),
    }),
    subject: (p) => p.sku,
  }),
  'feed.processing.finished': defineEvent({
    type: 'feed.processing.finished',
    context: 'channel',
    description: 'FEED_PROCESSING_FINISHED resolved for a submitted feed.',
    schema: z.strictObject({
      feedId: z.string().min(1),
      processingStatus: z.string().min(1),
      jobId: z.string().nullable(),
      productId: z.string().nullable(),
    }),
    subject: (p) => p.feedId,
  }),
  'flat_file_feed.status_changed': defineEvent({
    type: 'flat_file_feed.status_changed',
    context: 'channel',
    description: 'A JSON_LISTINGS_FEED submission changed status.',
    schema: z.strictObject({
      feedId: z.string().min(1),
      processingStatus: z.string().min(1),
      marketplace: z.string().nullable(),
      productType: z.string().nullable(),
      messagesWithError: z.number().int().nullable(),
      terminal: z.boolean(),
    }),
    subject: (p) => p.feedId,
  }),
  'ebay_push.status_changed': defineEvent({
    type: 'ebay_push.status_changed',
    context: 'channel',
    description: 'An eBay feed-mode push job resolved.',
    schema: z.strictObject({
      jobId: z.string().min(1),
      taskId: z.string().min(1),
      status: z.string().min(1),
      pushed: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
    }),
    subject: (p) => p.jobId,
  }),
  'account.health.changed': defineEvent({
    type: 'account.health.changed',
    context: 'channel',
    description: 'ACCOUNT_STATUS_CHANGED — suspension, warning or policy violation. Account-level outage.',
    schema: z.strictObject({
      accountStatus: z.string().min(1),
      marketplaceId: z.string().min(1),
      message: z.string().optional(),
    }),
    subject: (p) => p.marketplaceId,
  }),

  // ── advertising ───────────────────────────────────────────────────────────
  // Source: marketing-events.service.ts
  'campaign.mutated': defineEvent({
    type: 'campaign.mutated',
    context: 'advertising',
    description: 'A campaign on any channel was created, updated, status-changed or deleted.',
    schema: z.strictObject({
      campaignId: z.string().min(1),
      channel: z.string().min(1),
      action: z.enum(['created', 'updated', 'status', 'deleted']),
    }),
    subject: (p) => p.campaignId,
  }),
  'campaign.metrics.refreshed': defineEvent({
    type: 'campaign.metrics.refreshed',
    context: 'advertising',
    description: 'Daily performance metrics were refreshed for a channel/marketplace window.',
    schema: z.strictObject({
      channel: z.string().min(1),
      marketplace: z.string().nullable().optional(),
      rows: z.number().int().nonnegative(),
    }),
    subject: (p) => p.channel,
  }),
  'budget.rebalanced': defineEvent({
    type: 'budget.rebalanced',
    context: 'advertising',
    description: 'A cross-channel budget pool finished a rebalance.',
    schema: z.strictObject({
      budgetId: z.string().min(1),
      dryRun: z.boolean(),
      totalShiftCents: z.number().int(),
    }),
    subject: (p) => p.budgetId,
  }),
  'rule.executed': defineEvent({
    type: 'rule.executed',
    context: 'advertising',
    description: 'A marketing-domain automation rule executed.',
    schema: z.strictObject({
      ruleId: z.string().min(1),
      executionId: z.string().min(1),
      status: z.string().min(1),
    }),
    subject: (p) => p.ruleId,
  }),
  // Source: ads-execution-events.service.ts
  'automation.rule.fired': defineEvent({
    type: 'automation.rule.fired',
    context: 'advertising',
    description:
      'An advertising automation rule fired. executionId is null for CAP_EXCEEDED — a cap refusal is not work, ' +
      'so it persists no execution row, but the event still fires so a capped rule stays visible.',
    schema: z.strictObject({
      executionId: z.string().min(1).nullable(),
      ruleId: z.string().min(1),
      ruleName: z.string(),
      trigger: z.string(),
      status: z.enum(['SUCCESS', 'PARTIAL', 'FAILED', 'DRY_RUN', 'CAP_EXCEEDED']),
      dryRun: z.boolean(),
      durationMs: z.number().nonnegative().nullable(),
      marketplace: z.string().nullable(),
      campaignId: z.string().nullable(),
      campaignName: z.string().nullable(),
      externalCampaignId: z.string().nullable(),
      actionCount: z.number().int().nonnegative(),
    }),
    subject: (p) => p.ruleId,
  }),

  // ── purchasing ────────────────────────────────────────────────────────────
  // Source: po-events.service.ts
  'po.created': defineEvent({
    type: 'po.created',
    context: 'purchasing',
    description: 'A purchase order was created.',
    schema: z.strictObject({ poId: z.string().min(1), poNumber: z.string().min(1) }),
    subject: (p) => p.poId,
  }),
  'po.transitioned': defineEvent({
    type: 'po.transitioned',
    context: 'purchasing',
    description: 'A purchase order moved between statuses.',
    schema: z.strictObject({
      poId: z.string().min(1),
      poNumber: z.string().min(1),
      fromStatus: z.string().min(1),
      toStatus: z.string().min(1),
    }),
    subject: (p) => p.poId,
  }),
  'po.updated': defineEvent({
    type: 'po.updated',
    context: 'purchasing',
    description: 'A purchase order changed.',
    schema: z.strictObject({ poId: z.string().min(1), reason: z.string().optional() }),
    subject: (p) => p.poId,
  }),
  'po.deleted': defineEvent({
    type: 'po.deleted',
    context: 'purchasing',
    description: 'A purchase order was deleted.',
    schema: z.strictObject({ poId: z.string().min(1) }),
    subject: (p) => p.poId,
  }),
  'po.restored': defineEvent({
    type: 'po.restored',
    context: 'purchasing',
    description: 'A deleted purchase order was restored.',
    schema: z.strictObject({ poId: z.string().min(1) }),
    subject: (p) => p.poId,
  }),
  'po.received': defineEvent({
    type: 'po.received',
    context: 'purchasing',
    description: 'A purchase order was received against an inbound shipment.',
    schema: z.strictObject({ poId: z.string().min(1), shipmentId: z.string().min(1) }),
    subject: (p) => p.poId,
  }),

  // ── reviews ───────────────────────────────────────────────────────────────
  // Source: review-events.service.ts
  'review.created': defineEvent({
    type: 'review.created',
    context: 'reviews',
    description: 'A product review landed on any channel.',
    schema: z.strictObject({
      reviewId: z.string().min(1),
      channel: z.string().min(1),
      marketplace: z.string().nullable().optional(),
      rating: z.number().nullable().optional(),
      label: z.enum(['POSITIVE', 'NEUTRAL', 'NEGATIVE']).nullable().optional(),
      productId: z.string().nullable().optional(),
    }),
    subject: (p) => p.reviewId,
  }),
  'review.negative': defineEvent({
    type: 'review.negative',
    context: 'reviews',
    description: 'Fired in addition to review.created when sentiment is NEGATIVE or rating <= 2.',
    schema: z.strictObject({
      reviewId: z.string().min(1),
      channel: z.string().min(1),
      marketplace: z.string().nullable().optional(),
      rating: z.number().nullable().optional(),
      productId: z.string().nullable().optional(),
      productName: z.string().nullable().optional(),
      excerpt: z.string().optional(),
    }),
    subject: (p) => p.reviewId,
  }),
  'review.spike.detected': defineEvent({
    type: 'review.spike.detected',
    context: 'reviews',
    description: 'An abnormal rate of reviews was detected for a product or category.',
    schema: z.strictObject({
      spikeId: z.string().min(1),
      productId: z.string().nullable(),
      marketplace: z.string().min(1),
      category: z.string().min(1),
      multiplier: z.number().nullable(),
    }),
    subject: (p) => p.spikeId,
  }),
  'review.responded': defineEvent({
    type: 'review.responded',
    context: 'reviews',
    description: 'A response was posted to a review.',
    schema: z.strictObject({ reviewId: z.string().min(1), channel: z.string().min(1) }),
    subject: (p) => p.reviewId,
  }),
} as const satisfies Record<string, EventDefinition>

// ── derived types + lookups ─────────────────────────────────────────────────

export type EventType = keyof typeof EVENTS

/** The validated payload type for one event type. */
export type EventPayload<T extends EventType> = z.infer<(typeof EVENTS)[T]['schema']>

/** Every registered type, sorted. Used by the pre-push contract guard. */
export const EVENT_TYPES: readonly EventType[] = Object.freeze(
  (Object.keys(EVENTS) as EventType[]).sort(),
)

export function isEventType(type: string): type is EventType {
  return Object.prototype.hasOwnProperty.call(EVENTS, type)
}

export function getEventDefinition(type: string): EventDefinition {
  if (!isEventType(type)) {
    throw new Error(
      `Unknown event type "${type}". Every event must be declared in packages/events/catalog.ts — ` +
        `publishing an undeclared event is what the contract exists to prevent.`,
    )
  }
  return EVENTS[type] as EventDefinition
}

/**
 * Validate a payload against its declared schema. Strict: an unknown key is a
 * failure, not a silent strip.
 */
export function parseEventPayload<T extends EventType>(type: T, payload: unknown): EventPayload<T> {
  const def = getEventDefinition(type)
  const result = def.schema.safeParse(payload)
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
    throw new Error(`Invalid payload for event "${type}": ${detail}`)
  }
  return result.data as EventPayload<T>
}

/** Derive the partition key for an already-validated payload. */
export function deriveSubject<T extends EventType>(type: T, payload: EventPayload<T>): string {
  const def = getEventDefinition(type)
  const subject = def.subject(payload)
  if (typeof subject !== 'string' || subject.length === 0) {
    throw new Error(`Event "${type}" derived an empty subject; a subject is the partition key and cannot be blank.`)
  }
  return subject
}

export function eventsByContext(context: EventContext): EventDefinition[] {
  return (Object.values(EVENTS) as EventDefinition[]).filter((d) => d.context === context)
}
