import { describe, it, expect } from 'vitest'
import { parseSqp, share, periodWindow } from './sqp.service.js'

describe('periodWindow', () => {
  it('WEEK: most recent completed Sunday→Sunday (exclusive end)', () => {
    // Wed 2026-05-27. Current week's Sunday = 2026-05-24; previous completed
    // week = 2026-05-17 (Sun) .. 2026-05-24 (exclusive).
    const w = periodWindow('WEEK', new Date('2026-05-27T10:00:00Z'))
    expect(w.start.toISOString().slice(0, 10)).toBe('2026-05-17')
    expect(w.end.toISOString().slice(0, 10)).toBe('2026-05-24')
    expect(w.start.getUTCDay()).toBe(0) // Sunday
  })
  it('WEEK lookback=2 steps back another full week', () => {
    const w = periodWindow('WEEK', new Date('2026-05-27T10:00:00Z'), 2)
    expect(w.start.toISOString().slice(0, 10)).toBe('2026-05-10')
    expect(w.end.toISOString().slice(0, 10)).toBe('2026-05-17')
  })
  it('MONTH: previous full calendar month', () => {
    const w = periodWindow('MONTH', new Date('2026-05-15T10:00:00Z'))
    expect(w.start.toISOString().slice(0, 10)).toBe('2026-04-01')
    expect(w.end.toISOString().slice(0, 10)).toBe('2026-05-01')
  })
  it('QUARTER: previous full quarter', () => {
    const w = periodWindow('QUARTER', new Date('2026-05-15T10:00:00Z'))
    // Q2 in progress → previous completed = Q1 (Jan–Mar)
    expect(w.start.toISOString().slice(0, 10)).toBe('2026-01-01')
    expect(w.end.toISOString().slice(0, 10)).toBe('2026-04-01')
  })
})

describe('share', () => {
  it('brand / total, clamped to [0,1]', () => {
    expect(share(30, 120)).toBeCloseTo(0.25, 5)
    expect(share(5, 0)).toBe(0) // no market volume → 0, not NaN
    expect(share(150, 100)).toBe(1) // never above 1
  })
})

describe('parseSqp', () => {
  it('maps the nested brandCount/totalCount funnel shape', () => {
    const payload = {
      dataByDepartmentAndSearchQuery: [
        {
          searchQuery: 'giacca moto',
          asin: 'B00ABC123',
          searchQueryVolume: 5000,
          searchQueryScore: 12,
          impressionData: { totalCount: 1000, brandCount: 250 },
          clickData: { totalCount: 200, brandCount: 40 },
          cartAddData: { totalCount: 80, brandCount: 10 },
          purchaseData: { totalCount: 50, brandCount: 5 },
        },
      ],
    }
    const rows = parseSqp(payload)
    expect(rows).toHaveLength(1)
    const r = rows[0]
    expect(r.searchQuery).toBe('giacca moto')
    expect(r.asin).toBe('B00ABC123')
    expect(r.searchQueryVolume).toBe(5000)
    expect(r.searchQueryRank).toBe(12)
    expect(r.impressionsTotal).toBe(1000)
    expect(r.impressionsBrand).toBe(250)
    expect(share(r.impressionsBrand, r.impressionsTotal)).toBeCloseTo(0.25, 5)
    expect(r.purchasesTotal).toBe(50)
  })

  it('handles the searchQueryData-nested + bare-array variants', () => {
    const rows = parseSqp([{ searchQueryData: { searchQuery: 'casco', searchQueryVolume: 9 }, impressions: { total: 10, brand: 3 } }])
    expect(rows).toHaveLength(1)
    expect(rows[0].searchQuery).toBe('casco')
    expect(rows[0].searchQueryVolume).toBe(9)
    expect(rows[0].impressionsTotal).toBe(10)
    expect(rows[0].impressionsBrand).toBe(3)
  })

  it('skips rows with no query; missing funnel fields default to 0', () => {
    const rows = parseSqp({ records: [{ asin: 'X' }, { searchQuery: 'q1' }] })
    expect(rows).toHaveLength(1)
    expect(rows[0].clicksTotal).toBe(0)
    expect(rows[0].purchasesBrand).toBe(0)
  })

  it('returns [] on unrecognised payloads', () => {
    expect(parseSqp(null)).toEqual([])
    expect(parseSqp({ somethingElse: true })).toEqual([])
    expect(parseSqp(42)).toEqual([])
  })
})
