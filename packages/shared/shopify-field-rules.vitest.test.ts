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
  it.each(bad.filter(sample => !sample.gap).map(s => [s.type, s.rule, s.value] as const))('%s refuses a value that breaks %s', (type, _rule, value) => {
    expect(validateShopifyField(labTypeField(type), value)).toEqual(expect.any(String))
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
