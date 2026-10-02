/**
 * MCP full control L6 — create-draft-listings, remove-draft-listings and set-listing-fields, run through the one door
 * (call-tool.ts) against a real PostgreSQL with the production schema and business-isolation policies (PGlite), on the
 * services the product sheet uses (`ensureDraftListings`, `applyProductBulkEdits`, the family projection writers).
 *
 * Proven here: a dry run writes nothing; drafts are started inert, for the whole family, as approved, and refused when the
 * set changed since; only untouched drafts are removed; a listing's own attributes are set and reset, and stock, price and
 * content are refused here; which variations a listing includes changes and changes back; each undo asks for the inverse
 * request of a registered tool.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'

const state = vi.hoisted(() => ({ database: null as any, refreshMany: null as any }))
// The package itself, as the product sheet's own suites do: some readers on these paths import it directly.
vi.mock('@nexus/database', async (original) => {
  const { formulaDatabase } = await import('../../../test-support/formula-database.js')
  state.database = await formulaDatabase()
  return { ...(await original<object>()), default: state.database.client }
})
vi.mock('../../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn() }))
vi.mock('../../product-event.service.js', () => ({ productEventService: { emit: vi.fn(), emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('../../product-read-cache.service.js', () => {
  state.refreshMany = vi.fn(async () => [])
  return { productReadCacheService: { refresh: vi.fn(), refreshMany: state.refreshMany, refreshInTransaction: vi.fn() }, FACE_IMAGE_ORDER_BY: [], FACE_IMAGE_SELECT: {}, pickFaceImage: () => null }
})
vi.mock('../../pim/readiness-index.service.js', async () => (await import('../../../test-support/readiness-module-mock.js')).readinessModuleMock(vi.fn()))
/** A controlled Amazon product type: two attributes (color, brand) and the fulfilment selector. */
const AMAZON_DEFINITION = vi.hoisted(() => {
  const attribute = () => ({ type: 'array', minUniqueItems: 1, maxUniqueItems: 1, items: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } })
  // A measure (2026-10-02, GALE on Amazon SE): { value, unit } with the units Amazon takes.
  const measure = () => ({ type: 'array', minUniqueItems: 1, maxUniqueItems: 1, items: { type: 'object', required: ['value', 'unit'],
    properties: { value: { type: 'number' }, unit: { type: 'string', enum: ['kilograms', 'grams'] } } } })
  return { type: 'object', properties: { item_name: attribute(), brand: attribute(), color: attribute(), item_package_weight: measure(),
    fulfillment_availability: { type: 'array', selectors: ['fulfillment_channel_code'], minUniqueItems: 1, maxUniqueItems: 1, items: { type: 'object', required: ['fulfillment_channel_code'],
      properties: { fulfillment_channel_code: { type: 'string', enum: ['AMAZON_EU', 'DEFAULT'] }, quantity: { type: 'integer', minimum: 0 } } } } } }
})
vi.mock('../../categories/seller-schema.service.js', async () => {
  const { amazonSpecFromDefinition } = await import('../../pim/channel-specs/amazon.js')
  return { amazonSellerSpec: async (_account: string, marketplace: string, productType: string) => amazonSpecFromDefinition({ marketplace, productType, fetchedAt: new Date(), schemaVersion: 'fixture', schemaDefinition: AMAZON_DEFINITION }) }
})

import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'
import { callTool, executeTool, type UserPrincipal } from '../call-tool.js'
import { getTool } from '../tool-registry.js'

const A = LEGACY_WORKSPACE_ID
const business = { workspaceId: A, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const person = (userId: string): UserPrincipal => ({
  kind: 'user', userId, label: userId,
  permissions: { isOwner: false, permissions: new Set([...Object.values(FEATURES), ...Object.values(FIELDS)]) },
  workspace: business, via: 'claude',
})
const claude = person('u-l6-asker')
const approver = person('u-l6-approver')
type Json = Record<string, any>
const db = () => state.database.client

const dryRun = async (tool: string, args: Json) => (await inside(() => callTool(claude, tool, args))).raw as Json
async function approveAndRun(tool: string, args: Json) {
  const preview = await dryRun(tool, args)
  expect(preview.ok, preview.error).toBe(true)
  const ran = (await inside(() => executeTool(approver, tool, args, { approvedPreview: JSON.parse(JSON.stringify(preview.preview)), via: 'claude' }))).raw as Json
  return { preview: preview.preview as Json, ran }
}
const listingsOf = (productIds: string[], channel = 'AMAZON') => inside(() => db().channelListing.findMany({ where: { productId: { in: productIds }, channel }, orderBy: { productId: 'asc' } }))

const ids: Record<string, string> = {}
const accounts: Record<string, string> = {}
async function family(key: string) {
  ids[key] = (await db().product.create({ data: { sku: `TEST-SKU-${key}`, name: key, basePrice: 10, isParent: true, productType: 'OUTERWEAR', variationAxes: ['Size'] } as never })).id
  for (const v of ['M', 'L']) ids[`${key}${v}`] = (await db().product.create({ data: { sku: `TEST-SKU-${key}-${v}`, name: `${key} ${v}`, basePrice: 10, parentId: ids[key], productType: 'OUTERWEAR', variantAttributes: { Size: v } } as never })).id
}
const members = (key: string) => [ids[key], ids[`${key}M`], ids[`${key}L`]]
const amazonSE = { channel: 'AMAZON', market: 'SE' }

beforeAll(async () => {
  await inside(async () => {
    await db().marketplace.create({ data: { channel: 'AMAZON', code: 'SE', name: 'Sweden', currency: 'SEK', region: 'EU', language: 'sv', languages: ['sv'], marketplaceId: 'FAKE-SE-ID' } as never })
    accounts.amazon = (await db().channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'Test Amazon', isActive: true, isPrimary: true, externalAccountId: 'TEST-L6-SELLER' } as never })).id
    await db().categorySchema.create({ data: { channel: 'AMAZON', marketplace: 'SE', productType: 'OUTERWEAR', schemaVersion: 'fixture', schemaDefinition: AMAZON_DEFINITION as never, expiresAt: new Date('2099-01-01') } })
    for (const key of ['DRAFTS', 'RACE', 'REMOVE', 'FIELDS', 'VARIANTS']) await family(key)
  })
}, 120_000)
afterAll(async () => { await state.database?.close() }, 30_000)
beforeEach(() => { state.refreshMany.mockClear() })

describe('create-draft-listings', () => {
  it('previews the family\'s drafts without writing; runs as approved: parent and variants, inert', async () => {
    const preview = await dryRun('create-draft-listings', { productId: ids.DRAFTSM, ...amazonSE })
    expect(preview.preview).toMatchObject({ destination: { channel: 'AMAZON', market: 'SE', accountId: accounts.amazon, accountLabel: 'Test Amazon' },
      create: [{ sku: 'TEST-SKU-DRAFTS' }, { sku: 'TEST-SKU-DRAFTS-L' }, { sku: 'TEST-SKU-DRAFTS-M' }], alreadyListed: 0 })
    expect(await listingsOf(members('DRAFTS'))).toEqual([])
    const { ran } = await approveAndRun('create-draft-listings', { productId: ids.DRAFTSM, ...amazonSE })
    expect(ran.ok, ran.error).toBe(true)
    const rows = await listingsOf(members('DRAFTS'))
    expect(rows).toHaveLength(3)
    for (const row of rows) expect(row).toMatchObject({ marketplace: 'SE', channelConnectionId: accounts.amazon, listingStatus: 'DRAFT', isPublished: false, syncPaused: true, externalListingId: null, price: null, quantity: null })
    expect(state.refreshMany).toHaveBeenCalledWith(expect.arrayContaining(members('DRAFTS')))
    // Undo removes exactly those drafts, while untouched.
    const tool = getTool('create-draft-listings')!
    expect(await inside(() => tool.undo!.current(ran.change))).toEqual(ran.change.after)
    expect(tool.undo!.request(ran.change)).toEqual({ tool: 'remove-draft-listings', args: { listingIds: ran.change.after.listings.map((l: Json) => l.id) } })
    // Nothing more to start: refused.
    expect(await dryRun('create-draft-listings', { productId: ids.DRAFTS, ...amazonSE })).toMatchObject({ ok: false, error: expect.stringContaining('already has a listing there') })
  })

  it('refuses when the drafts it would start changed since the approval, and creates nothing', async () => {
    const preview = await dryRun('create-draft-listings', { productId: ids.RACE, ...amazonSE })
    // A variant gets its own listing meanwhile: the run would start another set.
    await inside(() => db().channelListing.create({ data: { productId: ids.RACEM, channel: 'AMAZON', marketplace: 'SE', channelMarket: 'AMAZON_SE', region: 'SE', channelConnectionId: accounts.amazon, listingStatus: 'DRAFT', isPublished: false, syncPaused: true } }))
    const ran = (await inside(() => executeTool(approver, 'create-draft-listings', { productId: ids.RACE, ...amazonSE }, { approvedPreview: preview.preview }))).raw as Json
    expect(ran).toMatchObject({ ok: false, error: expect.stringContaining('changed since it was approved') })
    expect((await listingsOf(members('RACE'))).map((r: Json) => r.productId)).toEqual([ids.RACEM])
  })

  it('a market that is not active here is refused by the creator\'s own sentence', async () => {
    expect(await dryRun('create-draft-listings', { productId: ids.RACE, channel: 'AMAZON', market: 'XX' })).toMatchObject({ ok: false, error: expect.stringContaining('is not an active market in this business') })
  })
})

describe('remove-draft-listings', () => {
  it('removes untouched drafts only; its undo starts them again', async () => {
    await approveAndRun('create-draft-listings', { productId: ids.REMOVE, ...amazonSE })
    const rows = await listingsOf(members('REMOVE'))
    // One draft holds a value of its own; one listing is live.
    await inside(() => db().channelListing.update({ where: { id: rows[1].id }, data: { overrideData: { note: 'own value' } } }))
    await inside(() => db().channelListing.update({ where: { id: rows[2].id }, data: { listingStatus: 'ACTIVE', isPublished: true } }))
    const refused = await dryRun('remove-draft-listings', { listingIds: rows.map((r: Json) => r.id) })
    expect(refused).toMatchObject({ ok: false })
    expect(refused.error).toContain('values of its own')
    expect(refused.error).toContain('not a draft')
    const { ran } = await approveAndRun('remove-draft-listings', { listingIds: [rows[0].id] })
    expect(ran.ok, ran.error).toBe(true)
    expect((await listingsOf(members('REMOVE'))).map((r: Json) => r.id)).toEqual([rows[1].id, rows[2].id])
    const tool = getTool('remove-draft-listings')!
    expect(await inside(() => tool.undo!.current(ran.change))).toEqual(ran.change.after)
    expect(tool.undo!.request(ran.change)).toEqual({ tool: 'create-draft-listings', args: { productId: ids.REMOVE, channel: 'AMAZON', market: 'SE', accountId: accounts.amazon } })
  })
})

describe('set-listing-fields', () => {
  it('sets a listing\'s own attribute and makes it follow the product again; undo puts it back', async () => {
    const base = { productId: ids.FIELDSM, ...amazonSE }
    expect(await dryRun('set-listing-fields', { ...base, values: { attr_color: 'Nero' } })).toMatchObject({ ok: false, error: expect.stringContaining('create-draft-listings') })
    await approveAndRun('create-draft-listings', { productId: ids.FIELDS, ...amazonSE })
    const set = await approveAndRun('set-listing-fields', { ...base, values: { attr_color: 'Nero' } })
    expect(set.preview).toMatchObject({ destination: { accountId: accounts.amazon }, changes: [{ key: 'attr_color', fromOwn: false, to: 'Nero' }] })
    expect(set.ran.ok, set.ran.error).toBe(true)
    expect(set.ran.change.after).toMatchObject({ kind: 'values', values: { attr_color: { value: 'Nero', own: true } } })
    const tool = getTool('set-listing-fields')!
    // Before, it followed the product: undo makes it follow again.
    expect(tool.undo!.request(set.ran.change)).toMatchObject({ tool: 'set-listing-fields', args: { productId: ids.FIELDSM, channel: 'AMAZON', market: 'SE', reset: ['attr_color'] } })
    expect(await inside(() => tool.undo!.current(set.ran.change))).toEqual(set.ran.change.after)
    // product-content lists the key without the sheet's prefix: that names the same attribute.
    const reset = await approveAndRun('set-listing-fields', { ...base, reset: ['color'] })
    expect(reset.ran.ok, reset.ran.error).toBe(true)
    expect(reset.ran.change.after).toMatchObject({ values: { attr_color: { own: false } } })
    expect(tool.undo!.request(reset.ran.change)).toMatchObject({ args: { values: { attr_color: 'Nero' } } })
  })

  it('sets a measure as { value, unit }; a bare number is refused', async () => {
    const base = { productId: ids.FIELDSM, ...amazonSE }
    const set = await approveAndRun('set-listing-fields', { ...base, values: { item_package_weight: { value: 2, unit: 'kilograms' } } })
    expect(set.ran.ok, set.ran.error).toBe(true)
    expect(set.ran.change.after).toMatchObject({ kind: 'values', values: { attr_item_package_weight: { value: { value: 2, unit: 'kilograms' }, own: true } } })
    expect(await dryRun('set-listing-fields', { ...base, values: { item_package_weight: 2 } }))
      .toMatchObject({ ok: false, error: expect.stringContaining('send { value, unit }') })
    // P1 (value-verdict): a unit off the list is stored with a finding, and the publish review blocks it.
    expect(await dryRun('set-listing-fields', { ...base, values: { item_package_weight: { value: 2, unit: 'stones' } } })).toMatchObject({ ok: true })
  })

  it('refuses stock, price, content and unknown keys, and two kinds of change at once', async () => {
    const base = { productId: ids.FIELDSM, ...amazonSE }
    for (const key of ['attr_fulfillment_availability', 'ebay_quantity', 'amazon_title']) {
      expect((await dryRun('set-listing-fields', { ...base, values: { [key]: 'x' } })).error).toContain('only listing attributes')
    }
    expect((await dryRun('set-listing-fields', { ...base, values: { attr_nothing_here: 'x' } })).error).toContain('not an attribute of this listing')
    expect((await dryRun('set-listing-fields', { ...base, values: { attr_color: 'x' }, variationTheme: 'SIZE' })).error).toContain('one kind of change at a time')
  })

  it('changes which variations a listing includes, and back', async () => {
    await approveAndRun('create-draft-listings', { productId: ids.VARIANTS, ...amazonSE })
    const args = { productId: ids.VARIANTS, ...amazonSE, variants: { exclude: [ids.VARIANTSL] } }
    const { preview, ran } = await approveAndRun('set-listing-fields', args)
    expect(preview).toMatchObject({ variants: [{ sku: 'TEST-SKU-VARIANTS-L', included: { from: true, to: false } }] })
    expect(ran.ok, ran.error).toBe(true)
    expect(ran.change.after).toEqual({ coordinate: expect.anything(), kind: 'variants', included: { [ids.VARIANTSL]: false } })
    const tool = getTool('set-listing-fields')!
    const undo = tool.undo!.request(ran.change) as Json
    expect(undo).toEqual({ tool: 'set-listing-fields', args: { productId: ids.VARIANTS, channel: 'AMAZON', market: 'SE', accountId: accounts.amazon, variants: { include: [ids.VARIANTSL], exclude: [] } } })
    expect((await approveAndRun('set-listing-fields', undo.args)).ran.ok).toBe(true)
    expect(await inside(() => tool.undo!.current(ran.change))).toEqual({ ...ran.change.after, included: { [ids.VARIANTSL]: true } })
  })

  it('a variation theme is Amazon\'s; another business\'s product is not found', async () => {
    expect((await dryRun('set-listing-fields', { productId: ids.FIELDS, channel: 'EBAY', market: 'SE', variationTheme: 'SIZE' })).error).toContain('no listing here yet')
    expect(await dryRun('set-listing-fields', { productId: 'no-such-product', ...amazonSE, values: { attr_color: 'x' } })).toEqual({ ok: false, error: 'Product not found' })
  })
})
