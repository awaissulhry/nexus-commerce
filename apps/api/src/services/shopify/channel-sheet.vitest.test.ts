import { beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyShopifyLinkedDraft } from '@nexus/shared/shopify-linked-products'
import { informationRegistry, informationStoredValue } from '@nexus/shared/shopify-information'
import { projectShopifyChannelSheet, shopifyCellToken } from './channel-sheet-projection.js'
import { resolveSharedContent } from './linked-shared-content.service.js'
import type { ShopifyGraphql } from './admin-client.js'

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

function sharedFixture() {
  const sourceId = 'gid://shopify/Product/20', siblingId = 'gid://shopify/Product/30'
  const original = s.snapshot.rows[0]
  for (const id of [sourceId, siblingId]) s.snapshot.rows.push({ ...structuredClone(original), id, productId: id,
    title: id === sourceId ? 'Shared source' : 'Other follower',
    fields: [{ ...original.fields[0], ownerId: id, value: id === sourceId ? 'true' : 'false' }],
  })
  s.workspace.draft.members = s.snapshot.rows.filter((r: any) => r.kind === 'PRODUCT').map((r: any) => ({ id: r.id, title: r.title, handle: r.handle, image: null }))
  s.workspace.draft.sharedFields = [{ namespace: 'custom', key: 'flag', sourceProductId: sourceId, excludedProductIds: [],
    baseline: s.snapshot.rows.filter((r: any) => r.kind === 'PRODUCT').flatMap((r: any) => r.fields) }]
  return { sourceId, siblingId, fieldId: 'metafield:PRODUCT:custom.flag' }
}
async function sharedPublishPlan() {
  const provider = async (_query: string, variables: Record<string, unknown> = {}) => {
    const result: Record<string, unknown> = {}
    for (let i = 0; variables[`id${i}`]; i++) {
      const id = variables[`id${i}`], row = s.snapshot.rows.find((r: any) => r.id === id)
      result[`owner${i}`] = { id, metafield: row.fields.find((f: any) => f.namespace === variables[`ns${i}`] && f.key === variables[`key${i}`]) }
    }
    return result
  }
  return resolveSharedContent(provider as ShopifyGraphql, s.workspace.draft, s.schema)
}


describe('Shopify behind the common channel sheet', () => {
  it('returns separate per-owner receipts for one physical column, including a stale owner', async () => {
    const { fieldId, sourceId, siblingId } = sharedFixture()
    const good = { ...change(fieldId, 'false', product), colId: 'flag', receiptKey: 'row-a' }
    const stale = { ...change(fieldId, 'false', siblingId), colId: 'flag', receiptKey: 'row-b', token: 'stale' }
    const source = { ...change(fieldId, 'true', sourceId), colId: 'flag', receiptKey: 'row-c' }
    const result = await saveShopifySheetCells('family', scope, { cells: [good, stale, source] }, 'editor')
    expect(Object.keys(result.cells)).toEqual(['row-a', 'row-b', 'row-c'])
    expect(result.cells['row-a']).toMatchObject({ ok: true, shopifyWrite: { ownerId: product, fieldId } })
    expect(result.cells['row-b']).toMatchObject({ ok: false, reason: expect.stringContaining('Another editor') })
    expect(result.cells['row-c']).toMatchObject({ ok: true, shopifyWrite: { ownerId: sourceId, fieldId } })
    expect(s.workspace.draft.sheetValues.map((v: any) => v.ownerId)).toEqual([product, sourceId])
    expect(s.workspace.draft.sharedFields[0].excludedProductIds).toEqual([product])
  })
  it('reports exact sharing facts on every write address, and the follower’s new facts after its own write', async () => {
    const { fieldId, sourceId, siblingId } = sharedFixture()
    s.workspace.draft.sharedFields[0].excludedProductIds = [siblingId]
    s.workspace.draft.sheetValues = [{ ownerId: product, fieldId, type: 'boolean', locale: '', value: 'true' }]
    const rows = projectShopifyChannelSheet(page(), s.workspace, s.snapshot, s.schema,
      [{ id: 'listing-a', productId: 'family', externalListingId: '10', platformAttributes: {} }], 'alias-a')
    // The legacy follower pin still FOLLOWS by the rule; its pin does not make it own.
    expect(rows[0].values[fieldId].shopifyWrite?.sharing).toEqual({ sourceOwnerId: sourceId, follows: true })
    expect(rows[0].values[fieldId].pinned).toBe(true)
    // A field no sharing rule covers says so explicitly (null), never by omission.
    expect(rows[0].values.vendor.shopifyWrite?.sharing).toBeNull()
    s.workspace.draft.sheetValues = []
    const result = await saveShopifySheetCells('family', scope, { cells: [
      { ...change(fieldId, 'false', product), colId: fieldId, receiptKey: 'follower' },
      { ...change(fieldId, 'true', sourceId), colId: fieldId, receiptKey: 'source' },
      { ...change(fieldId, 'false', siblingId), colId: fieldId, receiptKey: 'excluded' },
    ] }, 'editor')
    expect(result.cells.follower.shopifyWrite?.sharing).toEqual({ sourceOwnerId: sourceId, follows: false })
    expect(result.cells.source.shopifyWrite?.sharing).toEqual({ sourceOwnerId: sourceId, follows: false })
    expect(result.cells.excluded.shopifyWrite?.sharing).toEqual({ sourceOwnerId: sourceId, follows: false })
  })
  it('refuses duplicate effective receipt identities before writing any draft', async () => {
    const { fieldId, sourceId } = sharedFixture(), before = structuredClone(s.workspace.draft)
    const a = { ...change(fieldId, 'false'), colId: 'flag', receiptKey: 'same' }
    const b = { ...change(fieldId, 'true', sourceId), colId: 'same' }
    await expect(saveShopifySheetCells('family', scope, { cells: [a, b] }, 'editor')).rejects.toThrow(/conflicting/)
    expect(s.workspace.draft).toEqual(before)
    expect(s.writes).toEqual([])
  })
  it('creates an own override and resets to the shared source without changing its siblings', async () => {
    const { sourceId, siblingId, fieldId } = sharedFixture()
    const untouched = structuredClone(s.snapshot.rows.filter((r: any) => [sourceId, siblingId].includes(r.id)))
    const result = await saveShopifySheetCells('family', scope, { cells: [change(fieldId, 'false')] }, 'editor')
    expect(result.cells[fieldId].ok).toBe(true)
    expect(s.workspace.draft.sharedFields[0].excludedProductIds).toEqual([product])
    expect(s.workspace.draft.sheetValues).toEqual([expect.objectContaining({ ownerId: product, value: 'false', locale: '' })])
    const reset = await saveShopifySheetCells('family', scope, { cells: [{ ...change(fieldId, null), intent: 'reset' }] }, 'editor')
    expect(reset.cells[fieldId].ok).toBe(true)
    expect(s.workspace.draft.sharedFields[0].excludedProductIds).toEqual([])
    expect(s.workspace.draft.edits.filter((e: any) => e.ownerId === product)).toEqual([])
    const rows = projectShopifyChannelSheet(page(), s.workspace, s.snapshot, s.schema,
      [{ id: 'listing-a', productId: 'family', externalListingId: '10', platformAttributes: {} }], 'alias-a')
    expect(rows[0].values[fieldId]).toMatchObject({ value: 'true', writable: true, pinned: false, inherited: true, follows: true })
    expect(s.snapshot.rows.filter((r: any) => [sourceId, siblingId].includes(r.id))).toEqual(untouched)
    expect(s.workspace.draft.sheetValues.every((v: any) => v.ownerId === product)).toBe(true)
  })
  it('does not exclude a follower when its new value cannot be stored', async () => {
    const { fieldId } = sharedFixture(), before = structuredClone(s.workspace.draft)
    const result = await saveShopifySheetCells('family', scope, { cells: [change(fieldId, 'maybe')] }, 'editor')
    expect(result.cells[fieldId].ok).toBe(false)
    expect(s.workspace.draft).toEqual(before)
    expect(s.writes).toEqual([])
  })
  it('keeps an excluded product own even when its value equals the shared source', async () => {
    const { fieldId } = sharedFixture()
    s.workspace.draft.sharedFields[0].excludedProductIds = [product]
    s.snapshot.rows[0].fields[0].value = 'true'
    const rows = projectShopifyChannelSheet(page(), s.workspace, s.snapshot, s.schema,
      [{ id: 'listing-a', productId: 'family', externalListingId: '10', platformAttributes: {} }], 'alias-a')
    expect(rows[0].values[fieldId]).toMatchObject({ value: 'true', pinned: true, inherited: false, follows: false, resettable: true })
  })
  it('captures only the reset product’s current provider baseline when it rejoins sharing', async () => {
    const { fieldId } = sharedFixture()
    s.workspace.draft.sharedFields[0].excludedProductIds = [product]
    const otherBaselines = structuredClone(s.workspace.draft.sharedFields[0].baseline.filter((f: any) => f.ownerId !== product))
    s.snapshot.rows[0].fields = [{ ...s.snapshot.rows[0].fields[0], value: 'true', compareDigest: 'new-provider-value' }]
    const result = await saveShopifySheetCells('family', scope, { cells: [{ ...change(fieldId, null), intent: 'reset' }] }, 'editor')
    expect(result.cells[fieldId].ok).toBe(true)
    expect(s.workspace.draft.sharedFields[0].baseline.find((f: any) => f.ownerId === product)).toMatchObject({ value: 'true', compareDigest: 'new-provider-value' })
    expect(s.workspace.draft.sharedFields[0].baseline.filter((f: any) => f.ownerId !== product)).toEqual(otherBaselines)
    expect(s.workspace.draft.sharedFields[0].excludedProductIds).toEqual([])
  })
  it('uses the Shopify sharing address instead of a lower content mapping for a shared field', () => {
    const { fieldId } = sharedFixture(), base = page()
    base.rows[0].values[fieldId] = { ...base.rows[0].values[fieldId], value: 'false', pinned: true,
      contentAddress: { tier: 'source' }, contentAcknowledgement: { shared: { address: { tier: 'source' } } }, contentVersion: 8,
      mapped: { status: 'mapped', value: 'false', sourceOwner: { kind: 'product', id: 'family' } } }
    const rows = projectShopifyChannelSheet(base, s.workspace, s.snapshot, s.schema,
      [{ id: 'listing-a', productId: 'family', externalListingId: '10', platformAttributes: {} }], 'alias-a')
    expect(rows[0].values[fieldId]).toMatchObject({ value: 'true', pinned: false, inherited: true, layer: 'linked',
      mapped: null, shopifyWrite: { ownerId: product, fieldId } })
    expect(rows[0].values[fieldId].contentAcknowledgement).toBeUndefined()
    expect(rows[0].values[fieldId].contentAddress).toBeUndefined()
  })
  it('retains the required-field warning when the inherited source is empty', () => {
    const { fieldId, sourceId } = sharedFixture(), base = page()
    s.schema.definitions[0].required = true
    s.snapshot.rows.find((r: any) => r.id === sourceId).fields[0].value = null
    base.columns = base.columns.map((column: object) => ({ ...column, requiredBy: [] }))
    base.rows[0].completeness = { required: { filled: 0, total: 0, missing: [] }, optional: { filled: 0, total: 0, missing: [] } }
    const rows = projectShopifyChannelSheet(base, s.workspace, s.snapshot, s.schema,
      [{ id: 'listing-a', productId: 'family', externalListingId: '10', platformAttributes: {} }], 'alias-a')
    expect(rows[0].values[fieldId]).toMatchObject({ value: null, inherited: true, follows: true })
    expect(rows[0].readiness.issues).toContainEqual(expect.objectContaining({ key: fieldId, message: 'Enter a value. Shopify needs this field.' }))
  })
  it('edits a translated shared field without changing primary-language sharing or another product', async () => {
    s.schema.definitions[0].type = 'single_line_text_field'
    s.snapshot.rows[0].fields[0].type = 'single_line_text_field'
    const { fieldId, sourceId } = sharedFixture(), rule = structuredClone(s.workspace.draft.sharedFields[0])
    const source = s.snapshot.rows.find((r: any) => r.id === sourceId)
    const primary = { ...source.fields[0], nextValue: 'Primary pending text', ownerLabel: source.title }
    s.workspace.draft.edits = [primary]
    s.schema.locales.push({ locale: 'it', primary: false, published: true })
    s.schema.native = { scopes: ['read_products', 'write_products', 'read_translations', 'write_translations'], inputs: {}, enums: {} }
    s.snapshot.rows[0].locale = 'it'
    s.snapshot.rows[0].translations = { [fieldId]: { resourceId: 'gid://shopify/Metafield/14', fieldId,
      key: 'value', locale: 'it', digest: 'source-it', value: 'Prima', sourceValue: 'false', outdated: false } }
    const result = await saveShopifySheetCells('family', { ...scope, locale: 'it' }, { cells: [change(fieldId, 'Dopo')] }, 'editor')
    expect(result.cells[fieldId].ok).toBe(true)
    expect(s.workspace.draft.sharedFields).toEqual([rule])
    expect(s.workspace.draft.edits).toEqual([primary])
    expect(s.workspace.draft.nativeEdits).toEqual([expect.objectContaining({ ownerId: product, nextValue: 'Dopo', translation: expect.objectContaining({ locale: 'it' }) })])
    expect(s.workspace.draft.sheetValues).toEqual([expect.objectContaining({ ownerId: product, locale: 'it', value: 'Dopo' })])
    const reset = await saveShopifySheetCells('family', { ...scope, locale: 'it' }, { cells: [{ ...change(fieldId, null), intent: 'reset' }] }, 'editor')
    expect(reset.cells[fieldId].ok).toBe(true)
    expect(s.workspace.draft.sharedFields).toEqual([rule])
    expect(s.workspace.draft.edits).toEqual([primary])
    expect(s.workspace.draft.nativeEdits).toEqual([])
    expect(s.workspace.draft.sheetValues).toEqual([expect.objectContaining({ ownerId: product, locale: 'it', value: 'Prima', inherited: true })])
  })
  it('refuses a follower token captured before its shared draft source changed', async () => {
    const { sourceId, fieldId } = sharedFixture(), stale = change(fieldId, 'false')
    const source = await saveShopifySheetCells('family', scope, { cells: [change(fieldId, 'false', sourceId)] }, 'editor')
    expect(source.cells[fieldId].ok).toBe(true)
    const result = await saveShopifySheetCells('family', scope, { cells: [stale] }, 'editor')
    expect(result.cells[fieldId]).toMatchObject({ ok: false, reason: expect.stringContaining('Another editor changed') })
    expect(s.workspace.draft.sharedFields[0].excludedProductIds).toEqual([])
    expect(s.workspace.draft.edits).toEqual([expect.objectContaining({ ownerId: sourceId, nextValue: 'false' })])
  })
  it('keeps an own override token current when only the shared source value changes', async () => {
    const { sourceId, fieldId } = sharedFixture()
    s.workspace.draft.sharedFields[0].excludedProductIds = [product]
    const own = change(fieldId, 'false')
    expect((await saveShopifySheetCells('family', scope, { cells: [change(fieldId, 'false', sourceId)] }, 'editor')).ok).toBe(true)
    const result = await saveShopifySheetCells('family', scope, { cells: [own] }, 'editor')
    expect(result.cells[fieldId].ok).toBe(true)
    expect(s.workspace.draft.sharedFields[0].excludedProductIds).toEqual([product])
  })
  it('uses the publisher’s remote source value when only a surviving source pin differs', async () => {
    const { sourceId, fieldId } = sharedFixture()
    s.workspace.draft.sheetValues = [{ ownerId: sourceId, fieldId, type: 'boolean', locale: '', value: 'false' }]
    const rows = projectShopifyChannelSheet(page(), s.workspace, s.snapshot, s.schema,
      [{ id: 'listing-a', productId: 'family', externalListingId: '10', platformAttributes: {} }], 'alias-a')
    expect(rows[0].values[fieldId]).toMatchObject({ value: 'true', inherited: true, follows: true })
    const plan = await sharedPublishPlan()
    expect(plan.changes.find(change => change.ownerId === product)?.nextValue).toBe(rows[0].values[fieldId].value)
  })
  it('does not attach product sharing dependencies to a variant definition with the same namespace/key', async () => {
    const { sourceId, fieldId } = sharedFixture()
    s.schema.definitions.push({ ...s.schema.definitions[0], id: 'variant-flag', ownerType: 'PRODUCTVARIANT', name: 'Variant flag' })
    s.snapshot.rows[1].fields = [{ ownerId: variant, namespace: 'custom', key: 'flag', type: 'boolean', value: 'false', compareDigest: 'variant-digest' }]
    const variantField = 'metafield:PRODUCTVARIANT:custom.flag', own = change(variantField, 'true', variant)
    expect((await saveShopifySheetCells('family', scope, { cells: [change(fieldId, 'false', sourceId)] }, 'editor')).ok).toBe(true)
    expect(change(variantField, 'true', variant).token).toBe(own.token)
    expect((await saveShopifySheetCells('family', scope, { cells: [own] }, 'editor')).cells[variantField].ok).toBe(true)
    expect(s.workspace.draft.sharedFields[0].excludedProductIds).toEqual([])
  })
  it.each(['false', 'true'])('makes a surviving follower pin %s and its conflicting sharing rule explicit', async value => {
    const { fieldId } = sharedFixture(), base = page()
    s.workspace.draft.sheetValues = [{ ownerId: product, fieldId, type: 'boolean', locale: '', value }]
    base.columns = base.columns.map((column: object) => ({ ...column, requiredBy: [] }))
    base.rows[0].completeness = { required: { filled: 0, total: 0, missing: [] }, optional: { filled: 0, total: 0, missing: [] } }
    const before = structuredClone(s.workspace.draft)
    const rows = projectShopifyChannelSheet(base, s.workspace, s.snapshot, s.schema,
      [{ id: 'listing-a', productId: 'family', externalListingId: '10', platformAttributes: {} }], 'alias-a')
    const plan = await sharedPublishPlan()
    expect(rows[0].values[fieldId].value).toBe(value)
    expect(rows[0].values[fieldId].divergence).toMatchObject({ publishesAs: plan.changes.find(change => change.ownerId === product)!.nextValue })
    expect(rows[0].readiness.issues).toContainEqual(expect.objectContaining({ key: fieldId, severity: 'warn', message: expect.stringContaining('sharing rule') }))
    expect(s.workspace.draft).toEqual(before)
  })
  it('preserves locale content facts when the product has a primary-only sharing rule', () => {
    s.schema.definitions[0].type = 'single_line_text_field'; s.snapshot.rows[0].fields[0].type = 'single_line_text_field'
    const { fieldId } = sharedFixture(), base = page()
    s.snapshot.rows[0].locale = 'it'
    s.snapshot.rows[0].translations = { [fieldId]: { resourceId: 'gid://shopify/Metafield/14', fieldId,
      key: 'value', locale: 'it', digest: 'source-it', value: 'Prima', sourceValue: 'false', outdated: false } }
    const cell = { ...base.rows[0].values[fieldId], value: 'Nexus Italian', tier: 'language', language: 'it', requested: 'it',
      contentAddress: { tier: 'language', language: 'it' }, contentAcknowledgement: { shared: { address: { tier: 'language', language: 'it' } } }, contentVersion: 5 }
    base.rows[0].values[fieldId] = cell
    const rows = projectShopifyChannelSheet(base, s.workspace, s.snapshot, s.schema,
      [{ id: 'listing-a', productId: 'family', externalListingId: '10', platformAttributes: {} }], 'alias-a')
    expect(rows[0].values[fieldId]).toMatchObject(cell)
    expect(rows[0].values[fieldId].shopifyWrite).toBeUndefined()
  })
  it.each(['', null, 'Nexus pin'])('keeps addressed title %j and its source facts instead of replacing it with the provider baseline', value => {
    const base = page()
    const cell = { ...base.rows[0].values.title, value, pinned: true, inherited: false,
      contentAcknowledgement: { pin: { address: { tier: 'pin', language: 'en' } } },
      contentAddress: { tier: 'pin', language: 'en' }, contentVersion: 7, source: 'channelExplicit',
      mapped: { status: 'mapped', value, sourceOwner: { kind: 'listing', id: 'listing-a' } },
    }
    base.rows[0].values.title = cell
    const rows = projectShopifyChannelSheet(base, s.workspace, s.snapshot, s.schema,
      [{ id: 'listing-a', productId: 'family', externalListingId: '10', platformAttributes: {} }], 'alias-a')
    expect(rows[0].values.title).toMatchObject(cell)
    expect(rows[0].values.title.shopifyWrite).toBeUndefined()
  })
  it.each(['four', '', null])('saves %j as a draft and projects its store warning after reload', async value => {
    const definition = s.schema.definitions[0]
    Object.assign(definition, { type: 'single_line_text_field', required: true, validations: [{ name: 'max', value: '3' }] })
    Object.assign(s.snapshot.rows[0].fields[0], { type: definition.type, value: 'old' })
    const fieldId = 'metafield:PRODUCT:custom.flag'
    const result = await saveShopifySheetCells('family', scope, { cells: [change(fieldId, value)] }, 'editor')
    expect(result.cells[fieldId]).toMatchObject({ ok: true, shopifyWrite: { ownerId: product, fieldId } })
    expect(s.workspace.draft.edits[0]).toMatchObject({ value: 'old', nextValue: value, compareDigest: 'digest-1' })
    expect(s.workspace.draft.sheetValues[0]).toMatchObject({ ownerId: product, value, locale: '' })
    const base = page()
    base.columns = base.columns.map((column: object) => ({ ...column, requiredBy: [] }))
    base.rows[0].completeness = { required: { filled: 0, total: 0, missing: [] }, optional: { filled: 0, total: 0, missing: [] } }
    const rows = projectShopifyChannelSheet(base, s.workspace, s.snapshot, s.schema,
      [{ id: 'listing-a', productId: 'family', externalListingId: '10', platformAttributes: {} }], 'alias-a')
    expect(rows[0].values[fieldId]).toMatchObject({ value, writable: true, nexusDraft: true, pinned: true })
    expect(rows[0].readiness.issues).toContainEqual(expect.objectContaining({ key: fieldId,
      message: value === null ? 'Enter a value. Shopify needs this field.' : value === '' ? 'Enter one line of text, or clear the field.' : 'Use 3 characters or fewer. Now: 4.' }))
  })
  it('refuses a malformed cell without losing a type-valid draft that violates store limits', async () => {
    const definition = s.schema.definitions[0]
    s.schema.definitions.push({ ...definition, id: 'definition-2', key: 'label', name: 'Label', type: 'single_line_text_field', validations: [{ name: 'max', value: '3' }] })
    const result = await saveShopifySheetCells('family', scope, { cells: [change('metafield:PRODUCT:custom.flag', 'maybe'), change('metafield:PRODUCT:custom.label', 'four')] }, 'editor')
    expect(result.ok).toBe(false)
    expect(result.cells['metafield:PRODUCT:custom.flag']).toMatchObject({ ok: false, reason: expect.stringContaining('Yes or No') })
    expect(result.cells['metafield:PRODUCT:custom.label'].ok).toBe(true)
    expect(s.workspace.draft.edits).toEqual([expect.objectContaining({ key: 'label', nextValue: 'four' })])
  })
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
  /* S1 item 5 (f), Owner decision 11 — a live cell that follows Shared while Shopify keeps another value says so. */
  describe('a product already on Shopify keeps its own value', () => {
    const note = (words: string) => `Shopify keeps ${words}. Shared changes are not sent to a product already on Shopify; enter the value here to send it.`
    const project = (base: any) => projectShopifyChannelSheet(base, s.workspace, s.snapshot, s.schema, [{ id: 'variant-listing', productId: 'child', externalListingId: '10', platformAttributes: { variantId: '11' } }], 'alias-a')
    const following = (base: any, key: string, value: unknown) => { base.rows[1].values = { ...base.rows[1].values, [key]: { ...base.rows[1].values[key], value, mapped: { status: 'mapped', value } } } }
    it('marks a Shared value Shopify does not have, with Shopify\'s value and the reason', () => {
      const base = page()
      following(base, 'barcode', '0001'); following(base, 'weight', { value: 1.2, unit: 'kg' }); following(base, 'cost', 9)
      Object.assign(s.snapshot.rows[1].values, { barcode: '0002', weight: '{"value":1,"unit":"KILOGRAMS"}', cost: '9.00' })
      const values = project(base)[1].values
      expect(values.barcode).toMatchObject({ value: '0001', divergence: { publishesAs: '0002', note: note('0002') } })
      expect(values.weight).toMatchObject({ value: '{"value":1.2,"unit":"KILOGRAMS"}', divergence: { publishesAs: '{"value":1,"unit":"KILOGRAMS"}', note: note('1 kg') } })
      expect(values.cost.divergence).toBeUndefined()
    })
    it('compares a weight in grams, treats an empty Shopify value as no value, and names it', () => {
      const base = page()
      following(base, 'weight', { value: 1.2, unit: 'kg' }); following(base, 'barcode', null); following(base, 'harmonizedSystemCode', '640399')
      Object.assign(s.snapshot.rows[1].values, { weight: '{"value":1200,"unit":"GRAMS"}', barcode: '', harmonizedSystemCode: null })
      const values = project(base)[1].values
      expect(values.weight.divergence).toBeUndefined()
      expect(values.barcode.divergence).toBeUndefined()
      expect(values.harmonizedSystemCode.divergence).toEqual({ publishesAs: null, note: note('no value') })
    })
    it('no mark where a synchronisation sends the Shared value, or where the operator has an edit waiting', () => {
      const base = page()
      following(base, 'barcode', '0001')
      Object.assign(s.snapshot.rows[1].values, { barcode: '0002' })
      s.workspace.draft.nativeEdits = [{ ownerId: variant, productId: product, ownerLabel: 'Small', field: 'barcode', value: '0002', nextValue: '0003' }]
      const rows = project(base)
      expect(rows[0].values.vendor).toMatchObject({ value: 'Shared vendor' })
      expect(rows[0].values.vendor.divergence).toBeUndefined()
      expect(rows[1].values.barcode).toMatchObject({ value: '0003', unsentDraft: true })
      expect(rows[1].values.barcode.divergence).toBeUndefined()
    })
  })
  it('D2 — while Nexus sends the quantity (Follow or Pinned), Shopify\'s own inventory field is held and points to Qty; paused → editable', () => {
    const base = page()
    base.rows[1].listing = { ...(base.rows[1].listing ?? {}), syncPaused: false, follows: { followMasterQuantity: true } }
    s.snapshot.rows[1].values.inventory = JSON.stringify({ inventoryItemId: 'gid://shopify/InventoryItem/12', tracked: true, locations: [] })
    const listings = [{ id: 'variant-listing', productId: 'child', externalListingId: '10', platformAttributes: { variantId: '11' } }]
    const held = projectShopifyChannelSheet(base, s.workspace, s.snapshot, s.schema, listings, 'alias-a')[1].values.inventory
    expect(held).toMatchObject({ editable: false, writable: false })
    expect(held.writeBlockedReason).toMatch(/^Nexus sends this quantity to Shopify \(Mode: Follow\)\. Change it in the Qty column/)
    base.rows[1].listing = { ...base.rows[1].listing, syncPaused: true }
    const paused = projectShopifyChannelSheet(base, s.workspace, s.snapshot, s.schema, listings, 'alias-a')[1].values.inventory
    expect(String(paused.writeBlockedReason ?? '')).not.toMatch(/Nexus sends this quantity/)
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
  it('says which Nexus value Shopify does not have yet (`unsentDraft`), and never says it of a synchronized pin', async () => {
    // 2026-10-04 (channel cell marks): `nexusDraft` is true for both; only an unsent edit waits for Review synchronization.
    const identities = [{ id: 'listing-a', productId: 'family', externalListingId: '10', platformAttributes: {} }]
    const vendor = () => projectShopifyChannelSheet(page(), s.workspace, s.snapshot, s.schema, identities, 'alias-a')[0].values.vendor
    expect(vendor()).not.toHaveProperty('unsentDraft')
    // An edit saved in Nexus: Shopify does not have it yet.
    await saveShopifySheetCells('family', scope, { cells: [change('vendor', 'A durable override')] }, 'editor')
    expect(s.workspace.draft.nativeEdits).toHaveLength(1)
    expect(vendor()).toMatchObject({ value: 'A durable override', nexusDraft: true, pinned: true, unsentDraft: true })
    // A finished synchronization clears the draft's edits and keeps the value as a saved pin: pinned, not unsent.
    s.workspace.draft.nativeEdits = []
    expect(vendor()).toMatchObject({ value: 'A durable override', nexusDraft: true, pinned: true })
    expect(vendor()).not.toHaveProperty('unsentDraft')
    // A reset back to the Shared value is an edit too, until synchronization sends it.
    await saveShopifySheetCells('family', scope, { cells: [{ ...change('vendor', 'Untrusted client reset value'), intent: 'reset' }] }, 'editor')
    expect(vendor()).toMatchObject({ value: 'Shared vendor', pinned: false, nexusDraft: true, unsentDraft: true })
  })
  it('says which field the Shared product supplies nothing for (`channelOnly`), also once Nexus holds its value', async () => {
    // 2026-10-04 (channel cell marks): every value Nexus holds arrives `mapped: null`, so only this fact tells the sheet
    // that a pin on such a field no longer follows Shopify's own value — not the Shared product.
    const identities = [{ id: 'listing-a', productId: 'family', externalListingId: '10', platformAttributes: {} }]
    const project = () => projectShopifyChannelSheet(page(), s.workspace, s.snapshot, s.schema, identities, 'alias-a')[0].values
    const flag = 'metafield:PRODUCT:custom.flag'
    // No Shared mapping reaches the metafield: Shopify's own value.
    expect(project()[flag]).toMatchObject({ value: 'false', channelOnly: true, mapped: null })
    // A Shared mapping reaches the vendor: never channel-only.
    expect(project().vendor).not.toHaveProperty('channelOnly')
    // An edit Shopify does not have yet, then the saved pin synchronization leaves: still channel-only, still no mapping.
    await saveShopifySheetCells('family', scope, { cells: [change(flag, 'true')] }, 'editor')
    expect(project()[flag]).toMatchObject({ value: 'true', pinned: true, nexusDraft: true, unsentDraft: true, channelOnly: true, mapped: null })
    s.workspace.draft.edits = []
    expect(project()[flag]).toMatchObject({ value: 'true', pinned: true, nexusDraft: true, channelOnly: true, mapped: null })
    // A pin on the vendor arrives `mapped: null` too, and is NOT channel-only: its reset returns the Shared value.
    await saveShopifySheetCells('family', scope, { cells: [change('vendor', 'A durable override')] }, 'editor')
    s.workspace.draft.nativeEdits = []
    expect(project().vendor).toMatchObject({ value: 'A durable override', pinned: true, mapped: null })
    expect(project().vendor).not.toHaveProperty('channelOnly')
  })
})
