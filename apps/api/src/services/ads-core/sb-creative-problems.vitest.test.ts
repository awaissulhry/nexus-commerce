/**
 * CC-11 — `sbCreativeProblems`, the one check the SB builder's preview, its pre-launch check and the create all ask.
 * Limits from Amazon's Sponsored Brands 4.0 document (`CreateManualCollectionCreative`, `CreateProductCollectionCreative`).
 */
import { describe, expect, it } from 'vitest'
import { sbCreativeProblems } from './sb-ad-types.js'

const asins = (n: number) => Array.from({ length: n }, (_, i) => `B0TEST${String(i).padStart(4, '0')}`)
const base = { headline: 'Ride in style', brandName: 'Acme' }

describe('sbCreativeProblems', () => {
  it('manual collection: 3 to 10 products, a title of up to 32 characters', () => {
    expect(sbCreativeProblems({ ...base, creativeType: 'manualCollection', asins: asins(3) })).toEqual([])
    expect(sbCreativeProblems({ ...base, creativeType: 'manualCollection', asins: asins(10) })).toEqual([])
    expect(sbCreativeProblems({ ...base, creativeType: 'manualCollection', asins: asins(2) })).toEqual(['A Manual collection creative needs at least 3 products; it has 2.'])
    expect(sbCreativeProblems({ ...base, creativeType: 'manualCollection', asins: asins(11) })).toEqual(['A Manual collection creative takes at most 10 products; it has 11.'])
    expect(sbCreativeProblems({ ...base, creativeType: 'manualCollection', asins: asins(3), headline: 'x'.repeat(33) }))
      .toEqual(['Amazon allows 32 characters in a Manual collection title; it has 33.'])
  })

  it('product collection: 1 to 3 products and a headline of up to 50 characters', () => {
    expect(sbCreativeProblems({ ...base, creativeType: 'productCollection', asins: asins(1) })).toEqual([])
    expect(sbCreativeProblems({ ...base, creativeType: 'productCollection', asins: asins(4) })).toEqual(['A Product collection creative takes at most 3 products; it has 4.'])
    expect(sbCreativeProblems({ ...base, creativeType: 'productCollection', asins: asins(1), headline: ' ' })).toEqual(['A Product collection creative needs a headline.'])
  })

  it('store spotlight and video are refused with the reason: Nexus cannot send store pages or a video', () => {
    expect(sbCreativeProblems({ ...base, creativeType: 'storeSpotlight', asins: asins(1) })[0]).toMatch(/needs store pages, which Nexus cannot send/)
    expect(sbCreativeProblems({ ...base, creativeType: 'video', asins: asins(1) })[0]).toMatch(/needs a video, which Nexus cannot send/)
  })

  it('a brand name is required, at most 30 characters', () => {
    expect(sbCreativeProblems({ ...base, brandName: '', creativeType: 'manualCollection', asins: asins(3) })).toEqual(['A Sponsored Brands creative needs a brand name.'])
    expect(sbCreativeProblems({ ...base, brandName: 'x'.repeat(31), creativeType: 'manualCollection', asins: asins(3) })[0]).toMatch(/30 characters in a brand name/)
  })

  it('an unknown type is named', () => {
    expect(sbCreativeProblems({ ...base, creativeType: 'banner', asins: asins(3) })[0]).toMatch(/"banner" is not a Sponsored Brands creative type/)
  })
})
