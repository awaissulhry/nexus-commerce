/**
 * KT.3 — the export, and the four facts a spreadsheet destroys if you let it.
 *
 * An export travels. Nothing goes with it: not the reach line's coverage denominator, not the week
 * the grid reads, not the truncation flag. So the preamble carries them, and the three blank states
 * export as their words rather than as empty cells — `never measured`, `no row this week`, `not
 * measurable here` and a real `0.00%` are four different facts and a spreadsheet flattens all four
 * to nothing.
 */
import { describe, it, expect } from 'vitest'
import { buildCsv } from './csv'

const row = (over: Record<string, unknown>) => ({
  keyword: 'giacca moto', marketplace: 'IT', marketVolume: 1177, marketRank: 3,
  impressionShare: 0.0117, asinsCompeting: 8, asOf: '2026-07-19', asOfAgeDays: 24,
  state: 'measured', measured: true, branded: false, ...over,
}) as Parameters<typeof buildCsv>[0][number]

const payload = {
  scope: {
    market: 'IT', boundBy: 'market', line: null, portfolio: null, campaign: null,
    list: { id: 'w1', name: 'IT — curated coverage', marketplace: 'IT', terms: 107 },
    resolved: { campaigns: 149, asins: 250, keywordsWatched: 97, keywordsMeasured: 97, asinsCovered: 18 },
    unreachable: null,
  },
  window: { lookbackDays: 42, period: '2026-07-19', periodAgeDays: 24, truncated: false, periodsUsed: [], newestAsOf: null, oldestAsOf: null },
  topOfSearch: { avgShare: 0.254, campaignsWithReading: 54, campaignsInScope: 149, asOf: '2026-08-10' },
  freshness: { sqp: { latestPeriodStart: null, ingestedAt: null, ageDays: null }, searchTerm: { latestDate: null, ageDays: null }, placement: { latestDate: null, ageDays: null } },
  rows: [], total: 0, lists: [],
} as unknown as Parameters<typeof buildCsv>[1]

describe('buildCsv', () => {
  it('carries the coverage denominator — the one thing that must never travel without the numbers', () => {
    const csv = buildCsv([row({})], payload)
    expect(csv).toContain('share measured across 18 of 250 advertised ASINs')
  })

  it('names the period and whether the week was complete', () => {
    const csv = buildCsv([row({})], payload)
    expect(csv).toContain('2026-07-19')
    expect(csv).toContain('24 days old')
    expect(csv).toMatch(/week complete\?,yes/)
    const trunc = buildCsv([row({})], { ...payload, window: { ...payload.window, truncated: true } })
    expect(trunc).toContain('NO — truncated week')
  })

  it('exports each blank state as its WORDS, and a real zero as a number', () => {
    const csv = buildCsv([
      row({ state: 'never-measured', measured: false, impressionShare: null }),
      row({ state: 'no-row-this-period', measured: false, impressionShare: null, lastSeen: '2026-07-12' }),
      row({ state: 'not-measurable-here', measured: false, impressionShare: null }),
      row({ state: 'measured', impressionShare: 0 }),
    ], payload)
    expect(csv).toContain('never measured')
    expect(csv).toContain('no row this week')
    expect(csv).toContain('not measurable here')
    expect(csv).toContain('0.00%')
  })

  it('says "no earlier week" rather than leaving the Δ blank on a measured row', () => {
    const csv = buildCsv([row({ deltaPP: null })], payload)
    expect(csv).toContain('no earlier week')
  })

  it('carries the gap beside the Δ, so a 35-day change cannot read as weekly', () => {
    const csv = buildCsv([row({ deltaPP: -3.26, deltaGapDays: 35, priorShare: 0.0336, priorPeriod: '2026-06-14' })], payload)
    expect(csv).toContain('-3.26')
    expect(csv).toContain('35')
    expect(csv).toContain('2026-06-14')
  })

  it('exports every row it is given — the FULL set, not a page', () => {
    const many = Array.from({ length: 97 }, (_, i) => row({ keyword: `term ${i}` }))
    const csv = buildCsv(many, payload)
    expect(csv).toContain('exported rows,97')
    // header + 97 body rows, plus the preamble
    expect(csv.split('\n').filter((l) => l.startsWith('term ')).length).toBe(97)
  })

  it('quotes a keyword containing a comma instead of splitting the row', () => {
    const csv = buildCsv([row({ keyword: 'giacca moto, uomo' })], payload)
    expect(csv).toContain('"giacca moto, uomo"')
  })
})
