import { describe, expect, it } from 'vitest'
import { emptyShopifyLinkedDraft, fieldAddress, linkedFamilyChanges, mergeImportedLinkedFamily, shopifyLinkedDraftSchema, validateShopifyField } from './shopify-linked-products'
const gid = (id: number) => `gid://shopify/Product/${id}`
const draft = () => ({ ...emptyShopifyLinkedDraft(), relationship: { namespace: 'store_a', key: 'siblings', includeSelf: true },
  members: [1, 2].map(id => ({ id: gid(id), title: `Product ${id}`, handle: `p-${id}`, image: null })),
  baselineLinks: [1, 2].map(id => ({ ownerId: gid(id), namespace: 'store_a', key: 'siblings', type: 'list.product_reference', value: JSON.stringify([gid(1), gid(2)]), compareDigest: `digest${id}` })),
})
describe('Shopify separate-product relationship contract', () => {
  it('is a no-op for an already consistent family', () => expect(linkedFamilyChanges(draft())).toEqual([]))
  it('applies one reviewed order to every sibling with independent compare digests', () => {
    const d = draft(); d.members.reverse()
    expect(linkedFamilyChanges(d).map(c => [c.ownerId, c.nextValue, c.compareDigest])).toEqual([1, 2].map(id => [gid(id), JSON.stringify([gid(2), gid(1)]), `digest${id}`]))
  })
  it('supports themes that omit each owning product', () => {
    const d = draft(); d.relationship.includeSelf = false
    expect(linkedFamilyChanges(d).map(c => JSON.parse(c.nextValue!))).toEqual([[gid(2)], [gid(1)]])
  })
  it('unlinks a member and preserves its unrelated product references', () => {
    const d = draft(); d.members.pop(); d.baselineLinks[1].value = JSON.stringify([gid(2), gid(3), gid(1)])
    expect(linkedFamilyChanges(d).map(c => JSON.parse(c.nextValue!))).toEqual([[gid(1)], [gid(3)]])
  })
  it('keeps removed member observations and external-edit detection during replacement imports', () => {
    const before = draft(), imported = draft(); imported.members.pop(); imported.baselineLinks = imported.baselineLinks.slice(0, 1)
    imported.baselineLinks[0].compareDigest = 'changed-while-importing'
    const merged = mergeImportedLinkedFamily(before, imported)
    expect(merged.baselineLinks.map(f => f.compareDigest)).toEqual(['digest1', 'digest2'])
    expect(linkedFamilyChanges(merged).map(c => JSON.parse(c.nextValue!))).toEqual([[gid(1)], []])
  })
  it('requires observations for newly added products and preserves unreadable source values', () => {
    const d = draft(); d.members.push({ id: gid(3), title: 'Third', handle: 'third', image: null })
    expect(() => linkedFamilyChanges(d)).toThrow('every member')
    d.members.pop(); d.baselineLinks[0].value = 'broken'
    expect(() => linkedFamilyChanges(d)).toThrow('cannot be read')
  })
  it('refuses duplicate members and a second editing route for the relationship field', () => {
    const d = draft(); d.members.push(d.members[0]); expect(shopifyLinkedDraftSchema.safeParse(d).success).toBe(false)
    d.members.pop(); const withEdit = { ...d, edits: [{ ...d.baselineLinks[0], nextValue: '[]', ownerLabel: 'Product' }] }
    expect(shopifyLinkedDraftSchema.safeParse(withEdit).success).toBe(false)
  })
  it('keeps the same namespace/key distinct across product and variant owners', () => {
    expect(fieldAddress({ ownerId: gid(1), namespace: 'custom', key: 'copy' })).not.toBe(fieldAddress({ ownerId: 'gid://shopify/ProductVariant/1', namespace: 'custom', key: 'copy' }))
  })
})
describe('store-driven field types and validation', () => {
  it.each([
    ['boolean', 'false', null], ['number_integer', '0', null], ['number_integer', '1.2', 'whole number'],
    ['list.product_reference', JSON.stringify([gid(1)]), null], ['product_reference', 'gid://shopify/Metaobject/1', 'Product reference'],
    ['date', '2026-02-30', 'valid date'], ['date', '2026-09-09', null], ['json', '{', 'valid JSON'],
    ['list.single_line_text_field', '["Red","Blue"]', null], ['single_line_text_field', 'first\nsecond', 'one line'],
  ])('%s validates without discarding the stored value', (type, value, error) => {
    const result = validateShopifyField({ type: type!, validations: [] }, value)
    if (error) expect(result).toContain(error); else expect(result).toBeNull()
  })
  it('distinguishes explicit clears, empty lists, false and zero', () => {
    expect(validateShopifyField({ type: 'boolean', validations: [] }, null)).toBeNull()
    expect(validateShopifyField({ type: 'boolean', validations: [], required: true }, null)).toContain('required')
    expect(validateShopifyField({ type: 'list.product_reference', validations: [{ name: 'list.min', value: '1' }] }, '[]')).toContain('at least 1')
  })
  it('loads store-specific choices and text length limits', () => {
    expect(validateShopifyField({ type: 'single_line_text_field', validations: [{ name: 'choices', value: '["Rouge","Bleu"]' }] }, 'Red')).toContain('allowed values')
    expect(validateShopifyField({ type: 'single_line_text_field', validations: [{ name: 'max', value: '3' }] }, 'four')).toContain('at most 3')
  })
})
