import { describe, expect, it } from 'vitest'
import { shopifyReferenceError, validateShopifyField } from './shopify-linked-products'
import { shopifyRuleSummary } from './shopify-field-rules'
import { LAB_ENTRIES, LAB_PAGES, LAB_PRODUCTS, LAB_SCHEMA, LAB_VARIANTS, labBadValues, labGoodValue, labKind, labReferences, labTypeField } from './shopify-lab-store'

/*
 * Lane B slice B3c (docs/shopify-metafields/PLAN-2026-09-28.md §5, §6.3 rows "References" and "Mixed / disclosure", §7 L3):
 * the exact refusal sentence for every rule the other reference types and the mixed / disclosure types carry. Made-up store.
 */
const RESOURCES: Array<[type: string, one: string, other: string]> = [
  ['variant_reference', 'variant', 'variants'], ['collection_reference', 'collection', 'collections'], ['article_reference', 'article', 'articles'],
  ['customer_reference', 'customer', 'customers'], ['company_reference', 'company', 'companies'], ['order_reference', 'order', 'orders'],
]
const refs = labReferences()
const entry = (kind: string, n = 0) => refs.filter(r => r.type === kind)[n]
const article = (one: string) => (/^[aeiou]/.test(one) ? 'an' : 'a')

describe('B3c · the other references refuse with the exact plain sentence', () => {
  it.each(RESOURCES)('%s: the good value passes; another resource, a non-id, a duplicate and the list cap are refused', (type, one, other) => {
    const list = `list.${type}`
    expect(validateShopifyField(labTypeField(type), labGoodValue(type))).toBeNull()
    expect(validateShopifyField(labTypeField(list), labGoodValue(list))).toBeNull()
    const wrong = type === 'variant_reference' ? LAB_PRODUCTS[0].id : LAB_VARIANTS[0].id
    expect(validateShopifyField(labTypeField(type), wrong)).toBe(`This field takes ${other} only.`)
    expect(validateShopifyField(labTypeField(list), JSON.stringify([wrong]))).toBe(`Value 1: This field takes ${other} only.`)
    expect(validateShopifyField(labTypeField(type), 'not an id')).toBe(`Choose ${article(one)} ${one} from the store.`)
    const first = JSON.parse(labGoodValue(list)!)[0]
    expect(validateShopifyField(labTypeField(list), JSON.stringify([first, first]))).toBe(`The same ${one} is in the list twice. Remove one.`)
    const cap = labBadValues(list).find(b => b.rule === 'list.max')!.value
    expect(validateShopifyField(labTypeField(list), cap)).toBe(`Use 5 ${other} or fewer. Remove 1.`)
    expect(shopifyReferenceError(labTypeField(list), [{ available: false }], LAB_SCHEMA)).toBe(`A chosen ${one} is no longer in the store. Remove it or choose another.`)
  })
  it('every bad value of these types is refused (none is a known gap any more)', () => {
    for (const [type] of RESOURCES) for (const t of [type, `list.${type}`]) for (const bad of labBadValues(t)) {
      expect(bad.gap, `${t} ${bad.rule}`).toBeUndefined()
      expect(validateShopifyField(labTypeField(t), bad.value), `${t} ${bad.rule}`).not.toBeNull()
    }
  })
  it('the rule line: the list cap in the type’s own word', () => {
    expect(RESOURCES.map(([type]) => shopifyRuleSummary(labTypeField(`list.${type}`), LAB_SCHEMA)))
      .toEqual(['Up to 5 variants', 'Up to 5 collections', 'Up to 5 articles', 'Up to 5 customers', 'Up to 5 companies', 'Up to 5 orders'])
    expect(shopifyRuleSummary(labTypeField('order_reference'), LAB_SCHEMA)).toBe('')
  })
})

describe('B3c · mixed and disclosure entries', () => {
  const mixed = labTypeField('list.mixed_reference'), disclosure = labTypeField('list.disclosure_reference')
  it('an entry of any allowed kind passes, and one of each together', () => {
    expect(shopifyReferenceError(mixed, [entry('lab_faq'), entry('lab_press')], LAB_SCHEMA)).toBeNull()
    expect(shopifyReferenceError(labTypeField('mixed_reference'), [entry('lab_press', 1)], LAB_SCHEMA)).toBeNull()
    expect(shopifyReferenceError(disclosure, [entry('shopify--disclosure-lab'), entry('shopify--disclosure-lab', 1)], LAB_SCHEMA)).toBeNull()
  })
  it('an entry of a kind the field does not allow: "This field takes {Kind} or {Kind} entries only."', () => {
    expect(shopifyReferenceError(mixed, [entry('lab_faq'), entry('lab_icon_text')], LAB_SCHEMA)).toBe('This field takes FAQ or Press quote entries only.')
    expect(shopifyReferenceError(mixed, [entry('shopify--disclosure-lab')], LAB_SCHEMA)).toBe('This field takes FAQ or Press quote entries only.')
    expect(shopifyReferenceError(disclosure, [entry('lab_faq')], LAB_SCHEMA)).toBe('This field takes Disclosure (made up) entries only.')
    const three = { type: 'mixed_reference', validations: [{ name: 'metaobject_definition_types', value: '["lab_faq","lab_press","lab_heading"]' }] }
    expect(shopifyReferenceError(three, [entry('lab_ticker')], LAB_SCHEMA)).toBe('This field takes FAQ, Press quote or Heading entries only.')
    /* A reference whose kind is not known is not proven allowed: refused, never waved through. */
    expect(shopifyReferenceError(mixed, [{ available: true }], LAB_SCHEMA)).toBe('This field takes FAQ or Press quote entries only.')
  })
  it('gone, unreadable, or no kind in the store', () => {
    expect(shopifyReferenceError(mixed, [{ available: false }], LAB_SCHEMA)).toBe('A chosen entry is no longer in the store. Remove it or choose another.')
    expect(shopifyReferenceError({ type: 'mixed_reference', validations: [{ name: 'metaobject_definition_ids', value: 'not a list' }] }, [entry('lab_faq')], LAB_SCHEMA))
      .toBe('This field’s reference constraints cannot be read. Refresh the store schema.')
    const noDisclosureKinds = { ...LAB_SCHEMA, metaobjectDefinitions: LAB_SCHEMA.metaobjectDefinitions.filter(d => !d.type.startsWith('shopify--disclosure-')) }
    expect(shopifyReferenceError(disclosure, [entry('shopify--disclosure-lab')], noDisclosureKinds)).toBe('This field’s entry kind is no longer in the store. Refresh the store schema.')
  })
  it('the value itself: an entry id, once each, within the list cap', () => {
    for (const type of ['mixed_reference', 'disclosure_reference']) {
      expect(validateShopifyField(labTypeField(type), labGoodValue(type)), type).toBeNull()
      expect(validateShopifyField(labTypeField(`list.${type}`), labGoodValue(`list.${type}`)), type).toBeNull()
      expect(validateShopifyField(labTypeField(type), LAB_PRODUCTS[0].id), type).toBe('This field takes entries only.')
      expect(validateShopifyField(labTypeField(`list.${type}`), JSON.stringify([LAB_PAGES[0].id])), type).toBe('Value 1: This field takes entries only.')
      expect(validateShopifyField(labTypeField(type), 'not an id'), type).toBe('Choose an entry from the store.')
      const first = JSON.parse(labGoodValue(`list.${type}`)!)[0]
      expect(validateShopifyField(labTypeField(`list.${type}`), JSON.stringify([first, first])), type).toBe('The same entry is in the list twice. Remove one.')
      expect(validateShopifyField(labTypeField(`list.${type}`), labBadValues(`list.${type}`).find(b => b.rule === 'list.max')!.value), type).toBe('Use 5 entries or fewer. Remove 1.')
    }
  })
  it('the rule line names the allowed kinds', () => {
    expect(shopifyRuleSummary(mixed, LAB_SCHEMA)).toBe('FAQ or Press quote entries · Up to 5 entries')
    expect(shopifyRuleSummary(labTypeField('disclosure_reference'), LAB_SCHEMA)).toBe('Disclosure (made up) entries')
  })
  it('the made-up store holds two entries of each kind the lab’s mixed and disclosure fields take', () => {
    for (const kind of ['lab_faq', 'lab_press', 'shopify--disclosure-lab']) expect(LAB_ENTRIES.filter(e => e.type === kind).map(e => e.name)).toEqual([`${labKind(kind).name} 1`, `${labKind(kind).name} 2`])
  })
})
