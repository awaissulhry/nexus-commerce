/**
 * AM-14 / AM-5 — the Ad Manager's freshness line says when the PERFORMANCE numbers arrived (the daily report per
 * market), never a settings-sync time, and says how far today's hourly figures reach.
 */
import { describe, expect, it } from 'vitest'
import { reportFreshnessText } from './reportFreshness'

const RECEIVED = '2026-10-05T01:12:00.000Z'

describe('reportFreshnessText', () => {
  it('one day for every market: one date, and when the report arrived', () => {
    const t = reportFreshnessText([
      { marketplace: 'DE', dataThrough: '2026-10-04', receivedAt: '2026-10-05T01:05:00.000Z' },
      { marketplace: 'IT', dataThrough: '2026-10-04', receivedAt: RECEIVED },
    ], null)
    expect(t).toMatch(/^through 4 Oct 2026 \(Amazon's daily report, received 5 Oct, \d\d:12\)$/)
  })

  it('markets that differ are each named — a late market is never hidden behind the newest', () => {
    const t = reportFreshnessText([
      { marketplace: 'DE', dataThrough: '2026-10-03', receivedAt: null },
      { marketplace: 'IT', dataThrough: '2026-10-04', receivedAt: RECEIVED },
      { marketplace: 'FR', dataThrough: '2026-10-04', receivedAt: null },
    ], null)
    expect(t.startsWith('IT, FR through 4 Oct 2026; DE through 3 Oct 2026')).toBe(true)
  })

  it('a range reaching today says how far the hourly stream has got — or that it has nothing yet', () => {
    const m = [{ marketplace: 'IT', dataThrough: '2026-10-04', receivedAt: null }]
    expect(reportFreshnessText(m, { day: '2026-10-05', throughHour: 13, unavailable: false })).toContain("today so far from Amazon's hourly stream, to 14:00 UTC")
    expect(reportFreshnessText(m, { day: '2026-10-05', throughHour: null, unavailable: false })).toContain('today: no hourly figures from Amazon yet')
    expect(reportFreshnessText(m, { day: '2026-10-05', throughHour: null, unavailable: true })).toContain('could not be read')
  })

  it('no report at all is said, not shown as a time', () => {
    expect(reportFreshnessText([], null)).toBe('no daily report from Amazon in the last 60 days')
  })
})
