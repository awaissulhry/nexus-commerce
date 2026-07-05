import { describe, it, expect } from 'vitest'
import { fetchCatalog } from '../fetch'

// ---------------------------------------------------------------------------
// Mock Prisma — no real DB hit
// ---------------------------------------------------------------------------
const mockPrisma = {
  product: {
    findMany: async () => [
      { sku: 'P1', parent: { sku: 'PARENT' } },
      { sku: 'PARENT', parent: null },
    ],
  },
  channelListing: {
    findMany: async () => [
      { channel: 'AMAZON', marketplace: 'IT', product: { sku: 'P1' } },
      { channel: 'EBAY', marketplace: 'IT', product: { sku: 'PARENT' } },
    ],
  },
}

describe('fetchCatalog', () => {
  it('resolves parent_sku from parent relation', async () => {
    const result = await fetchCatalog(mockPrisma, { channels: ['AMAZON'] })
    const p1 = result.products.find((p: any) => p.sku === 'P1')
    expect(p1?.parent_sku).toBe('PARENT')
  })

  it('sets parent_sku to empty string when parent is null', async () => {
    const result = await fetchCatalog(mockPrisma, { channels: ['AMAZON'] })
    const parent = result.products.find((p: any) => p.sku === 'PARENT')
    expect(parent?.parent_sku).toBe('')
  })

  it('buckets listings by channel', async () => {
    const result = await fetchCatalog(mockPrisma, { channels: ['AMAZON', 'EBAY'] })
    expect(result.listings.AMAZON).toHaveLength(1)
    expect(result.listings.EBAY).toHaveLength(1)
    expect(result.listings.SHOPIFY).toHaveLength(0)
  })

  it('adds sku from joined product to each listing row', async () => {
    const result = await fetchCatalog(mockPrisma, { channels: ['AMAZON'] })
    expect(result.listings.AMAZON[0].sku).toBe('P1')
  })

  it('product rows include the raw parent relation field intact', async () => {
    const result = await fetchCatalog(mockPrisma, { channels: ['AMAZON'] })
    const p1 = result.products.find((p: any) => p.sku === 'P1')
    // The spread keeps all original fields; parent_sku is additive
    expect((p1 as any).parent).toEqual({ sku: 'PARENT' })
  })

  it('EBAY listing row carries correct sku', async () => {
    const result = await fetchCatalog(mockPrisma, { channels: ['AMAZON', 'EBAY'] })
    expect(result.listings.EBAY[0].sku).toBe('PARENT')
    expect(result.listings.EBAY[0].marketplace).toBe('IT')
  })
})
