import { beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyShopifyLinkedDraft } from '@nexus/shared/shopify-linked-products'
import { informationRegistry, informationStoredValue } from '@nexus/shared/shopify-information'
import { projectShopifyChannelSheet, shopifyCellToken } from './channel-sheet-projection.js'

const s = vi.hoisted(() => ({ workspace: null as any, snapshot: null as any, schema: null as any, writes: [] as any[], audit: vi.fn() }))
vi.mock('../../db.js', () => ({ default: { channelListing: { findMany: async () => [{ id: 'listing-a', productId: 'family', externalListingId: '10', platformAttributes: {} }] } } }))
vi.mock('../pim/studio-sheet.service.js', () => ({ getStudioSheet: async () => page() }))
vi.mock('../pim/channel-specs/shopify.js', () => ({ readShopifyMappingSchema: async () => s.schema }))
vi.mock('./content-workspace.service.js', () => ({ PUBLISH_KEY: '_nexusContentPublish', object: (v: unknown) => v ?? {}, contentDestination: async (productId: string, scope: any) => {
  if (productId !== 'family' || scope.accountId !== 'store-a' || scope.listingId !== 'listing-a') throw new Error('Wrong destination')
  return { productId, familyId: 'family', accountId: scope.accountId, aliasKey: 'alias-a', marketplace: 'GLOBAL' }
} }))
vi.mock('./admin-client.js', () => ({ shopifyAdmin: async () => ({ graphql: vi.fn() }) }))
vi.mock('./information-gateway.js', () => ({ readInformation: async () => s.snapshot }))
vi.mock('./linked-products.service.js', () => ({ LINKED_KEY: '_nexusLinkedProducts', AUTOMATION_KEY: '_nexusLinkedAutomation',
  getLinkedWorkspace: async () => structuredClone(s.workspace),
  linkedState: async () => ({ workspace: structuredClone(s.workspace), draft: structuredClone(s.workspace.draft), listing: { id: 'listing-a' } }),
  linkedTransaction: async (fn: any) => fn({ auditLog: { create: s.audit }, channelListing: { findMany: async () => [] } }),
  writeLinkedState: async (_tx: any, destination: any, _current: any, patch: any) => { s.writes.push({ destination, patch }); s.workspace.draft = patch._nexusLinkedProducts; s.workspace.revision += '1' },
}))
import { saveShopifySheetCells } from './channel-sheet.service.js'

const product = 'gid://shopify/Product/10', variant = 'gid://shopify/ProductVariant/11'
const scope = { accountId: 'store-a', listingId: 'listing-a', market: 'GLOBAL', locale: 'en' }
beforeEach(() => {
  s.writes = []; s.audit.mockClear()
  s.schema = { revision: 'schema-1', definitions: [{ id: 'definition-1', ownerType: 'PRODUCT', namespace: 'custom', key: 'flag', name: 'Flag', type: 'boolean', validations: [], access: {} }], types: [], locales: [{ locale: 'en', primary: true }], metaobjects: [], currency: 'EUR' }
  s.workspace = { productId: 'family', familyId: 'family', revision: '1', destination: { accountId: 'store-a', listingId: 'listing-a', market: 'GLOBAL' }, suggestedProductIds: [product], operation: null, draft: { ...emptyShopifyLinkedDraft(), informationOnly: true, members: [{ id: product, title: 'Listed title', handle: 'listed', image: null }] } }
  s.snapshot = { currency: 'EUR', timezone: 'Europe/Rome', rows: [
    { id: product, productId: product, kind: 'PRODUCT', title: 'Listed title', handle: 'listed', image: null, media: [], fields: [{ ownerId: product, namespace: 'custom', key: 'flag', type: 'boolean', value: 'false', compareDigest: 'digest-1' }], values: { title: 'Listed title', vendor: 'Vendor', category: null } },
    { id: variant, productId: product, kind: 'PRODUCTVARIANT', title: 'Small', handle: 'listed', image: null, media: [], fields: [], values: { sku: 'S', price: '0.00', taxable: 'false', category: null } },
  ] }
})
function change(fieldId = 'title', value: string | null = 'Draft title', ownerId = product) {
  const field = informationRegistry(s.schema).find(f => f.id === fieldId)!, row = s.snapshot.rows.find((r: any) => r.id === ownerId)
  return { colId: fieldId, ownerId, fieldId, value, token: shopifyCellToken(s.workspace, ownerId, field, row.locale), baseline: informationStoredValue(row, field), intent: 'set' }
}
function page() {
  const columns = informationRegistry(s.schema).map(field => ({ key: field.id, label: field.label, shopifyField: field, writeField: `attr_${field.id}` }))
  const values = Object.fromEntries(columns.map(c => [c.key, { value: null, writable: true, editable: true, writeTarget: 'channelListing', source: 'master', layer: 'master', mapped: null }]))
  values.title = { ...values.title, value: 'Shared title', mapped: { status: 'mapped', value: 'Shared title' } as any }
  values.vendor = { ...values.vendor, value: 'Shared vendor', mapped: { status: 'mapped', value: 'Shared vendor' } as any }
  return { columns, scope: { channel: 'SHOPIFY', connectionId: 'store-a' }, rows: [{ id: 'family', sku: 'NEXUS', name: 'Shared title', aliasId: 'alias-a', parentId: null, version: 5, values, listing: { id: 'listing-a', version: 7 }, readiness: { state: 'ready', issues: [] } }, { id: 'child', sku: 'S', aliasId: 'alias-a', parentId: 'family', version: 2, values, listing: { id: 'variant-listing', version: 2 } }] } as any
}
describe('Shopify behind the common channel sheet', () => {
  it.each(['ACTIVE', 'ARCHIVED', 'DRAFT'])('carries raw %s only in fact detail and uses the stored status vocabulary', status => {
    s.snapshot.rows[0].values.status = status
    const rows = projectShopifyChannelSheet(page(), s.workspace, s.snapshot, s.schema,
      [{ id: 'listing-a', productId: 'family', externalListingId: '10', platformAttributes: {} }], 'alias-a')
    expect(rows[0].listing).toMatchObject({
      listingStatus: status === 'ACTIVE' ? 'ACTIVE' : 'INACTIVE',
      isPublished: status === 'ACTIVE', channelFactDetail: { shopifyStatus: status }, offerActiveHonoured: false,
    })
  })
  it('keeps exact Nexus rows and shared mappings, then overlays saved listing intent', () => {
    const identities = [{ id: 'listing-a', productId: 'family', externalListingId: '10', platformAttributes: {} }, { id: 'variant-listing', productId: 'child', externalListingId: '10', platformAttributes: { variantId: '11' } }]
    let rows = projectShopifyChannelSheet(page(), s.workspace, s.snapshot, s.schema, identities, 'alias-a')
    expect(rows.map(r => r.id)).toEqual(['family', 'child'])
    expect(rows[0].values.title).toMatchObject({ value: 'Shared title', inherited: true, shopifyWrite: { ownerId: product, baseline: 'Listed title' } })
    expect(rows[1].values.price).toMatchObject({ value: '0.00', writable: true })
    expect(rows[1].values.title).toMatchObject({ writable: false, writeBlockedReason: 'Edit this field on the product row that owns this Shopify listing.' })
    s.workspace.draft.nativeEdits = [{ ownerId: product, productId: product, ownerLabel: 'Listed title', field: 'title', value: 'Listed title', nextValue: 'Saved override' }]
    rows = projectShopifyChannelSheet(page(), s.workspace, s.snapshot, s.schema, identities, 'alias-a')
    expect(rows[0].values.title).toMatchObject({ value: 'Saved override', pinned: true, inherited: false })
  })
  it('does not infer a variant identity from matching SKUs', () => {
    const rows = projectShopifyChannelSheet(page(), s.workspace, s.snapshot, s.schema, [], 'alias-a')
    expect(rows.map(r => r.id)).toEqual(['family', 'child'])
    expect(rows[1].shopify).toBeUndefined()
    expect(rows[1].values.title.value).toBe('Shared title')
  })
  it('addresses an imported child product without synthesizing a family listing or remote rows', () => {
    s.workspace.destination.listingId = null
    const base = page(), rows = projectShopifyChannelSheet(base, s.workspace, s.snapshot, s.schema, [{ id: 'variant-listing', productId: 'child', externalListingId: '10', platformAttributes: { variantId: '11' } }], 'alias-a')
    expect(rows.map(r => r.id)).toEqual(['family', 'child'])
    expect(rows[0]).toBe(base.rows[0])
    expect(rows[1].shopify?.listingId).toBe('variant-listing')
    expect(rows[1].values.title.shopifyWrite?.ownerId).toBe(product)
    expect(rows[1].values.price.shopifyWrite?.ownerId).toBe(variant)
  })
  it('adapts shared weight units and keeps stock tied to exact Shopify locations', () => {
    const base = page()
    base.rows[1].values.weight = { ...base.rows[1].values.weight, value: { value: 0, unit: 'kg' }, mapped: { status: 'mapped' } }
    base.rows[1].values.inventory = { ...base.rows[1].values.inventory, value: 99, mapped: { status: 'mapped' } }
    s.snapshot.rows[1].values.inventory = JSON.stringify({ inventoryItemId: 'gid://shopify/InventoryItem/12', tracked: true, locations: [] })
    const rows = projectShopifyChannelSheet(base, s.workspace, s.snapshot, s.schema, [{ id: 'variant-listing', productId: 'child', externalListingId: '10', platformAttributes: { variantId: '11' } }], 'alias-a')
    expect(rows[1].values.weight.value).toBe('{"value":0,"unit":"KILOGRAMS"}')
    expect(rows[1].values.inventory.value).toBe(s.snapshot.rows[1].values.inventory)
  })
  it('uses the persisted publish map without changing row hierarchy or media', () => {
    const base = page()
    base.rows[0].productMedia = [{ id: 'nexus-file', type: 'IMAGE', alt: 'Shared media' }]
    const rows = projectShopifyChannelSheet(base, s.workspace, s.snapshot, s.schema, [{ id: 'listing-a', productId: 'family', externalListingId: '10', platformAttributes: { _nexusContentPublish: { variantIds: { child: variant } } } }], 'alias-a')
    expect(rows.map(r => [r.id, r.parentId, r.sku])).toEqual(base.rows.map((r: any) => [r.id, r.parentId, r.sku]))
    expect(rows[1].values.price.shopifyWrite?.ownerId).toBe(variant)
    expect(rows[0].productMedia).toEqual(base.rows[0].productMedia)
    expect(rows[0].values.media.shopifyWrite).toBeUndefined()
  })
  it('saves exact owner intent without a Shopify mutation and preserves the first baseline', async () => {
    await saveShopifySheetCells('family', scope, { cells: [change('vendor')] }, 'editor')
    await saveShopifySheetCells('family', scope, { cells: [change('vendor', 'Second title')] }, 'editor')
    expect(s.workspace.draft.nativeEdits).toEqual([expect.objectContaining({ ownerId: product, value: 'Vendor', nextValue: 'Second title' })])
    expect(s.writes[0].destination).toMatchObject({ accountId: 'store-a', aliasKey: 'alias-a' })
    expect(s.audit).toHaveBeenCalledTimes(2)
  })
  it('retains a conflicting cell while saving a different valid cell', async () => {
    const title = change('vendor'), other = change('metafield:PRODUCT:custom.flag', 'true')
    await saveShopifySheetCells('family', scope, { cells: [change('vendor', 'Other editor')] }, 'other')
    const result = await saveShopifySheetCells('family', scope, { cells: [title, other] }, 'editor')
    expect(result.ok).toBe(false); expect(result.cells.vendor.ok).toBe(false); expect(result.cells['metafield:PRODUCT:custom.flag'].ok).toBe(true)
    expect(s.workspace.draft.nativeEdits.find((e: any) => e.field === 'vendor').nextValue).toBe('Other editor')
  })
  it('refuses a stale remote baseline, wrong owner, and another store token', async () => {
    const stale = change(); s.snapshot.rows[0].values.title = 'Changed in Shopify'
    expect((await saveShopifySheetCells('family', scope, { cells: [stale] }, 'editor')).cells.title.ok).toBe(false)
    const wrong = change(); wrong.ownerId = 'gid://shopify/Product/999'
    expect((await saveShopifySheetCells('family', scope, { cells: [wrong] }, 'editor')).cells.title.ok).toBe(false)
    const crossStore = change(); s.workspace.destination.accountId = 'store-b'
    expect((await saveShopifySheetCells('family', scope, { cells: [crossStore] }, 'editor')).cells.title.ok).toBe(false)
    expect(s.writes).toHaveLength(0)
  })
  it('preserves false, clears explicitly, and resets by removing only that edit', async () => {
    const field = 'metafield:PRODUCT:custom.flag'
    expect((await saveShopifySheetCells('family', scope, { cells: [change(field, 'true')] }, 'editor')).ok).toBe(true)
    expect(s.workspace.draft.edits[0]).toMatchObject({ value: 'false', nextValue: 'true', compareDigest: 'digest-1' })
    await saveShopifySheetCells('family', scope, { cells: [change(field, null)] }, 'editor')
    expect(s.workspace.draft.edits[0].nextValue).toBeNull()
    await saveShopifySheetCells('family', scope, { cells: [{ ...change(field, null), intent: 'reset' }] }, 'editor')
    expect(s.workspace.draft.edits).toEqual([])
  })
  it('refuses legacy title writes in both languages without changing existing drafts', async () => {
    s.schema.locales.push({ locale: 'fr', primary: false, published: true })
    s.schema.native = { scopes: ['read_products', 'write_products', 'read_translations', 'write_translations'], inputs: { product: ['title'] }, enums: {} }
    s.workspace.draft.nativeEdits = [{ ownerId: product, productId: product, ownerLabel: 'Listed title', field: 'title', value: 'Listed title', nextValue: 'Primary draft' }]
    const before = structuredClone(s.workspace.draft)
    for (const locale of ['en', 'fr']) {
      s.snapshot.rows[0].locale = locale
      s.snapshot.rows[0].translations = { title: { resourceId: product, fieldId: 'title', key: 'title', locale, digest: 'digest', value: 'Titre', sourceValue: 'Listed title', outdated: false } }
      const result = await saveShopifySheetCells('family', { ...scope, locale }, { cells: [change('title', null)] }, 'editor')
      expect(result.cells.title).toMatchObject({ ok: false, reason: expect.stringContaining('content address writer') })
    }
    expect(s.workspace.draft).toEqual(before)
    expect(s.writes).toHaveLength(0)
  })
  it('rejects a changed destination, changed definition and overlapping batch commands', async () => {
    const first = change()
    s.workspace.destination.listingId = 'another-alias'
    expect((await saveShopifySheetCells('family', scope, { cells: [first] }, 'editor')).ok).toBe(false)
    const field = change('metafield:PRODUCT:custom.flag', 'true')
    s.schema.definitions[0].readOnlyReason = 'This app owns the field.'
    expect((await saveShopifySheetCells('family', scope, { cells: [field] }, 'editor')).ok).toBe(false)
    await expect(saveShopifySheetCells('family', scope, { cells: [change(), change('title', 'Different')] }, 'editor')).rejects.toThrow('conflicting edits')
    expect(s.writes).toHaveLength(0)
  })
  it('refuses edits while an interrupted synchronization still needs verification', async () => {
    s.workspace.operation = { id: 'operation', status: 'UNVERIFIED' }
    await expect(saveShopifySheetCells('family', scope, { cells: [change()] }, 'editor')).rejects.toThrow('pending synchronization')
    expect(s.writes).toHaveLength(0)
  })
  it('keeps equal-value pins and saved overrides after pending synchronization commands clear', async () => {
    await saveShopifySheetCells('family', scope, { cells: [{ ...change('vendor', 'Vendor'), intent: 'pin' }] }, 'editor')
    expect(s.workspace.draft.nativeEdits).toEqual([])
    expect(s.workspace.draft.sheetValues[0]).toMatchObject({ value: 'Vendor', locale: '' })
    const identities = [{ id: 'listing-a', productId: 'family', externalListingId: '10', platformAttributes: {} }]
    expect(projectShopifyChannelSheet(page(), s.workspace, s.snapshot, s.schema, identities, 'alias-a')[0].values.vendor).toMatchObject({ value: 'Vendor', pinned: true, inherited: false })
    await saveShopifySheetCells('family', scope, { cells: [change('vendor', 'A durable override')] }, 'editor')
    s.workspace.draft.nativeEdits = []
    expect(projectShopifyChannelSheet(page(), s.workspace, s.snapshot, s.schema, identities, 'alias-a')[0].values.vendor).toMatchObject({ value: 'A durable override', pinned: true })
    const reset = await saveShopifySheetCells('family', scope, { cells: [{ ...change('vendor', 'Untrusted client reset value'), intent: 'reset' }] }, 'editor')
    expect(reset.ok).toBe(true)
    expect(s.workspace.draft.nativeEdits[0].nextValue).toBe('Shared vendor')
    expect(projectShopifyChannelSheet(page(), s.workspace, s.snapshot, s.schema, identities, 'alias-a')[0].values.vendor).toMatchObject({ value: 'Shared vendor', pinned: false, inherited: true })
  })
})
