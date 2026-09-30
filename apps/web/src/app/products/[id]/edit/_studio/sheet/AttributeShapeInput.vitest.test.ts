/**
 * Audit A32 — the record drawer's list input never cuts a value at the column's cap (eBay's 65 per aspect value): the
 * browser limit is `textLimitFor`'s, as on every sheet editor, and a value over the cap is marked by its counter and
 * `aria-invalid`. The save stores it and warns with the channel's rule.
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AttributeShapeInput } from './AttributeShapeInput'
import { NO_TEXT_LIMIT } from '@/design-system/grid/editors/sheet'

const render = (value: string[]) => renderToStaticMarkup(createElement(AttributeShapeInput, {
  column: { label: 'Caratteristiche', shape: 'list', maxLength: 65 }, value, onChange: () => {},
}))

describe('the drawer list input', () => {
  it('a 72-character value is not cut at 65: the browser limit is the sheet editors\' one, and the counter marks it over', () => {
    const html = render(['x'.repeat(72)])
    expect(html).not.toContain('maxLength="65"')
    expect(html).toContain(`maxLength="${NO_TEXT_LIMIT}"`)
    expect(html).toContain('72 / 65')
    expect(html).toContain('nds-slotlist-count over')
    expect(html).toContain('aria-invalid="true"')
  })
  it('a value within the cap shows its count and is not marked', () => {
    const html = render(['Ventilato'])
    expect(html).toContain('9 / 65')
    expect(html).not.toContain('aria-invalid')
  })
})
