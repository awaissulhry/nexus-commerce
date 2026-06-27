// apps/api/src/services/ebay-shared-listing-push.routing.vitest.test.ts
import { describe, it, expect, vi } from 'vitest'
import { pushSharedListings, type CapQtyFn } from './ebay-shared-listing-push.service.js'

function mockDb() {
  const created: any[] = []
  return {
    created,
    sharedListingMembership: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: any) => { created.push(data); return data }),
    },
  }
}

// A flagged family exactly as the push handler hands it to pushSharedListings:
// the full flat rows, parent carrying _isParent + shared_sku_listing.
const familyRows = [
  { sku: 'LNR-BLK', _isParent: true, shared_sku_listing: true, platformProductId: 'P', title: 'Inner Liner', category_id: '57988', condition: '1000' },
  { sku: 'SHARED-M', platformProductId: 'P', it_price: 49.9, it_qty: 9, aspect_Size: 'M', _productId: 'p1' },
  { sku: 'SHARED-L', platformProductId: 'P', it_price: 49.9, it_qty: 9, aspect_Size: 'L', _productId: 'p2' },
]

describe('Phase 4 shared-SKU routing contract', () => {
  it('publishes a flagged family via the injected addFixedPriceItem and writes one membership per variant', async () => {
    const db = mockDb()
    const addFn = vi.fn(async () => ({ itemId: '110099887766' }))
    const results = await pushSharedListings(familyRows, { oauthToken: 'TKN', market: 'IT', db, addFixedPriceItemFn: addFn })
    expect(results).toHaveLength(1)
    expect(results[0].status).toBe('CREATED')
    expect(results[0].itemId).toBe('110099887766')
    expect(addFn).toHaveBeenCalledOnce()
    // ctx.market threads through to the Trading-API call:
    expect(addFn).toHaveBeenCalledWith(expect.anything(), { oauthToken: 'TKN', market: 'IT' })
    expect(db.created).toHaveLength(2) // M + L (parent is not a sellable variant)
  })

  it('applies capToFbm-shaped capQty to each variant quantity', async () => {
    const db = mockDb()
    const addFn = vi.fn(async () => ({ itemId: 'X' }))
    // Mirror the route's capToFbm signature: (pid, sku, requested, market) => number
    const capQty: CapQtyFn = vi.fn((_pid, _sku, requested) => Math.min(requested, 3))
    await pushSharedListings(familyRows, { oauthToken: 'T', market: 'IT', db, addFixedPriceItemFn: addFn, capQty })
    // requested 9 → capped 3 on both variants
    expect(db.created.every((m) => m.lastQtyPushed === 3)).toBe(true)
    expect(capQty).toHaveBeenCalledWith('p1', 'SHARED-M', 9, 'IT')
  })
})
