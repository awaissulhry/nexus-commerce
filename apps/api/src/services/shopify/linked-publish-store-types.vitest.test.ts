import { beforeEach, describe, expect, it } from 'vitest'
import type { ShopifyFieldEdit } from '@nexus/shared/shopify-linked-products'
import { LAB_ENTRIES, LAB_FILES, LAB_PAGES, LAB_PRODUCTS, LAB_SCHEMA, LAB_STORE_FIELDS, labTypeField } from '@nexus/shared/shopify-lab-store'
import { applyLinkedBatch, linkedRefusalSentence, sharedSourceChanged } from './linked-products.service.js'

/*
 * Lane B slice B1 (docs/shopify-metafields/PLAN-2026-09-28.md §6.1, §7 L5): publishing the 11 store types to a stand-in
 * Shopify. Q4 "what you see is what is sent": `metafieldsSet` receives exactly the sheet's type and value. G10: a value
 * Shopify stores in another spelling (spacing, key order, "4.50") is the same value, so a good write is not reported as
 * a failure — while a real difference still is. G9: Shopify's refusal names the field and the product in plain words.
 */
const product = 'gid://shopify/Product/10', variant = 'gid://shopify/ProductVariant/11'
interface Stored { type: string; value: string; compareDigest: string }
let store: Map<string, Stored>, sets: any[][], respell: (type: string, value: string) => string, refuse: any[] | null
const address = (ownerId: string, namespace: string, key: string) => `${ownerId}|${namespace}|${key}`
const gql = async (query: string, variables: any): Promise<any> => {
  if (query.includes('NexusLinkedFieldValues')) {
    const out: Record<string, unknown> = {}
    for (let i = 0; variables[`id${i}`]; i++) {
      const stored = store.get(address(variables[`id${i}`], variables[`ns${i}`], variables[`key${i}`]))
      out[`owner${i}`] = { id: variables[`id${i}`], metafield: stored ? { id: `gid://shopify/Metafield/${i + 1}`, namespace: variables[`ns${i}`], key: variables[`key${i}`], ...stored } : null }
    }
    return out
  }
  if (query.includes('NexusLinkedSet')) {
    sets.push(variables.metafields)
    if (refuse) return { metafieldsSet: { metafields: [], userErrors: refuse } }
    for (const m of variables.metafields) store.set(address(m.ownerId, m.namespace, m.key), { type: m.type, value: respell(m.type, m.value), compareDigest: `digest-${sets.length}` })
    return { metafieldsSet: { metafields: variables.metafields.map((_: unknown, i: number) => ({ id: `gid://shopify/Metafield/${i}` })), userErrors: [] } }
  }
  throw new Error(`Unexpected Shopify call: ${query.slice(0, 60)}`)
}
beforeEach(() => { store = new Map(); sets = []; respell = (_type, value) => value; refuse = null })

const def = (key: string) => key === 'limited_file' ? labTypeField('file_reference') : LAB_STORE_FIELDS.find(d => d.key === key)!
const edit = (key: string, nextValue: string | null, value: string | null = null): ShopifyFieldEdit => {
  const d = def(key), ownerId = d.ownerType === 'PRODUCT' ? product : variant
  if (value !== null) store.set(address(ownerId, d.namespace, d.key), { type: d.type, value, compareDigest: 'digest-0' })
  return { ownerId, namespace: d.namespace, key: d.key, type: d.type, value, compareDigest: value === null ? null : 'digest-0', nextValue, ownerLabel: d.ownerType === 'PRODUCT' ? 'Listed title' : 'Listed title / Small' }
}
const entry = (kind: string, n = 0) => LAB_ENTRIES.filter(e => e.type === kind)[n].id
const GOOD: Array<[string, string]> = [
  ['related_items_display', 'only manual'],
  ['variation_label', 'Black'],
  ['search_words', JSON.stringify(['rain jacket', 'touring'])],
  ['icons_with_text', JSON.stringify([entry('lab_icon_text', 0), entry('lab_icon_text', 1)])],
  ['short_summary', entry('lab_summary')],
  ['related_items', JSON.stringify([LAB_PRODUCTS[1].id, LAB_PRODUCTS[2].id])],
  ['average_rating', '{"value":"4.5","scale_min":"1.0","scale_max":"5.0"}'],
  ['rating_count', '12'],
  ['feed_custom_product', 'true'],
  ['size_guide_page', LAB_PAGES[0].id],
  ['swatch_picture', LAB_FILES[0].id],
  ['swatch_colour', '#1A2B3C'],
  ['sort_position', '2'],
  ['limited_file', LAB_FILES[1].id],
]

describe('B1 · publish sends exactly what the sheet holds (Q4 parity)', () => {
  it.each(GOOD)('%s: metafieldsSet receives the sheet’s type and value unchanged', async (key, value) => {
    const change = edit(key, value)
    await applyLinkedBatch(gql as never, [change], LAB_SCHEMA)
    expect(sets).toHaveLength(1)
    expect(sets[0]).toEqual([{ ownerId: change.ownerId, namespace: change.namespace, key: change.key, type: def(key).type, value, compareDigest: null }])
  })
  it('sends a whole batch of the store types in one call, in order', async () => {
    const changes = GOOD.map(([key, value]) => edit(key, value))
    await applyLinkedBatch(gql as never, changes, LAB_SCHEMA)
    expect(sets).toHaveLength(1)
    expect(sets[0].map((m: any) => [m.key, m.type, m.value])).toEqual(changes.map(c => [c.key, c.type, c.nextValue]))
  })
})

describe('B1 · read-back compares by type (G10)', () => {
  it('accepts a value Shopify stores in another spelling', async () => {
    respell = (type, value) => type.startsWith('list.') ? JSON.stringify(JSON.parse(value), null, 1)
      : type === 'rating' ? '{"scale_max":"5.0","scale_min":"1.0","value":"4.50"}'
      : type === 'color' ? value.toLowerCase() : value
    await expect(applyLinkedBatch(gql as never, [edit('search_words', '["a","b"]'), edit('average_rating', '{"value":"4.5","scale_min":"1.0","scale_max":"5.0"}'), edit('swatch_colour', '#1A2B3C')], LAB_SCHEMA)).resolves.toBeUndefined()
  })
  it('still refuses a real difference', async () => {
    respell = (type, value) => type === 'rating' ? '{"value":"4.0","scale_min":"1.0","scale_max":"5.0"}' : value
    await expect(applyLinkedBatch(gql as never, [edit('average_rating', '{"value":"4.5","scale_min":"1.0","scale_max":"5.0"}')], LAB_SCHEMA)).rejects.toThrow('Shopify readback differs')
  })
  it('does not write again when Shopify already holds the same value in another spelling', async () => {
    const change = edit('search_words', '["a","b"]', '["x"]')
    store.set(address(product, change.namespace, change.key), { type: change.type, value: '[ "a", "b" ]', compareDigest: 'digest-9' })
    await applyLinkedBatch(gql as never, [change], LAB_SCHEMA)
    expect(sets).toEqual([])
  })
})

describe('B1 · Shopify’s refusal in plain words (G9)', () => {
  it('names the field and the owner, with Shopify’s own message, for each refused input', async () => {
    refuse = [
      { field: ['metafields', '1', 'value'], message: 'Value must be an entry of the right kind', code: 'INVALID_VALUE', elementIndex: 1 },
      { field: ['metafields', '2', 'value'], message: 'Color is invalid.', code: 'INVALID_VALUE', elementIndex: null },
    ]
    const changes = [edit('variation_label', 'Black'), edit('icons_with_text', JSON.stringify([entry('lab_icon_text')])), edit('swatch_colour', '#1A2B3C')]
    await expect(applyLinkedBatch(gql as never, changes, LAB_SCHEMA)).rejects.toThrow(
      'Shopify did not save Icons with text on Listed title: Value must be an entry of the right kind. Shopify did not save Swatch colour on Listed title / Small: Color is invalid.')
  })
  it('keeps Shopify’s words when it does not say which input it refused', () => {
    expect(linkedRefusalSentence([{ message: 'Too many requests' }], [], LAB_SCHEMA)).toBe('Shopify did not save the fields: Too many requests.')
  })
})

describe('B1 · a resumed sync reads its shared sources by type (G10, review finding)', () => {
  const rating = '{"value":"4.5","scale_min":"1.0","scale_max":"5.0"}'
  const read = { ownerId: product, namespace: 'lab_store', key: 'average_rating', type: 'rating', value: '{"value":"4.0","scale_min":"1.0","scale_max":"5.0"}', compareDigest: 'd-0' }
  const own = { ...read, nextValue: rating, ownerLabel: 'Listed title' }
  it('its own planned edit, stored by Shopify in another spelling, is not a change', () => {
    expect(sharedSourceChanged([read], [{ ...read, value: '{"scale_max":"5.0","scale_min":"1.0","value":"4.50"}', compareDigest: 'd-1' }], [own])).toBe(false)
  })
  it('a source still as it was read is not a change', () => {
    expect(sharedSourceChanged([read], [read], [])).toBe(false)
  })
  it('a value someone else wrote is a change', () => {
    expect(sharedSourceChanged([read], [{ ...read, value: '{"value":"3.0","scale_min":"1.0","scale_max":"5.0"}', compareDigest: 'd-2' }], [own])).toBe(true)
    expect(sharedSourceChanged([read], [{ ...read, value: rating, compareDigest: 'd-3' }], [])).toBe(true)
  })
})
