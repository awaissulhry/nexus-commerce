// EV.2 — oversell watchdog.
//
// The two trap tests are the reason this file exists. Both describe a way the
// watchdog would report an overcommitment that is not real, and a false alarm
// here is worse than a miss: it makes an operator "correct" stock that was
// already correct.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { findUniqueProduct, findManyStock, findManyListings, findFirstOutbox, createOutbox } = vi.hoisted(() => ({
  findUniqueProduct: vi.fn(),
  findManyStock: vi.fn(),
  findManyListings: vi.fn(),
  findFirstOutbox: vi.fn(),
  createOutbox: vi.fn(),
}))

vi.mock('../db.js', () => ({
  default: {
    product: { findUnique: findUniqueProduct },
    stockLevel: { findMany: findManyStock },
    channelListing: { findMany: findManyListings },
    eventOutbox: { findFirst: findFirstOutbox, create: createOutbox },
  },
}))
// stock-movement.service constructs BullMQ queues at module load; the watchdog
// imports its real resolver, so the queue module is stubbed rather than the
// resolver — testing against a reimplementation of the FBA rule would defeat
// the point of sharing it.
vi.mock('../lib/queue.js', () => ({
  outboundSyncQueue: {},
  addJobSafely: vi.fn(),
  redis: { connection: {} },
  resolveRedisTarget: () => ({ kind: 'host-port', host: 'localhost', port: 6379, options: {} }),
}))

import {
  computeCommitments,
  evaluateOversellRisk,
  handleStockChanged,
  type ListingRow,
} from './inventory-oversell-watchdog.service.js'

const listing = (over: Partial<ListingRow>): ListingRow => ({
  listingId: 'cl1',
  channel: 'EBAY',
  marketplace: 'IT',
  quantity: 5,
  listingStatus: 'ACTIVE',
  fulfillment: 'FBM',
  ...over,
})

const total = (rows: ListingRow[]) => computeCommitments(rows).reduce((s, c) => s + c.quantity, 0)

describe('computeCommitments — TRAP 1: FBA is not backed by the merchant pool', () => {
  it('excludes an FBA listing entirely', () => {
    // Product.totalStock sums WAREHOUSE locations only. FBA stock is
    // Amazon-managed and is not in that pool, so an FBA listing's quantity is
    // not a claim against it. Counting it invents an overcommitment.
    const rows = [
      listing({ listingId: 'fbm', channel: 'EBAY', quantity: 3 }),
      listing({ listingId: 'fba', channel: 'AMAZON', quantity: 100, fulfillment: 'FBA' }),
    ]
    expect(total(rows)).toBe(3)
    expect(computeCommitments(rows).map((c) => c.listingId)).toEqual(['fbm'])
  })

  it('counts an FBM Amazon listing normally', () => {
    expect(total([listing({ channel: 'AMAZON', quantity: 4, fulfillment: 'FBM' })])).toBe(4)
  })
})

describe('computeCommitments — TRAP 2: Amazon EU is ONE shared quantity', () => {
  it('collapses Amazon marketplaces to a single commitment instead of summing', () => {
    // Amazon holds merchant quantity at (sellerId, SKU) for the EU region.
    // IT/DE/FR are one number seen three times; summing triples it.
    const rows = [
      listing({ listingId: 'it', channel: 'AMAZON', marketplace: 'IT', quantity: 5, fulfillment: 'FBM' }),
      listing({ listingId: 'de', channel: 'AMAZON', marketplace: 'DE', quantity: 5, fulfillment: 'FBM' }),
      listing({ listingId: 'fr', channel: 'AMAZON', marketplace: 'FR', quantity: 5, fulfillment: 'FBM' }),
    ]
    expect(total(rows)).toBe(5)          // not 15
    expect(computeCommitments(rows)).toHaveLength(1)
  })

  it('reports which marketplaces were folded together', () => {
    const rows = [
      listing({ listingId: 'it', channel: 'AMAZON', marketplace: 'IT', quantity: 5, fulfillment: 'FBM' }),
      listing({ listingId: 'de', channel: 'AMAZON', marketplace: 'DE', quantity: 5, fulfillment: 'FBM' }),
    ]
    const [c] = computeCommitments(rows)
    expect(c.marketplace).toBeNull()
    expect(c.sharedWith).toEqual(['DE', 'IT'])
  })

  it('takes the MAX when the shared value disagrees — a difference is a stale read', () => {
    const rows = [
      listing({ listingId: 'it', channel: 'AMAZON', marketplace: 'IT', quantity: 2, fulfillment: 'FBM' }),
      listing({ listingId: 'de', channel: 'AMAZON', marketplace: 'DE', quantity: 7, fulfillment: 'FBM' }),
    ]
    expect(total(rows)).toBe(7)
  })

  it('does NOT collapse eBay — its quantities are genuinely per listing', () => {
    const rows = [
      listing({ listingId: 'e1', channel: 'EBAY', marketplace: 'IT', quantity: 3 }),
      listing({ listingId: 'e2', channel: 'EBAY', marketplace: 'DE', quantity: 4 }),
    ]
    expect(total(rows)).toBe(7)
    expect(computeCommitments(rows)).toHaveLength(2)
  })
})

describe('computeCommitments — what counts as a live promise', () => {
  it.each(['DRAFT', 'INACTIVE', 'ENDED', 'ERROR'])('excludes a %s listing', (listingStatus) => {
    expect(total([listing({ listingStatus, quantity: 9 })])).toBe(0)
  })

  it('excludes null and zero quantities', () => {
    expect(total([listing({ quantity: null }), listing({ listingId: 'z', quantity: 0 })])).toBe(0)
  })

  it('sums across different per-listing channels', () => {
    expect(
      total([
        listing({ listingId: 'a', channel: 'EBAY', quantity: 2 }),
        listing({ listingId: 'b', channel: 'SHOPIFY', quantity: 3 }),
      ]),
    ).toBe(5)
  })
})

describe('evaluateOversellRisk', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    findUniqueProduct.mockResolvedValue({ sku: 'SUIT-48', fulfillmentMethod: 'FBM' })
    findManyStock.mockResolvedValue([])
  })

  it('returns null when every channel fits inside the pool', async () => {
    findManyListings.mockResolvedValue([
      { id: 'e1', channel: 'EBAY', marketplace: 'IT', quantity: 2, listingStatus: 'ACTIVE', fulfillmentMethod: 'FBM' },
    ])
    expect(await evaluateOversellRisk('p1', 5)).toBeNull()
  })

  it('does NOT fire when several channels each show the whole pool', async () => {
    // THE REGRESSION THIS EXISTS FOR. Listing one pool on several channels is
    // the intended model — cascadeQuantityToListings actively maintains it. An
    // earlier draft summed the commitments, which made 9 units advertised on
    // three channels look like an overcommitment of 27 and would have alarmed
    // on every healthy multi-channel product. Caught by the live run, not by
    // the unit tests, because the fixtures encoded the same wrong assumption.
    findManyListings.mockResolvedValue([
      { id: 'a1', channel: 'AMAZON', marketplace: 'IT', quantity: 9, listingStatus: 'ACTIVE', fulfillmentMethod: 'FBM' },
      { id: 'a2', channel: 'AMAZON', marketplace: 'DE', quantity: 9, listingStatus: 'ACTIVE', fulfillmentMethod: 'FBM' },
      { id: 'e1', channel: 'EBAY', marketplace: 'IT', quantity: 9, listingStatus: 'ACTIVE', fulfillmentMethod: 'FBM' },
      { id: 's1', channel: 'SHOPIFY', marketplace: 'GLOBAL', quantity: 9, listingStatus: 'ACTIVE', fulfillmentMethod: 'FBM' },
    ])
    expect(await evaluateOversellRisk('p1', 9)).toBeNull()
  })

  it('fires when ONE channel promises more than the pool holds', async () => {
    // The real defect: the pool fell to 2, but this listing still advertises 9.
    findManyListings.mockResolvedValue([
      { id: 'stale', channel: 'EBAY', marketplace: 'IT', quantity: 9, listingStatus: 'ACTIVE', fulfillmentMethod: 'FBM' },
      { id: 'ok', channel: 'SHOPIFY', marketplace: 'GLOBAL', quantity: 2, listingStatus: 'ACTIVE', fulfillmentMethod: 'FBM' },
    ])
    const risk = await evaluateOversellRisk('p1', 2)
    expect(risk).toMatchObject({ sku: 'SUIT-48', poolAvailable: 2, maxChannelCommitment: 9, excessUnits: 7 })
    // Only the offender is reported — a healthy listing is not evidence.
    expect(risk!.commitments.map((c) => c.listingId)).toEqual(['stale'])
  })

  it('does not fire on FBA stock alone — the real-resolver path', async () => {
    // fbaBucket > 0 makes the shared resolver treat an unresolved AMAZON
    // listing as FBA. If the watchdog ever diverges from the cascade here,
    // every FBA product becomes a false alarm.
    findManyStock.mockResolvedValue([{ quantity: 50, location: { type: 'AMAZON_FBA' } }])
    findManyListings.mockResolvedValue([
      { id: 'a1', channel: 'AMAZON', marketplace: 'IT', quantity: 50, listingStatus: 'ACTIVE', fulfillmentMethod: null },
    ])
    expect(await evaluateOversellRisk('p1', 0)).toBeNull()
  })

  it('returns null for a product that no longer exists', async () => {
    findUniqueProduct.mockResolvedValue(null)
    expect(await evaluateOversellRisk('gone', 0)).toBeNull()
  })
})

describe('handleStockChanged', () => {
  const envelope = (payload: Record<string, unknown>, id = '11111111-1111-4111-8111-111111111111') =>
    ({
      id, type: 'inventory.stock_changed', version: 1, occurredAt: new Date().toISOString(),
      accountId: null, subject: 'p1', correlationId: 'c1', causationId: null, source: 'api', payload,
    }) as never

  beforeEach(() => {
    vi.clearAllMocks()
    findUniqueProduct.mockResolvedValue({ sku: 'SUIT-48', fulfillmentMethod: 'FBM' })
    findManyStock.mockResolvedValue([])
    findFirstOutbox.mockResolvedValue(null)
    findManyListings.mockResolvedValue([
      { id: 'e1', channel: 'EBAY', marketplace: 'IT', quantity: 9, listingStatus: 'ACTIVE', fulfillmentMethod: 'FBM' },
    ])
  })

  it('ignores a stock INCREASE — risk can only be created by the pool shrinking', async () => {
    await handleStockChanged(envelope({ productId: 'p1', poolTotal: 1, change: +5 }))
    expect(findManyListings).not.toHaveBeenCalled()
    expect(createOutbox).not.toHaveBeenCalled()
  })

  it('publishes a risk event on a decrease that overcommits', async () => {
    await handleStockChanged(envelope({ productId: 'p1', poolTotal: 1, change: -3 }))
    expect(createOutbox).toHaveBeenCalledTimes(1)
    const row = createOutbox.mock.calls[0]![0].data
    expect(row.type).toBe('inventory.oversell_risk_detected')
    expect(row.payload).toMatchObject({ excessUnits: 8, maxChannelCommitment: 9, poolAvailable: 1 })
  })

  it('publishes nothing when there is no excess', async () => {
    await handleStockChanged(envelope({ productId: 'p1', poolTotal: 20, change: -3 }))
    expect(createOutbox).not.toHaveBeenCalled()
  })

  it('is idempotent — a redelivered event reports once', async () => {
    // Delivery is at-least-once by contract, so this handler WILL run twice.
    findFirstOutbox.mockResolvedValue({ id: 'already-reported' })
    await handleStockChanged(envelope({ productId: 'p1', poolTotal: 1, change: -3 }))
    expect(createOutbox).not.toHaveBeenCalled()
  })
})
