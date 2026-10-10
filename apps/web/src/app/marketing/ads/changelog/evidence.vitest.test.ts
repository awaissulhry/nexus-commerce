/**
 * Free visibility numbers (2026-10-10, F3) — the Change Log's evidence cell says a share in its unit and the data date,
 * where it printed "top of search impression share · 0.31 vs 0.45".
 */
import { describe, expect, it } from 'vitest'
import { evidenceValue, fmtEvidence, isThin } from './evidence'

describe('fmtEvidence', () => {
  it('prints a share as a percent, with the window', () => {
    expect(fmtEvidence({ metric: 'topOfSearchImpressionShare', observed: 0.31, threshold: 0.45, sampleSize: 3, sampleUnit: 'days' }))
      .toBe('top of search impression share · 31.00% vs 45.00% · 3 days')
  })

  it('never prints a tiny share as 0.00%', () => {
    expect(evidenceValue('sqp_brand_impression_share', 0.00002)).toBe('<0.01%')
  })

  it('says the week and its age, or the data day, the decision read', () => {
    expect(fmtEvidence({ metric: 'sqp_brand_impression_share', observed: 0.012, week: '2026-10-04', ageDays: 13 }))
      .toBe('sqp brand impression share · 1.20% · week of 4 Oct 2026 (13 d old)')
    expect(fmtEvidence({ metric: 'expectedAcos', observed: 0.21, threshold: 0.35, brain: { dataDay: '2026-10-08' } }))
      .toBe('expected acos · 21.00% vs 35.00% · data day 8 Oct 2026')
  })

  it('keeps text a writer already put in its unit, and never re-scales a "share" above 1', () => {
    expect(evidenceValue('coverage_share', '1.20%')).toBe('1.20%')
    expect(evidenceValue('topOfSearchImpressionShare', 31)).toBe('31 (unit not recorded)')
    expect(evidenceValue('clicks', 12)).toBe('12')
  })

  it('flags thin data', () => {
    expect(isThin({ sampleSize: 3, sampleUnit: 'days' })).toBe(true)
    expect(isThin({ sampleSize: 30, sampleUnit: 'days' })).toBe(false)
  })
})
