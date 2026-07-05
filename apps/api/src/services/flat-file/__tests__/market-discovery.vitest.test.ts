import { describe, it, expect } from 'vitest'
import { discoverMarkets, sortMarkets } from '../market-discovery'

describe('sortMarkets', () => {
  it('sorts with IT first, then alphabetical', () => {
    expect(sortMarkets(['UK', 'IT', 'DE', 'FR'])).toEqual(['IT', 'DE', 'FR', 'UK'])
  })

  it('deduplicates markets', () => {
    expect(sortMarkets(['IT', 'IT', 'DE', 'DE'])).toEqual(['IT', 'DE'])
  })

  it('filters out falsy values', () => {
    expect(sortMarkets(['IT', '', null, 'DE'])).toEqual(['IT', 'DE'])
  })
})

describe('discoverMarkets', () => {
  it('unions live + configured markets, IT first then alpha, dedup', async () => {
    const prisma = {
      channelListing: {
        findMany: async () => [{ marketplace: 'DE' }, { marketplace: 'IT' }, { marketplace: 'UK' }],
      },
      marketplace: {
        findMany: async () => [{ code: 'IT' }, { code: 'FR' }],
      },
    }
    expect(await discoverMarkets(prisma as any, 'AMAZON')).toEqual(['IT', 'DE', 'FR', 'UK'])
  })

  it('filters out DEFAULT and GLOBAL for non-SHOPIFY channels', async () => {
    const prisma = {
      channelListing: {
        findMany: async () => [{ marketplace: 'IT' }, { marketplace: 'DEFAULT' }],
      },
      marketplace: {
        findMany: async () => [{ code: 'GLOBAL' }, { code: 'FR' }],
      },
    }
    expect(await discoverMarkets(prisma as any, 'AMAZON')).toEqual(['IT', 'FR'])
  })

  it('keeps DEFAULT and GLOBAL for SHOPIFY channel', async () => {
    const prisma = {
      channelListing: {
        findMany: async () => [{ marketplace: 'IT' }, { marketplace: 'DEFAULT' }],
      },
      marketplace: {
        findMany: async () => [{ code: 'GLOBAL' }, { code: 'FR' }],
      },
    }
    expect(await discoverMarkets(prisma as any, 'SHOPIFY')).toEqual(['IT', 'DEFAULT', 'FR', 'GLOBAL'])
  })
})
