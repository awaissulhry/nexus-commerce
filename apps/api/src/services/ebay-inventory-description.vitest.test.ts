/** eBay 25718: inventory_item.description must be 1–4000 chars — even though a
 *  grouped listing's per-variant description never surfaces to buyers. */
import { describe, it, expect } from 'vitest'

// Mirrors the fallback chain in pushVariationGroup's itemBody.
const variantDescription = (
  row: { description?: unknown; title?: unknown },
  sku: string,
  parentDescription?: string,
) => String(
  (typeof row.description === 'string' && row.description.trim() ? row.description : '')
  || parentDescription
  || (typeof row.title === 'string' && row.title.trim() ? row.title : '')
  || sku,
).slice(0, 4000)

describe('inventory_item description fallback (eBay 25718)', () => {
  it('uses the row description when it has one', () => {
    expect(variantDescription({ description: '<p>Giacca</p>' }, 'SKU-1', 'group')).toBe('<p>Giacca</p>')
  })
  it('falls back to the GROUP description when the variant row is blank', () => {
    expect(variantDescription({ description: '' }, 'SKU-1', '<p>Group copy</p>')).toBe('<p>Group copy</p>')
  })
  it('falls back to the title when there is no group description either', () => {
    expect(variantDescription({ description: '   ', title: 'XAVIA GALE' }, 'SKU-1')).toBe('XAVIA GALE')
  })
  it('falls back to the SKU as a last resort — NEVER empty', () => {
    expect(variantDescription({}, 'GALE-JACKET-BLACK-MEN-M')).toBe('GALE-JACKET-BLACK-MEN-M')
  })
  it('never exceeds eBay’s 4000-char limit', () => {
    expect(variantDescription({ description: 'x'.repeat(5000) }, 'S').length).toBe(4000)
  })
  it('is never empty for any realistic input (the 400 condition)', () => {
    for (const row of [{}, { description: '' }, { description: '  ' }, { title: '' }, { description: null }]) {
      expect(variantDescription(row as never, 'SKU-X').length).toBeGreaterThan(0)
    }
  })
})
