/**
 * 3.10 — the hourly heatmap says what the data can honestly say. A ratio with no denominator is "no value", not 0%
 * (an hour that spent and sold nothing used to be the palest, best-looking ACoS cell); the one-line read calls only
 * a volume metric's top hour "busiest"; sales and orders are disclosed as Amazon's 1-day attribution.
 */
import { describe, expect, it } from 'vitest'
import { metricInfo, metricLegendNote, metricReading, metricVal, oneDayNote, peakLine, type RawCell } from './heatMetrics'

const cell = (p: Partial<RawCell>): RawCell => ({ dow: 1, hour: 3, costCents: 0, salesCents: 0, orders: 0, clicks: 0, impressions: 0, acos: null, roas: null, ...p })

describe('metricReading — no denominator is no value, not 0', () => {
  it('ACoS: spend with no sales has no value and is the worst case; nothing at all is a plain no value', () => {
    expect(metricReading('ACoS', cell({ costCents: 420 }))).toEqual({ value: null, empty: 'spend, no sales', worst: true })
    expect(metricReading('ACoS', cell({}))).toEqual({ value: null, empty: 'no spend, no sales' })
    expect(metricReading('ACoS', cell({ costCents: 500, salesCents: 2000, acos: 25 }))).toEqual({ value: 25 })
    // The builder's reader keeps its old answer (0) — only the new reader changes.
    expect(metricVal('ACoS').f(cell({ costCents: 420 }))).toBe(0)
  })
  it('CPC, CTR, CVR, ROAS, CPA: no clicks, impressions, spend or orders means no value', () => {
    expect(metricReading('CPC', cell({ costCents: 300 }))).toEqual({ value: null, empty: 'no clicks' })
    expect(metricReading('CTR', cell({}))).toEqual({ value: null, empty: 'no impressions' })
    expect(metricReading('CVR', cell({ impressions: 50 }))).toEqual({ value: null, empty: 'no clicks' })
    expect(metricReading('ROAS', cell({ salesCents: 900 }))).toEqual({ value: null, empty: 'no spend' })
    expect(metricReading('CPA', cell({ costCents: 300, clicks: 4 }))).toEqual({ value: null, empty: 'spend, no orders', worst: true })
    expect(metricReading('CPC', cell({ costCents: 300, clicks: 4 }))).toEqual({ value: 0.75 })
  })
  it('volume metrics read a real 0', () => {
    expect(metricReading('Spend', cell({}))).toEqual({ value: 0 })
    expect(metricReading('Orders', cell({ orders: 2 }))).toEqual({ value: 2 })
  })
})

describe('peakLine — busiest only for volume; ratios name their highest hour', () => {
  it('a volume metric names the busiest hour', () => {
    const r = peakLine('Spend', [{ dow: 1, hour: 9, value: 5 }, { dow: 2, hour: 21, value: 12 }])
    expect(r).toEqual({ label: 'Busiest', when: 'Tuesday 21:00', note: null })
  })
  it('ACoS names the highest hour, never "busiest", leaves no-value hours out and counts spend with no sales', () => {
    const r = peakLine('ACoS', [
      { dow: 1, hour: 3, value: 180 },
      { dow: 1, hour: 4, value: null, empty: 'spend, no sales', worst: true },
      { dow: 1, hour: 5, value: null, empty: 'no spend, no sales' },
      { dow: 3, hour: 10, value: 40 },
    ])
    expect(r).toEqual({ label: 'Highest ACoS', when: 'Monday 03:00', note: '1 hour with spend and no sales' })
  })
  it('a ratio with no valued hour still says how many spent without selling', () => {
    expect(peakLine('ACoS', [{ dow: 0, hour: 1, value: null, empty: 'spend, no sales', worst: true }])).toEqual({ label: 'Highest ACoS', when: null, note: '1 hour with spend and no sales' })
    expect(peakLine('CPC', [{ dow: 0, hour: 1, value: null, empty: 'no clicks' }])).toBeNull()
  })
})

describe('the card notes', () => {
  it('flags: volume vs ratio, higher-is-worse, 1-day attribution', () => {
    expect(metricInfo('Sales')).toEqual({ volume: true, lowerIsBetter: false, oneDay: true })
    expect(metricInfo('ACoS')).toEqual({ volume: false, lowerIsBetter: true, oneDay: true })
    expect(metricInfo('Clicks').oneDay).toBe(false)
  })
  it('says 1-day attribution in the direction it moves the number, and nothing for traffic metrics', () => {
    expect(oneDayNote('Sales')).toContain('1-day attributed sales and orders')
    expect(oneDayNote('Sales')).toContain('read lower')
    expect(oneDayNote('ACoS')).toContain('reads higher')
    expect(oneDayNote('ROAS')).toContain('reads lower')
    expect(oneDayNote('Spend')).toBeNull()
  })
  it('explains the no-value marks for ratios', () => {
    expect(metricLegendNote('Spend')).toBe('Darker cells are higher.')
    expect(metricLegendNote('ACoS')).toContain('∞ spent money and sold nothing')
    expect(metricLegendNote('CTR')).toContain('— has no value')
  })
})
