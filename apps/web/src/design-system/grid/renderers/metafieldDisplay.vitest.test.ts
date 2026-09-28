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

/* ── Lane B slice B3a (PLAN §6.3, G13): every measurement kind in words, like weight — single values and lists. ── */
import { shopifyMeasurementUnits } from '@nexus/shared/shopify-linked-products'

describe('B3a · every measurement kind shows its value in words, never raw JSON', () => {
  it.each([
    ['antenna_gain', 'decibels_isotropic', '2.5 decibels isotropic'],
    ['area', 'square_centimeters', '2.5 square centimeters'],
    ['battery_charge_capacity', 'milliamp_hours', '2.5 milliamp hours'],
    ['battery_energy_capacity', 'watt_hours', '2.5 watt hours'],
    ['capacitance', 'picofarads', '2.5 picofarads'],
    ['concentration', 'milligrams_per_gram', '2.5 milligrams per gram'],
    ['data_storage_capacity', 'bytes', '2.5 bytes'],
    ['data_transfer_rate', 'bits_per_second', '2.5 bits per second'],
    ['dimension', 'inches', '2.5 inches'],
    ['display_density', 'pixels_per_inch', '2.5 pixels per inch'],
    ['distance', 'kilometers', '2.5 kilometers'],
    ['duration', 'nanoseconds', '2.5 nanoseconds'],
    ['electric_current', 'milliamperes', '2.5 milliamperes'],
    ['electrical_resistance', 'ohms', '2.5 ohms'],
    ['energy', 'joules', '2.5 joules'],
    ['frequency', 'hertz', '2.5 hertz'],
    ['illuminance', 'lux', '2.5 lux'],
    ['inductance', 'microhenries', '2.5 microhenries'],
    ['luminous_flux', 'lumens', '2.5 lumens'],
    ['mass_flow_rate', 'grams_per_day', '2.5 grams per day'],
    ['power', 'milliwatts', '2.5 milliwatts'],
    ['pressure', 'pounds_per_square_inch', '2.5 pounds per square inch'],
    ['resolution', 'pixels', '2.5 pixels'],
    ['rotational_speed', 'revolutions_per_minute', '2.5 revolutions per minute'],
    ['sound_level', 'decibels', '2.5 decibels'],
    ['speed', 'kilometers_per_hour', '2.5 kilometers per hour'],
    ['temperature', 'celsius', '2.5 celsius'],
    ['thermal_power', 'british_thermal_units_per_hour', '2.5 british thermal units per hour'],
    ['voltage', 'volts', '2.5 volts'],
    ['volume', 'milliliters', '2.5 milliliters'],
    ['volumetric_flow_rate', 'liters_per_hour', '2.5 liters per hour'],
    ['weight', 'ounces', '2.5 ounces'],
  ])('%s (%s) → "%s"', (kind, unit, text) => {
    expect(metafieldDisplay(kind, JSON.stringify({ value: 2.5, unit }))).toEqual({ kind: 'text', text })
  })
  it('the list above is all 32 kinds, and every unit of every kind reads the same way', () => {
    expect(Object.keys(shopifyMeasurementUnits)).toHaveLength(32)
    for (const [kind, units] of Object.entries(shopifyMeasurementUnits)) for (const unit of units) {
      expect(metafieldDisplay(kind, `{"value":21.5,"unit":"${unit}"}`), `${kind} · ${unit}`).toEqual({ kind: 'text', text: `21.5 ${unit.split('_').join(' ')}` })
    }
  })
  it.each([
    ['temperature', '{"value":21.5,"unit":"celsius"}', '21.5 celsius'],
    ['temperature', '{"value":-3,"unit":"fahrenheit"}', '-3 fahrenheit'],
    ['speed', '{"value":2.5,"unit":"kilometers_per_hour"}', '2.5 kilometers per hour'],
    ['data_storage_capacity', '{"unit":"megabytes","value":"64.0"}', '64.0 megabytes'],
    ['weight', '{"value":12.3,"unit":"kg"}', '12.3 kg'],
  ])('%s %s → "%s" (the stored digits and unit, as written)', (kind, raw, text) => {
    expect(metafieldDisplay(kind, raw)).toEqual({ kind: 'text', text })
  })
  it('list forms: one value per chip, for every kind', () => {
    expect(metafieldDisplay('list.temperature', '[{"value":21.5,"unit":"celsius"},{"value":-3,"unit":"fahrenheit"}]'))
      .toEqual({ kind: 'values', items: ['21.5 celsius', '-3 fahrenheit'], text: '21.5 celsius, -3 fahrenheit' })
    expect(metafieldDisplay('list.duration', labGoodValue('list.duration'))).toEqual({ kind: 'values', items: ['45 minutes', '46 minutes'], text: '45 minutes, 46 minutes' })
    for (const [kind, units] of Object.entries(shopifyMeasurementUnits)) {
      expect(metafieldDisplay(`list.${kind}`, JSON.stringify([{ value: 1, unit: units[0] }, { value: 2, unit: units[units.length - 1] }])), kind)
        .toEqual({ kind: 'values', items: [`1 ${units[0].split('_').join(' ')}`, `2 ${units[units.length - 1].split('_').join(' ')}`], text: expect.any(String) })
    }
    expect(metafieldDisplay('list.speed', '[]')).toEqual({ kind: 'empty', text: '' })
  })
  it.each([
    ['temperature', '{"value":"warm","unit":"celsius"}'],
    ['temperature', '{"unit":"celsius"}'],
    ['temperature', '{"value":21.5}'],
    ['temperature', '{"value":21.5,"unit":""}'],
    ['temperature', '21.5'],
    ['temperature', '[]'],
    ['temperature', '{"value":'],
    ['speed', '{"value":null,"unit":"meters_per_second"}'],
    ['list.speed', '[{"value":1,"unit":"meters_per_second"},{}]'],
    ['list.speed', '{"value":1,"unit":"meters_per_second"}'],
  ])('%s %s → "Stored value needs review"', (kind, raw) => {
    expect(metafieldDisplay(kind, raw)).toEqual({ kind: 'invalid', text: 'Stored value needs review' })
  })
  it('a text field that holds measurement-like text stays text', () => {
    expect(metafieldDisplay('single_line_text_field', '{"value":1,"unit":"kg"}')).toEqual({ kind: 'text', text: '{"value":1,"unit":"kg"}' })
  })
  it('draws the words in the cell (markup), not the stored JSON', () => {
    const cell = (type: string, raw: string) => renderToStaticMarkup(createElement(MetafieldValue, { type, raw }))
    expect(cell('temperature', '{"value":21.5,"unit":"celsius"}')).toContain('21.5 celsius')
    expect(cell('temperature', '{"value":21.5,"unit":"celsius"}')).not.toContain('&quot;unit&quot;')
    expect(cell('list.speed', '[{"value":2.5,"unit":"kilometers_per_hour"},{"value":3,"unit":"miles_per_hour"}]')).toContain('2.5 kilometers per hour')
  })
})

/* Lane B slice B3c (PLAN §6.3, §7 L1): the other references and mixed / disclosure entries in the cell — each by its
   name, with its picture where the made-up store has one (variants, collections, press quotes), never a raw id. */
import { labGoodValue as good } from '@nexus/shared/shopify-lab-store'

const cellHtml = (type: string, raw = good(type)) => renderToStaticMarkup(createElement(MetafieldValue, { type, raw, ...maps }))

describe('B3c · references and entries in the cell', () => {
  it.each([
    ['variant_reference', 'Sample Jacket / S', [true]],
    ['list.variant_reference', 'Sample Jacket / S, Sample Jacket / M', [true, true]],
    ['collection_reference', 'Jackets', [true]],
    ['list.collection_reference', 'Jackets, Gloves', [true, true]],
    ['article_reference', 'How to measure', [false]],
    ['list.article_reference', 'How to measure, Wash guide', [false, false]],
    ['customer_reference', 'Sample Customer A', [false]],
    ['list.customer_reference', 'Sample Customer A, Sample Customer B', [false, false]],
    ['company_reference', 'Sample Company', [false]],
    ['list.company_reference', 'Sample Company', [false]],
    ['order_reference', '#1001', [false]],
    ['list.order_reference', '#1001, #1002', [false, false]],
    ['mixed_reference', 'FAQ 1', [false]],
    ['list.mixed_reference', 'FAQ 1, Press quote 1', [false, true]],
    ['disclosure_reference', 'Disclosure (made up) 1', [false]],
    ['list.disclosure_reference', 'Disclosure (made up) 1, Disclosure (made up) 2', [false, false]],
  ])('%s → "%s"', (type, text, pictures) => {
    const d = metafieldDisplay(type, good(type), maps)
    expect(d.kind).toBe('references')
    expect(d.text).toBe(text)
    if (d.kind === 'references') {
      expect(d.items.map(i => !!i.src)).toEqual(pictures)
      expect(d.items.every(i => i.named)).toBe(true)
    }
  })
  it('while names load: the kind’s word, never the raw id (article, customer, company and order say "Reference")', () => {
    const words = (type: string) => { const d = metafieldDisplay(type, good(type)); return d.kind === 'references' ? d.items.map(i => i.label) : d.kind }
    expect(words('list.variant_reference')).toEqual(['Variant', 'Variant'])
    expect(words('collection_reference')).toEqual(['Collection'])
    expect(['article_reference', 'customer_reference', 'company_reference', 'order_reference'].map(words)).toEqual([['Reference'], ['Reference'], ['Reference'], ['Reference']])
    expect(words('list.mixed_reference')).toEqual(['Entry', 'Entry'])
    expect(words('disclosure_reference')).toEqual(['Entry'])
  })
  it('draws chips with pictures where there is one and no empty picture slot where there is none', () => {
    expect(cellHtml('list.variant_reference')).toContain('2 references: Sample Jacket / S, Sample Jacket / M')
    expect(cellHtml('list.variant_reference').match(/<img/g)).toHaveLength(2)
    expect(cellHtml('collection_reference').match(/<img/g)).toHaveLength(1)
    const mixedCell = cellHtml('list.mixed_reference')
    expect(mixedCell).toContain('2 references: FAQ 1, Press quote 1')
    expect(mixedCell.match(/<img/g)).toHaveLength(1)
    expect(mixedCell.match(/class="[^"]*nds-mf-refchip/g)).toHaveLength(2)
    for (const type of ['list.article_reference', 'list.customer_reference', 'company_reference', 'list.order_reference', 'list.disclosure_reference']) {
      expect(cellHtml(type), type).not.toContain('<img')
      expect(cellHtml(type), type).not.toContain('nds-media-mark')
    }
    for (const type of ['list.variant_reference', 'list.collection_reference', 'list.article_reference', 'list.customer_reference', 'list.company_reference', 'list.order_reference', 'list.mixed_reference', 'list.disclosure_reference']) {
      expect(cellHtml(type), type).not.toMatch(/>gid:\/\//)
    }
  })
  it('three mixed entries: two chips and "+1"; a list that does not parse says so', () => {
    const three = JSON.stringify([...JSON.parse(good('list.mixed_reference')!), refs.filter(r => r.type === 'lab_faq')[1].id])
    expect(cellHtml('list.mixed_reference', three)).toContain('>+1</span>')
    expect(metafieldDisplay('list.mixed_reference', '[1,').kind).toBe('invalid')
    expect(metafieldDisplay('list.disclosure_reference', '["x", 2]').kind).toBe('invalid')
  })
})
