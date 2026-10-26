/**
 * 6a (2026-10-26) — the coverage strip's header counts over Sponsored Products only: an hourly plan holds those only, so
 * a Brands or Display campaign no plan holds is not a gap. It is named on its own line, and "clean" means no
 * Sponsored Products campaign is uncovered.
 */
import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { coverageShare } from './coverageShare'

const panel = readFileSync(new URL('./CoveragePanel.tsx', import.meta.url), 'utf8')
const base = { total: 220, covered: 40, governed: 5, uncovered: 3 }

describe('coverageShare', () => {
  it('🔴 the share is over the campaigns a plan can hold: the total minus Brands/Display no plan holds', () => {
    expect(coverageShare({ ...base, notForHourlyPlans: 20 })).toEqual({ held: 45, total: 200, pct: 23, notForHourlyPlans: 20, clean: false })
  })
  it('an answer without the count (an older API) is read as today', () => {
    expect(coverageShare(base)).toEqual({ held: 45, total: 220, pct: 20, notForHourlyPlans: 0, clean: false })
  })
  it('a count that is not a non-negative number is ignored', () => {
    for (const junk of ['20', -1, Number.NaN, null]) expect(coverageShare({ ...base, notForHourlyPlans: junk }).total).toBe(220)
  })
  it('clean only when no Sponsored Products campaign is uncovered', () => {
    expect(coverageShare({ ...base, uncovered: 0 }).clean).toBe(true)
    expect(coverageShare({ ...base, uncovered: 1 }).clean).toBe(false)
  })
  it('never divides by zero or passes 100%', () => {
    expect(coverageShare({ total: 5, covered: 0, governed: 0, uncovered: 0, notForHourlyPlans: 5 }).pct).toBe(0)
    expect(coverageShare({ total: 5, covered: 6, governed: 0, uncovered: 0 }).pct).toBe(100)
  })
})

describe('CoveragePanel uses it', () => {
  it('header, percentage and clean state come from the share; Brands/Display get their own line', () => {
    expect(panel).toContain('const share = coverageShare(data)')
    expect(panel).toContain('const clean = share.clean')
    expect(panel).toContain('<b>{share.held} of {share.total}</b> campaigns are under rank control')
    expect(panel).toContain('{share.notForHourlyPlans} Brands/Display, not for hourly plans')
    expect(panel).toContain('<span className="pct">{share.pct}%</span>')
    expect(panel).not.toContain('data.covered + data.governed')
  })
})
