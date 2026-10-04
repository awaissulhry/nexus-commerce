/**
 * 6c (review G.2, Owner decision S9) — every ads decision waits for the ad product's attribution
 * window: Sponsored Products 7 days, Sponsored Brands and Display 14. Same window length as before,
 * a later end.
 */
import { describe, expect, it } from 'vitest'
import { PROVISIONAL_DAYS, ruleWindowBounds, settledEndPhrase, settledLagDays, settledWindowBounds } from './data-vintage.js'

const NOW = new Date('2026-10-04T10:30:00Z')
const day = (d: Date) => d.toISOString().slice(0, 10)

describe('settledLagDays', () => {
  it('is the attribution window per ad product', () => {
    expect(settledLagDays('SPONSORED_PRODUCTS')).toBe(7)
    expect(settledLagDays('SPONSORED_BRANDS')).toBe(14)
    expect(settledLagDays('SPONSORED_DISPLAY')).toBe(14)
    // unknown or missing reads as Sponsored Products, exactly as attributionWindowDays does
    expect(settledLagDays(null)).toBe(7)
  })

  it('the escape hatch goes back to the two provisional days for every ad product', () => {
    expect(settledLagDays('SPONSORED_PRODUCTS', 'provisional')).toBe(PROVISIONAL_DAYS)
    expect(settledLagDays('SPONSORED_BRANDS', 'provisional')).toBe(PROVISIONAL_DAYS)
  })
})

describe('settledWindowBounds', () => {
  it('Sponsored Products: 30 days ending 7 days ago (D-36..D-7)', () => {
    const w = settledWindowBounds(30, 'SPONSORED_PRODUCTS', { now: NOW })
    expect(day(w.since)).toBe('2026-08-29')
    expect(day(w.until)).toBe('2026-09-27')
    expect(w.until.toISOString()).toBe('2026-09-27T23:59:59.999Z')
    expect(w.since.toISOString()).toBe('2026-08-29T00:00:00.000Z')
    expect(w.vintage.days).toBe(30)
    expect(w.vintage.breakdown.provisional).toBe(0)
  })

  it('Sponsored Brands and Display: 7 days ending 14 days ago (D-20..D-14)', () => {
    for (const p of ['SPONSORED_BRANDS', 'SPONSORED_DISPLAY']) {
      const w = settledWindowBounds(7, p, { now: NOW })
      expect(day(w.since), p).toBe('2026-09-14')
      expect(day(w.until), p).toBe('2026-09-20')
    }
  })

  it('keeps the window length — only the end moves', () => {
    for (const n of [7, 14, 30]) {
      expect(settledWindowBounds(n, 'SPONSORED_PRODUCTS', { now: NOW }).vintage.days).toBe(n)
      expect(settledWindowBounds(n, 'SPONSORED_BRANDS', { now: NOW }).vintage.days).toBe(n)
    }
  })

  it('offsetDays gives the earlier half of a week-over-week comparison, touching the recent half', () => {
    const recent = settledWindowBounds(7, 'SPONSORED_PRODUCTS', { now: NOW })
    const prior = settledWindowBounds(7, 'SPONSORED_PRODUCTS', { now: NOW, offsetDays: 7 })
    expect(day(recent.since)).toBe('2026-09-21')
    expect(day(recent.until)).toBe('2026-09-27')
    expect(day(prior.since)).toBe('2026-09-14')
    expect(day(prior.until)).toBe('2026-09-20')
  })

  it('with the escape hatch it equals the old ruleWindowBounds exactly', () => {
    const hatch = settledWindowBounds(30, 'SPONSORED_BRANDS', { now: NOW, lag: 'provisional' })
    const old = ruleWindowBounds(30, NOW)
    expect(hatch.since.toISOString()).toBe(old.since.toISOString())
    expect(hatch.until.toISOString()).toBe(old.until.toISOString())
  })

  it('ruleWindowBounds itself is unchanged: 30 days ending 2 days ago', () => {
    const w = ruleWindowBounds(30, NOW)
    expect(day(w.since)).toBe('2026-09-03')
    expect(day(w.until)).toBe('2026-10-02')
  })
})

describe('settledEndPhrase', () => {
  it('states both lags in one phrase', () => {
    expect(settledEndPhrase()).toBe('ending 7 days ago (14 for Sponsored Brands and Display)')
  })

  it('states one lag when the escape hatch makes them equal', () => {
    expect(settledEndPhrase('provisional')).toBe(`ending ${PROVISIONAL_DAYS} days ago`)
  })
})
