/**
 * 6c (review G.2, Owner decision S9) — the days an ads decision may read: the same window length,
 * ending 7 days ago for Sponsored Products and 14 for every other ad product; the escape hatch
 * NEXUS_ADS_SETTLED_LAG=provisional puts back the old two-day tail.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { withWorkspace } from '@nexus/database/workspace-context'
import {
  MAX_SETTLED_SHIFT_DAYS,
  SETTLED_FACTS_TTL_MS,
  clearSettledFacts,
  setSettledFacts,
  settledBounds,
  settledEnd,
  settledEndText,
  settledLag,
  settledWhere,
} from './ads-settled-window.js'

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

describe('BB-14 — the window ends at the newest day Amazon has settled for the business', () => {
  // NOW = 2026-10-04 10:30 UTC: the clock rule ends Sponsored Products on 09-27 and Brands/Display on 09-20.
  const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`)
  afterEach(() => clearSettledFacts())

  it('with last night\'s re-read ingested (SP settled through 09-26), the window ends there: same length, one day earlier', () => {
    setSettledFacts({ spThrough: d('2026-09-26'), otherThrough: d('2026-09-19') }, NOW.getTime())
    const w = settledBounds(7, 'SPONSORED_PRODUCTS', { now: NOW })
    expect([iso(w.since), iso(w.until)]).toEqual(['2026-09-20T00:00:00.000Z', '2026-09-26T23:59:59.999Z'])
    expect(settledEnd('SPONSORED_PRODUCTS', { now: NOW })).toMatchObject({ shiftDays: 1, stillFilling: false, known: true })
    const where = settledWhere(7, { now: NOW }) as { OR: Array<{ date: { gte: Date; lte: Date } }> }
    expect(iso(where.OR[0].date.lte)).toBe('2026-09-26T23:59:59.999Z')
    expect(iso(where.OR[1].date.lte)).toBe('2026-09-19T23:59:59.999Z')
    expect(settledEndText({ now: NOW })).toBe('ending 8 days ago (15 for Sponsored Brands and Display), the newest days Amazon has settled')
  })

  it('a comparison\'s earlier half moves back with it, still back to back', () => {
    setSettledFacts({ spThrough: d('2026-09-25'), otherThrough: d('2026-09-18') }, NOW.getTime())
    const recent = settledBounds(7, 'SPONSORED_PRODUCTS', { now: NOW })
    const prior = settledBounds(7, 'SPONSORED_PRODUCTS', { now: NOW, offsetDays: 7 })
    expect(iso(recent.until)).toBe('2026-09-25T23:59:59.999Z')
    expect(prior.until.getTime() + 1).toBe(recent.since.getTime())
  })

  it('a settled day at or past the clock rule changes nothing', () => {
    setSettledFacts({ spThrough: d('2026-09-28'), otherThrough: d('2026-09-20') }, NOW.getTime())
    expect(iso(settledBounds(7, 'SPONSORED_PRODUCTS', { now: NOW }).until)).toBe('2026-09-27T23:59:59.999Z')
    expect(settledEnd('SPONSORED_BRANDS', { now: NOW })).toMatchObject({ shiftDays: 0, stillFilling: false })
  })

  it(`more than ${MAX_SETTLED_SHIFT_DAYS} days behind (the re-read is failing): the clock rule, said as still filling`, () => {
    setSettledFacts({ spThrough: d('2026-09-23'), otherThrough: d('2026-09-19') }, NOW.getTime())
    expect(iso(settledBounds(7, 'SPONSORED_PRODUCTS', { now: NOW }).until)).toBe('2026-09-27T23:59:59.999Z')
    expect(settledEnd('SPONSORED_PRODUCTS', { now: NOW })).toMatchObject({ shiftDays: 0, stillFilling: true })
    expect(settledEndText({ now: NOW })).toBe('ending 7 days ago (15 for Sponsored Brands and Display); the newest days may still be filling (no settled re-read of them yet)')
  })

  it('no settled day for an ad product, or a fact older than a day: the clock rule, said as still filling', () => {
    setSettledFacts({ spThrough: null, otherThrough: d('2026-09-19') }, NOW.getTime())
    expect(settledEnd('SPONSORED_PRODUCTS', { now: NOW })).toMatchObject({ shiftDays: 0, stillFilling: true })
    expect(settledEnd('SPONSORED_DISPLAY', { now: NOW })).toMatchObject({ shiftDays: 1, stillFilling: false })
    setSettledFacts({ spThrough: d('2026-09-26'), otherThrough: d('2026-09-19') }, NOW.getTime() - SETTLED_FACTS_TTL_MS - 1)
    expect(iso(settledBounds(7, 'SPONSORED_PRODUCTS', { now: NOW }).until)).toBe('2026-09-27T23:59:59.999Z')
    expect(settledEnd('SPONSORED_PRODUCTS', { now: NOW }).stillFilling).toBe(true)
  })

  it('facts belong to one business: another business keeps the clock rule', () => {
    withWorkspace({ workspaceId: 'ws_settled_a', actorUserId: null, membershipId: null, roleKeys: [] }, () =>
      setSettledFacts({ spThrough: d('2026-09-26'), otherThrough: d('2026-09-19') }, NOW.getTime()))
    const end = (workspaceId: string) => withWorkspace({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, () => settledEnd('SPONSORED_PRODUCTS', { now: NOW }))
    expect(end('ws_settled_a').shiftDays).toBe(1)
    expect(end('ws_settled_b')).toMatchObject({ shiftDays: 0, known: false })
  })

  it('the escape hatch ignores the facts', () => {
    setSettledFacts({ spThrough: d('2026-09-26'), otherThrough: d('2026-09-19') }, NOW.getTime())
    process.env[HATCH] = 'provisional'
    expect(settledEndText({ now: NOW })).toBe('ending 2 days ago')
    expect(iso(settledBounds(7, 'SPONSORED_PRODUCTS', { now: NOW }).until)).toBe('2026-10-02T23:59:59.999Z')
  })
})
