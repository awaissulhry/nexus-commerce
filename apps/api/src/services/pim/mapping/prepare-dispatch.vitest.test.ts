import { beforeEach, describe, expect, it, vi } from 'vitest'
const { db, resolve, specLoad, primary } = vi.hoisted(() => ({ db: { channelListing: { findUnique: vi.fn() } }, resolve: vi.fn(), specLoad: vi.fn(), primary: vi.fn() }))
vi.mock('../../../db.js', () => ({ default: db }))
vi.mock('./resolve-batch.service.js', () => ({ resolveBatch: resolve }))
vi.mock('../channel-specs/index.js', () => ({ loadAmazonSpec: specLoad }))
vi.mock('../../connection-resolver.service.js', () => ({ primaryConnectionIds: primary }))
import { prepareMappingDispatch } from './prepare-dispatch.js'
import { amazonSpecFromDefinition } from '../channel-specs/amazon.js'
let result: any
const item = { channelListingId: 'listing-b', productId: 'product', targetChannel: 'EBAY', payload: { fields: { color: 'Blue' }, title: 'Unreviewed injection' } }
beforeEach(() => {
  vi.resetAllMocks()
  db.channelListing.findUnique.mockResolvedValue({ id: 'listing-b', productId: 'product', channel: 'EBAY', marketplace: 'IT', channelConnectionId: 'account-b', aliasKey: 'outlet' })
  result = { catalogue: { schema: { present: true }, fields: [{ fieldKey: 'color', label: 'Colour', channelStore: { kind: 'platformAttributes', path: ['itemSpecifics', 'Colore'] } }] },
    products: [{ category: { channelCategoryId: '123' }, cells: { color: { fieldKey: 'color', value: 'Blue', errors: [] } } }] }
  resolve.mockImplementation(async () => result)
})
describe('mapping queue dispatch contract', () => {
  it('resolves the exact account and alias and sends only verified named aspects', async () => {
    const prepared = await prepareMappingDispatch(item)
    expect(resolve).toHaveBeenCalledWith({ channel: 'EBAY', marketplace: 'IT', channelConnectionId: 'account-b', aliasKey: 'outlet', productIds: ['product'] })
    expect(prepared.payload.mappingAspects).toEqual({ Colore: ['Blue'] })
    expect(prepared.payload.title).toBeUndefined()
  })
  it('rejects a queued value changed by a later edit', async () => {
    result.products[0].cells.color.value = 'Red'
    await expect(prepareMappingDispatch(item)).rejects.toThrow('changed after queueing')
  })
  it('blocks unresolved translations, missing schemas and owner-managed fields', async () => {
    result.products[0].cells.color.needsTranslation = true
    await expect(prepareMappingDispatch(item)).rejects.toThrow('cannot be published')
    result.products[0].cells.color.needsTranslation = false
    result.catalogue.schema.present = false
    await expect(prepareMappingDispatch(item)).rejects.toThrow('schema validation')
    result.catalogue.schema.present = true
    result.catalogue.fields[0].sourceOwner = 'Media'
    await expect(prepareMappingDispatch(item)).rejects.toThrow('cannot be published')
  })
  it('preserves other mapped leaves when replacing a compound Amazon root', async () => {
    db.channelListing.findUnique.mockResolvedValue({ productId: 'product', channel: 'AMAZON', marketplace: 'IT', channelConnectionId: 'account-b', aliasKey: '' })
    primary.mockResolvedValue(new Map([['AMAZON', 'account-b']]))
    const spec = amazonSpecFromDefinition({ marketplace: 'IT', productType: 'COAT', schemaDefinition: { properties: { size: { type: 'array', items: { type: 'object', properties: { value: { type: 'string' }, system: { type: 'string' } } } } } } })
    specLoad.mockResolvedValue(spec)
    result.catalogue.fields = spec.fields.map(f => ({ fieldKey: f.key, label: f.label }))
    result.products[0].cells = Object.fromEntries(spec.fields.map(f => [f.key, { fieldKey: f.key, value: f.path[0] === 'system' ? 'EU' : 'Large', errors: [] }]))
    const field = spec.fields.find(f => f.path[0] !== 'system')!
    const prepared = await prepareMappingDispatch({ ...item, targetChannel: 'AMAZON', payload: { fields: { [field.key]: 'Large' } } })
    expect(prepared.payload.mappingAttributePatches).toEqual([{ op: 'replace', path: '/attributes/size', value: [{ value: 'Large', system: 'EU' }] }])
  })
})
