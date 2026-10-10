/**
 * S4 (2026-10-10, honest numbers) — `sqpShareForAsins`, the family share rank-runtime shows as "SQP x %", over a fake
 * table: the newest WEEK only (a month's or a quarter's rows are another period), the market total counted ONCE per
 * query (it is repeated on every ASIN row), our ASINs' counts summed. Fake ASINs and round numbers only.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const findMany = vi.fn()
vi.mock('../../db.js', () => ({ default: { searchQueryPerformance: { findMany: (...a: unknown[]) => findMany(...a) } } }))

import { sqpShareForAsins } from './sqp.service.js'

const WEEK_NEW = new Date('2026-09-27T00:00:00Z')
const WEEK_OLD = new Date('2026-09-20T00:00:00Z')
const now = new Date('2026-10-05T12:00:00Z')
const row = (asin: string, searchQuery: string, ours: number, total: number, startDate = WEEK_NEW) =>
  ({ startDate, asin, searchQuery, impressionsBrand: ours, impressionsTotal: total })

beforeEach(() => findMany.mockReset())

describe('sqpShareForAsins — S4', () => {
  it('asks for WEEK rows only', async () => {
    findMany.mockResolvedValue([])
    await sqpShareForAsins('IT', ['B0FAKE0001'], now)
    expect(findMany.mock.calls[0][0].where).toMatchObject({ marketplace: 'IT', reportPeriod: 'WEEK', asin: { in: ['B0FAKE0001'] } })
  })

  it('two ASINs on the same queries: the market total once per query, ours summed — not understated ×2', async () => {
    findMany.mockResolvedValue([
      row('B0FAKE0001', 'test jacket', 30, 1000),
      row('B0FAKE0002', 'test jacket', 20, 1000),
      row('B0FAKE0001', 'test gloves', 10, 500),
      row('B0FAKE0002', 'test gloves', 0, 500),
      row('B0FAKE0001', 'test jacket', 99, 99, WEEK_OLD), // an older week: not mixed in
    ])
    const r = await sqpShareForAsins('IT', ['B0FAKE0001', 'B0FAKE0002'], now)
    expect(r.share).toBeCloseTo(60 / 1500, 10) // the old sum read 60 / 3000
    expect(r.weekStart).toBe('2026-09-27')
    expect(r.contributors).toEqual({ withData: 2, total: 2 })
  })

  it('a week whose queries carry no market total → null with a reason, never 0', async () => {
    findMany.mockResolvedValue([row('B0FAKE0001', 'q', 0, 0), row('B0FAKE0002', 'q', 0, 0)])
    const r = await sqpShareForAsins('IT', ['B0FAKE0001', 'B0FAKE0002'], now)
    expect(r.share).toBeNull()
    expect(r.reason).toContain('no impressions to take a share of')
  })
})
