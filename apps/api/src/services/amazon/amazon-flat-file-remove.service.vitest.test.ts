import { describe, it, expect } from 'vitest'
import { removeAmazonListing } from './amazon-flat-file-remove.service.js'

describe('removeAmazonListing — market-scoped, Product untouched', () => {
  it('removes only the AMAZON listing for the target marketplace', async () => {
    const seen: any = {}
    const prisma = {
      product: {
        findFirst: async () => ({ id: 'p1', amazonAsin: 'B00TEST' }),
        findMany: async () => [],               // no children
      },
      channelListing: {
        findMany: async () => [{ externalListingId: 'B00TEST' }],
        deleteMany: async (a: any) => { seen.where = a.where; return { count: 1 } },
      },
      // No product.update anywhere → soft-delete is structurally impossible (guard).
      $transaction: async (fn: any) => fn({
        channelListing: { deleteMany: async (a: any) => { seen.txWhere = a.where; return { count: 1 } } },
      }),
    }
    const res = await removeAmazonListing(prisma as any, { productId: 'p1', marketplace: 'IT' })
    expect(res.error).toBeUndefined()
    expect(res.channelListingsRemoved).toBe(1)
    expect(seen.txWhere.channel).toBe('AMAZON')
    expect(seen.txWhere.marketplace).toBe('IT')
  })

  it('returns an error (no throw) when product is missing', async () => {
    const prisma = {
      product: { findFirst: async () => null, findMany: async () => [] },
      channelListing: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) },
      $transaction: async (fn: any) => fn({ channelListing: { deleteMany: async () => ({ count: 0 }) } }),
    }
    const res = await removeAmazonListing(prisma as any, { productId: 'nope', marketplace: 'IT' })
    expect(res.error).toMatch(/not found/i)
    expect(res.channelListingsRemoved).toBe(0)
  })
})
