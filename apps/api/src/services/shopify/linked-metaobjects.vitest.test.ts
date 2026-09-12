import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'graphql'
const fixture = vi.hoisted(() => ({ entries: new Map<string, any>(), readOnly: false, writes: [] as any[], loseAck: false, badReadback: false }))
const entryId = 'gid://shopify/Metaobject/1'
const definition = { id: 'gid://shopify/MetaobjectDefinition/1', name: 'Feature', type: 'feature', description: null, access: { admin: null, storefront: 'PUBLIC_READ' }, capabilities: { publishable: { enabled: true } }, fieldDefinitions: [
  { key: 'heading', name: 'Heading', description: null, required: true, type: { name: 'single_line_text_field' }, validations: [] },
  { key: 'image', name: 'Image', description: null, required: false, type: { name: 'file_reference' }, validations: [] },
] }
vi.mock('./linked-products-gateway.js', async importOriginal => ({
  ...await importOriginal<any>(),
  readLinkedStoreSchema: async () => ({ metaobjectDefinitions: [{ ...definition, publishable: true, fields: definition.fieldDefinitions.map(f => ({ ...f, type: f.type.name, readOnlyReason: fixture.readOnly ? 'App owned' : null })) }] }),
  readLinkedMetaobject: async (_: any, id: string) => { const entry = fixture.entries.get(id); if (!entry) throw new Error('Entry unavailable in this store'); return structuredClone(entry) },
  resolveLinkedReferences: async (_: any, ids: string[]) => ids.map(id => ({ id, available: id !== 'gid://shopify/MediaImage/999' })),
}))
vi.mock('./admin-client.js', () => ({ assertShopifyResult: (payload: any) => { if (payload.userErrors?.length) throw new Error(payload.userErrors[0].message); return payload } }))
import { getLinkedEntry, saveLinkedEntry } from './linked-metaobjects.service'
beforeEach(() => {
  fixture.entries.clear(); fixture.writes = []; fixture.readOnly = false; fixture.loseAck = false; fixture.badReadback = false
  fixture.entries.set(entryId, { id: entryId, type: 'feature', handle: 'shared-feature', displayName: 'Shared feature', updatedAt: 'initial', definition,
    capabilities: { publishable: { status: 'ACTIVE' } }, fields: [{ key: 'heading', type: 'single_line_text_field', value: 'Shared text' }, { key: 'image', type: 'file_reference', value: 'gid://shopify/MediaImage/1' }],
    referencedBy: { nodes: [{ referencer: { id: 'gid://shopify/Product/1', title: 'Red product' } }, { referencer: { id: 'gid://shopify/Product/2', title: 'Blue product' } }], pageInfo: { hasNextPage: true } } })
})
const gql: any = async (query: string, variables: any) => {
  parse(query)
  if (query.includes('NexusLinkedEntryByHandle')) return { metaobjectByHandle: [...fixture.entries.values()].find(e => e.type === variables.handle.type && e.handle === variables.handle.handle) ?? null }
  fixture.writes.push(variables)
  const create = query.includes('NexusLinkedEntryCreate'), id = create ? 'gid://shopify/Metaobject/2' : variables.id
  const entry = create ? { ...structuredClone(fixture.entries.get(entryId)), id, handle: variables.metaobject.handle, fields: [], referencedBy: { nodes: [], pageInfo: { hasNextPage: false } } } : fixture.entries.get(id)
  for (const field of variables.metaobject.fields) {
    entry.fields = entry.fields.filter((f: any) => f.key !== field.key)
    entry.fields.push({ ...field, value: fixture.badReadback ? 'unexpected' : field.value || null, type: definition.fieldDefinitions.find(d => d.key === field.key)!.type.name })
  }
  if (variables.metaobject.capabilities) entry.capabilities = variables.metaobject.capabilities
  entry.updatedAt = `write-${fixture.writes.length}`; fixture.entries.set(id, entry)
  if (fixture.loseAck) { fixture.loseAck = false; throw new Error('Lost acknowledgement') }
  return { [create ? 'metaobjectCreate' : 'metaobjectUpdate']: { metaobject: { id }, userErrors: [] } }
}
const identity = { id: entryId, type: 'feature', handle: 'shared-feature' }
describe('shared reusable entry changes', () => {
  it('shows shared references and preserves fields omitted from an update', async () => {
    const initial = await getLinkedEntry(gql, entryId)
    expect(initial.usedBy.map(u => u.label)).toEqual(['Red product', 'Blue product']); expect(initial.moreUses).toBe(true)
    const done = await saveLinkedEntry(gql, { ...identity, expectedRevision: initial.revision, fields: [{ key: 'heading', value: 'New heading' }] })
    expect(done.fields.find(f => f.key === 'image')?.value).toBe('gid://shopify/MediaImage/1')
    expect(fixture.writes[0].metaobject).toEqual({ fields: [{ key: 'heading', value: 'New heading' }] })
  })
  it('refuses overwriting another editor’s update', async () => {
    const initial = await getLinkedEntry(gql, entryId); fixture.entries.get(entryId).updatedAt = 'external'
    await expect(saveLinkedEntry(gql, { ...identity, expectedRevision: initial.revision, fields: [{ key: 'heading', value: 'Mine' }] })).rejects.toThrow('changed in Shopify')
    expect(fixture.writes).toHaveLength(0)
  })
  it('creates a separate colour copy and reconciles lost acknowledgement by its stable handle', async () => {
    const input = { type: 'feature', handle: 'red-feature-copy', status: 'ACTIVE', fields: [{ key: 'heading', value: 'Red feature' }, { key: 'image', value: 'gid://shopify/MediaImage/2' }] }
    fixture.loseAck = true; await expect(saveLinkedEntry(gql, input)).rejects.toThrow('Lost acknowledgement')
    const retry = await saveLinkedEntry(gql, input)
    expect(retry.id).not.toBe(entryId); expect(retry.status).toBe('ACTIVE'); expect(fixture.writes).toHaveLength(1)
    expect(fixture.entries.get(entryId).fields[0].value).toBe('Shared text')
  })
  it('updates publication status independently and detects status changes in the revision', async () => {
    const initial = await getLinkedEntry(gql, entryId)
    const saved = await saveLinkedEntry(gql, { ...identity, expectedRevision: initial.revision, status: 'DRAFT', fields: [] })
    expect(saved.status).toBe('DRAFT'); expect(saved.revision).not.toBe(initial.revision)
  })
  it('clears optional fields with readback while refusing required clears', async () => {
    const initial = await getLinkedEntry(gql, entryId)
    await expect(saveLinkedEntry(gql, { ...identity, expectedRevision: initial.revision, fields: [{ key: 'heading', value: '' }] })).rejects.toThrow('required')
    const saved = await saveLinkedEntry(gql, { ...identity, expectedRevision: initial.revision, fields: [{ key: 'image', value: '' }] })
    expect(saved.fields.find(f => f.key === 'image')?.value).toBeNull()
  })
  it('refuses missing references and read-only definitions before a write', async () => {
    const initial = await getLinkedEntry(gql, entryId)
    await expect(saveLinkedEntry(gql, { ...identity, expectedRevision: initial.revision, fields: [{ key: 'image', value: 'gid://shopify/MediaImage/999' }] })).rejects.toThrow('reference is unavailable')
    fixture.readOnly = true
    await expect(saveLinkedEntry(gql, { ...identity, expectedRevision: initial.revision, fields: [{ key: 'heading', value: 'Mine' }] })).rejects.toThrow('read-only')
    expect(fixture.writes).toHaveLength(0)
  })
  it('does not report success when Shopify readback differs', async () => {
    const initial = await getLinkedEntry(gql, entryId); fixture.badReadback = true
    await expect(saveLinkedEntry(gql, { ...identity, expectedRevision: initial.revision, fields: [{ key: 'heading', value: 'Mine' }] })).rejects.toThrow('readback differs')
  })
})
