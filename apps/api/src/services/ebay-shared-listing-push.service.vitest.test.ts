import { describe, it, expect, vi } from 'vitest'
import { buildSharedListingInput, createSharedListing } from './ebay-shared-listing-push.service.js'

const parent = {
  sku: 'LNR-BLK', _isParent: true, title: 'Inner Liner', description: '<p>x</p>',
  category_id: '57988', condition: '1000', item_location_country: 'IT',
  image_1: 'https://img/a.jpg', fulfillment_policy_id: 'F1', payment_policy_id: 'P1', return_policy_id: 'R1',
}
const variants = [
  { sku: 'LNR-BLK-M', it_price: 49.9, it_qty: 5, aspect_Size: 'M', _productId: 'p1' },
  { sku: 'LNR-BLK-L', it_price: 49.9, it_qty: 3, aspect_Size: 'L', _productId: 'p2' },
]

describe('buildSharedListingInput', () => {
  const input = buildSharedListingInput(parent, variants, 'IT')

  it('derives variation axis names from aspect_* keys with >1 value', () => {
    expect(input.variationSpecificNames).toEqual(['Size'])
  })
  it('builds one variation per row with sku/price/qty/specifics', () => {
    expect(input.variations).toHaveLength(2)
    expect(input.variations[0]).toMatchObject({ sku: 'LNR-BLK-M', price: 49.9, quantity: 5, specifics: { Size: 'M' } })
    expect(input.variations[1]).toMatchObject({ sku: 'LNR-BLK-L', quantity: 3, specifics: { Size: 'L' } })
  })
  it('takes listing fields from the parent and currency/country from market', () => {
    expect(input.title).toBe('Inner Liner')
    expect(input.categoryId).toBe('57988')
    expect(input.conditionId).toBe('1000')
    expect(input.currency).toBe('EUR')
    expect(input.country).toBe('IT')
    expect(input.pictureUrls).toEqual(['https://img/a.jpg'])
    expect(input.policies).toEqual({ fulfillmentPolicyId: 'F1', paymentPolicyId: 'P1', returnPolicyId: 'R1' })
  })
  it('applies the capQty function to quantities', () => {
    const cap: any = vi.fn(() => 2)
    const capped = buildSharedListingInput(parent, variants, 'IT', cap)
    expect(capped.variations.every((v) => v.quantity === 2)).toBe(true)
    expect(cap).toHaveBeenCalledWith('p1', 'LNR-BLK-M', 5, 'IT')
  })
  it('UK market uses GBP', () => {
    expect(buildSharedListingInput(parent, [{ sku: 'X', uk_price: 9, uk_qty: 1, aspect_Size: 'M' }], 'UK').currency).toBe('GBP')
  })
})

function mockDb(existing: unknown = null) {
  const created: any[] = []
  return {
    created,
    sharedListingMembership: {
      findFirst: vi.fn(async () => existing),
      create: vi.fn(async ({ data }: any) => { created.push(data); return data }),
    },
  }
}

describe('createSharedListing', () => {
  const ctx0 = { oauthToken: 'O', market: 'IT' as const }

  it('creates the listing and one membership per variant', async () => {
    const db = mockDb(null)
    const addFn = vi.fn(async () => ({ itemId: '110556677' }))
    const res = await createSharedListing(parent, variants, { ...ctx0, db, addFixedPriceItemFn: addFn })
    expect(res.status).toBe('CREATED')
    expect(res.itemId).toBe('110556677')
    expect(res.memberships).toBe(2)
    expect(db.created).toHaveLength(2)
    expect(db.created[0]).toMatchObject({ marketplace: 'IT', sku: 'LNR-BLK-M', itemId: '110556677', parentSku: 'LNR-BLK', variationSpecifics: { Size: 'M' } })
    expect(addFn).toHaveBeenCalledOnce()
  })

  it('is idempotent: skips creation when a membership already exists', async () => {
    const db = mockDb({ id: 'x' })
    const addFn = vi.fn(async () => ({ itemId: 'NEW' }))
    const res = await createSharedListing(parent, variants, { ...ctx0, db, addFixedPriceItemFn: addFn })
    expect(res.status).toBe('SKIPPED_EXISTS')
    expect(addFn).not.toHaveBeenCalled()
    expect(db.created).toHaveLength(0)
  })

  it('returns ERROR (no throw) when the eBay call fails', async () => {
    const db = mockDb(null)
    const addFn = vi.fn(async () => { throw new Error('eBay AddFixedPriceItem Failure: Bad category') })
    const res = await createSharedListing(parent, variants, { ...ctx0, db, addFixedPriceItemFn: addFn })
    expect(res.status).toBe('ERROR')
    expect(res.message).toMatch(/Bad category/)
    expect(db.created).toHaveLength(0)
  })
})
