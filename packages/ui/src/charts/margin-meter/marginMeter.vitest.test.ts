import { createElement as h } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MarginMeter } from './MarginMeter'
import { marginMeterView, marginPercent, marginScale } from './marginMeterModel'

/** B-W2b-09 — MarginMeter: the margin against floor and target, in tone AND words; nothing without the grain. */
describe('marginMeterModel', () => {
  it('says where the margin is, with a tone', () => {
    expect(marginMeterView({ value: 18.2, floor: 20, target: 30 })).toMatchObject({ tone: 'danger', words: '18.2 % — under the 20.0 % floor' })
    expect(marginMeterView({ value: 24, floor: 20, target: 30 })).toMatchObject({ tone: 'warning', words: '24.0 % — under the 30.0 % target' })
    expect(marginMeterView({ value: 31.5, floor: 20, target: 30 })).toMatchObject({ tone: 'success', words: '31.5 % — at or above the 30.0 % target' })
    expect(marginMeterView({ value: 22, floor: 20 })).toMatchObject({ tone: 'success', words: '22.0 % — above the 20.0 % floor' })
    expect(marginMeterView({ value: 22 })).toMatchObject({ tone: 'neutral', words: '22.0 %' })
  })
  it('says an unknown margin is not known, never 0', () => {
    expect(marginMeterView({ value: null, floor: 20 })).toMatchObject({ known: false, words: 'Margin not known', valueText: '—', fill: null })
    expect(marginMeterView({ value: Number.NaN })).toMatchObject({ known: false })
  })
  it('scales from 0 (or a loss) past the highest mark, in tens', () => {
    expect(marginScale([18.2, 20, 30])).toEqual({ min: 0, max: 40 })
    expect(marginScale([-12, 20])).toEqual({ min: -20, max: 30 })
    expect(marginScale([null])).toEqual({ min: 0, max: 20 })
    const view = marginMeterView({ value: -5, floor: 10 })
    expect(view.zero).toBeGreaterThan(0)
    expect(view.fill).toBeLessThan(view.zero)
  })
  it('writes percents in the language', () => {
    expect(marginPercent(18.25, 'it')).toBe('18,3 %')
  })
})

describe('MarginMeter', () => {
  it('draws nothing without the margin grain', () => {
    expect(render(h(MarginMeter, { value: 18.2, floor: 20, allowed: false }))).toBe('')
  })
  it('is a meter with the sentence, the marks named in a key', () => {
    const html = render(h(MarginMeter, { value: 18.2, floor: 20, target: 30 }))
    expect(html).toContain('role="meter"')
    expect(html).toContain('aria-valuenow="18.2"')
    expect(html).toContain('aria-valuetext="18.2 % — under the 20.0 % floor"')
    expect(html).toContain('Floor 20.0 %')
    expect(html).toContain('Target 30.0 %')
  })
  it('has a one-line mini form for a grid cell, and speaks the words it is given', () => {
    const html = render(h(MarginMeter, { value: 12, floor: 20, size: 'mini', locale: 'it', labels: { underFloor: (v, f) => `${v} — sotto il minimo del ${f}` } }))
    expect(html).toContain('class="nds-marginmeter mini tone-danger"')
    expect(html).toContain('title="12,0 % — sotto il minimo del 20,0 %"')
    expect(html).not.toContain('nds-marginmeter-key')
  })
})
