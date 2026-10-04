import { afterAll, beforeAll, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as Awaited<ReturnType<typeof import('../../test-support/formula-database.js').formulaDatabase>> | null }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn() }))
vi.mock('../product-event.service.js', () => ({ productEventService: { emit: vi.fn(), emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn() }, FACE_IMAGE_ORDER_BY: [], FACE_IMAGE_SELECT: {}, pickFaceImage: () => null }))
vi.mock('./readiness-index.service.js', async () => (await import('../../test-support/readiness-module-mock.js')).readinessModuleMock(vi.fn()))
vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('No provider calls in the Amazon draft fixture') }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { applyProductBulkEdits, ProductBulkError } from '../products/bulk-edit.service.js'
import { getStudioSheet } from './studio-sheet.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const workspaceMode = process.env.NEXUS_WORKSPACES_ENABLED
process.env.NEXUS_WORKSPACES_ENABLED = '1'
const context = { formulaCascade: false, contentPerRow: true, logger: { warn: vi.fn(), error: vi.fn() } }
const attribute = (properties: Record<string, unknown>) => ({ type: 'array', maxItems: 1, items: { type: 'object', properties } })
const definition = { type: 'object', properties: {
  item_name: attribute({ value: { type: 'string' } }),
  brand: attribute({ value: { type: 'string', editable: false } }),
  condition_type: attribute({ value: { type: 'string', editable: false, enum: ['new_new', 'used_like_new'] } }),
  externally_assigned_product_identifier: attribute({ value: { type: 'string', editable: false }, type: { type: 'string', editable: false } }),
  child_parent_sku_relationship: attribute({ parent_sku: { type: 'string', editable: false }, child_relationship_type: { type: 'string', editable: false } }),
  unknown_immutable: attribute({ value: { type: 'string', editable: false } }),
} }
let account = '', otherAccount = '', serial = 0

beforeAll(() => scoped(async () => {
  for (const code of ['IT', 'DE']) {
    await prisma.marketplace.create({ data: { channel: 'AMAZON', code, name: code, currency: 'EUR', region: 'EU', language: code === 'IT' ? 'it' : 'de', languages: ['it', 'de'], marketplaceId: code === 'IT' ? 'APJ6JRA9NG5V4' : 'A1PA6795UKMFR9' } })
    await prisma.categorySchema.create({ data: { channel: 'AMAZON', marketplace: code, productType: 'E2E_DRAFT_COAT', schemaVersion: 'draft-fixture', expiresAt: new Date('2099-01-01'), schemaDefinition: definition } })
  }
  for (const label of ['draft-selected', 'draft-other']) {
    const row = await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: label, isActive: true, isPrimary: label === 'draft-selected', externalAccountId: `FAKE-${label}` } })
    if (label === 'draft-selected') account = row.id
    else otherAccount = row.id
  }
}), 60_000)
afterAll(async () => {
  if (workspaceMode === undefined) delete process.env.NEXUS_WORKSPACES_ENABLED
  else process.env.NEXUS_WORKSPACES_ENABLED = workspaceMode
  vi.unstubAllGlobals()
  await state.db?.close()
})

async function fixture(existing = true) {
  const product = await prisma.product.create({ data: { sku: `E2E-AMAZON-DRAFT-${++serial}`, name: 'Coat draft fixture', brand: 'Master brand', basePrice: 29, productType: 'E2E_DRAFT_COAT' } })
  for (const [channelConnectionId, marketplace, aliasKey] of [[account, 'IT', ''], [account, 'DE', ''], [otherAccount, 'IT', '']] as const) {
    await prisma.channelListing.create({ data: { productId: product.id, channel: 'AMAZON', marketplace, channelMarket: `AMAZON_${marketplace}`, region: 'EU', channelConnectionId, aliasKey,
      externalListingId: existing ? 'SYNTHETIC-ASIN' : null, listingStatus: existing ? 'ACTIVE' : 'DRAFT', isPublished: existing,
      platformAttributes: { brand: 'Before', condition_type: 'new_new' } } })
  }
  return product.id
}
const read = (id: string, accountId = account, market = 'IT', locale = 'it') => getStudioSheet({ productId: id, scope: 'channel', channel: 'AMAZON', accountId, market, locale })
const listing = (id: string) => prisma.channelListing.findFirstOrThrow({ where: { productId: id, channelConnectionId: account, marketplace: 'IT', aliasKey: '' } })
const write = (id: string, field: string, value: unknown, expectedVersion: number) => applyProductBulkEdits({ changes: [{ id, field, value, target: 'channel', intent: 'set' }],
  marketplaceContexts: [{ channel: 'AMAZON', marketplace: 'IT', locale: 'it', accountId: account, aliasKey: '' }], expectedVersion }, context)

it('offers an existing brand draft, persists it, and warns on the real sheet reload', () => scoped(async () => {
  const id = await fixture()
  const before = (await read(id)).rows[0]
  expect(before.values.brand).toMatchObject({ editable: true, writable: true, writeBlockedReason: null })
  const answer = await write(id, 'attr_brand', 'New draft brand', (await listing(id)).version)
  expect(answer.errors ?? []).toEqual([])
  expect((await listing(id)).platformAttributes).toMatchObject({ brand: 'New draft brand' })
  const reloaded = (await read(id)).rows[0]
  expect(reloaded.values.brand).toMatchObject({ value: 'New draft brand', editable: true, writable: true })
  expect(reloaded.values.brand.mapped?.warnings).toContain('brand cannot be edited on an existing Amazon listing. You can save a draft here, but cannot publish this change.')
  expect(reloaded.readiness.issues).toContainEqual(expect.objectContaining({ key: 'brand', severity: 'warn', message: expect.stringContaining('brand cannot be edited') }))
  expect((await prisma.product.findUniqueOrThrow({ where: { id } })).brand).toBe('Master brand')
}))

it('offers the classified attribute drafts but keeps unknown and actual relationship fields locked', () => scoped(async () => {
  const id = await fixture()
  const row = (await read(id)).rows[0]
  expect(row.values.condition_type).toMatchObject({ editable: true, writable: true })
  for (const key of ['externally_assigned_product_identifier', 'externally_assigned_product_identifier__type']) {
    expect(row.values[key], key).toMatchObject({ editable: true, writable: true, writeBlockedReason: null })
  }
  // Item 12 (2026-10-05): the family's relationship cells are read-only system values, not drafts.
  for (const key of ['child_parent_sku_relationship__parent_sku', 'child_parent_sku_relationship__child_relationship_type']) {
    expect(row.values[key], key).toMatchObject({ editable: false, writable: false })
  }
  expect(row.values.unknown_immutable).toMatchObject({ editable: false, writable: false, writeBlockedReason: expect.any(String) })
  for (const key of ['__productRole', '__parentSku']) expect(row.values[key], key).toMatchObject({ editable: false, writable: false })
  const answer = await write(id, 'attr_condition_type', 'used_like_new', (await listing(id)).version)
  expect(answer.errors ?? []).toEqual([])
  expect((await read(id)).rows[0].values.condition_type.value).toBe('used_like_new')
}))

it('keeps a new listing authorable without claiming an existing-listing warning', () => scoped(async () => {
  const id = await fixture(false)
  const row = (await read(id)).rows[0]
  expect(row.values.brand).toMatchObject({ editable: true, writable: true })
  expect(row.values.brand.mapped?.warnings ?? []).not.toContain(expect.stringContaining('existing Amazon listing'))
  expect(row.readiness.issues.some(issue => issue.message.includes('existing Amazon listing'))).toBe(false)
}))

it('refuses malformed types and a stale token without changing the stored brand', () => scoped(async () => {
  const id = await fixture(), original = await listing(id)
  let refused: unknown
  try { refused = await write(id, 'attr_brand', { invalid: 'record' }, original.version) }
  catch (error) { if (!(error instanceof ProductBulkError)) throw error; refused = error.details }
  expect(refused).toMatchObject({ errors: [expect.objectContaining({ field: 'attr_brand' })] })
  expect((await listing(id)).platformAttributes).toMatchObject({ brand: 'Before' })
  const first = await write(id, 'attr_brand', 'Accepted draft', original.version)
  expect(first.errors ?? []).toEqual([])
  await expect(write(id, 'attr_brand', 'Stale draft', original.version)).rejects.toMatchObject({ statusCode: 409 })
  expect((await listing(id)).platformAttributes).toMatchObject({ brand: 'Accepted draft' })
}))

it('keeps the selected account and market isolated and keeps language stores unchanged', () => scoped(async () => {
  const id = await fixture(), own = await listing(id)
  const otherRows = await prisma.channelListing.findMany({ where: { productId: id, NOT: { id: own.id } }, orderBy: { id: 'asc' } })
  await prisma.channelListingTranslation.create({ data: { channelListingId: own.id, language: 'de', name: 'Deutscher Titel', attributes: { brand: 'German content stays' } } })
  const translations = await prisma.channelListingTranslation.findMany({ where: { channelListingId: own.id } })
  const answer = await write(id, 'attr_brand', 'Selected market draft', own.version)
  expect(answer.errors ?? []).toEqual([])
  expect(await prisma.channelListing.findMany({ where: { productId: id, NOT: { id: own.id } }, orderBy: { id: 'asc' } })).toEqual(otherRows)
  expect(await prisma.channelListingTranslation.findMany({ where: { channelListingId: own.id } })).toEqual(translations)
  expect((await read(id, otherAccount)).rows[0].values.brand.value).toBe('Before')
  expect((await read(id, account, 'DE', 'de')).rows[0].values.brand.value).toBe('Before')
}))

it('does not expose the listing draft in another business', () => scoped(async () => {
  const id = await fixture()
  const other = await prisma.workspace.create({ data: { name: 'Other draft business', createdByUserId: 'test-bootstrap', creationKey: 'other-draft-business' } })
  await withWorkspace({ workspaceId: other.id, actorUserId: null, membershipId: null, roleKeys: [] }, async () => {
    expect(await prisma.channelListing.findMany({ where: { productId: id } })).toEqual([])
    await expect(read(id)).rejects.toThrow()
  })
  expect((await listing(id)).platformAttributes).toMatchObject({ brand: 'Before' })
}))

it.each(['externalListingId', 'sku', 'listingStatus', 'lastSyncedAt', '__productRole', '__parentSku'])(
  'the real writer refuses protected %s and leaves listing storage and version unchanged', field => scoped(async () => {
    const id = await fixture(), before = await listing(id)
    const productBefore = await prisma.product.findUniqueOrThrow({ where: { id } })
    let refused: unknown
    try { refused = await write(id, field, 'SYNTHETIC-CHANGED-IDENTITY', before.version) }
    catch (error) { if (!(error instanceof ProductBulkError)) throw error; refused = error.details }
    expect(refused).toMatchObject({ errors: [expect.objectContaining({ id, field, error: expect.any(String) })] })
    expect(await listing(id)).toEqual(before)
    expect(await prisma.product.findUniqueOrThrow({ where: { id } })).toEqual(productBefore)
  }),
)

it('a failed catalog parent write does not partly change the product or listing', () => scoped(async () => {
  // parentId is deliberately writable by the catalog's link-variant workflow (master-field-gate.ts).
  // It is not the draft attribute above or the read-only __parentSku cell. Preserve its rollback contract.
  const id = await fixture(), before = await listing(id)
  const productBefore = await prisma.product.findUniqueOrThrow({ where: { id } })
  await expect(write(id, 'parentId', 'SYNTHETIC-MISSING-PARENT', before.version)).rejects.toMatchObject({
    statusCode: 500, details: { error: 'Bulk update failed', message: expect.stringContaining('Foreign key constraint violated') },
  })
  expect(await listing(id)).toEqual(before)
  expect(await prisma.product.findUniqueOrThrow({ where: { id } })).toEqual(productBefore)
}))

it('stores a valid brand beside one malformed cell and returns a usable next-save token', () => scoped(async () => {
  const id = await fixture(), before = await listing(id)
  const others = await prisma.channelListing.findMany({ where: { productId: id, NOT: { id: before.id } }, orderBy: { id: 'asc' } })
  const answer = await applyProductBulkEdits({ changes: [
    { id, field: 'attr_brand', value: 'Mixed valid draft', target: 'channel', intent: 'set' },
    { id, field: 'attr_condition_type', value: { invalid: 'record' }, target: 'channel', intent: 'set' },
  ], marketplaceContexts: [{ channel: 'AMAZON', marketplace: 'IT', locale: 'it', accountId: account, aliasKey: '' }], expectedVersion: before.version }, context)
  expect(answer.errors).toEqual([expect.objectContaining({ id, field: 'attr_condition_type' })])
  expect((await listing(id)).platformAttributes).toMatchObject({ brand: 'Mixed valid draft', condition_type: 'new_new' })
  expect(answer).toMatchObject({ versionOf: 'channelListing', currentVersion: (await listing(id)).version })
  expect(typeof answer.currentVersion).toBe('number')
  const next = await write(id, 'attr_brand', 'Next valid draft', answer.currentVersion!)
  expect(next.errors ?? []).toEqual([])
  expect((await listing(id)).platformAttributes).toMatchObject({ brand: 'Next valid draft', condition_type: 'new_new' })
  expect(await prisma.channelListing.findMany({ where: { productId: id, NOT: { id: before.id } }, orderBy: { id: 'asc' } })).toEqual(others)
}))

it.each(['child_parent_sku_relationship__parent_sku', 'child_parent_sku_relationship__child_relationship_type'])(
  'a direct %s write is refused (a read-only family value) and changes nothing', key => scoped(async () => {
    const id = await fixture()
    const before = await listing(id)
    const productBefore = await prisma.product.findUniqueOrThrow({ where: { id } })
    await expect(write(id, `attr_${key}`, 'SYNTHETIC-DRAFT', before.version)).rejects.toThrow()
    const after = await listing(id)
    expect(after.overrideData).toEqual(before.overrideData)
    expect(after.version).toBe(before.version)
    expect(await prisma.product.findUniqueOrThrow({ where: { id } })).toEqual(productBefore)
  }),
)

it.each(['externally_assigned_product_identifier', 'externally_assigned_product_identifier__type'])(
  'a direct %s draft leaves real product/listing identities and observed data unchanged', key => scoped(async () => {
    const id = await fixture()
    const parent = await prisma.product.create({ data: { sku: `DRAFT-RELATION-PARENT-${serial}`, name: 'Original parent', isParent: true, basePrice: 29, productType: 'E2E_DRAFT_COAT' } })
    await prisma.product.update({ where: { id }, data: { parentId: parent.id } })
    const before = await prisma.channelListing.update({ where: { id: (await listing(id)).id }, data: {
      externalParentId: 'SYNTHETIC-PARENT-ASIN', flatFileSnapshot: { item_sku: 'SYNTHETIC-SELLER-SKU', parent_sku: 'SYNTHETIC-PARENT-SKU' },
      lastSyncedAt: new Date('2026-01-01T00:00:00Z'),
    } })
    const offer = await prisma.offer.create({ data: { channelListingId: before.id, fulfillmentMethod: 'FBM', sku: 'SYNTHETIC-SELLER-SKU', price: 29, quantity: 4 } })
    const productBefore = await prisma.product.findUniqueOrThrow({ where: { id } })
    const answer = await write(id, `attr_${key}`, 'SYNTHETIC-DRAFT', before.version)
    expect(answer.errors ?? []).toEqual([])
    const after = await listing(id)
    expect(after.overrideData).toEqual({ [key]: 'SYNTHETIC-DRAFT' })
    expect(after.version).toBe(before.version + 1)
    expect(await prisma.product.findUniqueOrThrow({ where: { id } })).toEqual(productBefore)
    expect(await prisma.offer.findUniqueOrThrow({ where: { id: offer.id } })).toEqual(offer)
    // Only the draft bag, its version and edit time can change. This compares every other listing field.
    expect({ ...after, overrideData: before.overrideData, version: before.version, updatedAt: before.updatedAt }).toEqual(before)
    const reloaded = (await read(id)).rows.find(row => row.id === id)!
    expect(reloaded.values[key]).toMatchObject({ value: 'SYNTHETIC-DRAFT', editable: true, writable: true, writeBlockedReason: null })
    expect(reloaded.values[key].mapped?.warnings).toContain(`${key.split('__')[0]} cannot be edited on an existing Amazon listing. You can save a draft here, but cannot publish this change.`)
  }),
)

it('keeps an immutable companion warning inside its own product type on a mixed-type sheet', () => scoped(async () => {
  const root = 'externally_assigned_product_identifier', key = root
  const types = ['E2E_RELATION_LOCKED', 'E2E_RELATION_EDITABLE']
  for (const [index, productType] of types.entries()) {
    await prisma.categorySchema.create({ data: { channel: 'AMAZON', marketplace: 'IT', productType, schemaVersion: 'mixed-draft-fixture', expiresAt: new Date('2099-01-01'),
      schemaDefinition: { type: 'object', properties: { [root]: attribute({ value: { type: 'string', editable: true },
        ...(index === 0 ? { type: { type: 'string', editable: false } } : {}) }) } } } })
  }
  const parent = await prisma.product.create({ data: { sku: 'E2E-MIXED-DRAFT-PARENT', name: 'Mixed draft types', isParent: true, basePrice: 29, productType: types[0] } })
  const children: string[] = []
  for (const [index, productType] of types.entries()) {
    const child = await prisma.product.create({ data: { sku: `E2E-MIXED-DRAFT-${index}`, name: `Mixed type ${index}`, parentId: parent.id, basePrice: 29, productType } })
    children.push(child.id)
    await prisma.channelListing.create({ data: { productId: child.id, channel: 'AMAZON', marketplace: 'IT', channelMarket: 'AMAZON_IT', region: 'EU', channelConnectionId: account,
      externalListingId: `SYNTHETIC-MIXED-${index}`, overrideData: { [key]: 'Draft parent SKU' } } })
  }
  const sheet = await read(parent.id)
  const locked = sheet.rows.find(row => row.id === children[0])!, editable = sheet.rows.find(row => row.id === children[1])!
  const message = `${root} cannot be edited on an existing Amazon listing. You can save a draft here, but cannot publish this change.`
  for (const row of [locked, editable]) expect(row.values[key], JSON.stringify({ type: row.productType, isParent: row.isParent, reason: row.values[key].writeBlockedReason,
    column: sheet.columns.find(column => column.key === key) })).toMatchObject({ value: 'Draft parent SKU', editable: true, writable: true })
  expect(locked.values[key].mapped?.warnings).toContain(message)
  expect(locked.readiness.issues).toContainEqual(expect.objectContaining({ key, message, severity: 'warn' }))
  expect(editable.values[key].mapped?.warnings ?? []).not.toContain(message)
  expect(editable.readiness.issues.some(issue => issue.key === key && issue.message === message)).toBe(false)
}))
