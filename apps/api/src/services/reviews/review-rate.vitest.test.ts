/**
 * Reviews — the ONE review rate (audit C2, B2): requests a review followed ÷ requests sent where a review can follow;
 * where none can, "not measurable" in words — never 0 %. Pure.
 */
import { describe, expect, it } from 'vitest'
import { notMeasurableWords, rateKey, rateMeasurable, rateOf, ratePercent, reviewedKeysOf, type RateFacts } from './review-rate.service.js'

const facts = (keys: string[], ebayLinked = false): RateFacts => ({ reviewedKeys: new Set(keys), ebayLinked })
const sent = (channel: string, marketplace: string | null, followed = false) => ({ channel, marketplace, followed })

describe('where a review can follow a request', () => {
  it('eBay: only once eBay feedback in Nexus is linked to its order (feedback names no product)', () => {
    expect(rateMeasurable('EBAY', 'DE', facts(['EBAY|IT']))).toBe(false)
    expect(rateMeasurable('EBAY', 'DE', facts([], true))).toBe(true)
  })

  it('every other channel: reviews of that channel and market are in Nexus', () => {
    expect(rateMeasurable('AMAZON', 'DE', facts([rateKey('AMAZON', 'de')]))).toBe(true)
    expect(rateMeasurable('AMAZON', 'IT', facts([rateKey('AMAZON', 'DE')]))).toBe(false)
    expect(rateMeasurable('SHOPIFY', null, facts(['SHOPIFY|']))).toBe(true)
  })

  it('Amazon seller feedback never makes a market measurable: only 1–3 star rows about the seller, so no product rate', () => {
    expect([...reviewedKeysOf([{ channel: 'AMAZON', marketplace: 'IT', kind: 'SELLER' }])]).toEqual([])
    const rows = [sent('AMAZON', 'IT'), sent('AMAZON', 'IT')]
    const r = rateOf(rows, { reviewedKeys: reviewedKeysOf([{ channel: 'AMAZON', marketplace: 'IT', kind: 'SELLER' }]), ebayLinked: false })
    expect(r).toMatchObject({ sent: 2, measured: 0, rate: null })
    expect(r.words).toMatch(/^Not measurable: Amazon gives no review count/)
  })

  it('an imported Amazon review opens its market, and so does a row stored before the kind column', () => {
    expect([...reviewedKeysOf([
      { channel: 'AMAZON', marketplace: 'DE', kind: 'PRODUCT' },
      { channel: 'AMAZON', marketplace: 'FR', kind: null },
      { channel: 'EBAY', marketplace: 'IT', kind: 'SELLER' },
      { channel: 'SHOPIFY', marketplace: null, kind: 'PRODUCT' },
    ])]).toEqual(['AMAZON|DE', 'AMAZON|FR', 'EBAY|IT', 'SHOPIFY|'])
  })
})

describe('rateOf', () => {
  it('counts only the measurable requests, and says how many it leaves out', () => {
    const r = rateOf([sent('AMAZON', 'DE', true), sent('AMAZON', 'DE'), sent('AMAZON', 'DE'), sent('AMAZON', 'DE'), sent('AMAZON', 'IT')], facts(['AMAZON|DE']))
    expect(r).toMatchObject({ sent: 5, measured: 4, followed: 1, rate: 0.25 })
    expect(r.words).toBe('1 of 5 sent where no review can be matched yet — left out of the rate.')
    expect(ratePercent(r)).toBe(25)
  })

  it('nothing measurable: no rate, and the words say why — never 0 %', () => {
    const ebay = rateOf([sent('EBAY', 'DE'), sent('EBAY', 'IT')], facts([]))
    expect(ebay).toMatchObject({ sent: 2, measured: 0, rate: null })
    expect(ebay.words).toMatch(/^Not measurable: no eBay feedback in Nexus is linked to its order yet/)
    expect(rateOf([sent('AMAZON', 'IT')], facts([])).words).toMatch(/^Not measurable: Amazon gives no review count/)
    expect(notMeasurableWords([{ channel: 'AMAZON' }, { channel: 'EBAY' }])).toMatch(/^Not measurable: no review that could follow/)
    // Lane N6 — Shopify keeps no reviews itself: they come from the store's review app.
    expect(rateOf([sent('SHOPIFY', null)], facts(['AMAZON|IT'])).words).toBe('Not measurable: no Shopify review is in Nexus yet — Shopify keeps none itself; connect the store’s review app to count them.')
    expect(rateOf([sent('SHOPIFY', null, true)], facts(['SHOPIFY|']))).toMatchObject({ measured: 1, followed: 1, rate: 1, words: null })
    expect(rateOf([], facts([]))).toEqual({ sent: 0, measured: 0, followed: 0, rate: null, words: null })
  })
})
