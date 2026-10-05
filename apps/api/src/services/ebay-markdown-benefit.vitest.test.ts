/**
 * The discount an eBay markdown sends. Nexus stores a FIXED_PRICE markdown's value as the NEW price; eBay must be sent
 * the amount off (`amountOffItem`), and a percent as `percentageOffItem` — each from eBay's preset list. Before this,
 * the new price itself went out as `amountOffOrder` (a 49.90 new price on a 59.90 listing asked eBay for 49.90 off).
 */
import { describe, expect, it } from 'vitest'
import { ebayMarkdownBenefit, isEbayMarkdownAmountCents } from './ebay-markdown-benefit.js'

describe('ebayMarkdownBenefit', () => {
  it('sends a fixed new price as the amount off the listing price', () => {
    expect(ebayMarkdownBenefit({ discountType: 'FIXED_PRICE', discountValue: 49.9, price: 59.9, currency: 'EUR' })).toEqual({
      ok: true,
      benefit: { amountOffItem: { value: '10.00', currency: 'EUR' } },
      markdownPrice: 49.9,
    })
  })

  it('sends a percent as percentageOffItem, a whole number', () => {
    expect(ebayMarkdownBenefit({ discountType: 'PERCENTAGE', discountValue: 10, price: 59.9, currency: 'EUR' })).toEqual({
      ok: true,
      benefit: { percentageOffItem: '10' },
      markdownPrice: 53.91,
    })
  })

  it('never sends an order-level field', () => {
    for (const discountType of ['PERCENTAGE', 'FIXED_PRICE'] as const) {
      const result = ebayMarkdownBenefit({ discountType, discountValue: discountType === 'PERCENTAGE' ? 20 : 40, price: 60, currency: 'GBP' })
      expect(result.ok && JSON.stringify(result.benefit)).not.toMatch(/Order/)
    }
  })

  it('refuses a percent eBay does not take', () => {
    for (const value of [4, 81, 12.5]) {
      const result = ebayMarkdownBenefit({ discountType: 'PERCENTAGE', discountValue: value, price: 59.9, currency: 'EUR' })
      expect(result).toMatchObject({ ok: false })
      expect(!result.ok && result.reason).toContain('5 to 80 %')
    }
  })

  it('refuses an amount off eBay does not take, and names new prices that work', () => {
    const result = ebayMarkdownBenefit({ discountType: 'FIXED_PRICE', discountValue: 54.0, price: 59.9, currency: 'EUR' })
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toContain('59.90 → 54.00 is 5.90 off')
    expect(!result.ok && result.reason).toContain('a new price of 54.90 or 53.90 works')
  })

  it('refuses an amount off below 5', () => {
    const result = ebayMarkdownBenefit({ discountType: 'FIXED_PRICE', discountValue: 47.9, price: 49.9, currency: 'EUR' })
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toContain('a new price of 44.90 works')
  })

  it('refuses a new price that is not below the listing price', () => {
    const result = ebayMarkdownBenefit({ discountType: 'FIXED_PRICE', discountValue: 59.9, price: 59.9, currency: 'EUR' })
    expect(result).toEqual({ ok: false, reason: 'the new price 59.90 is not below the eBay price 59.90' })
  })
})

describe('isEbayMarkdownAmountCents', () => {
  it('follows eBay\'s preset list', () => {
    const ok = [5, 6, 99, 100, 105, 110, 1000, 1100, 1200, 15000].map((n) => n * 100)
    const refused = [0, 4, 4.5, 5.5, 101, 104, 106, 1001, 1050, 1150, 15100].map((n) => Math.round(n * 100))
    for (const c of ok) expect(isEbayMarkdownAmountCents(c), `${c / 100}`).toBe(true)
    for (const c of refused) expect(isEbayMarkdownAmountCents(c), `${c / 100}`).toBe(false)
  })
})
