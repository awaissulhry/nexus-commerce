// EV.0 — contract invariants.
//
// These are not tests of behaviour; they are the properties the catalogue has
// to hold for anything downstream to be safe. Each one has a failure mode that
// would otherwise show up as a silent production defect.

import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  EVENTS,
  EVENT_TYPES,
  getEventDefinition,
  parseEventPayload,
  deriveSubject,
  isEventType,
  eventsByContext,
  type EventDefinition,
} from './catalog.js'
import { eventEnvelopeSchema, parseEventEnvelope, serialiseEnvelope, deserialiseEnvelope } from './envelope.js'

const defs = Object.values(EVENTS) as EventDefinition[]

describe('catalogue shape', () => {
  it('registers every event under its own type string', () => {
    // A key that disagrees with its `type` makes lookup-by-type return the
    // wrong definition — and every consumer dispatches on `type`.
    for (const [key, def] of Object.entries(EVENTS)) {
      expect(def.type).toBe(key)
    }
  })

  it('has no duplicate type strings', () => {
    const types = defs.map((d) => d.type)
    expect(new Set(types).size).toBe(types.length)
  })

  it('gives every event a positive integer version', () => {
    for (const def of defs) {
      expect(Number.isInteger(def.version)).toBe(true)
      expect(def.version).toBeGreaterThan(0)
    }
  })

  it('gives every event a context and a description', () => {
    for (const def of defs) {
      expect(def.context).toBeTruthy()
      expect(def.description.length).toBeGreaterThan(10)
    }
  })

  it('exposes EVENT_TYPES sorted and complete', () => {
    expect([...EVENT_TYPES]).toEqual([...EVENT_TYPES].sort())
    expect(EVENT_TYPES.length).toBe(defs.length)
  })

  it('carries no `ts` or `ping` — time lives on the envelope, keepalive is transport', () => {
    // The nine in-process buses each carried a `ts` field and a `ping` event.
    // Both were normalised away on the way in; this is what stops them coming
    // back one payload at a time.
    expect(EVENT_TYPES).not.toContain('ping')
    for (const def of defs) {
      const shape = (def.schema as unknown as { shape?: Record<string, unknown> }).shape
      if (shape) expect(Object.keys(shape)).not.toContain('ts')
    }
  })
})

describe('payload validation', () => {
  it('rejects an unknown event type with an actionable message', () => {
    expect(() => getEventDefinition('does.not.exist')).toThrow(/Unknown event type/)
    expect(isEventType('does.not.exist')).toBe(false)
  })

  it('rejects an unknown key rather than silently stripping it', () => {
    // The failure this prevents: a publisher misspells a field, zod strips it,
    // and the event ships having quietly lost data no one notices for weeks.
    expect(() => parseEventPayload('product.updated', { productId: 'p1', raeson: 'typo' })).toThrow(
      /Invalid payload/,
    )
  })

  it('rejects a missing required field', () => {
    expect(() => parseEventPayload('listing.synced', { listingId: 'l1' })).toThrow(/Invalid payload/)
  })

  it('accepts a valid payload and returns it typed', () => {
    const payload = parseEventPayload('listing.synced', { listingId: 'l1', status: 'SUCCESS', durationMs: 12 })
    expect(payload.listingId).toBe('l1')
    expect(payload.status).toBe('SUCCESS')
  })

  it('enforces enum membership', () => {
    expect(() => parseEventPayload('listing.synced', { listingId: 'l1', status: 'MAYBE' })).toThrow()
  })
})

describe('subject derivation', () => {
  it('derives a non-empty subject for every event from a minimal payload', () => {
    // Every definition must be able to produce a partition key. A definition
    // whose extractor reads a field that does not exist returns undefined —
    // which would partition every event of that type onto the same shard and
    // silently serialise the whole platform.
    const samples: Record<string, unknown> = {
      'product.created': { productId: 'p1' },
      'product.updated': { productId: 'p1' },
      'product.deleted': { productId: 'p1' },
      'listing.created': { listingId: 'l1' },
      'listing.updated': { listingId: 'l1' },
      'listing.deleted': { listingId: 'l1' },
      'listing.syncing': { listingId: 'l1' },
      'listing.synced': { listingId: 'l1', status: 'SUCCESS' },
      'wizard.submitted': { wizardId: 'w1', productId: 'p1', status: 'LIVE' },
      'bulk.progress': { jobId: 'j1', processed: 1, total: 2, succeeded: 1, failed: 0 },
      'bulk.completed': { jobId: 'j1', status: 'DONE' },
      'inventory.stock_changed': {
        productId: 'p1', locationId: 'loc1', movementId: 'm1', change: -1,
        quantityBefore: 5, quantityAfter: 4, available: 4, poolTotal: 4, reason: 'ORDER_PLACED',
      },
      'inventory.reserved': {
        productId: 'p1', reservationId: 'rs1', locationId: 'loc1', quantity: 2, kind: 'HARD', availableAfter: 2,
      },
      'inventory.reservation_released': {
        productId: 'p1', reservationId: 'rs1', quantity: 2, kind: 'HARD', availableAfter: 4,
      },
      'inventory.reservation_consumed': { productId: 'p1', reservationId: 'rs1', quantity: 2, kind: 'HARD' },
      'inventory.stockout': {
        productId: 'p1', sku: 'SUIT-48', locationId: 'loc1', previousAvailable: 1, availableNow: 0,
      },
      'inventory.stockout_cleared': {
        productId: 'p1', sku: 'SUIT-48', locationId: null, availableNow: 3,
      },
      'inventory.oversell_risk_detected': {
        productId: 'p1', sku: 'SUIT-48', poolAvailable: 2, maxChannelCommitment: 5, excessUnits: 3,
        commitments: [{ listingId: 'cl1', channel: 'EBAY', marketplace: 'IT', quantity: 5 }],
      },
      'inbound.created': { shipmentId: 's1' },
      'inbound.updated': { shipmentId: 's1' },
      'inbound.received': { shipmentId: 's1' },
      'inbound.discrepancy': { shipmentId: 's1' },
      'inbound.cancelled': { shipmentId: 's1' },
      'shipment.created': { shipmentId: 's1' },
      'shipment.updated': { shipmentId: 's1' },
      'shipment.deleted': { shipmentId: 's1' },
      'tracking.event': { shipmentId: 's1', code: 'IN_TRANSIT' },
      'order.shipped': { orderId: 'o1' },
      'order.created': { orderId: 'o1', channel: 'SHOPIFY' },
      'order.updated': { orderId: 'o1', channel: 'SHOPIFY' },
      'order.cancelled': { orderId: 'o1' },
      'return.created': { returnId: 'r1', channel: 'SHOPIFY' },
      'analytics.salesReport.refreshed': { day: '2026-08-31', marketplacesProcessed: 3 },
      'sales.drift.detected': {
        day: '2026-08-31', marketplace: null, orderSumCents: 1, aggregateSumCents: 2, deltaCents: -1, deltaPct: 0.5,
      },
      'sync.dlq.threshold': { depth: 3, threshold: 1, queueArn: null },
      'sync.latency.breach': { channel: 'AMAZON', p95Ms: 9, thresholdMs: 5, window: '1h' },
      'sync.realtime.degraded': { reason: 'redis down' },
      'sync.oversell.clamped': { sku: 'SUIT-48', channel: 'EBAY', requested: 5, clampedTo: 2, available: 2 },
      'sync.reconcile.drift': { channel: 'AMAZON', metric: 'quantity', driftPct: 4 },
      'sync.drift.cumulative': { channel: 'AMAZON', absDriftUnits: 12, windowHours: 24 },
      'sync.conflict.stale': { count: 4, olderThanDays: 7 },
      'api-call.recorded': {
        id: 'a1', channel: 'AMAZON', marketplace: null, operation: 'putListing', statusCode: 200,
        success: true, latencyMs: 120, errorType: null, errorMessage: null,
      },
      'competitive.buyBoxLost': {
        asin: 'B01', marketplaceId: 'A1PA6795UKMFR9', ourPrice: null, winnerPrice: null,
        currency: 'EUR', winnerSellerId: null, winnerFulfillmentType: null,
      },
      'listing.suppressed': { asin: 'B01', sku: 'SKU1', marketplaceId: 'A1PA6795UKMFR9', status: 'SUPPRESSED' },
      'feed.processing.finished': { feedId: 'f1', processingStatus: 'DONE', jobId: null, productId: null },
      'flat_file_feed.status_changed': {
        feedId: 'f1', processingStatus: 'DONE', marketplace: null, productType: null,
        messagesWithError: null, terminal: true,
      },
      'ebay_push.status_changed': { jobId: 'j1', taskId: 't1', status: 'DONE', pushed: 1, failed: 0 },
      'account.health.changed': { accountStatus: 'WARNING', marketplaceId: 'A1PA6795UKMFR9' },
      'campaign.mutated': { campaignId: 'c1', channel: 'AMAZON', action: 'updated' },
      'campaign.metrics.refreshed': { channel: 'AMAZON', rows: 10 },
      'budget.rebalanced': { budgetId: 'b1', dryRun: false, totalShiftCents: 100 },
      'rule.executed': { ruleId: 'r1', executionId: 'e1', status: 'SUCCESS' },
      'automation.rule.fired': {
        executionId: null, ruleId: 'r1', ruleName: 'n', trigger: 't', status: 'CAP_EXCEEDED',
        dryRun: false, durationMs: null, marketplace: null, campaignId: null, campaignName: null,
        externalCampaignId: null, actionCount: 0,
      },
      'po.created': { poId: 'po1', poNumber: 'PO-1' },
      'po.transitioned': { poId: 'po1', poNumber: 'PO-1', fromStatus: 'DRAFT', toStatus: 'SENT' },
      'po.updated': { poId: 'po1' },
      'po.deleted': { poId: 'po1' },
      'po.restored': { poId: 'po1' },
      'po.received': { poId: 'po1', shipmentId: 's1' },
      'review.created': { reviewId: 'rv1', channel: 'AMAZON' },
      'review.negative': { reviewId: 'rv1', channel: 'AMAZON' },
      'review.spike.detected': { spikeId: 'sp1', productId: null, marketplace: 'IT', category: 'c', multiplier: null },
      'review.responded': { reviewId: 'rv1', channel: 'AMAZON' },
    }

    // Every registered event needs a sample — a new event with no sample fails
    // here rather than shipping with an unexercised subject extractor.
    for (const type of EVENT_TYPES) {
      expect(samples, `no sample payload for "${type}"`).toHaveProperty(type)
      const payload = parseEventPayload(type, samples[type])
      const subject = deriveSubject(type, payload as never)
      expect(subject, `empty subject for "${type}"`).toBeTruthy()
      expect(typeof subject).toBe('string')
    }
  })
})

describe('envelope', () => {
  const valid = {
    id: randomUUID(),
    type: 'product.updated',
    version: 1,
    occurredAt: new Date().toISOString(),
    accountId: null,
    subject: 'p1',
    correlationId: randomUUID(),
    causationId: null,
    source: 'api',
    payload: { productId: 'p1' },
  }

  it('accepts a well-formed envelope', () => {
    expect(eventEnvelopeSchema.safeParse(valid).success).toBe(true)
  })

  it('rejects a blank subject — the partition key cannot be empty', () => {
    expect(eventEnvelopeSchema.safeParse({ ...valid, subject: '' }).success).toBe(false)
  })

  it('rejects a non-uuid id — the id is the idempotency key', () => {
    expect(eventEnvelopeSchema.safeParse({ ...valid, id: 'not-a-uuid' }).success).toBe(false)
  })

  it('round-trips through serialise/deserialise unchanged', () => {
    const back = deserialiseEnvelope(serialiseEnvelope(parseEventEnvelope(valid)))
    expect(back).toEqual(valid)
  })
})

describe('context mapping', () => {
  it('the inventory context is populated (it was EMPTY before EV.2)', () => {
    // The platform moved stock constantly and published nothing about it.
    // If this ever returns to zero, the oversell watchdog has no input.
    expect(eventsByContext('inventory').length).toBeGreaterThanOrEqual(6)
  })

  it('records that order-events carried five different contexts', () => {
    // The finding that motivated the catalogue. These types all lived on ONE
    // in-process bus (order-events.service.ts) despite belonging to five
    // bounded contexts. Asserting it keeps the seam visible to whoever does
    // the extraction.
    expect(getEventDefinition('order.created').context).toBe('orders')
    expect(getEventDefinition('analytics.salesReport.refreshed').context).toBe('analytics')
    expect(getEventDefinition('sync.oversell.clamped').context).toBe('observability')
    expect(getEventDefinition('competitive.buyBoxLost').context).toBe('channel')
    expect(getEventDefinition('order.shipped').context).toBe('fulfillment')
  })

  it('assigns every event to a context that has at least one event', () => {
    for (const def of defs) {
      expect(eventsByContext(def.context).length).toBeGreaterThan(0)
    }
  })
})
