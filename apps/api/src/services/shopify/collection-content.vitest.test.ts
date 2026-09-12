import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { parse } from 'graphql'
const state = vi.hoisted(() => ({ metadata: {} as any, calls: [] as string[], remote: null as any, interrupt: false, conflict: false }))
vi.mock('../../db.js', () => ({ default: { channelConnection: {
  findUniqueOrThrow: vi.fn(async () => ({ id: 'account', connectionMetadata: structuredClone(state.metadata), updatedAt: new Date(0) })),
  updateMany: vi.fn(async ({ data }: any) => { if (state.conflict) return { count: 0 }; state.metadata = data.connectionMetadata; return { count: 1 } }),
} } }))
vi.mock('./content-workspace.service.js', () => ({ object: (v: any) => v && typeof v === 'object' && !Array.isArray(v) ? v : {}, digest: (v: any) => createHash('sha256').update(JSON.stringify(v)).digest('hex') }))
vi.mock('./admin-client.js', () => ({ assertShopifyResult: (p: any) => { if (p?.userErrors?.length) throw new Error(p.userErrors[0].message); return p }, shopifyAdmin: async (accountId: string) => {
  expect(accountId).toBe('account')
  return { domain: 'sample.myshopify.com', graphql: async (query: string, variables: any = {}) => {
    parse(query); const name = query.match(/(?:query|mutation) (\w+)/)![1]; state.calls.push(name)
    if (name === 'NexusCollection') return { collection: { id: 'gid://shopify/Collection/1', title: 'Helmets', handle: 'helmets', sortOrder: 'MANUAL', updatedAt: 't1', metafield: state.remote, products: { nodes: [{ id: 'gid://shopify/Product/1', title: 'Helmet', handle: 'helmet', status: 'ACTIVE', metafield: { value: JSON.stringify({ managed: true, cards: [{ id: 'red', label: 'Red', variantIds: ['1'] }, { id: 'blue', label: 'Blue', variantIds: ['2'] }] }) } }], pageInfo: { hasNextPage: false } } } }
    if (name === 'NexusCollectionVariants') return { product: { variants: { nodes: [1, 2].map(id => ({ id: `gid://shopify/ProductVariant/${id}`, sku: `SKU-${id}`, image: null })), pageInfo: { hasNextPage: false } } } }
    if (name === 'NexusCollectionDefinition') return { metafieldDefinitions: { nodes: [{ type: { name: 'json' }, access: { storefront: 'PUBLIC_READ' } }] } }
    if (name === 'NexusCollectionOrder') {
      expect(variables.metafields[0].compareDigest).toBe(state.remote?.compareDigest ?? null)
      state.remote = { value: variables.metafields[0].value, compareDigest: 'digest' }
      if (state.interrupt) state.metadata = { _nexusCollectionOrders: { '1': { order: ['1:red', '1:blue'] } } }
      return { metafieldsSet: { userErrors: [] } }
    }
    throw new Error(`Unexpected operation ${name}`)
  } }
} }))
import { readCollectionContent, saveCollectionContent, synchronizeCollectionContent } from './collection-content.service.js'
beforeEach(() => { state.metadata = { unrelated: 'preserved' }; state.calls = []; state.remote = null; state.interrupt = false; state.conflict = false })
describe('collection content publication', () => {
  it('saves each native colour independently without Shopify mutations or lost account metadata', async () => {
    const view = await readCollectionContent('account', '1')
    await saveCollectionContent('account', '1', { expectedRevision: view.revision, order: ['1:blue', '1:red'] })
    expect(state.metadata.unrelated).toBe('preserved')
    expect(state.metadata._nexusCollectionOrders['1'].order).toEqual(['1:blue', '1:red'])
    expect(state.calls).not.toContain('NexusCollectionOrder')
  })
  it('refuses stale, duplicate and concurrent saves', async () => {
    const view = await readCollectionContent('account', '1')
    await expect(saveCollectionContent('account', '1', { expectedRevision: 'stale', order: view.order })).rejects.toThrow('changed')
    await expect(saveCollectionContent('account', '1', { expectedRevision: view.revision, order: ['1:red', '1:red'] })).rejects.toThrow('exactly once')
    state.conflict = true
    await expect(saveCollectionContent('account', '1', { expectedRevision: view.revision, order: view.order })).rejects.toThrow('concurrent')
  })
  it('requires explicit review and reads back the order after a guarded metafield write', async () => {
    const view = await readCollectionContent('account', '1')
    const input = { expectedRevision: view.revision, expectedRemoteRevision: view.remoteRevision }
    await expect(synchronizeCollectionContent('account', '1', input)).rejects.toThrow('approve')
    expect(state.calls).not.toContain('NexusCollectionOrder')
    const saved = await synchronizeCollectionContent('account', '1', { ...input, confirmCollection: true })
    expect(saved.publication.status).toBe('VERIFIED')
    expect(saved.order).toEqual(view.order)
  })
  it('preserves a newer local order if it changes while Shopify saves the reviewed order', async () => {
    let view = await readCollectionContent('account', '1')
    await saveCollectionContent('account', '1', { expectedRevision: view.revision, order: ['1:blue', '1:red'] })
    view = await readCollectionContent('account', '1'); state.interrupt = true
    await expect(synchronizeCollectionContent('account', '1', { expectedRevision: view.revision, expectedRemoteRevision: view.remoteRevision, confirmCollection: true })).rejects.toThrow('draft changed')
    expect(state.metadata._nexusCollectionOrders['1'].order).toEqual(['1:red', '1:blue'])
    expect(state.metadata._nexusCollectionOrders['1'].publication).toBeUndefined()
  })
})
