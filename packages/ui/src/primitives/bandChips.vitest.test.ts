import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { AxisChip } from './AxisChip'
import { MappingChip } from './MappingChip'

/**
 * The two 28px chips the Variants page's bands are built from (spec §3.1 / §4.1).
 *
 * Geometry and colour are CSS and are measured on screen, not here. What a test can hold is the
 * STRUCTURE the CSS and the accessibility rules depend on: that the chip is a button and the
 * mapping chip is not, that the count becomes a `Tag`, that the grip is a span carrying the
 * caller's drag handlers rather than a nested button, and that an unmapped axis still renders a
 * side.
 */
describe('AxisChip', () => {
  it('is a button carrying the DS class and the grip, with the count as a neutral Tag', () => {
    const out = renderToStaticMarkup(createElement(AxisChip, { label: 'Colore', count: '2 values' }))
    expect(out).toMatch(/^<button type="button" class="nds-axischip"/)
    expect(out).toContain('nds-axischip-grip')
    expect(out).toContain('class="nds-tag neutral">2 values<')
    expect(out).toContain('>Colore<')
  })

  it('takes a number count too — the caller should not have to pre-format it', () => {
    expect(renderToStaticMarkup(createElement(AxisChip, { label: 'Taglia', count: 10 }))).toContain(
      'class="nds-tag neutral">10<',
    )
  })

  it('renders a caller-supplied node as given, without wrapping it in a Tag', () => {
    const out = renderToStaticMarkup(
      createElement(AxisChip, { label: 'Taglia', count: createElement('em', null, 'mixed') }),
    )
    expect(out).toContain('<em>mixed</em>')
    expect(out).not.toContain('nds-tag')
  })

  it('puts the drag handlers on the GRIP, never on a button inside a button', () => {
    const out = renderToStaticMarkup(
      createElement(AxisChip, { label: 'Colore', dragHandleProps: { draggable: true } }),
    )
    expect(out).toContain('draggable="true"')
    // One button only: a nested one would be invalid markup and would swallow the chip's click.
    expect(out.match(/<button/g)).toHaveLength(1)
    // The draggable attribute belongs to the grip span, not to the chip itself.
    expect(out).toMatch(/class="nds-axischip-grip"[^>]*draggable="true"|draggable="true"[^>]*class="nds-axischip-grip"/)
  })

  it('drops the grip when the chip cannot be reordered', () => {
    const out = renderToStaticMarkup(createElement(AxisChip, { label: 'Colore', grip: false }))
    expect(out).not.toContain('nds-axischip-grip')
    expect(out).toContain('>Colore<')
  })

  it('emits aria-pressed, which is what the engaged visual keys on', () => {
    expect(renderToStaticMarkup(createElement(AxisChip, { label: 'Colore', pressed: true }))).toContain(
      'aria-pressed="true"',
    )
  })
})

describe('MappingChip', () => {
  it('renders the pair as a static span, with the arrow between the two sides', () => {
    const out = renderToStaticMarkup(createElement(MappingChip, { from: 'Colore', to: 'Colore' }))
    expect(out).toMatch(/^<span class="nds-mapchip"/)
    // §4.1 gives the band ONE control. A chip that is a button would be a second way in.
    expect(out).not.toContain('<button')
    expect(out).toContain('class="nds-mapchip-from">Colore<')
    expect(out).toContain('class="nds-mapchip-to">Colore<')
    expect(out.indexOf('nds-mapchip-from')).toBeLessThan(out.indexOf('nds-mapchip-arrow'))
    expect(out.indexOf('nds-mapchip-arrow')).toBeLessThan(out.indexOf('nds-mapchip-to'))
  })

  it('shows the dash for an axis that is not mapped yet, rather than an empty side', () => {
    const out = renderToStaticMarkup(createElement(MappingChip, { from: 'Taglia' }))
    expect(out).toContain('class="nds-mapchip-to">—<')
  })

  it('carries the hover explanation the band has no room to print', () => {
    expect(
      renderToStaticMarkup(createElement(MappingChip, { from: 'Colore', to: 'Colore', title: 'eBay specific' })),
    ).toContain('title="eBay specific"')
  })
})
