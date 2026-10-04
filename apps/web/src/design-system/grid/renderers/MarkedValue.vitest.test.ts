import { createElement } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { MarkedValue, type MarkedValueProps } from './MarkedValue'

/*
 * 2026-10-04 (channel cell marks) — the ONE cell layout both sheet scopes draw: mark · text · trail · after. The order is
 * the contract: the text is the ellipsizing box, so the trail (chevron) and the after (cell action, save marks) are its
 * SIBLINGS — inside it they would fall to a second line (#707).
 */
const html = (props: Partial<MarkedValueProps> = {}) =>
  render(createElement(MarkedValue, {
    provenance: 'pinned',
    from: 'GALE-JACKET',
    trail: createElement('i', { 'data-part': 'trail' }),
    after: createElement('b', { 'data-part': 'after' }),
    children: createElement('em', { 'data-part': 'value' }, 'Gale Jacket'),
    ...props,
  }))

describe('MarkedValue', () => {
  it('renders mark, text, trail and after — in that order, as siblings', () => {
    const out = html()
    expect(out).toMatch(/^<span class="nds-cell-value">/)
    const order = ['nds-cell-prov ', 'nds-cell-value-text', 'data-part="trail"', 'data-part="after"'].map((s) => out.indexOf(s))
    expect(order.every((at) => at > 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    // The value is INSIDE the text box; the trail and after are not.
    expect(out).toContain('<span class="nds-cell-value-text"><em data-part="value">Gale Jacket</em></span><i data-part="trail">')
  })
  it('draws no mark for own — the text still leads', () => {
    const out = html({ provenance: 'own' })
    expect(out).not.toContain('nds-cell-prov')
    expect(out).not.toContain('role="img"')
    expect(out).toMatch(/^<span class="nds-cell-value"><span class="nds-cell-value-text">/)
  })
  it('hands the mark its source and sentence: one text for hover and screen reader', () => {
    expect(html()).toContain('aria-label="Pinned on this row — it no longer follows GALE-JACKET" title="Pinned on this row — it no longer follows GALE-JACKET"')
    expect(html({ provenance: 'pending', from: null, tooltip: 'Live until you publish: Black' }))
      .toContain('aria-label="Live until you publish: Black" title="Live until you publish: Black"')
  })
  it('renders nothing extra when there is no trail and no after', () => {
    const out = render(createElement(MarkedValue, { provenance: 'own', children: 'x' }))
    expect(out).toBe('<span class="nds-cell-value"><span class="nds-cell-value-text">x</span></span>')
  })
})
