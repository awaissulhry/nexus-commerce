import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'graphql'
import { LAB_ENTRIES, LAB_FILES, LAB_SCHEMA, LAB_TAXONOMY_VALUES, labKind, labReferences } from '@nexus/shared/shopify-lab-store'

/*
 * Lane B slice B2 (docs/shopify-metafields/PLAN-2026-09-28.md §6.2, §7 L6): saving entries of the made-up store's kinds.
 * The category Color entry takes "Base color" and "Base pattern" values of their own taxonomy attribute; a required field,
 * a file limit and Shopify's own refusal read as plain sentences; one read-only field no longer blocks the whole kind.
 */
const f = vi.hoisted(() => ({ entries: new Map<string, any>(), writes: [] as any[], refuse: null as any[] | null, readOnlyKey: null as string | null, taxonomyReads: [] as string[][] }))
const schemaWithReadOnly = () => ({ ...LAB_SCHEMA, metaobjectDefinitions: LAB_SCHEMA.metaobjectDefinitions.map(kind => ({ ...kind,
  fields: kind.fields.map(field => ({ ...field, readOnlyReason: f.readOnlyKey && `${kind.type}.${field.key}` === f.readOnlyKey ? 'An app owns this field.' : null })) })) })
vi.mock('./linked-products-gateway.js', async importOriginal => ({
  ...await importOriginal<any>(),
  readLinkedStoreSchema: async () => schemaWithReadOnly(),
  readLinkedMetaobject: async (_: unknown, id: string) => { const e = f.entries.get(id); if (!e) throw new Error('unavailable'); return structuredClone(e) },
  resolveLinkedReferences: async (_: unknown, ids: string[]) => ids.map(id => labReferences().find(r => r.id === id) ?? { id, label: 'Unavailable reference', image: null, available: false }),
  readTaxonomyAttributeValues: async (_: unknown, handle: string, categories: string[]) => {
    f.taxonomyReads.push(categories)
    const values = LAB_TAXONOMY_VALUES.filter(v => v.attribute === handle)
    return values.length && categories.length ? { attribute: { id: `gid://shopify/TaxonomyAttribute/${handle}`, name: handle }, values } : { attribute: null, values: [] }
  },
}))
vi.mock('./admin-client.js', () => ({ assertShopifyResult: (payload: any) => payload }))
import { saveLinkedEntry } from './linked-metaobjects.service'

const kindOf = (type: string) => labKind(type)
function asShopify(entry: (typeof LAB_ENTRIES)[number], updatedAt = 'initial') {
  const kind = kindOf(entry.type)
  return { id: entry.id, type: entry.type, handle: entry.handle, displayName: entry.name, updatedAt, capabilities: kind.publishable ? { publishable: { status: 'ACTIVE' } } : null,
    fields: kind.fields.map(field => ({ key: field.key, type: field.type, value: entry.fields[field.key] ?? null })), definition: { id: kind.id },
    referencedBy: { nodes: [], pageInfo: { hasNextPage: false } } }
}
beforeEach(() => {
  f.entries.clear(); f.writes = []; f.refuse = null; f.readOnlyKey = null; f.taxonomyReads = []
  for (const e of LAB_ENTRIES) f.entries.set(e.id, asShopify(e))
})
const gql: any = async (query: string, variables: any) => {
  parse(query)
  if (query.includes('NexusLinkedEntryByHandle')) return { metaobjectByHandle: [...f.entries.values()].find(e => e.type === variables.handle.type && e.handle === variables.handle.handle) ?? null }
  f.writes.push(variables)
  const create = query.includes('NexusLinkedEntryCreate'), key = create ? 'metaobjectCreate' : 'metaobjectUpdate'
  if (f.refuse) return { [key]: { metaobject: null, userErrors: f.refuse } }
  const id = create ? `gid://shopify/Metaobject/${6000 + f.writes.length}` : variables.id
  const base = create ? { id, type: variables.metaobject.type, handle: variables.metaobject.handle, displayName: 'New', definition: { id: kindOf(variables.metaobject.type).id }, fields: [], capabilities: null, referencedBy: { nodes: [], pageInfo: { hasNextPage: false } } } : f.entries.get(id)
  for (const field of variables.metaobject.fields) { base.fields = base.fields.filter((x: any) => x.key !== field.key); base.fields.push({ key: field.key, type: 'x', value: field.value || null }) }
  base.updatedAt = `write-${f.writes.length}`; f.entries.set(id, base)
  return { [key]: { metaobject: { id }, userErrors: [] } }
}
const tax = (label: string) => LAB_TAXONOMY_VALUES.find(v => v.label === label)!.id
const colourFields = (overrides: Record<string, string> = {}) => Object.entries({
  label: 'Teal', color: '#0f7c7c', color_taxonomy_reference: JSON.stringify([tax('Blue'), tax('Green')]), pattern_taxonomy_reference: tax('Solid'), ...overrides,
}).map(([key, value]) => ({ key, value }))

describe('B2 · entries of the store kinds', () => {
  it('creates a category Color entry whose Base color and Base pattern are values of their own attribute', async () => {
    const saved = await saveLinkedEntry(gql, { type: 'shopify--color-pattern', handle: 'teal-k2p9', fields: colourFields() })
    expect(saved.fields.find(x => x.key === 'pattern_taxonomy_reference')?.value).toBe(tax('Solid'))
    expect(f.taxonomyReads.length).toBeGreaterThan(0)
    expect(f.taxonomyReads.every(categories => categories.length > 0)).toBe(true)
  })
  it('refuses a value of another attribute, naming the field, before any write', async () => {
    await expect(saveLinkedEntry(gql, { type: 'shopify--color-pattern', handle: 'teal-k2p9', fields: colourFields({ color_taxonomy_reference: JSON.stringify([tax('Solid')]) }) }))
      .rejects.toThrow('Base color: Choose a Base color value from Shopify’s list.')
    await expect(saveLinkedEntry(gql, { type: 'shopify--color-pattern', handle: 'teal-k2p9', fields: colourFields({ pattern_taxonomy_reference: tax('Black') }) }))
      .rejects.toThrow('Base pattern: Choose a Base pattern value from Shopify’s list.')
    expect(f.writes).toEqual([])
  })
  it('refuses a missing required field and more Base colors than the store allows', async () => {
    await expect(saveLinkedEntry(gql, { type: 'shopify--color-pattern', handle: 'teal-k2p9', fields: colourFields().filter(x => x.key !== 'label') }))
      .rejects.toThrow('Label: Enter a value. Shopify needs this field.')
    const five = JSON.stringify(['Beige', 'Black', 'Blue', 'Brown', 'Gold'].map(tax))
    await expect(saveLinkedEntry(gql, { type: 'shopify--color-pattern', handle: 'teal-k2p9', fields: colourFields({ color_taxonomy_reference: five }) }))
      .rejects.toThrow('Base color: Use 4 values or fewer. Remove 1.')
  })
  it('refuses a video in an image-only entry field', async () => {
    const video = LAB_FILES.find(x => x.type === 'Video')!.id
    await expect(saveLinkedEntry(gql, { type: 'shopify--color-pattern', handle: 'teal-k2p9', fields: colourFields({ image: video }) }))
      .rejects.toThrow('Image: This field takes images only.')
  })
  it('a read-only field no longer blocks the kind: other fields save, a write to that field is refused with its reason', async () => {
    f.readOnlyKey = 'lab_faq.answer'
    const faq = LAB_ENTRIES.find(e => e.type === 'lab_faq')!
    const revision = (await import('./linked-metaobjects.service')).getLinkedEntry
    const current = await revision(gql, faq.id)
    const saved = await saveLinkedEntry(gql, { id: faq.id, expectedRevision: current.revision, type: 'lab_faq', handle: faq.handle, status: 'ACTIVE', fields: [{ key: 'question', value: 'Is it waterproof?' }] })
    expect(saved.fields.find(x => x.key === 'question')?.value).toBe('Is it waterproof?')
    const again = await revision(gql, faq.id)
    await expect(saveLinkedEntry(gql, { id: faq.id, expectedRevision: again.revision, type: 'lab_faq', handle: faq.handle, fields: [{ key: 'answer', value: 'Yes' }] }))
      .rejects.toThrow('Answer cannot be changed here: An app owns this field.')
  })
  it('Shopify’s refusal names the field in plain words', async () => {
    f.refuse = [{ field: ['metaobject', 'fields', '0'], message: 'Value is too long', code: 'TOO_LONG', elementKey: 'label' }]
    await expect(saveLinkedEntry(gql, { type: 'shopify--color-pattern', handle: 'teal-k2p9', fields: colourFields() })).rejects.toThrow('Shopify did not save Label: Value is too long.')
  })
})
