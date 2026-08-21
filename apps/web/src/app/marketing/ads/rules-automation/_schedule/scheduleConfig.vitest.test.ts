/**
 * BSP-P1 — the builder's "Period" field stated `04/18/2026 - 06/16/2026` as a hard-coded, readOnly
 * string while the fetch beside it asked for the last 60 days. Measured on prod 2026-08-21 the two
 * did not overlap by a single day.
 *
 * These assert the RELATIONSHIP — that the label describes the window the request actually asks
 * for — rather than pinning a formatted string, which is how the original defect survived: a frozen
 * literal passes every test that compares it to itself.
 */
import { describe, expect, it } from 'vitest'
import { CHART_WINDOW_DAYS, chartWindowLabel } from './scheduleConfig'

const parseMdy = (s: string) => {
  const [m, d, y] = s.split('/').map(Number)
  return new Date(y, m - 1, d)
}

describe('chartWindowLabel', () => {
  it('ends today and starts exactly CHART_WINDOW_DAYS ago', () => {
    const now = new Date(2026, 7, 21) // 21 Aug 2026, local
    const [from, to] = chartWindowLabel(now).split(' - ').map(parseMdy)
    expect(to.getTime()).toBe(now.getTime())
    const days = Math.round((to.getTime() - from.getTime()) / 86_400_000)
    expect(days).toBe(CHART_WINDOW_DAYS)
  })

  it('crosses a month and a year boundary without drifting', () => {
    const [from, to] = chartWindowLabel(new Date(2027, 0, 15)).split(' - ').map(parseMdy)
    expect(Math.round((to.getTime() - from.getTime()) / 86_400_000)).toBe(CHART_WINDOW_DAYS)
    expect(from.getFullYear()).toBe(2026)
    expect(to.getFullYear()).toBe(2027)
  })

  it('is MM/DD/YYYY, zero-padded — the format every other date field in this builder uses', () => {
    expect(chartWindowLabel(new Date(2026, 2, 5))).toMatch(/^\d{2}\/\d{2}\/\d{4} - 03\/05\/2026$/)
  })

  it('🔴 is not the frozen string it replaced', () => {
    expect(chartWindowLabel(new Date(2026, 7, 21))).not.toBe('04/18/2026 - 06/16/2026')
  })
})
