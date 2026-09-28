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
    /* Changed in B3b (G15): this row said `false` in B1, when dates compared as exact text. Shopify documents a
       `date_time` with no zone as GMT, so both spellings are the same moment and a read-back of either is a good write. */
    ['date_time', '2026-09-28T12:30:00', '2026-09-28T12:30:00Z', true],
  ] as const)('%s: %s vs %s → %s', (type, a, b, same) => {
    expect(shopifyValuesEqual(type, a, b)).toBe(same)
  })
  it('null is only equal to null', () => {
    expect(shopifyValuesEqual('color', null, null)).toBe(true)
    expect(shopifyValuesEqual('color', null, '#111111')).toBe(false)
  })
})

/* ── Slice B3a: the 32 measurement kinds (PLAN §6.3, G14) — the lab's limits in other units, the rule line, read-back. ── */

describe('B3a · the lab’s newer measurement fields refuse with the exact sentence (limits in other units)', () => {
  const sentences = (type: string) => labBadValues(type).filter(bad => bad.rule === 'min' || bad.rule === 'max').map(bad => [bad.rule, bad.value, validateShopifyField(labTypeField(type), bad.value)])
  it.each([
    ['temperature', [['min', '{"value":-10.5,"unit":"celsius"}', 'Enter 14 fahrenheit or more.'], ['max', '{"value":50.5,"unit":"celsius"}', 'Enter 323.15 kelvin or less.']]],
    ['speed', [['max', '{"value":50,"unit":"kilometers_per_hour"}', 'Enter 30 miles per hour or less.']]],
    ['data_storage_capacity', [['min', '{"value":3999,"unit":"bytes"}', 'Enter 4 kilobytes or more.'], ['max', '{"value":2049,"unit":"megabytes"}', 'Enter 2 gigabytes or less.']]],
    ['duration', [['min', '{"value":0.25,"unit":"minutes"}', 'Enter 30 seconds or more.'], ['max', '{"value":121,"unit":"minutes"}', 'Enter 2 hours or less.']]],
    ['list.temperature', [['min', '[{"value":-10.5,"unit":"celsius"}]', 'Value 1: Enter 14 fahrenheit or more.'], ['max', '[{"value":50.5,"unit":"celsius"}]', 'Value 1: Enter 323.15 kelvin or less.']]],
  ] as const)('%s', (type, expected) => {
    expect(sentences(type)).toEqual(expected)
    expect(validateShopifyField(labTypeField(type), labGoodValue(type))).toBeNull()
  })
})

describe('B3a · the rule line states a measurement limit in its own words, and who checks one Nexus cannot read', () => {
  const weight = (...rules: Array<[string, string]>) => ({ type: 'weight', validations: rules.map(([name, value]) => ({ name, value })) })
  it.each([
    [labTypeField('temperature'), '14 fahrenheit to 323.15 kelvin'],
    [labTypeField('list.temperature'), '14 fahrenheit to 323.15 kelvin each · Up to 5 values'],
    [labTypeField('speed'), '30 miles per hour or less'],
    [labTypeField('data_storage_capacity'), '4 kilobytes to 2 gigabytes'],
    [labTypeField('duration'), '30 seconds to 2 hours'],
    [{ type: 'antenna_gain', validations: [{ name: 'max', value: '{"unit":"dBi","value":5}' }] }, '5 dBi or less'],
    [weight(['max', '{"unit":"parsecs","value":3}']), '3 parsecs or less · Shopify checks this limit when you publish'],
    [weight(['min', '{"unit":"rankine","value":400}'], ['max', '{"unit":"rankine","value":600}']), '400 rankine to 600 rankine · Shopify checks these limits when you publish'],
    [weight(['min', '{"unit":"g","value":10}'], ['max', '{"unit":"parsecs","value":3}']), '10 g to 3 parsecs · Shopify checks the 3 parsecs limit when you publish'],
    [weight(['max', '5']), '5 or less · Shopify checks this limit when you publish'],
  ] as const)('%j → %s', (def, line) => {
    expect(shopifyRuleSummary(def, LAB_SCHEMA)).toBe(line)
  })
})

describe('B3a · read-back compares every measurement kind by value and unit (G10)', () => {
  it.each([
    ['temperature', '{"value":21.5,"unit":"celsius"}', '{"unit":"celsius","value":21.50}', true],
    ['temperature', '{"value":21.5,"unit":"celsius"}', '{"value":21.5,"unit":"fahrenheit"}', false],
    ['speed', '{"value":2.5,"unit":"kilometers_per_hour"}', '{"value":"2.5","unit":"kilometers_per_hour"}', true],
    ['list.duration', '[{"value":45,"unit":"minutes"},{"value":46,"unit":"minutes"}]', '[ {"unit":"minutes","value":45.0}, {"unit":"minutes","value":46} ]', true],
    ['list.duration', '[{"value":45,"unit":"minutes"},{"value":46,"unit":"minutes"}]', '[{"value":46,"unit":"minutes"},{"value":45,"unit":"minutes"}]', false],
  ] as const)('%s: %s vs %s → %s', (type, a, b, same) => {
    expect(shopifyValuesEqual(type, a, b)).toBe(same)
  })
})

/* ── Slice B3b: dates, JSON, codes, link, money — the exact sentence for every rule (PLAN §5, §6.3; G15, G16, G17). ── */
import { shopifyDateTimeMs, shopifyDateTimeValue, shopifyJsonProblem, shopifyMomentWords } from './shopify-field-rules'

const moment = labTypeField('date_time'), moments = labTypeField('list.date_time')
const withRules = (type: string, rules: Array<[string, string]>) => ({ type, validations: rules.map(([name, value]) => ({ name, value })) })
/** Run `check` with the machine in another time zone, then restore it. Node reads `TZ` again when it changes. */
function inZone<T>(zone: string, check: () => T): T {
  const before = process.env.TZ
  process.env.TZ = zone
  try { return check() } finally { if (before === undefined) delete process.env.TZ; else process.env.TZ = before }
}

describe('B3b · date and time (G15): strict ISO 8601, no zone = UTC', () => {
  it.each([
    ['tomorrow'], ['Sep 28 2026 12:30'], ['2026-09-28 12:30:00'], ['2026-09-28'], ['2026-02-30T12:00:00'], ['2100-02-29T00:00:00'],
    ['2026-09-28T24:00:00'], ['2026-09-28T12:60:00'], ['2026-09-28T12:30:00+25:00'], ['2026-09-28T12:30:00z'], ['2026-09-28T12:30:00+0200'], [''],
  ])('refuses %j: "Choose a date and a time."', value => {
    expect(validateShopifyField(moment, value)).toBe('Choose a date and a time.')
  })
  it.each([['2026-09-28T12:30'], ['2026-09-28T12:30:00'], ['2026-09-28T12:30:00Z'], ['2026-09-28T12:30:00.5Z'], ['2026-09-28T12:30:00.123456789Z'], ['2026-09-28T14:30:00+02:00'], ['2024-02-29T00:00:00']])('accepts %j', value => {
    expect(validateShopifyField(moment, value)).toBeNull()
  })
  it('the limits, in UTC words, whatever zone the value is written in', () => {
    expect(validateShopifyField(moment, '2019-12-31T23:59:59')).toBe('Choose 2020-01-01 00:00 (UTC) or later.')
    expect(validateShopifyField(moment, '2031-01-01T00:00:00')).toBe('Choose 2030-12-31 23:59:59 (UTC) or earlier.')
    expect(validateShopifyField(moment, '2020-01-01T00:30:00+01:00')).toBe('Choose 2020-01-01 00:00 (UTC) or later.') // 2019-12-31 23:30 UTC
    expect(validateShopifyField(moment, '2031-01-01T00:30:00+01:00')).toBeNull() // 2030-12-31 23:30 UTC
    expect(validateShopifyField(moments, JSON.stringify(['2026-09-28T12:30:00', '2031-01-01T00:00:00']))).toBe('Value 2: Choose 2030-12-31 23:59:59 (UTC) or earlier.')
    expect(validateShopifyField(moments, JSON.stringify(['Sep 28 2026']))).toBe('Value 1: Choose a date and a time.')
    const zoned = withRules('date_time', [['min', '2026-01-01T00:00:00+02:00']])
    expect(validateShopifyField(zoned, '2025-12-31T21:59:00')).toBe('Choose 2025-12-31 22:00 (UTC) or later.')
    expect(validateShopifyField(zoned, '2025-12-31T22:00:00')).toBeNull()
    expect(validateShopifyField(withRules('date_time', [['max', 'soon']]), '2026-09-28T12:30:00'), 'a limit Nexus cannot read is left to Shopify').toBeNull()
  })
  it('the rule line says the limits in UTC, even when the store wrote a zone', () => {
    expect(shopifyRuleSummary(moment, LAB_SCHEMA)).toBe('From 2020-01-01 00:00 (UTC) to 2030-12-31 23:59:59 (UTC)')
    expect(shopifyRuleSummary(withRules('date_time', [['min', '2026-01-01T00:00:00+02:00']]))).toBe('From 2025-12-31 22:00 (UTC)')
    expect(shopifyRuleSummary(labTypeField('date'), LAB_SCHEMA)).toBe('From 2020-01-01 to 2030-12-31')
  })
  it('never reads a value or a limit in the machine’s zone (Rome and Los Angeles give the UTC answer)', () => {
    for (const zone of ['Europe/Rome', 'America/Los_Angeles', 'Asia/Kolkata']) inZone(zone, () => {
      /* Control: the old reading (`Date.parse`) does move with the zone here, so this test would see the defect. */
      expect(Date.parse('2026-09-28T12:30:00'), zone).not.toBe(Date.parse('2026-09-28T12:30:00Z'))
      expect(shopifyDateTimeMs('2026-09-28T12:30:00'), zone).toBe(Date.parse('2026-09-28T12:30:00Z'))
      expect(validateShopifyField(moment, '2019-12-31T23:59:59'), zone).toBe('Choose 2020-01-01 00:00 (UTC) or later.')
      expect(validateShopifyField(moment, '2020-01-01T00:00:00'), zone).toBeNull()
      expect(validateShopifyField(moment, '2030-12-31T23:59:59'), zone).toBeNull()
      expect(shopifyValuesEqual('date_time', '2026-09-28T12:30:00', '2026-09-28T12:30:00Z'), zone).toBe(true)
      expect(shopifyRuleSummary(moment, LAB_SCHEMA), zone).toBe('From 2020-01-01 00:00 (UTC) to 2030-12-31 23:59:59 (UTC)')
    })
  })
  it('the picker’s instant is written in Shopify’s documented form: UTC, no zone', () => {
    expect(shopifyDateTimeValue('2026-09-28T12:30:00.000Z')).toBe('2026-09-28T12:30:00')
    expect(shopifyDateTimeValue('2026-09-28T12:30:00.250Z')).toBe('2026-09-28T12:30:00.250')
    expect(shopifyDateTimeValue('2026-09-28T14:30:00+02:00')).toBe('2026-09-28T12:30:00')
    for (const written of ['2026-09-28T12:30:00.000Z', '2026-09-28T12:30:00.250Z', '0099-01-01T00:00:00.000Z']) {
      expect(shopifyDateTimeMs(shopifyDateTimeValue(written))).toBe(Date.parse(written))
      expect(validateShopifyField({ type: 'date_time', validations: [] }, shopifyDateTimeValue(written))).toBeNull()
    }
    expect(shopifyMomentWords(Date.parse('2026-09-28T12:30:00Z'))).toBe('2026-09-28 12:30')
    expect(shopifyMomentWords(Date.parse('2026-09-28T12:30:05Z'))).toBe('2026-09-28 12:30:05')
  })
  it.each([
    ['date_time', '2026-09-28T12:30:00', '2026-09-28T14:30:00+02:00', true],
    ['date_time', '2026-09-28T12:30:00', '2026-09-28T12:30:00.000Z', true],
    ['date_time', '2026-09-28T12:30:00', '2026-09-28T12:31:00', false],
    ['date_time', 'Sep 28 2026', 'Sep 28 2026 00:00', false],
    ['list.date_time', '["2026-09-28T12:30:00"]', '["2026-09-28T12:30:00Z"]', true],
    ['list.date_time', '["2026-09-28T12:30:00"]', '["2026-09-28T13:30:00Z"]', false],
    ['date', '2026-09-28', '2026-09-28', true],
    ['date', '2026-09-28', '2026-09-29', false],
  ] as const)('read-back: %s %s vs %s → %s', (type, a, b, same) => {
    expect(shopifyValuesEqual(type, a, b)).toBe(same)
  })
})

describe('B3b · JSON (G16): the refusal says where and why, the same words in every engine', () => {
  const json = labTypeField('json')
  it.each([
    ['{"fit":', 'This is not valid JSON: the text ends where a value is needed.'],
    ['{fit: "regular"}', 'This is not valid JSON: a name in double quotes is needed at line 1, character 2.'],
    ["{'fit':1}", 'This is not valid JSON: a name in double quotes is needed at line 1, character 2.'],
    ['{"fit": "regular",}', 'This is not valid JSON: a name in double quotes is needed at line 1, character 19.'],
    ['{"fit" "regular"}', 'This is not valid JSON: “:” is needed at line 1, character 8.'],
    ['{"a":1 "b":2}', 'This is not valid JSON: “,” or “}” is needed at line 1, character 8.'],
    ['[1,2', 'This is not valid JSON: the text ends where “,” or “]” is needed.'],
    ['{"fit":"reg\nular"}', 'This is not valid JSON: a line break or tab inside quotes, at line 1, character 12, must be written as \\n or \\t.'],
    ['{"fit":"regular}', 'This is not valid JSON: the text in quotes that starts at line 1, character 8 is not closed.'],
    ['{"fit":"regular"}}', 'This is not valid JSON: there is more text after the end, at line 1, character 18.'],
    ['{\n  "fit": regular\n}', 'This is not valid JSON: a value is needed at line 2, character 10.'],
    ['"\\x"', 'This is not valid JSON: the “\\” at line 1, character 2 does not start a valid escape.'],
    ['', 'This is not valid JSON: it is empty.'],
    ['{"size":"M"}', 'The store’s JSON schema requires this value must have required property \'fit\'.'],
  ])('%j → %s', (value, sentence) => {
    expect(validateShopifyField(json, value)).toBe(sentence)
  })
  it('valid JSON of every kind passes the syntax check (the store schema is a separate rule)', () => {
    for (const value of ['{"fit":"regular"}', '[]', '0', '-1.5e3', 'true', 'null', '"text"', '{"a":[1,{"b":"\\u00e9\\n"}]}']) {
      expect(shopifyJsonProblem(value), value).toBeNull()
      expect(validateShopifyField({ type: 'json', validations: [] }, value), value).toBeNull()
    }
  })
  it('names a problem exactly when the parser refuses: every one-character cut of real JSON', () => {
    const samples = [JSON.stringify({ fit: 'regular', sizes: [1, 2.5, -3e2], nested: { ok: true, none: null, text: 'a\\"b' } }, null, 2), '["a",{"b":[]},0]']
    let checked = 0
    for (const sample of samples) for (let i = 0; i < sample.length; i++) for (const text of [sample.slice(0, i) + sample.slice(i + 1), sample.slice(0, i)]) {
      let parses = true
      try { JSON.parse(text) } catch { parses = false }
      expect(shopifyJsonProblem(text) === null, JSON.stringify(text)).toBe(parses)
      checked++
    }
    expect(checked).toBeGreaterThan(300)
  })
  it('rich text: a tree that is not JSON gets the same JSON sentence; a wrong tree its own', () => {
    const rich = labTypeField('rich_text_field')
    expect(validateShopifyField(rich, '{"type":"root"')).toBe('This is not valid JSON: the text ends where “,” or “}” is needed.')
    expect(validateShopifyField(rich, '{"type":"paragraph"}')).toBe('Use rich text with a root and children.')
    expect(validateShopifyField(rich, '{"type":"root","children":"wrong"}')).toBe('Use rich text with a root and children.')
    expect(validateShopifyField(rich, '{"type":"root","children":[]}')).toBeNull()
    expect(validateShopifyField(rich, labGoodValue('rich_text_field'))).toBeNull()
  })
})

describe('B3b · codes (G16)', () => {
  it.each([
    ['jurisdiction', 'Italy', 'Enter a country or subdivision code, such as US or US-CA.'],
    ['jurisdiction', 'it', 'Enter a country or subdivision code, such as US or US-CA.'],
    ['jurisdiction', 'US-', 'Enter a country or subdivision code, such as US or US-CA.'],
    ['jurisdiction', 'IT', null], ['jurisdiction', 'US-CA', null],
    ['language', 'english', 'Enter a language code, for example en or it-IT.'],
    ['language', 'EN', 'Enter a language code, for example en or it-IT.'],
    ['language', 'en', null], ['language', 'it-IT', null], ['language', 'pt-BR', null],
  ])('%s %j → %s', (type, value, sentence) => {
    expect(validateShopifyField(labTypeField(type), value)).toBe(sentence)
  })
})

describe('B3b · link (G17): the allowed sites are checked on the link’s URL, with the url field’s words', () => {
  const link = labTypeField('link'), links = labTypeField('list.link')
  it('refuses a link on another site, alone and in a list; accepts the allowed site in any letter case', () => {
    expect(validateShopifyField(link, JSON.stringify({ text: 'Elsewhere', url: 'https://other.test/' }))).toBe('Use a link on one of these sites: example.com.')
    expect(validateShopifyField(labTypeField('url'), 'https://other.test/size-guide')).toBe('Use a link on one of these sites: example.com.')
    expect(validateShopifyField(links, JSON.stringify([{ text: 'Size guide', url: 'https://example.com/a' }, { text: 'Elsewhere', url: 'https://other.test/' }]))).toBe('Value 2: Use a link on one of these sites: example.com.')
    expect(validateShopifyField(link, JSON.stringify({ text: 'Size guide', url: 'https://EXAMPLE.com/size-guide' }))).toBeNull()
    expect(validateShopifyField(link, JSON.stringify({ text: '', url: 'https://example.com' }))).toBe('Enter the link text.')
    expect(validateShopifyField(link, JSON.stringify({ text: 'Size guide', url: 'example.com' }))).toBe('Enter a full web address, for example https://example.com.')
  })
  it('several sites are listed; an unreadable list says so (a url field used to crash on a non-list); an empty list sets no limit', () => {
    expect(validateShopifyField(withRules('link', [['allowed_domains', '["example.com","shop.example"]']]), '{"text":"A","url":"https://b.test"}')).toBe('Use a link on one of these sites: example.com, shop.example.')
    for (const type of ['link', 'url']) {
      const value = type === 'link' ? '{"text":"A","url":"https://b.test"}' : 'https://b.test'
      expect(validateShopifyField(withRules(type, [['allowed_domains', 'not json']]), value)).toBe('This definition’s allowed domains cannot be read. Refresh the store schema.')
      expect(validateShopifyField(withRules(type, [['allowed_domains', '"example.com"']]), value)).toBe('This definition’s allowed domains cannot be read. Refresh the store schema.')
      expect(validateShopifyField(withRules(type, [['allowed_domains', '[]']]), value)).toBeNull()
    }
  })
})

describe('B3b · money: the sentences of §5', () => {
  it.each([
    ['{"amount":"abc","currency_code":"EUR"}', 'Enter an amount, for example 12.50.'],
    ['{"amount":"12,50","currency_code":"EUR"}', 'Enter an amount, for example 12.50.'],
    ['{"amount":"12.50","currency_code":"eur"}', 'Enter a three-letter currency code, for example EUR.'],
    ['{"amount":"12.50","currency_code":"EUR"}', null],
    ['{"amount":"20.00","currency_code":"USD"}', null],
  ])('%s → %s', (value, sentence) => {
    expect(validateShopifyField(labTypeField('money'), value)).toBe(sentence)
  })
})

/* B3 review: an empty allowed-sites list sets no limit (the check accepts every site), so the rule line says nothing of it. */
describe('B3 review · allowed sites in the rule line', () => {
  it('names the sites of a list, and nothing for an empty list', () => {
    for (const type of ['url', 'link']) {
      const withSites = (value: string) => ({ ...labTypeField(type), validations: [{ name: 'allowed_domains', value }] })
      expect(shopifyRuleSummary(withSites('["shop.test","help.test"]'), LAB_SCHEMA), type).toContain('Only links on shop.test or help.test')
      expect(shopifyRuleSummary(withSites('[]'), LAB_SCHEMA), type).not.toContain('Only links')
      expect(validateShopifyField(withSites('[]'), type === 'url' ? 'https://x.test/' : '{"text":"X","url":"https://x.test/"}'), type).toBeNull()
    }
  })
})

/* ── Slice B4: values and limits in the form a real store stores them (measured on a development store, 2026-09-28). ── */
describe('B4 · what Shopify stores, read as the same value', () => {
  it('a measurement unit comes back in capitals: the same value, and a valid one', () => {
    for (const [type, sent, stored] of [
      ['weight', '{"value":1.2,"unit":"kilograms"}', '{"value":1.2,"unit":"KILOGRAMS"}'],
      ['data_storage_capacity', '{"value":64,"unit":"megabytes"}', '{"value":64.0,"unit":"MEGABYTES"}'],
      ['antenna_gain', '{"value":2.5,"unit":"decibels_isotropic"}', '{"value":2.5,"unit":"DECIBELS_ISOTROPIC"}'],
      ['list.speed', '[{"value":2.5,"unit":"kilometers_per_hour"},{"value":3,"unit":"miles_per_hour"}]', '[{"value":2.5,"unit":"KILOMETERS_PER_HOUR"},{"value":3.0,"unit":"MILES_PER_HOUR"}]'],
    ] as const) {
      expect(shopifyValuesEqual(type, sent, stored), type).toBe(true)
      expect(validateShopifyField(labTypeField(type), stored), type).toBeNull()
    }
    expect(shopifyValuesEqual('weight', '{"value":1.2,"unit":"kilograms"}', '{"value":1.2,"unit":"GRAMS"}')).toBe(false)
    expect(shopifyValuesEqual('weight', '{"value":1.2,"unit":"kilograms"}', '{"value":1.3,"unit":"KILOGRAMS"}')).toBe(false)
    expect(validateShopifyField(labTypeField('weight'), '{"value":1.2,"unit":"PARSECS"}')).toBe('Choose a unit from the list.')
  })
  it('the other spellings Shopify returns are the same value', () => {
    expect(shopifyValuesEqual('date_time', '2026-09-28T12:30:00', '2026-09-28T12:30:00+00:00')).toBe(true)
    expect(shopifyValuesEqual('list.date_time', '["2026-09-28T12:30:00"]', '["2026-09-28T12:30:00+00:00"]')).toBe(true)
    expect(shopifyValuesEqual('list.number_decimal', '[12.5,3.25]', '["12.5","3.25"]')).toBe(true)
    expect(shopifyValuesEqual('rating', '{"value":"4.5","scale_min":"1.0","scale_max":"5.0"}', '{"scale_min":"1.0","scale_max":"5.0","value":"4.5"}')).toBe(true)
  })
  it('a limit stored in capitals is read, checked and said in plain words', () => {
    const withLimits = (type: string, validations: Array<[string, string]>) => ({ ...labTypeField(type), validations: validations.map(([name, value]) => ({ name, value })) })
    const weight = withLimits('weight', [['min', '{"value":10.0,"unit":"GRAMS"}'], ['max', '{"value":25.0,"unit":"KILOGRAMS"}']])
    expect(validateShopifyField(weight, '{"value":30,"unit":"kilograms"}')).toBe('Enter 25 kilograms or less.')
    expect(validateShopifyField(weight, '{"value":5,"unit":"GRAMS"}')).toBe('Enter 10 grams or more.')
    expect(validateShopifyField(weight, '{"value":1.2,"unit":"KILOGRAMS"}')).toBeNull()
    expect(shopifyRuleSummary(weight, LAB_SCHEMA)).toBe('10 grams to 25 kilograms')
    const temperature = withLimits('temperature', [['min', '{"value":14.0,"unit":"FAHRENHEIT"}'], ['max', '{"value":323.15,"unit":"KELVIN"}']])
    expect(validateShopifyField(temperature, '{"value":-10.5,"unit":"celsius"}')).toBe('Enter 14 fahrenheit or more.')
    expect(validateShopifyField(withLimits('speed', [['max', '{"value":30.0,"unit":"MILES_PER_HOUR"}']]), '{"value":50,"unit":"kilometers_per_hour"}')).toBe('Enter 30 miles per hour or less.')
  })
})
