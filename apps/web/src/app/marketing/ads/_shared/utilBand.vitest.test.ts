import { describe, it, expect } from 'vitest'
import { utilBand, UTIL_CAPPED_PCT, UTIL_NEARLY_PCT } from './utilBand'

/**
 * ADM-P6b — the two thresholds are a decision, so they are asserted rather than left to a
 * reader of the CSS. Every number here is a percent, never a fraction: the cell converts once.
 */
describe('utilBand', () => {
  it('turns red only once the budget is actually spent', () => {
    expect(utilBand(99.99)).toBe('nearly')
    expect(utilBand(100)).toBe('capped')
    expect(utilBand(288)).toBe('capped') // IT-AIRMESH-SP-Competitor-Broad's 7-day average
  })

  it('warns from 85% up, and not below', () => {
    expect(utilBand(84.99)).toBe('normal')
    expect(utilBand(85)).toBe('nearly')
    expect(utilBand(95)).toBe('nearly')
  })

  /** 🔴 A real 0% reading is a READING — it must not be coloured as if it were missing. */
  it('leaves a genuine zero neutral', () => {
    expect(utilBand(0)).toBe('normal')
  })

  /** An absence has no band. The cell renders a word for it and never reaches the gauge. */
  it('treats an absence as neutral rather than inventing a band', () => {
    expect(utilBand(null)).toBe('normal')
    expect(utilBand(undefined)).toBe('normal')
    expect(utilBand(NaN)).toBe('normal')
  })

  it('states its thresholds once, and this is where they are read from', () => {
    expect(UTIL_CAPPED_PCT).toBe(100)
    expect(UTIL_NEARLY_PCT).toBe(85)
  })

  /**
   * Severity may never go backwards as utilization rises. Written as a property over the whole
   * range rather than a hand-picked sample: a sample chosen from the top of a real distribution
   * proves only that the sample was chosen from the top.
   */
  it('never becomes less severe as utilization rises', () => {
    const rank = { normal: 0, nearly: 1, capped: 2 } as const
    let previous = 0
    for (let pct = 0; pct <= 400; pct += 0.25) {
      const current = rank[utilBand(pct)]
      expect(current).toBeGreaterThanOrEqual(previous)
      previous = current
    }
    expect(previous).toBe(2)
  })
})
