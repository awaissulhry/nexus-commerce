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

/* Lane B slice B1 (PLAN §6.1, §7 L1): each of the 11 store types draws like Shopify's bulk editor — the model and the markup. */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { LAB_STORE_FIELDS, LAB_STORE_START, labReferences } from '@nexus/shared/shopify-lab-store'
import { MetafieldValue } from './MetafieldValue'

const refs = labReferences()
const maps = {
  labels: Object.fromEntries(refs.map(r => [r.id, r.label])),
  images: Object.fromEntries(refs.flatMap(r => (r.image ? [[r.id, r.image]] : []))),
  swatches: Object.fromEntries(refs.flatMap(r => (r.swatch ? [[r.id, r.swatch]] : []))),
}
const storeField = (key: string) => LAB_STORE_FIELDS.find(f => f.key === key)!
const start = (key: string) => LAB_STORE_START[storeField(key).id] ?? null
const html = (key: string, raw = start(key)) => renderToStaticMarkup(createElement(MetafieldValue, { type: storeField(key).type, raw, ...maps }))

describe('B1 · the 11 store types in the cell', () => {
  it.each([
    ['related_items_display', 'text', 'ahead'],
    ['variation_label', 'text', 'Black'],
    ['search_words', 'values', 'rain jacket, touring'],
    ['icons_with_text', 'references', 'Water-repellent, Regular fit, Air vents'],
    ['colour_category', 'references', 'Black'],
    ['short_summary', 'references', 'Moss'],
    ['related_items', 'references', 'Sample Pant, Sample Vest'],
    ['average_rating', 'rating', '4.5 / 5'],
    ['rating_count', 'number', '12'],
    ['feed_custom_product', 'boolean', 'No'],
    ['size_guide_page', 'references', 'Size guide (jackets)'],
    ['swatch_picture', 'references', 'Size chart (IT)'],
    ['swatch_colour', 'colors', '#2458d6'],
  ])('%s → %s "%s"', (key, kind, text) => {
    const d = metafieldDisplay(storeField(key).type, start(key), maps)
    expect(d.kind).toBe(kind)
    expect(d.text).toBe(text)
  })
  it('draws pictures, swatches, stars and marks — and a name, never a raw id', () => {
    expect(html('icons_with_text')).toContain('3 references: Water-repellent, Regular fit, Air vents')
    expect(html('colour_category')).toContain('--nds-media-swatch:#111111')
    expect(html('related_items')).toContain('<img')
    expect(html('swatch_picture')).toContain('<img')
    expect(html('average_rating')).toContain('aria-label="Rating 4.5 / 5"')
    expect(html('feed_custom_product')).toContain('data-value="no"')
    expect(html('swatch_colour')).toContain('background-color:#2458d6')
    for (const key of ['icons_with_text', 'related_items', 'size_guide_page', 'swatch_picture']) expect(html(key)).not.toMatch(/>gid:\/\//)
  })
  it('an empty cell draws the empty mark; an unreadable value says so', () => {
    expect(html('media_and_text', null)).not.toContain('gid://')
    expect(metafieldDisplay('list.metaobject_reference', '[1,').kind).toBe('invalid')
  })
})
