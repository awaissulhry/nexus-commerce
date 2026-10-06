/**
 * AM-33 — the AMC page counts the ad types from the campaigns as they are now, instead of a fixed sentence measured on
 * one day in August 2026. No business numbers live in the code; every arm builds its own campaigns.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { adTypeMix, adTypeMixSentence, adTypeOf, type CampaignTypeRow } from './adTypeMix'

const rows = (n: number, row: CampaignTypeRow): CampaignTypeRow[] => Array.from({ length: n }, () => ({ ...row }))

describe('which ad type a campaign is', () => {
  it('reads Amazon’s adProduct first, then the legacy type', () => {
    expect(adTypeOf({ adProduct: 'SPONSORED_BRANDS' })).toBe('brands')
    expect(adTypeOf({ adProduct: 'SPONSORED_DISPLAY' })).toBe('display')
    expect(adTypeOf({ adProduct: 'SPONSORED_TELEVISION' })).toBe('tv')
    expect(adTypeOf({ adProduct: 'SPONSORED_PRODUCTS', type: 'SP' })).toBe('products')
    expect(adTypeOf({ adProduct: null, type: 'SB' })).toBe('brands')
    expect(adTypeOf({ adProduct: null, type: 'SD' })).toBe('display')
  })
})

describe('the counts and the sentence', () => {
  it('counts enabled and paused, not archived, and says when all are paused', () => {
    const mix = adTypeMix([
      ...rows(2, { adProduct: 'SPONSORED_BRANDS', status: 'PAUSED' }),
      ...rows(3, { adProduct: 'SPONSORED_DISPLAY', status: 'PAUSED' }),
      ...rows(4, { adProduct: 'SPONSORED_DISPLAY', status: 'ARCHIVED' }),
      ...rows(9, { adProduct: 'SPONSORED_PRODUCTS', status: 'ENABLED' }),
    ])
    expect(mix).toEqual({ brands: { total: 2, enabled: 0 }, display: { total: 3, enabled: 0 }, tv: { total: 0, enabled: 0 } })
    const s = adTypeMixSentence(mix)
    expect(s.facts).toBe('This account has 2 Sponsored Brands and 3 Sponsored Display campaigns, and no Sponsored TV; all 5 are paused.')
    expect(s.meaning).toBe('An instance provisioned today would draw a diagram of one circle.')
  })

  it('when some run, it says how many and no longer claims one circle', () => {
    const mix = adTypeMix([
      ...rows(1, { adProduct: 'SPONSORED_BRANDS', status: 'ENABLED' }),
      ...rows(2, { adProduct: 'SPONSORED_DISPLAY', status: 'PAUSED' }),
      ...rows(1, { adProduct: 'SPONSORED_TELEVISION', status: 'ENABLED' }),
    ])
    const s = adTypeMixSentence(mix)
    expect(s.facts).toBe('This account has 1 Sponsored Brands and 2 Sponsored Display campaigns, and 1 Sponsored TV campaign; 2 of the 4 are enabled.')
    expect(s.meaning).toContain('With 2 campaigns beyond Sponsored Products enabled')
    expect(s.meaning).not.toContain('one circle')
  })

  it('an account with none of them says so', () => {
    const s = adTypeMixSentence(adTypeMix(rows(3, { adProduct: 'SPONSORED_PRODUCTS', status: 'ENABLED' })))
    expect(s.facts).toBe('This account has no Sponsored Brands, Sponsored Display or Sponsored TV campaigns.')
    expect(s.meaning).toContain('one circle')
  })

  it('a list cut at its limit says the counts may be short', () => {
    const s = adTypeMixSentence(adTypeMix(rows(1, { adProduct: 'SPONSORED_BRANDS', status: 'PAUSED' })), 500)
    expect(s.facts).toBe('This account has 1 Sponsored Brands and 0 Sponsored Display campaign, and no Sponsored TV; it is paused. Counted over the first 500 campaigns only.')
  })
})

describe('the page', () => {
  it('no longer states a fixed count as a current fact', () => {
    const page = readFileSync(fileURLToPath(new URL('./page.tsx', import.meta.url)), 'utf8')
    expect(page).not.toMatch(/\d+ Sponsored Brands and \d+ Sponsored Display/)
    expect(page).toContain('<AdTypeMixLine />')
  })
})
