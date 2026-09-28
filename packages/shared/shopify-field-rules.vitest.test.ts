import { describe, expect, it } from 'vitest'
import { SHOPIFY_TYPE_CATALOG, shopifyTypeInfo } from './shopify-type-catalog'
import { shopifyReferenceError, validateShopifyField } from './shopify-linked-products'
import {
  LAB_ENTRIES, LAB_ENTRY_KINDS, LAB_ODD_VALUES, LAB_SCHEMA, LAB_STORE_FIELDS, LAB_STORE_START, LAB_TYPE_FIELDS, labBadValues, labGoodValue, labReferences, labTypeField,
} from './shopify-lab-store'

/*
 * Lane B slice B0 (docs/shopify-metafields/PLAN-2026-09-28.md §7 L3/L3b, §8): the made-up store is sound, and the one
 * rule function never crashes on any Shopify type. The exact refusal sentences are pinned per type in B1 (your store's
 * 11 types) and B3 (the rest); here a bad value only has to be refused — or be a KNOWN gap, listed as a todo.
 */
const READ_ONLY = 'product_taxonomy_disclosure_reference'
const types = SHOPIFY_TYPE_CATALOG.map(entry => entry.name)

describe('the made-up store is safe to publish and complete', () => {
  it('uses only small made-up ids (the repository is public)', () => {
    const text = JSON.stringify({ LAB_SCHEMA, LAB_ENTRIES, references: labReferences(), LAB_STORE_START, LAB_ODD_VALUES, bad: types.map(labBadValues) })
    const ids = text.match(/gid:\/\/shopify\/[A-Za-z]+\/[^"\\/]+/g) ?? []
    expect(ids.length).toBeGreaterThan(100)
    for (const id of ids) expect(id).toMatch(/\/(\d{1,4}|lab-\d)$/)
  })
  it('has one product field per Shopify type, with only rules that type supports', () => {
    expect(LAB_TYPE_FIELDS.map(field => field.type)).toEqual(types)
    for (const field of LAB_TYPE_FIELDS) {
      const supported = shopifyTypeInfo(field.type)!.validations.map(rule => rule.name)
      for (const rule of field.validations) expect(supported, `${field.type} · ${rule.name}`).toContain(rule.name)
    }
  })
  it('mirrors a real store by type and rule: 39 fields (25 product, 14 variant) over 11 types', () => {
    expect(LAB_STORE_FIELDS).toHaveLength(39)
    expect(LAB_STORE_FIELDS.filter(field => field.ownerType === 'PRODUCT')).toHaveLength(25)
    expect(new Set(LAB_STORE_FIELDS.map(field => field.type)).size).toBe(11)
    for (const field of LAB_STORE_FIELDS) {
      const supported = shopifyTypeInfo(field.type)!.validations.map(rule => rule.name)
      for (const rule of field.validations) expect(supported).toContain(rule.name)
    }
  })
  it('has 23 mirrored entry kinds plus one made-up disclosure kind, and every entry is valid for its kind', () => {
    expect(LAB_ENTRY_KINDS).toHaveLength(24)
    for (const entry of LAB_ENTRIES) {
      const kind = LAB_ENTRY_KINDS.find(k => k.type === entry.type)!
      for (const field of kind.fields) {
        const value = entry.fields[field.key] ?? null
        expect(validateShopifyField(field, value), `${entry.name} · ${field.name}`).toBeNull()
      }
    }
    for (const kind of LAB_ENTRY_KINDS) expect(LAB_ENTRIES.filter(e => e.type === kind.type).length, kind.name).toBeGreaterThanOrEqual(2)
  })
  it('points every entry field at an entry kind the store has', () => {
    for (const field of [...LAB_STORE_FIELDS, ...LAB_TYPE_FIELDS]) {
      const id = field.validations.find(rule => rule.name === 'metaobject_definition_id')?.value
      if (id) expect(LAB_ENTRY_KINDS.some(kind => kind.id === id), field.name).toBe(true)
    }
  })
  it('starts every store field with a value its own rules accept', () => {
    for (const field of LAB_STORE_FIELDS) expect(validateShopifyField(field, LAB_STORE_START[field.id]), field.name).toBeNull()
  })
})

describe('every Shopify type: the rules never crash', () => {
  it.each(types.filter(type => type !== READ_ONLY))('%s: the good value passes its field’s rules', type => {
    expect(validateShopifyField(labTypeField(type), labGoodValue(type))).toBeNull()
  })
  it('the read-only type refuses every value with its reason, and keeps it', () => {
    expect(validateShopifyField(labTypeField(READ_ONLY), labGoodValue(READ_ONLY))).toMatch(/stored value is preserved/)
  })
  const bad = types.flatMap(type => labBadValues(type).map(sample => ({ type, ...sample })))
  it.each(bad.filter(sample => !sample.gap && !sample.storeCheck).map(s => [s.type, s.rule, s.value] as const))('%s refuses a value that breaks %s', (type, _rule, value) => {
    expect(validateShopifyField(labTypeField(type), value)).toEqual(expect.any(String))
  })
  it.each(bad.filter(sample => sample.storeCheck).map(s => [s.type, s.rule, s.value] as const))('%s: a value that breaks %s needs Shopify’s list — the offline rule lets it through to the store check', (type, _rule, value) => {
    expect(validateShopifyField(labTypeField(type), value)).toBeNull()
  })
  for (const sample of bad.filter(s => s.gap)) it.todo(`${sample.gap}: ${sample.type} must refuse a value that breaks ${sample.rule}`)
  it('never throws, whatever is stored', () => {
    const junk = [null, '', ' ', 'x', '0', '-1', 'true', '[]', '{}', '[1,', '{"value":', 'null', '[null]', '[{}]', '["a","a"]', 'gid://shopify/Product/1', '#zzz', '\u0000', 'x'.repeat(5000)]
    for (const field of [...LAB_TYPE_FIELDS, ...LAB_STORE_FIELDS]) for (const value of [...junk, ...LAB_ODD_VALUES.map(o => o.value)]) {
      expect(() => validateShopifyField(field, value)).not.toThrow()
    }
  })
})

describe('entry references in the made-up store', () => {
  const refs = labReferences()
  it('an entry of the field’s own kind passes; another kind is refused', () => {
    const field = labTypeField('metaobject_reference')
    const own = refs.find(r => r.id === labGoodValue('metaobject_reference'))!
    const other = refs.find(r => r.type === 'lab_faq')!
    expect(shopifyReferenceError(field, [own], LAB_SCHEMA)).toBeNull()
    expect(shopifyReferenceError(field, [other], LAB_SCHEMA)).toEqual(expect.any(String))
  })
  it('a picked video is refused in an image-only field (the pick-time check)', () => {
    const field = labTypeField('file_reference')
    expect(shopifyReferenceError(field, [refs.find(r => r.type === 'MediaImage')!], LAB_SCHEMA)).toBeNull()
    expect(shopifyReferenceError(field, [refs.find(r => r.type === 'Video')!], LAB_SCHEMA)).toEqual(expect.any(String))
  })
})

/* ── Slice B1: your store's 11 types — the exact sentence for every rule they carry (PLAN §5, §6.1). ── */
import { LAB_FILES, LAB_PAGES, LAB_PRODUCTS, labKind } from './shopify-lab-store'
import { shopifyRuleSummary, shopifyValuesEqual } from './shopify-field-rules'

const store = (key: string) => LAB_STORE_FIELDS.find(field => field.key === key)!
const entryOf = (kind: string, n = 0) => LAB_ENTRIES.filter(e => e.type === kind)[n].id
const productIds = (n: number) => JSON.stringify(Array.from({ length: n }, (_, i) => `gid://shopify/Product/${i + 1}`))

describe('B1 · the 11 store types refuse with the exact plain sentence', () => {
  it.each([
    ['related_items_display', 'single_line_text_field', 'maybe', 'Choose one of these values: ahead, only manual.'],
    ['variation_label', 'single_line_text_field', 'two\nlines', 'Enter one line of text, or clear the field.'],
    ['search_words', 'list.single_line_text_field', JSON.stringify(['x'.repeat(101)]), 'Value 1: Use 100 characters or fewer. Now: 101.'],
    ['search_words', 'list.single_line_text_field', JSON.stringify(Array.from({ length: 11 }, (_, i) => `word ${i}`)), 'Use 10 values or fewer. Remove 1.'],
    ['icons_with_text', 'list.metaobject_reference', JSON.stringify([LAB_PRODUCTS[0].id]), 'Value 1: This field takes entries only.'],
    ['icons_with_text', 'list.metaobject_reference', JSON.stringify(['not an id']), 'Value 1: Choose an entry from the store.'],
    ['icons_with_text', 'list.metaobject_reference', JSON.stringify([entryOf('lab_icon_text'), entryOf('lab_icon_text')]), 'The same entry is in the list twice. Remove one.'],
    ['short_summary', 'metaobject_reference', LAB_PAGES[0].id, 'This field takes entries only.'],
    ['related_items', 'list.product_reference', productIds(11), 'Use 10 products or fewer. Remove 1.'],
    ['related_items', 'list.product_reference', JSON.stringify([LAB_PAGES[0].id]), 'Value 1: This field takes products only.'],
    ['average_rating', 'rating', '{"value":"6","scale_min":"1.0","scale_max":"5.0"}', 'Choose a rating from 1 to 5.'],
    ['average_rating', 'rating', '{"value":"8","scale_min":"0","scale_max":"10"}', 'Choose a rating from 1 to 5.'],
    ['average_rating', 'rating', 'four', 'Enter a valid structured value.'],
    ['rating_count', 'number_integer', '-1', 'Enter 0 or more.'],
    ['rating_count', 'number_integer', '1.5', 'Enter a whole number, for example 12.'],
    ['feed_custom_product', 'boolean', 'yes', 'Choose Yes or No.'],
    ['size_guide_page', 'page_reference', LAB_PRODUCTS[0].id, 'This field takes pages only.'],
    ['swatch_picture', 'file_reference', LAB_PRODUCTS[0].id, 'This field takes files only.'],
    ['swatch_colour', 'color', '#12345', 'Enter a colour as # and six characters, for example #1A2B3C.'],
  ])('%s (%s) refuses %j', (key, type, value, sentence) => {
    expect(store(key).type).toBe(type)
    expect(validateShopifyField(store(key), value)).toBe(sentence)
  })
  it('a file field limited to images refuses a video, and a pasted PDF in an image-or-video list, from the id alone', () => {
    const video = LAB_FILES.find(f => f.type === 'Video')!.id, pdf = LAB_FILES.find(f => f.type === 'GenericFile')!.id
    expect(validateShopifyField(labTypeField('file_reference'), video)).toBe('This field takes images only.')
    expect(validateShopifyField(labTypeField('list.file_reference'), JSON.stringify([LAB_FILES[0].id, pdf]))).toBe('Value 2: This field takes images and videos only.')
    expect(validateShopifyField(labTypeField('file_reference'), LAB_FILES[0].id)).toBeNull()
  })
  it('an entry of another kind is refused with the kind’s name; a missing one says so', () => {
    const refs = labReferences()
    const faq = refs.find(r => r.type === 'lab_faq')!
    expect(shopifyReferenceError(store('icons_with_text'), [faq], LAB_SCHEMA)).toBe('This field takes Icon with text entries only.')
    expect(shopifyReferenceError(store('icons_with_text'), [{ available: false }], LAB_SCHEMA)).toBe('A chosen entry is no longer in the store. Remove it or choose another.')
    expect(shopifyReferenceError(store('related_items'), [{ available: false }], LAB_SCHEMA)).toBe('A chosen product is no longer in the store. Remove it or choose another.')
  })
})

describe('B1 · the rule line in plain words (G6)', () => {
  it.each([
    ['related_items_display', 'One of: ahead, only manual'],
    ['search_words', 'Up to 100 characters each · Up to 10 values'],
    ['related_items', 'Up to 10 products'],
    ['average_rating', 'Rating 1 to 5'],
    ['rating_count', '0 or more'],
    ['icons_with_text', 'Icon with text entries'],
    ['colour_category', 'Color entries'],
    ['swatch_colour', ''],
    ['size_guide_page', ''],
  ])('%s → %s', (key, line) => {
    expect(shopifyRuleSummary(store(key), LAB_SCHEMA)).toBe(line)
  })
  it('covers the other rule kinds', () => {
    expect(shopifyRuleSummary(labTypeField('file_reference'), LAB_SCHEMA)).toBe('Images only')
    expect(shopifyRuleSummary(labTypeField('list.file_reference'), LAB_SCHEMA)).toBe('Images and videos only · Up to 6 files')
    expect(shopifyRuleSummary(labTypeField('number_decimal'), LAB_SCHEMA)).toBe('0 to 100 · Up to 2 decimal places')
    expect(shopifyRuleSummary(labTypeField('weight'), LAB_SCHEMA)).toBe('10 g to 25 kg')
    expect(shopifyRuleSummary(labTypeField('date'), LAB_SCHEMA)).toBe('From 2020-01-01 to 2030-12-31')
    expect(shopifyRuleSummary(labTypeField('url'), LAB_SCHEMA)).toBe('Only links on example.com')
    expect(shopifyRuleSummary(labTypeField('list.product_taxonomy_value_reference'), LAB_SCHEMA)).toBe('Shopify “color” values · 1 to 4 values')
    expect(shopifyRuleSummary(labTypeField('mixed_reference'), LAB_SCHEMA)).toBe('FAQ or Press quote entries')
    expect(shopifyRuleSummary({ type: 'single_line_text_field', validations: [{ name: 'min', value: '5' }, { name: 'max', value: '5' }], required: true })).toBe('Required · Exactly 5 characters')
    expect(shopifyRuleSummary({ type: 'metaobject_reference', validations: [{ name: 'metaobject_definition_id', value: 'gid://shopify/MetaobjectDefinition/77' }] }, LAB_SCHEMA)).toBe('An entry kind this store no longer has entries')
  })
})

describe('B1 · read-back compares values by type (G10)', () => {
  it.each([
    ['list.single_line_text_field', '["a","b"]', '[ "a", "b" ]', true],
    ['list.single_line_text_field', '["a","b"]', '["b","a"]', false],
    ['list.product_reference', JSON.stringify([LAB_PRODUCTS[0].id]), `[ "${LAB_PRODUCTS[0].id}" ]`, true],
    ['rating', '{"value":"4.5","scale_min":"1.0","scale_max":"5.0"}', '{"scale_max":"5.0","scale_min":"1.0","value":"4.50"}', true],
    ['rating', '{"value":"4.5","scale_min":"1.0","scale_max":"5.0"}', '{"value":"4.0","scale_min":"1.0","scale_max":"5.0"}', false],
    ['number_integer', '12', '12', true],
    ['number_integer', '12', '13', false],
    ['number_decimal', '12.50', '12.5', true],
    ['color', '#1A2B3C', '#1a2b3c', true],
    ['color', '#1A2B3C', '#1a2b3d', false],
    ['single_line_text_field', 'Racing', 'racing', false],
    ['boolean', 'true', 'false', false],
    ['weight', '{"value":1.2,"unit":"kilograms"}', '{"unit":"kilograms","value":1.20}', true],
    ['weight', '{"value":1.2,"unit":"kilograms"}', '{"value":1.2,"unit":"grams"}', false],
    ['json', '{"a":"1.0"}', '{"a":"1"}', false],
    ['json', '{"a":1,"b":[1,2]}', '{"b":[1,2],"a":1.0}', true],
    ['list.number_decimal', '[1.5,2]', '[1.50,2.0]', true],
    ['date_time', '2026-09-28T12:30:00', '2026-09-28T12:30:00Z', false],
  ] as const)('%s: %s vs %s → %s', (type, a, b, same) => {
    expect(shopifyValuesEqual(type, a, b)).toBe(same)
  })
  it('null is only equal to null', () => {
    expect(shopifyValuesEqual('color', null, null)).toBe(true)
    expect(shopifyValuesEqual('color', null, '#111111')).toBe(false)
  })
})
