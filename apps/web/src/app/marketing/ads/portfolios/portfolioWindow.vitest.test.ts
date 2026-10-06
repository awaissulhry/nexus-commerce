/**
 * AM-6 / AM-35 — the Portfolios page says which dates its money covers and which campaigns it counts.
 */
import { describe, expect, it } from 'vitest'
import { defaultPortfolioRange, portfolioWindowNote, windowLabel, ymd } from './portfolioWindow'

describe('the window the Portfolios money covers', () => {
  it('opens on the Ad Manager’s default: the last 7 days ending today', () => {
    const { start, end } = defaultPortfolioRange(new Date(2026, 9, 5, 15, 30))
    expect(ymd(start)).toBe('2026-09-29')
    expect(ymd(end)).toBe('2026-10-05')
  })
  it('prints the dates the API answered with', () => {
    expect(windowLabel({ startDate: '2026-10-01', endDate: '2026-10-05' })).toBe('1 Oct 2026 – 5 Oct 2026')
    expect(windowLabel({ startDate: '2026-10-04', endDate: '2026-10-04' })).toBe('4 Oct 2026')
  })
})

describe('the note under the tiles', () => {
  it('names the dates, the source, and that archived campaigns are not counted', () => {
    const note = portfolioWindowNote({ startDate: '2026-10-01', endDate: '2026-10-04', includesToday: false }, 3)
    expect(note).toContain('1 Oct 2026 – 4 Oct 2026')
    expect(note).toContain('daily reports')
    expect(note).toContain('3 archived campaigns are not counted')
    expect(note).not.toContain('today')
  })
  it('says today is not in the numbers yet when the window reaches today', () => {
    const note = portfolioWindowNote({ startDate: '2026-09-29', endDate: '2026-10-05', includesToday: true }, 1)
    expect(note).toContain('today is not in these numbers yet')
    expect(note).toContain('1 archived campaign is not counted')
  })
  it('still says what is counted before the first answer arrives', () => {
    expect(portfolioWindowNote(null, 0)).toContain('archived campaigns are not counted')
  })
})
