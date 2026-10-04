/**
 * 6c (review G.2, Owner decision S9) — the days an ads decision may read: the same window length,
 * ending 7 days ago for Sponsored Products and 14 for every other ad product; the escape hatch
 * NEXUS_ADS_SETTLED_LAG=provisional puts back the old two-day tail.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { settledBounds, settledEndText, settledLag, settledWhere } from './ads-settled-window.js'

const NOW = new Date('2026-10-04T10:30:00Z')
const iso = (d: Date) => d.toISOString()
const HATCH = 'NEXUS_ADS_SETTLED_LAG'

afterEach(() => { delete process.env[HATCH] })

describe('settledWhere — the where part every decision query spreads', () => {
  it('reads Sponsored Products over D-36..D-7 and every other ad product over D-43..D-14 (30 days)', () => {
    expect(settledWhere(30, { now: NOW })).toEqual({
      OR: [
        { adProduct: 'SPONSORED_PRODUCTS', date: { gte: new Date('2026-08-29T00:00:00.000Z'), lte: new Date('2026-09-27T23:59:59.999Z') } },
        { adProduct: { not: 'SPONSORED_PRODUCTS' }, date: { gte: new Date('2026-08-22T00:00:00.000Z'), lte: new Date('2026-09-20T23:59:59.999Z') } },
      ],
    })
  })

  it('7 days → Sponsored Products D-13..D-7, others D-20..D-14 (was D-8..D-2 for all)', () => {
    const w7 = settledWhere(7, { now: NOW }) as { OR: Array<{ date: { gte: Date; lte: Date } }> }
    expect([iso(w7.OR[0].date.gte), iso(w7.OR[0].date.lte)]).toEqual(['2026-09-21T00:00:00.000Z', '2026-09-27T23:59:59.999Z'])
    expect([iso(w7.OR[1].date.gte), iso(w7.OR[1].date.lte)]).toEqual(['2026-09-14T00:00:00.000Z', '2026-09-20T23:59:59.999Z'])
  })

  it('offsetDays gives the earlier week of a comparison, back to back with the recent one', () => {
    const recent = settledWhere(7, { now: NOW }) as { OR: Array<{ date: { gte: Date; lte: Date } }> }
    const prior = settledWhere(7, { now: NOW, offsetDays: 7 }) as { OR: Array<{ date: { gte: Date; lte: Date } }> }
    expect(prior.OR[0].date.lte.getTime() + 1).toBe(recent.OR[0].date.gte.getTime())
    expect(prior.OR[1].date.lte.getTime() + 1).toBe(recent.OR[1].date.gte.getTime())
  })

  it('escape hatch: one plain date range ending 2 days ago, exactly the old window', () => {
    process.env[HATCH] = 'provisional'
    expect(settledLag()).toBe('provisional')
    expect(settledWhere(30, { now: NOW })).toEqual({
      date: { gte: new Date('2026-09-03T00:00:00.000Z'), lte: new Date('2026-10-02T23:59:59.999Z') },
    })
  })

  it('any other value of the variable keeps the attribution lag', () => {
    process.env[HATCH] = 'off'
    expect(settledLag()).toBe('attribution')
    expect('OR' in settledWhere(7, { now: NOW })).toBe(true)
  })
})

describe('settledBounds — one ad product', () => {
  it('defaults to Sponsored Products', () => {
    const w = settledBounds(14, undefined, { now: NOW })
    expect([iso(w.since), iso(w.until)]).toEqual(['2026-09-14T00:00:00.000Z', '2026-09-27T23:59:59.999Z'])
  })

  it('Sponsored Display waits 14 days', () => {
    const w = settledBounds(14, 'SPONSORED_DISPLAY', { now: NOW })
    expect(iso(w.until)).toBe('2026-09-20T23:59:59.999Z')
  })
})

describe('settledEndText — the sentence screens print', () => {
  it('states both lags, and follows the escape hatch', () => {
    expect(settledEndText()).toBe('ending 7 days ago (14 for Sponsored Brands and Display)')
    process.env[HATCH] = 'provisional'
    expect(settledEndText()).toBe('ending 2 days ago')
  })
})
