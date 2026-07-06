import { describe, it, expect } from 'vitest'
import { buildListingScopeWhere } from './listing-scope.js'

describe('buildListingScopeWhere', () => {
  it("scope 'all' → empty where (no filtering)", () => {
    expect(buildListingScopeWhere({ channel: 'EBAY', scope: 'all' })).toEqual({})
  })

  it("scope 'listed', no marketplace → channel-level family-coherent OR", () => {
    const w = buildListingScopeWhere({ channel: 'EBAY', scope: 'listed' })
    expect(w).toEqual({
      OR: [
        { channelListings: { some: { channel: 'EBAY' } } },
        { parent: { channelListings: { some: { channel: 'EBAY' } } } },
        { children: { some: { channelListings: { some: { channel: 'EBAY' } } } } },
      ],
    })
  })

  it("scope 'listed' + marketplace → channel+market-scoped listing filter", () => {
    const w = buildListingScopeWhere({ channel: 'AMAZON', marketplace: 'IT', scope: 'listed' })
    expect(w).toEqual({
      OR: [
        { channelListings: { some: { channel: 'AMAZON', marketplace: 'IT' } } },
        { parent: { channelListings: { some: { channel: 'AMAZON', marketplace: 'IT' } } } },
        { children: { some: { channelListings: { some: { channel: 'AMAZON', marketplace: 'IT' } } } } },
      ],
    })
  })
})
