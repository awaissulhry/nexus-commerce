import { describe, expect, it } from 'vitest'
import { SHOPIFY_TYPE_CATALOG } from '@nexus/shared/shopify-type-catalog'
import { LAB_ODD_VALUES, labBadValues, labGoodValue } from '@nexus/shared/shopify-lab-store'
import { metafieldDisplay } from './metafieldDisplay'

/* Lane B slice B0 (docs/shopify-metafields/PLAN-2026-09-28.md §7 L3b): the cell model never crashes on any Shopify type,
   and a good value never reads as empty or unreadable. How each type LOOKS is pinned per type in B1 and B3. */
describe('metafieldDisplay over every Shopify type (made-up store)', () => {
  it.each(SHOPIFY_TYPE_CATALOG.map(entry => entry.name))('%s: the good value is shown, never empty or "needs review"', type => {
    const kind = metafieldDisplay(type, labGoodValue(type)).kind
    expect(kind).not.toBe('empty')
    expect(kind).not.toBe('invalid')
  })
  it('never throws on bad, odd or broken values', () => {
    const broken = ['[1,', '{"value":', 'null', '[null]', '[{}]', '{}', 'x', '\u0000']
    for (const { name } of SHOPIFY_TYPE_CATALOG) {
      for (const raw of [...labBadValues(name).map(b => b.value), ...broken, ...LAB_ODD_VALUES.map(o => o.value)]) {
        expect(() => metafieldDisplay(name, raw)).not.toThrow()
      }
    }
  })
})

/* Sheet pop-up rebuild P1: an entry carries its own picture or colour into the cell. Made-up ids. */
const green = 'gid://shopify/Metaobject/1', icon = 'gid://shopify/Metaobject/2', plain = 'gid://shopify/Metaobject/3'

describe('metafieldDisplay references', () => {
  it('carries each entry’s swatch and picture, and neither when it has none', () => {
    const d = metafieldDisplay('list.metaobject_reference', JSON.stringify([green, icon, plain]), {
      labels: { [green]: 'Green', [icon]: 'Water-repellent', [plain]: 'Plain' },
      images: { [icon]: 'https://cdn.shopify.com/s/files/icon.png' },
      swatches: { [green]: '#3c9a4b' },
    })
    expect(d.kind).toBe('references')
    if (d.kind !== 'references') return
    expect(d.items.map(i => [i.label, i.src, i.swatch, i.kind])).toEqual([
      ['Green', null, '#3c9a4b', 'entry'],
      ['Water-repellent', 'https://cdn.shopify.com/s/files/icon.png', null, 'entry'],
      ['Plain', null, null, 'entry'],
    ])
  })
  it('says the kind while names load, never the raw id', () => {
    const d = metafieldDisplay('metaobject_reference', green)
    expect(d.kind === 'references' && d.items[0]).toMatchObject({ label: 'Entry', named: false, swatch: null })
  })
})
