// P-RT.1 — verify productEventService.emit/emitMany fans out to the
// SSE listing-events bus so the /products workspace gets sub-200ms
// updates instead of waiting for the next 30s polling tick.
//
// We mock prisma.productEvent.create + createMany to resolve (the
// DB write is not under test). The bus is in-process; subscribers
// are notified synchronously via publishListingEvent → we can
// assert immediately after the awaited emit returns.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Mock prisma + the read-cache queue before importing the service.
vi.mock('../../db.js', () => ({
  default: {
    productEvent: {
      create: vi.fn().mockResolvedValue({}),
      createMany: vi.fn().mockResolvedValue({}),
    },
  },
}))
vi.mock('../../lib/queue.js', () => ({
  readCacheQueue: {
    // enqueueRefresh ignores the resolve value; just return something.
    add: vi.fn().mockResolvedValue({}),
  },
}))

import { productEventService } from '../product-event.service.js'
import { subscribeListingEvents } from '../listing-events.service.js'

describe('productEventService → SSE bus (P-RT.1)', () => {
  let received: any[]
  let unsubscribe: () => void

  beforeEach(() => {
    received = []
    unsubscribe = subscribeListingEvents((e) => { received.push(e) })
  })
  afterEach(() => {
    unsubscribe()
  })

  it('emit(PRODUCT_UPDATED) publishes product.updated to the bus', async () => {
    await productEventService.emit({
      aggregateId: 'p_test_1',
      aggregateType: 'Product',
      eventType: 'PRODUCT_UPDATED',
      metadata: { source: 'API' },
    })
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({
      type: 'product.updated',
      productId: 'p_test_1',
      reason: 'PRODUCT_UPDATED',
    })
    expect(typeof received[0].ts).toBe('number')
  })

  it('emit(PRODUCT_CREATED) publishes product.created', async () => {
    await productEventService.emit({
      aggregateId: 'p_test_2',
      aggregateType: 'Product',
      eventType: 'PRODUCT_CREATED',
      metadata: { source: 'OPERATOR' },
    })
    expect(received[0]).toMatchObject({ type: 'product.created', productId: 'p_test_2' })
  })

  it('emit(PRODUCT_DELETED) publishes product.deleted', async () => {
    await productEventService.emit({
      aggregateId: 'p_test_3',
      aggregateType: 'Product',
      eventType: 'PRODUCT_DELETED',
      metadata: { source: 'OPERATOR' },
    })
    expect(received[0]).toMatchObject({ type: 'product.deleted', productId: 'p_test_3' })
  })

  it('emit(PRICE_CHANGED) publishes product.updated with reason=PRICE_CHANGED', async () => {
    await productEventService.emit({
      aggregateId: 'p_test_4',
      aggregateType: 'Product',
      eventType: 'PRICE_CHANGED',
      metadata: { source: 'API' },
    })
    expect(received[0]).toMatchObject({
      type: 'product.updated',
      productId: 'p_test_4',
      reason: 'PRICE_CHANGED',
    })
  })

  it('emit(CHANNEL_LISTING_UPDATED) does NOT publish to the bus', async () => {
    // ChannelListing/SYNC_* events already get listing.* publishes from
    // the syndication routes; product-event-service should skip them
    // to avoid double-firing.
    await productEventService.emit({
      aggregateId: 'cl_test',
      aggregateType: 'ChannelListing',
      eventType: 'CHANNEL_LISTING_UPDATED',
      metadata: { source: 'API' },
    })
    expect(received).toHaveLength(0)
  })

  it('emit(SYNC_DEAD) on Product aggregate is unmapped and skipped', async () => {
    // SYNC_DEAD/SYNC_FAILED are emitted by the worker for ChannelListing
    // aggregates, but even if someone passes one with aggregateType
    // 'Product' the mapping returns null because the worker already
    // emits listing.synced{status:FAILED} for the UI to react to.
    await productEventService.emit({
      aggregateId: 'p_test_5',
      aggregateType: 'Product',
      eventType: 'SYNC_DEAD',
      metadata: { source: 'SYSTEM' },
    })
    expect(received).toHaveLength(0)
  })

  it('emitMany collapses multiple events per product into one product.updated', async () => {
    // Flat-file imports often emit TITLE_UPDATED + PRICE_CHANGED +
    // STOCK_ADJUSTED in one txn — the bus should fan out a single
    // product.updated per (productId, sseType) to keep the wire quiet.
    await productEventService.emitMany([
      { aggregateId: 'p_a', aggregateType: 'Product', eventType: 'TITLE_UPDATED', metadata: { source: 'API' } },
      { aggregateId: 'p_a', aggregateType: 'Product', eventType: 'PRICE_CHANGED', metadata: { source: 'API' } },
      { aggregateId: 'p_a', aggregateType: 'Product', eventType: 'STOCK_ADJUSTED', metadata: { source: 'API' } },
      { aggregateId: 'p_b', aggregateType: 'Product', eventType: 'TITLE_UPDATED', metadata: { source: 'API' } },
    ])
    const types = received.map((e) => `${e.type}:${e.productId}`)
    expect(types).toEqual(['product.updated:p_a', 'product.updated:p_b'])
  })
})
