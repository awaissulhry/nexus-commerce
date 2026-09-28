import { beforeEach, describe, expect, it } from 'vitest'
import { parse } from 'graphql'
import {
  invalidateLinkedReferenceNames, REFERENCE_NAME_TTL_MS, resolveLinkedReferenceNames, resolveLinkedReferences, searchLinkedReferences,
} from './linked-products-gateway'

/* Sheet pop-up rebuild P1 (docs/sheet-popup-editor/PLAN-2026-09-27.md §4.3): entries carry their own picture — the
   swatch of a colour entry, the icon of a "Text with icon" entry — and display names are cached per store. Made-up ids. */
const entry = (n: number) => `gid://shopify/Metaobject/${n}`
const variant = (n: number) => `gid://shopify/ProductVariant/${n}`

const nodeFor = (id: string): any => {
  if (id === entry(1)) return { id, __typename: 'Metaobject', displayName: 'Green', type: 'shopify--color-pattern', thumbnailField: { thumbnail: { hex: '#3c9a4b', file: null } } }
  if (id === entry(2)) return { id, __typename: 'Metaobject', displayName: 'Water-repellent', type: 'text_with_icon', thumbnailField: { thumbnail: { hex: null, file: { preview: { image: { url: 'https://cdn.shopify.com/s/files/icon.png' } } } } } }
  if (id === entry(3)) return { id, __typename: 'Metaobject', displayName: 'Plain', type: 'concise_description', thumbnailField: null }
  if (id === variant(1)) return { id, __typename: 'ProductVariant', title: 'M', product: { title: 'Sample Jacket', featuredMedia: { preview: { image: { url: 'https://cdn.shopify.com/s/files/jacket.png' } } } }, media: { nodes: [{ preview: { image: { url: 'https://cdn.shopify.com/s/files/jacket-m.png' } } }] } }
  if (id === variant(2)) return { id, __typename: 'ProductVariant', title: 'L', product: { title: 'Sample Jacket', featuredMedia: { preview: { image: { url: 'https://cdn.shopify.com/s/files/jacket.png' } } } }, media: { nodes: [] } }
  return null
}

let calls: { name: string; variables: any }[]
const gql = async (query: string, variables: any = {}): Promise<any> => {
  parse(query)
  const name = query.match(/(?:query|mutation)\s+(\w+)/)![1]
  calls.push({ name, variables })
  if (name === 'NexusLinkedReferenceNames') return { nodes: variables.ids.map(nodeFor) }
  if (name === 'NexusLinkedReferenceSearch') return { metaobjects: { nodes: [nodeFor(entry(1)), nodeFor(entry(2)), nodeFor(entry(3))], pageInfo: { hasNextPage: false, endCursor: null } } }
  throw new Error(`unexpected ${name}`)
}

beforeEach(() => { calls = []; invalidateLinkedReferenceNames() })

describe('reference pictures', () => {
  it('gives a colour entry its swatch and an icon entry its picture, read from the thumbnail field', async () => {
    const refs = await resolveLinkedReferences(gql, [entry(1), entry(2), entry(3)])
    expect(refs.map(r => [r.label, r.image, r.swatch ?? null])).toEqual([
      ['Green', null, '#3c9a4b'],
      ['Water-repellent', 'https://cdn.shopify.com/s/files/icon.png', null],
      ['Plain', null, null],
    ])
    expect(calls[0].name).toBe('NexusLinkedReferenceNames')
  })
  it("gives a variant its own first photo, else its product's", async () => {
    const refs = await resolveLinkedReferences(gql, [variant(1), variant(2)])
    expect(refs.map(r => [r.label, r.image])).toEqual([
      ['Sample Jacket / M', 'https://cdn.shopify.com/s/files/jacket-m.png'],
      ['Sample Jacket / L', 'https://cdn.shopify.com/s/files/jacket.png'],
    ])
  })
  it('returns entry pictures and swatches from the entry search too', async () => {
    const page = await searchLinkedReferences(gql, { type: 'list.metaobject_reference', metaobjectType: 'shopify--color-pattern' })
    expect(page.items.map(i => [i.label, i.image, i.swatch ?? null])).toEqual([
      ['Green', null, '#3c9a4b'],
      ['Water-repellent', 'https://cdn.shopify.com/s/files/icon.png', null],
      ['Plain', null, null],
    ])
  })
})

describe('display name cache', () => {
  it('asks Shopify once per store within ten minutes, and again after', async () => {
    const t0 = 1_000_000
    await resolveLinkedReferenceNames(gql, 'A', [entry(1), entry(2)], t0)
    await resolveLinkedReferenceNames(gql, 'A', [entry(2), entry(1)], t0 + 1000)
    expect(calls).toHaveLength(1)
    await resolveLinkedReferenceNames(gql, 'A', [entry(1)], t0 + REFERENCE_NAME_TTL_MS + 1)
    expect(calls).toHaveLength(2)
  })
  it('keeps stores apart, and asks only for what it does not hold', async () => {
    await resolveLinkedReferenceNames(gql, 'A', [entry(1)], 0)
    await resolveLinkedReferenceNames(gql, 'B', [entry(1)], 0)
    const refs = await resolveLinkedReferenceNames(gql, 'A', [entry(1), entry(2)], 1)
    expect(calls.map(c => c.variables.ids)).toEqual([[entry(1)], [entry(1)], [entry(2)]])
    expect(refs.map(r => r.label)).toEqual(['Green', 'Water-repellent'])
  })
  it('never caches an unavailable reference, and forgets everything when an entry is saved', async () => {
    const gone = entry(99)
    const first = await resolveLinkedReferenceNames(gql, 'A', [gone, entry(1)], 0)
    expect(first[0].available).toBe(false)
    await resolveLinkedReferenceNames(gql, 'A', [gone, entry(1)], 1)
    expect(calls.map(c => c.variables.ids)).toEqual([[gone, entry(1)], [gone]])
    invalidateLinkedReferenceNames()
    await resolveLinkedReferenceNames(gql, 'A', [entry(1)], 2)
    expect(calls).toHaveLength(3)
  })
  it('keeps the order and repeats of the request', async () => {
    const refs = await resolveLinkedReferenceNames(gql, 'A', [entry(2), entry(1), entry(2)], 0)
    expect(refs.map(r => r.id)).toEqual([entry(2), entry(1), entry(2)])
    expect(calls[0].variables.ids).toEqual([entry(2), entry(1)])
  })
})
