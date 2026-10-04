/**
 * 6a — which ad product a campaign is, and the one refusal sentence. The mutation layer, the write gate, the
 * placement path, the marketing adapter and Claude's change tools all read these, so a Sponsored Brands or Display
 * campaign is refused in the same words everywhere and a Sponsored Products one never is.
 */
import { describe, it, expect } from 'vitest'
import { adProductOf, adProductLabel, adProductRefusal, AD_PRODUCT_UNSUPPORTED, SPONSORED_PRODUCTS } from './ads-ad-product.js'

describe('adProductOf — v1 column first, legacy type second', () => {
  it('reads the v1 adProduct column', () => {
    expect(adProductOf({ adProduct: 'SPONSORED_PRODUCTS', type: 'SP' })).toBe('SPONSORED_PRODUCTS')
    expect(adProductOf({ adProduct: 'SPONSORED_BRANDS', type: 'SB' })).toBe('SPONSORED_BRANDS')
    expect(adProductOf({ adProduct: 'SPONSORED_DISPLAY', type: 'SD' })).toBe('SPONSORED_DISPLAY')
  })

  it('falls back to the required legacy type when the v1 column is empty (old rows)', () => {
    expect(adProductOf({ adProduct: null, type: 'SP' })).toBe('SPONSORED_PRODUCTS')
    expect(adProductOf({ adProduct: '', type: 'SB' })).toBe('SPONSORED_BRANDS')
    expect(adProductOf({ type: 'SD' })).toBe('SPONSORED_DISPLAY')
    expect(adProductOf({ type: 'DSP' })).toBe('DSP')
  })

  it('the v1 column wins over a type that disagrees, as the sync writes it', () => {
    expect(adProductOf({ adProduct: 'SPONSORED_BRANDS', type: 'SP' })).toBe('SPONSORED_BRANDS')
  })

  it('an unrecognised value stays itself — never read as Sponsored Products', () => {
    expect(adProductOf({ adProduct: 'SPONSORED_TELEVISION', type: 'SP' })).toBe('SPONSORED_TELEVISION')
    expect(adProductOf({ adProduct: 'something new' })).toBe('SOMETHING NEW')
  })

  it('null when neither column says', () => {
    expect(adProductOf({})).toBeNull()
    expect(adProductOf({ adProduct: null, type: null })).toBeNull()
    expect(adProductOf(null)).toBeNull()
    expect(adProductOf(undefined)).toBeNull()
  })
})

describe('adProductRefusal — one sentence, null for Sponsored Products', () => {
  it('never refuses a Sponsored Products campaign, from either column', () => {
    expect(adProductRefusal({ adProduct: SPONSORED_PRODUCTS, name: 'Italy exact' })).toBeNull()
    expect(adProductRefusal({ type: 'SP', name: 'Italy exact' })).toBeNull()
  })

  it('refuses Sponsored Brands and Display by name, saying what it is and where to make the change', () => {
    const sb = adProductRefusal({ adProduct: 'SPONSORED_BRANDS', type: 'SB', name: 'Italy brands' })
    expect(sb).toBe("Italy brands is not a Sponsored Products campaign (it is Sponsored Brands). Nexus changes Sponsored Products campaigns only for now, so nothing was sent to Amazon; make this change in Amazon's advertising console.")
    expect(adProductRefusal({ type: 'SD', name: 'GALE Display IT' })).toMatch(/^GALE Display IT is not a Sponsored Products campaign \(it is Sponsored Display\)\./)
    expect(adProductRefusal({ type: 'DSP' })).toMatch(/^This campaign is not a Sponsored Products campaign \(it is Amazon DSP\)\./)
  })

  it('an unknown ad product is refused by default (fail closed) and allowed only when the caller says so', () => {
    expect(adProductRefusal({ name: 'Mystery' })).toMatch(/^Mystery is not a Sponsored Products campaign\. Nexus changes/)
    expect(adProductRefusal({ name: 'Mystery' }, { unknown: 'allow' })).toBeNull()
    // 'allow' is about the unknown only: a known Sponsored Brands campaign is still refused.
    expect(adProductRefusal({ type: 'SB' }, { unknown: 'allow' })).toMatch(/it is Sponsored Brands/)
  })

  it('labels and the deniedAt code', () => {
    expect(adProductLabel('SPONSORED_BRANDS')).toBe('Sponsored Brands')
    expect(adProductLabel(null)).toBeNull()
    expect(AD_PRODUCT_UNSUPPORTED).toBe('ad_product_unsupported')
  })
})
