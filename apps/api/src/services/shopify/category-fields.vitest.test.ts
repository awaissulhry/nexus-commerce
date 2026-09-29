/**
 * Switching on a Shopify category field (sheet parity with Shopify's bulk editor). No database and no Shopify: every
 * collaborator is a stand-in, so the rules themselves are pinned — only a field Shopify offers for the family's OWN
 * category is switched on, and every reader of the store's fields hears about it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ZodError } from 'zod'

const m = vi.hoisted(() => ({
  destination: vi.fn(), family: vi.fn(), categories: vi.fn(), admin: vi.fn(), templates: vi.fn(), enable: vi.fn(),
  invalidate: vi.fn(), readSchema: vi.fn(), clearSheet: vi.fn(), clearStudio: vi.fn(), publish: vi.fn(), order: [] as string[],
}))
vi.mock('./content-workspace.service.js', () => ({ contentDestination: m.destination }))
vi.mock('../../db.js', () => ({ default: { product: { findFirst: m.family } } }))
vi.mock('../pim/product-category-context.js', () => ({ productCategoryContext: m.categories }))
vi.mock('./admin-client.js', () => ({ shopifyAdmin: m.admin }))
vi.mock('./linked-products-gateway.js', () => ({ readCategoryTemplates: m.templates, enableStandardShopifyDefinition: m.enable }))
vi.mock('../pim/channel-specs/shopify.js', () => ({ invalidateShopifyMappingSchema: m.invalidate, readShopifyMappingSchema: m.readSchema }))
vi.mock('../pim/sheet-columns.service.js', () => ({ clearSheetColumnCache: m.clearSheet }))
vi.mock('../pim/studio-columns.js', () => ({ clearStudioColumnCache: m.clearStudio }))
vi.mock('../listing-events.service.js', () => ({ publishListingEvent: m.publish }))
import { enableShopifyCategoryField } from './category-fields.service.js'

const template = (key: string) => ({ id: `t-${key}`, name: key, description: null, namespace: 'shopify', key, ownerTypes: ['PRODUCT'], type: { name: 'list.metaobject_reference' } })
const ageGroup = { ownerType: 'PRODUCT', namespace: 'shopify', key: 'age-group' }
const scope = { accountId: 'store-a', market: 'GLOBAL' }

beforeEach(() => {
  vi.clearAllMocks(); m.order.length = 0
  m.destination.mockResolvedValue({ familyId: 'fam', accountId: 'store-a', marketplace: 'GLOBAL' })
  m.family.mockResolvedValue({ id: 'fam', children: [{ id: 'size-s' }, { id: 'size-m' }] })
  m.categories.mockResolvedValue({ categories: ['gid://shopify/TaxonomyCategory/aa-1'] })
  m.admin.mockResolvedValue({ graphql: 'gql' })
  m.templates.mockResolvedValue([template('age-group'), template('fabric')])
  m.enable.mockImplementation(async () => { m.order.push('enable'); return { id: 'definition-age' } })
  m.invalidate.mockImplementation(() => { m.order.push('invalidate') })
  m.readSchema.mockImplementation(async () => { m.order.push('read'); return { revision: 'r2' } })
  m.clearSheet.mockImplementation(() => { m.order.push('clear-sheet') })
  m.clearStudio.mockImplementation(() => { m.order.push('clear-studio') })
  m.publish.mockImplementation(() => { m.order.push('event') })
})

describe('switching on a Shopify category field', () => {
  it('switches on a field the family\'s category offers, then refreshes every reader, in that order', async () => {
    expect(await enableShopifyCategoryField('size-s', scope, ageGroup)).toEqual({ definition: { id: 'definition-age' }, revision: 'r2' })
    expect(m.categories).toHaveBeenCalledWith(['fam', 'size-s', 'size-m'], 'SHOPIFY', 'GLOBAL', 'store-a')
    expect(m.templates).toHaveBeenCalledWith('gql', 'gid://shopify/TaxonomyCategory/aa-1', { fresh: true })
    expect(m.enable).toHaveBeenCalledWith('gql', ageGroup)
    expect(m.readSchema).toHaveBeenCalledWith('store-a', true)
    expect(m.order).toEqual(['enable', 'invalidate', 'read', 'clear-sheet', 'clear-studio', 'event'])
    expect(m.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'shopify.schema.changed', accountId: 'store-a' }))
  })

  it('refuses a field Shopify does not offer for the family\'s category, and switches nothing on', async () => {
    await expect(enableShopifyCategoryField('size-s', scope, { ...ageGroup, key: 'neckline' })).rejects.toThrow('Shopify does not offer this field for this family’s Shopify category. Nothing was switched on.')
    await expect(enableShopifyCategoryField('size-s', scope, { ...ageGroup, ownerType: 'PRODUCTVARIANT' })).rejects.toThrow('does not offer')
    expect(m.enable).not.toHaveBeenCalled()
    expect(m.publish).not.toHaveBeenCalled()
  })

  it('refuses a family with no Shopify category before asking Shopify anything', async () => {
    m.categories.mockResolvedValue({ categories: [] })
    await expect(enableShopifyCategoryField('size-s', scope, ageGroup)).rejects.toThrow('Choose this family’s Shopify category first')
    expect(m.admin).not.toHaveBeenCalled()
  })

  it('accepts only an owner, a namespace and a key', async () => {
    await expect(enableShopifyCategoryField('size-s', scope, { ...ageGroup, id: 'anything' })).rejects.toBeInstanceOf(ZodError)
    await expect(enableShopifyCategoryField('size-s', scope, { ownerType: 'COLLECTION', namespace: 'shopify', key: 'x' })).rejects.toBeInstanceOf(ZodError)
    expect(m.destination).not.toHaveBeenCalled()
  })
})
