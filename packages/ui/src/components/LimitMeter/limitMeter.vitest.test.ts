import { createElement as h } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LimitMeter, LimitMeterCellRenderer, ToleranceCell, limitMeterView } from './LimitMeter'
import { limitVerdict, passesLimit, scaleMax, toleranceResult } from './limitMeterModel'

/** B-W2b-78 — LimitMeter and ToleranceCell. Made-up results. */
describe('limit rules', () => {
  it('passes a maximum below the limit; at the limit fails by default (REACH: equal to or greater than fails)', () => {
    expect(limitVerdict({ value: 1.2, limit: 3 })).toBe('pass')
    expect(limitVerdict({ value: 3, limit: 3 })).toBe('fail')
    expect(limitVerdict({ value: 3, limit: 3, rule: 'atMost' })).toBe('pass')
    expect(limitVerdict({ value: 3.01, limit: 3, rule: 'atMost' })).toBe('fail')
  })
  it('a minimum passes at or above it', () => {
    expect(limitVerdict({ value: 40, limit: 40, rule: 'atLeast' })).toBe('pass')
    expect(limitVerdict({ value: 39.9, limit: 40, rule: 'atLeast' })).toBe('fail')
    expect(limitVerdict({ value: 40, limit: 40, rule: 'above' })).toBe('fail')
  })
  it('below detection passes a maximum only when the LOQ is within the limit', () => {
    expect(limitVerdict({ value: null, belowDetection: true, loq: 3, limit: 3 })).toBe('belowDetection')
    expect(limitVerdict({ value: 0.2, loq: 0.5, limit: 3 })).toBe('belowDetection')
    expect(limitVerdict({ value: null, belowDetection: true, loq: 5, limit: 3 })).toBe('inconclusive')
    expect(limitVerdict({ value: null, belowDetection: true, loq: 10, limit: 40, rule: 'atLeast' })).toBe('fail')
    expect(limitVerdict({ value: null, belowDetection: true, loq: 50, limit: 40, rule: 'atLeast' })).toBe('inconclusive')
  })
  it('is never a free pass: no value, no limit', () => {
    expect(limitVerdict({ value: null, limit: 3 })).toBe('notMeasured')
    expect(limitVerdict({ value: 1, limit: null })).toBe('noLimit')
  })
  it('rounds float noise away', () => {
    expect(passesLimit(0.1 + 0.2, 0.3, 'atMost')).toBe(true)
    expect(toleranceResult({ value: 52.5, nominal: 52, tolerance: 0.5 }).verdict).toBe('pass')
  })
  it('tolerance: over and under by the deviation from the nominal; asymmetric bands', () => {
    expect(toleranceResult({ value: 53.3, nominal: 52, tolerance: 0.5 })).toMatchObject({ verdict: 'over', deviation: 1.3 })
    expect(toleranceResult({ value: 51.4, nominal: 52, tolerance: 0.5 })).toMatchObject({ verdict: 'under' })
    expect(toleranceResult({ value: 51.8, nominal: 52, minus: 0.2, plus: 1 }).verdict).toBe('pass')
    expect(toleranceResult({ value: 51.7, nominal: 52, minus: 0.2, plus: 1 }).verdict).toBe('under')
    expect(toleranceResult({ value: null, nominal: 52, tolerance: 0.5 }).verdict).toBe('notMeasured')
  })
  it('the scale ends at a round number past what it draws', () => {
    expect(scaleMax(1.2, 3)).toBe(5)
    expect(scaleMax(8)).toBe(10)
    expect(scaleMax(null)).toBe(1)
  })
})

describe('LimitMeter', () => {
  it('says the value, the limit and the verdict in words with an icon; the bar is hidden from screen readers', () => {
    const html = render(h(LimitMeter, { label: 'Cr VI', value: 1.2, unit: 'mg/kg', limit: 3, loq: 0.5 }))
    expect(html).toContain('Cr VI')
    expect(html).toContain('1.2 mg/kg')
    expect(html).toContain('limit 3')
    expect(html).toContain('Pass')
    expect(html).toContain('<span class="nds-limit-bar" aria-hidden="true">')
    expect(html).toContain('<svg')
    expect(limitMeterView({ value: 1.2, unit: 'mg/kg', limit: 3 }).line).toBe('1.2 mg/kg · limit 3 · Pass')
  })
  it('below detection, not measured, no limit', () => {
    expect(limitMeterView({ value: null, belowDetection: true, loq: 3, limit: 3, unit: 'mg/kg' }).line).toBe('< 3 mg/kg · limit 3 · Below detection')
    expect(limitMeterView({ value: null, limit: 3, unit: 'mg/kg' }).line).toBe('limit 3 · Not measured')
    expect(limitMeterView({ value: 6.1, unit: 'pH' }).line).toBe('6.1 pH · No limit set')
    expect(limitMeterView({ value: 4.1, limit: 3, unit: 'mg/kg' })).toMatchObject({ verdict: 'fail', tone: 'danger' })
  })
  it('tolerance: the band and "over by"; the cell form says it in words, a pass for a screen reader', () => {
    expect(limitMeterView({ value: 53.3, nominal: 52, tolerance: 0.5, unit: 'cm' }).line).toBe('53.3 cm · 52 ± 0.5 · over by 1.3 cm')
    expect(limitMeterView({ value: 52, nominal: 52, minus: 0.2, plus: 1, unit: 'cm' }).targetText).toBe('52 −0.2 / +1')
    const fail = render(h(ToleranceCell, { value: 53.3, nominal: 52, tolerance: 0.5, unit: 'cm' }))
    expect(fail).toContain('data-variant="cell"')
    expect(fail).toContain('over by 1.3 cm')
    const ok = render(h(ToleranceCell, { value: 52.2, nominal: 52, tolerance: 0.5, unit: 'cm' }))
    expect(ok).toContain('class="nds-limit-sr">In tolerance')
  })
  it('the cell renderer reads a number or the row’s own target', () => {
    expect(render(h(LimitMeterCellRenderer, { value: 1.2, limit: 3, unit: 'mg/kg' }))).toContain('1.2 / 3 mg/kg')
    expect(render(h(LimitMeterCellRenderer, { value: { value: 53.3, nominal: 52, tolerance: 0.5 }, unit: 'cm' }))).toContain('over by 1.3 cm')
    expect(render(h(LimitMeterCellRenderer, { value: undefined, limit: 3 }))).toContain('Not measured')
  })
  it('speaks the host’s language and number format', () => {
    const view = limitMeterView({
      value: 1.25,
      unit: 'mg/kg',
      limit: 3,
      format: (n) => new Intl.NumberFormat('it-IT').format(n),
      labels: { limit: (l: string) => `limite ${l}`, verdicts: { pass: 'Conforme', fail: 'Non conforme', belowDetection: 'Sotto il limite di rilevabilità', inconclusive: 'Non conclusivo', notMeasured: 'Non misurato', noLimit: 'Nessun limite' } },
    })
    expect(view.line).toBe('1,25 mg/kg · limite 3 · Conforme')
  })
})
