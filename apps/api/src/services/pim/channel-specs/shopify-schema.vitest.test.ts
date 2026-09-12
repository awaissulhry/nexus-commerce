import { beforeEach, describe, expect, it, vi } from 'vitest'
import { withWorkspace } from '../../../lib/workspace-context.js'
const mocks = vi.hoisted(() => ({ admin: vi.fn(), read: vi.fn(), invalidateConstraints: vi.fn() }))
vi.mock('../../shopify/admin-client.js', () => ({ shopifyAdmin: mocks.admin }))
vi.mock('../../shopify/linked-products-gateway.js', () => ({ readLinkedStoreSchema: mocks.read, invalidateShopifyDefinitionConstraints: mocks.invalidateConstraints }))
import { invalidateShopifyMappingSchema, readShopifyMappingSchema, loadShopifyProductSpec } from './shopify.js'
const schema = (revision: string) => ({ revision, definitions: [], metaobjectDefinitions: [], types: [], locales: [] })
const scoped = <T>(id: string, work: () => T) => withWorkspace({ workspaceId: id, actorUserId: null, membershipId: null, roleKeys: [] }, work)
beforeEach(() => { vi.clearAllMocks(); for (const id of ['a', 'b']) invalidateShopifyMappingSchema(id); mocks.admin.mockImplementation(async id => ({ graphql: id })); mocks.read.mockImplementation(async id => schema(id)) })
describe('Shopify mapping schema lifecycle', () => {
  it('keeps the editable listing SKU separate from the common sheet identity band', async () => {
    const spec = await loadShopifyProductSpec('a')
    const sku = spec.fields.find(field => field.shopifyField?.id === 'sku')!
    expect(sku).toMatchObject({ key: 'listing_sku', editable: true, defaultRule: { source: 'sku' }, channelStore: { kind: 'platformAttributes', path: ['sku'] } })
    expect(sku.masterKey).toBeUndefined()
  })
  it('shares concurrent reads only in the same workspace and store', async () => {
    const [a, again, b] = await Promise.all([readShopifyMappingSchema('a'), readShopifyMappingSchema('a'), readShopifyMappingSchema('b')])
    expect(a).toBe(again); expect(b.revision).toBe('b'); expect(mocks.read).toHaveBeenCalledTimes(2)
    await scoped('profile-a', () => readShopifyMappingSchema('a'))
    await scoped('profile-b', () => readShopifyMappingSchema('a'))
    expect(mocks.read).toHaveBeenCalledTimes(4)
  })
  it('invalidates on a schema event and does not let an older read replace the fresh result', async () => {
    let finish!: (value: ReturnType<typeof schema>) => void
    mocks.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const old = readShopifyMappingSchema('a'); await Promise.resolve(); await Promise.resolve()
    invalidateShopifyMappingSchema('a')
    mocks.read.mockResolvedValue(schema('new'))
    expect((await readShopifyMappingSchema('a')).revision).toBe('new')
    finish(schema('old')); await old
    expect((await readShopifyMappingSchema('a')).revision).toBe('new')
  })
  it('propagates errors and recovers instead of caching an empty catalogue', async () => {
    mocks.read.mockRejectedValueOnce(new Error('Shopify unavailable'))
    await expect(loadShopifyProductSpec('a')).rejects.toThrow('Shopify unavailable')
    expect((await loadShopifyProductSpec('a')).fields.length).toBe(31)
    expect(mocks.read).toHaveBeenCalledTimes(2)
  })
})
