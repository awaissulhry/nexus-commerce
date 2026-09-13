import { describe, it, expect, vi } from 'vitest'
vi.mock('../channel-delist.service.js', () => ({ dispatchChannelDelist: vi.fn(async () => ({ success: true })) }))
vi.mock('../outbound-enqueue.js', () => ({ sellerSkuForDelist: (l: any) => l.product.sku }))
import { removeAmazonListing } from './amazon-flat-file-remove.service.js'

describe('removeAmazonListing — market-scoped, Product untouched', () => {
  it('enumerates children with the same account/alias and names every selected row in fanOut', async () => {
    const coordinate = { productId: 'parent', channel: 'AMAZON', marketplace: 'IT', channelConnectionId: 'account', aliasKey: 'named-alias' }
    const read = vi.fn(async () => [coordinate, { ...coordinate, productId: 'child' }].map((c, i) => ({ ...c, id: `cl-${i}`, externalListingId: null, product: { sku: `SKU-${i}` }, offers: [] })))
    const remove = vi.fn(async () => ({ count: 2 }))
    const event = vi.fn(async () => ({}))
    const db = {
      product: { findFirst: async () => ({ id: 'parent' }), findMany: async () => [{ id: 'child' }] },
      channelListing: { findMany: read, deleteMany: remove },
      $transaction: async (fn: any) => fn({ channelListing: { deleteMany: remove }, productEvent: { create: event } }),
    }
    const r = await removeAmazonListing(db, { ...coordinate, actor: 'operator' })
    const expected = { OR: [coordinate, { ...coordinate, productId: 'child' }] }
    expect(read.mock.calls[0][0].where).toEqual(expected)
    expect(remove.mock.calls[0][0].where).toEqual(expected)
    expect(r.fanOut.map(c => c.productId)).toEqual(['parent', 'child'])
    expect(r.fanOut.every(c => c.aliasKey === 'named-alias' && c.channelConnectionId === 'account')).toBe(true)
  })
  it('removes only the AMAZON listing for the target marketplace', async () => {
    const seen: any = {}
    const prisma = {
      product: {
        findFirst: async () => ({ id: 'p1', amazonAsin: 'B00TEST' }),
        findMany: async () => [],               // no children
      },
      channelListing: {
        findMany: async () => [{ id: 'cl', productId: 'p1', channel: 'AMAZON', marketplace: 'IT', channelConnectionId: 'account', aliasKey: '', externalListingId: 'B00TEST', product: { sku: 'SELLER-SKU' }, offers: [] }],
        deleteMany: async (a: any) => { seen.where = a.where; return { count: 1 } },
      },
      // No product.update anywhere → soft-delete is structurally impossible (guard).
      $transaction: async (fn: any) => fn({
        productEvent: { create: async () => ({}) },
        channelListing: { deleteMany: async (a: any) => { seen.txWhere = a.where; return { count: 1 } } },
      }),
    }
    const res = await removeAmazonListing(prisma as any, { productId: 'p1', marketplace: 'IT', channelConnectionId: 'account', aliasKey: '', actor: 'user' })
    expect(res.error).toBeUndefined()
    expect(res.channelListingsRemoved).toBe(1)
    expect(seen.txWhere.OR[0].channel).toBe('AMAZON')
    expect(seen.txWhere.OR[0].marketplace).toBe('IT')
  })

  it('returns an error (no throw) when product is missing', async () => {
    const prisma = {
      product: { findFirst: async () => null, findMany: async () => [] },
      channelListing: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) },
      $transaction: async (fn: any) => fn({ channelListing: { deleteMany: async () => ({ count: 0 }) } }),
    }
    const res = await removeAmazonListing(prisma as any, { productId: 'nope', marketplace: 'IT', channelConnectionId: 'account', aliasKey: '', actor: 'user' })
    expect(res.error).toMatch(/not found/i)
    expect(res.channelListingsRemoved).toBe(0)
  })
})
