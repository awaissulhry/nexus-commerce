/**
 * Amazon sheet gaps (D3) — the ONE fulfilment write keeps Amazon's own codes: an FBA write on a Remote Fulfilment row is
 * a no-op that keeps `AMAZON_EU_RAFN` (it used to rewrite it to `AMAZON_EU`), `AMAZON_EU` is written only when the row
 * has no Amazon code, FBM stays refused under FBA evidence, and every applied row is announced to the live views.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const s = vi.hoisted(() => ({
  listings: [] as any[],
  stock: [] as any[],
  offers: [] as any[],
  updates: [] as any[],
  announce: vi.fn(),
}))

vi.mock('../../db.js', () => {
  const channelListing = {
    findMany: async () => s.listings.map((l) => ({ ...l })),
    findUnique: async ({ where }: any) => s.listings.find((l) => l.id === where.id) ?? null,
    findFirst: async () => null,
    updateMany: async ({ where, data }: any) => {
      const row = s.listings.find((l) => l.id === where.id && l.version === where.version)
      if (!row) return { count: 0 }
      s.updates.push({ id: row.id, data })
      Object.assign(row, { fulfillmentMethod: data.fulfillmentMethod, platformAttributes: data.platformAttributes, version: row.version + 1 })
      return { count: 1 }
    },
  }
  const tx = { channelListing, product: { updateMany: async () => ({ count: 0 }), update: async () => ({}) }, offer: { findFirst: async () => null } }
  return { default: {
    channelListing,
    stockLevel: { findMany: async () => s.stock },
    offer: { findMany: async () => s.offers },
    syncControlAudit: { createMany: async () => ({ count: 1 }) },
    $transaction: async (fn: any) => fn(tx),
  } }
})
vi.mock('../stock-movement.service.js', () => ({ recascadeAfterSyncControlChange: vi.fn(async () => ({})) }))
vi.mock('../../lib/database-context.js', () => ({ afterDatabaseCommit: vi.fn(async () => {}) }))
vi.mock('../listing-values-events.js', () => ({ announceListingValues: (...a: unknown[]) => s.announce(...a) }))
vi.mock('../../utils/logger.js', () => ({ logger: { info() {}, warn() {}, error() {} } }))

import { codeHeldReason, fulfilmentAttributes, setFulfillmentMethod } from './fulfillment-method.service.js'

const row = (over: Record<string, unknown>) => ({
  id: 'l1', productId: 'p1', channel: 'AMAZON', marketplace: 'IT', fulfillmentMethod: null, platformAttributes: {}, version: 4,
  product: { sku: 'SKU-1', fulfillmentMethod: 'FBM' }, ...over,
})

beforeEach(() => { s.listings = []; s.stock = []; s.offers = []; s.updates = []; s.announce.mockReset() })

describe('FBA keeps the Amazon code the listing already carries', () => {
  it('FBA on a Remote Fulfilment row already set to FBA = no-op; the code stays AMAZON_EU_RAFN', async () => {
    const pa = { fulfillmentChannel: 'AFN', fulfillment_availability: [{ fulfillment_channel_code: 'AMAZON_EU_RAFN' }] }
    s.listings = [row({ fulfillmentMethod: 'FBA', platformAttributes: pa })]
    const r = await setFulfillmentMethod({ targets: [{ listingId: 'l1', method: 'FBA', expectedVersion: 4 }], actor: 'u' })
    expect(r.results[0]).toMatchObject({ outcome: 'noop', version: 4 })
    expect(s.updates).toEqual([])
    expect(s.announce).not.toHaveBeenCalled()
  })

  it('a code Amazon reports under .attributes is the one written, never AMAZON_EU', async () => {
    s.listings = [row({ platformAttributes: { attributes: { fulfillment_availability: [{ fulfillment_channel_code: 'AMAZON_EU2AE_RAFN' }] } } })]
    const r = await setFulfillmentMethod({ targets: [{ listingId: 'l1', method: 'FBA', expectedVersion: 4 }], actor: 'u' })
    expect(r.results[0]).toMatchObject({ outcome: 'applied', version: 5 })
    expect(s.updates[0].data.platformAttributes.fulfillment_availability).toEqual([{ fulfillment_channel_code: 'AMAZON_EU2AE_RAFN' }])
    expect(s.announce).toHaveBeenCalledWith(['l1'], ['fulfilment'], 'fulfilment-method')
  })

  it('FBA with no Amazon code writes AMAZON_EU and drops a merchant quantity', async () => {
    s.listings = [row({ platformAttributes: { fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT', quantity: 4, lead_time_to_ship_max_days: 2 }] } })]
    const r = await setFulfillmentMethod({ targets: [{ listingId: 'l1', method: 'FBA', expectedVersion: 4 }], actor: 'u' })
    expect(r.results[0].outcome).toBe('applied')
    expect(s.updates[0].data).toMatchObject({ fulfillmentMethod: 'FBA', platformAttributes: { fulfillmentChannel: 'AFN', fulfillment_availability: [{ fulfillment_channel_code: 'AMAZON_EU', lead_time_to_ship_max_days: 2 }] } })
  })

  it('pure: [{DEFAULT, qty}, {AMAZON_EU_RAFN}] → one FBA entry with the Remote Fulfilment code', () => {
    const pa = fulfilmentAttributes({ fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT', quantity: 2 }, { fulfillment_channel_code: 'AMAZON_EU_RAFN' }] }, 'AMAZON', 'FBA')
    expect(pa.fulfillment_availability).toEqual([{ fulfillment_channel_code: 'AMAZON_EU_RAFN' }])
  })
})

describe('FBM stays refused under FBA evidence', () => {
  it('FBA stock on hand → refused with the guard sentence; nothing written', async () => {
    s.listings = [row({ fulfillmentMethod: 'FBA', platformAttributes: { fulfillment_availability: [{ fulfillment_channel_code: 'AMAZON_EU' }] } })]
    s.stock = [{ productId: 'p1', quantity: 6 }]
    const r = await setFulfillmentMethod({ targets: [{ listingId: 'l1', method: 'FBM', expectedVersion: 4 }], actor: 'u' })
    expect(r.results[0]).toMatchObject({ outcome: 'refused', reason: 'Refused — 6 units of FBA stock on hand keep the guard closed; convert the offer in Seller Central first' })
    expect(s.updates).toEqual([])
  })

  it('a Remote Fulfilment code is kept: FBM and a clear are refused with the Seller Central sentence', async () => {
    s.listings = [row({ platformAttributes: { attributes: { fulfillment_availability: [{ fulfillment_channel_code: 'AMAZON_EU_RAFN' }] } } })]
    for (const method of ['FBM', null] as const) {
      const r = await setFulfillmentMethod({ targets: [{ listingId: 'l1', method, expectedVersion: 4 }], actor: 'u' })
      expect(r.results[0]).toMatchObject({ outcome: 'refused', reason: expect.stringContaining('Remote Fulfilment (EU stock → UK) is switched on in Seller Central') })
    }
    expect(s.updates).toEqual([])
  })

  it('D9 = A: an old AMAZON_EU in the copy Amazon\'s pull left does not hold FBM (only GALE is FBA, Owner 2026-10-03); Remote Fulfilment still does', () => {
    expect(codeHeldReason({ attributes: { fulfillment_availability: [{ fulfillment_channel_code: 'AMAZON_EU' }] } }, 'FBM')).toBeNull()
    expect(codeHeldReason({ attributes: { fulfillment_availability: [{ fulfillment_channel_code: 'AMAZON_EU_RAFN' }] } }, 'FBM')).toMatch(/^Refused — Remote Fulfilment/)
  })

  it('a code Nexus itself wrote (top-level AMAZON_EU) with no other evidence: FBM is written', async () => {
    s.listings = [row({ fulfillmentMethod: 'FBA', platformAttributes: { fulfillmentChannel: 'AFN', fulfillment_availability: [{ fulfillment_channel_code: 'AMAZON_EU' }] } })]
    const r = await setFulfillmentMethod({ targets: [{ listingId: 'l1', method: 'FBM', expectedVersion: 4 }], actor: 'u' })
    expect(r.results[0].outcome).toBe('applied')
    expect(s.updates[0].data.platformAttributes.fulfillment_availability).toEqual([{ fulfillment_channel_code: 'DEFAULT' }])
  })
})
