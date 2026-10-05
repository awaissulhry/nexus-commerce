/**
 * S9 — the writes of the per-channel SKU (plan docs/sheet-ids-sku-rows/PLAN.md), through the real product bulk writer
 * (`applyProductBulkEdits`, the writer behind the sheet and the set-* tools) on PGlite with the production schema,
 * row-level security policies and the shared-stock triggers:
 *   1. a SHARED SKU rename keeps every listing a channel holds on OLD (Amazon EU markets each on their own), drafts
 *      follow NEW, own SKUs are untouched; NEW is checked against other products' SKUs and channel SKUs (both ways),
 *      and against the other renames of the save; a product connected to shared stock is refused in one sentence;
 *   2. the channel-SKU field (`channel_sku`) of a channel scope: drafts and deleted listings take any SKU, a held listing
 *      only the SKU it holds (the live-move rule, until S10), version conflict, history, another business never read;
 *   3. the Shopify sheet's SKU column (`listing_sku`) writes the listing's own SKU through the same writer.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

vi.setConfig({ testTimeout: 60_000 })
let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', async () => {
  const { contextualDatabase } = await import('../../lib/database-context.js')
  let wrapped: object | null = null
  return {
    default: new Proxy({}, {
      get: (_target, property) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), property),
    }),
  }
})
vi.mock('../../lib/queue.js', () => ({
  outboundSyncQueue: null, channelSyncQueue: null, bulkJobQueue: null, redis: null,
  searchIndexQueue: null, readCacheQueue: null, readinessQueue: null,
  addJobSafely: vi.fn(async () => ({ enqueued: false })),
}))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn() } }))
vi.mock('../pim/readiness-index.service.js', async () => (await import('../../test-support/readiness-module-mock.js')).readinessModuleMock(vi.fn()))
// The Shopify column contract reads the store's schema: the information fixture, no Shopify call.
vi.mock('../shopify/admin-client.js', async importOriginal => ({ ...await importOriginal<any>(), shopifyAdmin: async () => ({ graphql: async () => { throw new Error('no Shopify call in this test') } }) }))
vi.mock('../shopify/linked-products-gateway.js', async importOriginal => ({ ...await importOriginal<any>(), readLinkedStoreSchema: async () => (await import('../../test-support/information-shopify-fixture.js')).informationShopifySchema }))

import { applyProductBulkEdits, ProductBulkError } from '../products/bulk-edit.service.js'
import { applyProductBulkSave } from '../products/bulk-save.service.js'
import { ChannelSkuError, setChannelSku } from './channel-sku.js'
import { ebayInventoryMoveRefusal } from './channel-sku-live-move.js'
import { amazonMainRowMove, etsySkuMoveSentence } from '@nexus/shared/publish-actions'

const A = LEGACY_WORKSPACE_ID
const B = 'ws_s9_writes_bravo'
const LENDER = 'ws_s9_writes_lender'
const inside = <T>(workspaceId: string, work: () => Promise<T>) => withWorkspace({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const db = () => database.client

const acc: Record<string, string> = {}
const pid: Record<string, string> = {}
const lid: Record<string, string> = {}
const HELD = { listingStatus: 'ACTIVE', isPublished: true }
const DRAFT = { listingStatus: 'DRAFT', isPublished: false, externalListingId: null }

type Answer = { success?: boolean; updated?: number; errors?: Array<{ id: string; field: string; error: string }>; currentVersion?: number; versionOf?: string
  skuRenames?: Array<{ productId: string; from: string; to: string; summary: string; listings: Array<{ listingId: string; outcome: string; sku: string | null }> }>
  dryRun?: boolean; wouldUpdate?: number }
const context = { formulaCascade: false, userId: 'tester-s9', logger: { warn: () => {}, error: () => {} } }
/** The writer's answer, or a refused request's details with its status. */
async function save(input: Parameters<typeof applyProductBulkEdits>[0], workspaceId = A): Promise<Answer & { status?: number; code?: string; error?: string }> {
  try { return await inside(workspaceId, () => applyProductBulkEdits(input, context)) as Answer }
  catch (error) {
    if (error instanceof ProductBulkError) return { status: error.statusCode, ...(error.details as object) }
    throw error
  }
}
const rename = (changes: Array<[string, string]>, extra: { dryRun?: boolean } = {}, workspaceId = A) =>
  save({ changes: changes.map(([sku, to]) => ({ id: pid[sku], field: 'sku', value: to })), ...extra }, workspaceId)
const ownSku = (listing: string, sku: string | null, channel: string, marketplace: string, extra: { expectedVersion?: number; dryRun?: boolean; reset?: boolean; field?: string; productSku?: string } = {}) =>
  save({ changes: [{ id: pid[extra.productSku ?? listing], field: extra.field ?? 'channel_sku', value: sku, target: 'channel', ...(extra.reset ? { intent: 'reset' as const } : {}) }],
    marketplaceContexts: [{ channel: channel as never, marketplace, accountId: acc[channel], aliasKey: '' }],
    ...(extra.expectedVersion !== undefined ? { expectedVersion: extra.expectedVersion } : {}), ...(extra.dryRun ? { dryRun: true } : {}) })
const row = (name: string) => inside(A, () => db().channelListing.findUniqueOrThrow({ where: { id: lid[name] },
  select: { channelSku: true, liveChannelSku: true, version: true, platformAttributes: true } }))
const productSku = async (name: string, workspaceId = A) => (await inside(workspaceId, () => db().product.findUniqueOrThrow({ where: { id: pid[name] } }))).sku

async function product(sku: string, data: Record<string, unknown> = {}) {
  pid[sku] = (await db().product.create({ data: { sku, name: sku, basePrice: '10.00', ...data } as never })).id
  return pid[sku]
}
async function listing(name: string, productSkuName: string, channel: string, marketplace: string, data: Record<string, unknown> = {}, offers: Array<{ sku: string; isActive: boolean }> = []) {
  const created = await db().channelListing.create({ data: {
    productId: pid[productSkuName], channel, marketplace, region: marketplace, channelMarket: `${channel}_${marketplace}`, channelConnectionId: acc[channel], aliasKey: '',
    externalListingId: `${name}-EXT`, ...HELD, ...data,
  } as never })
  for (const offer of offers) await db().offer.create({ data: { channelListingId: created.id, sku: offer.sku, fulfillmentMethod: 'FBM', isActive: offer.isActive } })
  lid[name] = created.id
  return created.id
}

beforeAll(async () => {
  database = await formulaDatabase()
  for (const [id, name] of [[B, 'Bravo S9'], [LENDER, 'Lender S9']]) {
    await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $2, 'active', 's9', $1, CURRENT_TIMESTAMP)`, [id, name])
  }
  await inside(A, async () => {
    for (const [channel, code] of [['AMAZON', 'DE'], ['AMAZON', 'IT'], ['AMAZON', 'FR'], ['EBAY', 'IT'], ['SHOPIFY', 'GLOBAL'], ['ETSY', 'GLOBAL']]) {
      await db().marketplace.create({ data: { channel, code, name: `${channel} ${code}`, currency: 'EUR', region: code === 'GLOBAL' ? 'GLOBAL' : 'EU', language: 'it', languages: ['it'], marketplaceId: `S9_${channel}_${code}` } as never })
    }
    for (const channel of ['AMAZON', 'EBAY', 'SHOPIFY', 'ETSY']) {
      acc[channel] = (await db().channelConnection.create({ data: { channelType: channel, accountLabel: `s9-${channel}`, externalAccountId: `s9-${channel}`, isActive: true, isPrimary: true } as never })).id
    }
    // 1. The rename: Amazon DE + IT held (two EU markets), FR a draft; eBay IT held; Shopify a draft with its own SKU.
    await product('R-1')
    await listing('r1DE', 'R-1', 'AMAZON', 'DE')
    await listing('r1IT', 'R-1', 'AMAZON', 'IT')
    await listing('r1FR', 'R-1', 'AMAZON', 'FR', DRAFT)
    await listing('r1EB', 'R-1', 'EBAY', 'IT')
    await listing('r1SH', 'R-1', 'SHOPIFY', 'GLOBAL', { ...DRAFT, channelSku: 'R-1-SHOP' })
    // A listing Deleted back to a draft: its flat-file copy and offer still name OLD (the Delete defect).
    await product('R-2')
    await listing('r2DE', 'R-2', 'AMAZON', 'DE', { ...DRAFT, flatFileSnapshot: { item_sku: 'R-2' } }, [{ sku: 'R-2', isActive: true }])
    // Uniqueness: another product's own channel SKU, confirmed SKU and offer SKU; a product SKU differing only in case.
    await product('U-OTHER')
    await listing('uOwn', 'U-OTHER', 'AMAZON', 'DE', { channelSku: 'U-TAKEN' })
    await listing('uLive', 'U-OTHER', 'EBAY', 'IT', { liveChannelSku: 'U-LIVE' })
    await listing('uOffer', 'U-OTHER', 'AMAZON', 'IT', {}, [{ sku: 'U-OFFER', isActive: false }])
    await product('U-CASE')
    await product('U-MOVE')
    await product('S-A')
    await product('S-B')
    await listing('sbDE', 'S-B', 'AMAZON', 'DE')
    // 2. The channel-SKU field.
    await product('W-DRAFT'); await listing('wDraft', 'W-DRAFT', 'AMAZON', 'DE', DRAFT)
    await product('W-DELETED'); await listing('wDeleted', 'W-DELETED', 'AMAZON', 'DE', { ...DRAFT, flatFileSnapshot: { item_sku: 'W-DELETED' } }, [{ sku: 'W-DELETED', isActive: true }])
    await product('W-HELD'); await listing('wHeld', 'W-HELD', 'AMAZON', 'DE')
    await product('W-KEPT'); await listing('wKept', 'W-KEPT', 'EBAY', 'IT', { channelSku: 'W-KEPT-OLD', liveChannelSku: 'W-KEPT-OLD' })
    await product('W-CROSS'); await listing('wCross', 'W-CROSS', 'AMAZON', 'DE', DRAFT)
    // S10 — per channel: an Amazon family (its main row cannot move, a variation can); an eBay Inventory item; Etsy.
    await product('W-FAM', { isParent: true }); await product('W-FAM-C', { parentId: pid['W-FAM'] })
    await listing('wFam', 'W-FAM', 'AMAZON', 'DE'); await listing('wFamC', 'W-FAM-C', 'AMAZON', 'DE')
    await product('W-INV'); await listing('wInv', 'W-INV', 'EBAY', 'IT', { platformAttributes: { offerId: 'OFFER-1' } })
    await product('W-ETSY'); await listing('wEtsy', 'W-ETSY', 'ETSY', 'GLOBAL')
    // 3. The Shopify SKU column.
    await product('SH-DRAFT'); await listing('shDraft', 'SH-DRAFT', 'SHOPIFY', 'GLOBAL', { ...DRAFT, platformAttributes: { sku: 'SH-OLD-COPY' } })
    await product('SH-HELD'); await listing('shHeld', 'SH-HELD', 'SHOPIFY', 'GLOBAL', { liveChannelSku: 'SH-HELD-LIVE', channelSku: 'SH-HELD-LIVE' })
    // Shared stock: P-POOL sells from the lender's stock (a SKU link).
    await product('P-POOL')
  })
  // Another business: the same SKUs are legal there, and its listings are never read.
  await inside(B, async () => {
    const other = (await db().channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 's9-bravo', externalAccountId: 's9-bravo', isActive: true, isPrimary: true } as never })).id
    const p = await db().product.create({ data: { sku: 'B-ONLY', name: 'Bravo', basePrice: '1.00' } as never })
    pid['B-ONLY'] = p.id
    await db().channelListing.create({ data: { productId: p.id, channel: 'AMAZON', marketplace: 'DE', region: 'DE', channelMarket: 'AMAZON_DE', channelConnectionId: other,
      aliasKey: '', ...HELD, externalListingId: 'B-EXT', channelSku: 'CROSS-1', liveChannelSku: 'B-HELD-CH' } as never })
  })
  // The shared-stock link, written as the lender and borrower would have (the link guard is not what this test is about).
  const lenderProduct = randomUUID(), grant = randomUUID()
  await database.db.query(`SET session_replication_role = replica`)
  await database.db.query(`INSERT INTO "Product" (id, "workspaceId", sku, name, "basePrice", "updatedAt") VALUES ($1, $2, 'P-POOL', 'P-POOL', 10, CURRENT_TIMESTAMP)`, [lenderProduct, LENDER])
  await database.db.query(`INSERT INTO "StockPoolGrant" (id, "ownerWorkspaceId", "workspaceId", "locationIds", status, "createdByUserId", "updatedAt") VALUES ($1, $2, $3, '{s9-location}', 'active', 's9', CURRENT_TIMESTAMP)`, [grant, LENDER, A])
  await database.db.query(`INSERT INTO "StockPoolLink" (id, "workspaceId", "grantId", sku, "productId", "sourceProductId", status, "updatedAt") VALUES ($1, $2, $3, 'P-POOL', $4, $5, 'active', CURRENT_TIMESTAMP)`, [randomUUID(), A, grant, pid['P-POOL'], lenderProduct])
  await database.db.query(`SET session_replication_role = origin`)
}, 180_000)

afterAll(async () => {
  await database?.close()
}, 30_000)

describe('S9 — a SHARED SKU rename keeps the channels in step (no refusal)', () => {
  it('the preview says which listings keep OLD and writes nothing', async () => {
    const before = await row('r1DE')
    const out = await rename([['R-1', 'R-1N']], { dryRun: true })
    expect(out).toMatchObject({ dryRun: true, wouldUpdate: 1, errors: [] })
    expect(out.skuRenames).toEqual([expect.objectContaining({ productId: pid['R-1'], from: 'R-1', to: 'R-1N',
      summary: 'Amazon · DE, Amazon · IT and eBay · IT keep R-1; the draft follows R-1N. Shopify · GLOBAL keeps its own SKU R-1-SHOP.' })])
    expect(await productSku('R-1')).toBe('R-1')
    expect(await row('r1DE')).toEqual(before)
  })

  it('held listings keep OLD (each Amazon EU market on its own, eBay too), the draft follows NEW, an own SKU is untouched', async () => {
    const versions = { de: (await row('r1DE')).version, fr: (await row('r1FR')).version, sh: (await row('r1SH')).version }
    const out = await rename([['R-1', 'R-1N']])
    expect(out).toMatchObject({ success: true, updated: 1 })
    expect(out.errors ?? []).toEqual([])
    expect(out.skuRenames?.[0].summary).toBe('Amazon · DE, Amazon · IT and eBay · IT keep R-1; the draft follows R-1N. Shopify · GLOBAL keeps its own SKU R-1-SHOP.')
    expect(await productSku('R-1')).toBe('R-1N')
    for (const name of ['r1DE', 'r1IT', 'r1EB']) expect(await row(name)).toMatchObject({ channelSku: 'R-1', liveChannelSku: 'R-1' })
    expect((await row('r1DE')).version).toBe(versions.de + 1)
    // The draft follows the product SKU: nothing written on it.
    expect(await row('r1FR')).toMatchObject({ channelSku: null, liveChannelSku: null, version: versions.fr })
    expect(await row('r1SH')).toMatchObject({ channelSku: 'R-1-SHOP', version: versions.sh })
    const history = await inside(A, () => db().channelListingOverride.findMany({ where: { channelListingId: lid.r1DE, fieldName: 'channelSku' } }))
    expect(history).toEqual([expect.objectContaining({ previousValue: null, newValue: 'R-1', changedBy: 'tester-s9', reason: 'Keeps R-1: the product SKU was renamed R-1 → R-1N' })])
  })

  it('both ways: no other product may take OLD while a listing keeps it, and a listing may not take another product\'s SKU', async () => {
    const out = await rename([['U-MOVE', 'r-1']])
    expect(out.errors).toEqual([{ id: pid['U-MOVE'], field: 'sku', error: 'r-1 is the SKU of R-1N on Amazon · DE. One SKU names one product: choose another SKU.' }])
    expect(await productSku('U-MOVE')).toBe('U-MOVE')
    const refused = await ownSku('wDraft', 'R-1N', 'AMAZON', 'DE', { productSku: 'W-DRAFT' })
    expect(refused.errors?.[0]).toMatchObject({ field: 'channel_sku', error: expect.stringContaining('R-1N is the SKU of another product (R-1N) in this business') })
  })

  it('a listing Deleted back to a draft (its old copies say OLD) follows NEW, and again after a second rename', async () => {
    expect((await rename([['R-2', 'R-2N']])).skuRenames?.[0].summary).toBe('No channel holds R-2: the draft follows R-2N.')
    expect((await row('r2DE')).channelSku).toBe('R-2N')
    pid['R-2N'] = pid['R-2']
    await rename([['R-2N', 'R-2X']])
    expect((await row('r2DE')).channelSku).toBe('R-2X')
  })

  it('NEW is refused when it is another product\'s channel SKU — own, confirmed or an old offer — or its SKU in another case', async () => {
    for (const [taken, where] of [['u-taken', 'Amazon · DE'], ['U-LIVE', 'eBay · IT'], ['u-offer', 'Amazon · IT']]) {
      expect((await rename([['U-MOVE', taken]])).errors).toEqual([{ id: pid['U-MOVE'], field: 'sku', error: `${taken} is the SKU of U-OTHER on ${where}. One SKU names one product: choose another SKU.` }])
    }
    expect((await rename([['U-MOVE', 'u-case']])).errors).toEqual([{ id: pid['U-MOVE'], field: 'sku', error: 'SKU "u-case" is already used by another product (U-CASE). One SKU names one product: choose another SKU.' }])
    expect(await productSku('U-MOVE')).toBe('U-MOVE')
  })

  it('two renames in one save may not clash: the same NEW twice, or a SKU the other product keeps on a listing', async () => {
    const twice = await rename([['U-MOVE', 'TWIN-1'], ['U-CASE', 'twin-1']])
    expect(twice.errors).toEqual([{ id: pid['U-CASE'], field: 'sku', error: 'twin-1 is given to two products in this save (U-MOVE and U-CASE). One SKU names one product: choose another SKU for one of them.' }])
    expect([await productSku('U-MOVE'), await productSku('U-CASE')]).toEqual(['TWIN-1', 'U-CASE'])
    // S-B is renamed and its held Amazon listing keeps S-B: S-A cannot take S-B in the same save.
    const swap = await rename([['S-A', 'S-B'], ['S-B', 'S-B2']])
    expect(swap.errors).toEqual([{ id: pid['S-A'], field: 'sku', error: 'S-B stays the SKU of S-B2 on Amazon · DE after its rename in this save. One SKU names one product: choose another SKU.' }])
    expect([await productSku('S-A'), await productSku('S-B')]).toEqual(['S-A', 'S-B2'])
    expect((await row('sbDE')).channelSku).toBe('S-B')
  })

  it('a product connected to shared stock: refused in one plain sentence that says what to do, the rest of the save stored', async () => {
    const out = await save({ changes: [{ id: pid['P-POOL'], field: 'sku', value: 'P-POOL-2' }, { id: pid['P-POOL'], field: 'brand', value: 'Pool brand' }] })
    expect(out.errors).toEqual([{ id: pid['P-POOL'], field: 'sku',
      error: 'P-POOL sells from the stock of Lender S9, and the SKU is what connects them: disconnect it first (Matrix, Stock source), then rename it.' }])
    const after = await inside(A, () => db().product.findUniqueOrThrow({ where: { id: pid['P-POOL'] } }))
    expect([after.sku, after.brand]).toEqual(['P-POOL', 'Pool brand'])
  })

  it('a sheet operation (one unit per row, each in its own savepoint): a rename keeps its listings, a connected one is refused alone', async () => {
    await inside(A, async () => { await product('BS-1'); await listing('bs1DE', 'BS-1', 'AMAZON', 'DE') })
    const out = await inside(A, () => applyProductBulkSave({ units: [
      { key: 'one', changes: [{ id: pid['BS-1'], field: 'sku', value: 'BS-1N' }] },
      { key: 'pool', changes: [{ id: pid['P-POOL'], field: 'sku', value: 'P-POOL-3' }] },
    ] }, context))
    const unit = (key: string) => out.units.find(u => u.key === key)!
    expect(unit('one')).toMatchObject({ status: 200, body: { success: true, skuRenames: [expect.objectContaining({ summary: 'Amazon · DE keeps BS-1.' })] } })
    expect(unit('pool')).toMatchObject({ status: 409, body: { code: 'SKU_RENAME_REFUSED', errors: [{ field: 'sku', error: expect.stringContaining('P-POOL sells from the stock of Lender S9') }] } })
    expect([await productSku('BS-1'), await productSku('P-POOL')]).toEqual(['BS-1N', 'P-POOL'])
    expect(await row('bs1DE')).toMatchObject({ channelSku: 'BS-1', liveChannelSku: 'BS-1' })
  })

  it('a SKU sent as a channel write never renames the product; another business is never read', async () => {
    const out = await save({ changes: [{ id: pid['U-CASE'], field: 'sku', value: 'U-CASE-CH', target: 'channel' }], marketplaceContexts: [{ channel: 'AMAZON', marketplace: 'DE', accountId: acc.AMAZON, aliasKey: '' }] })
    expect(out).toMatchObject({ status: 400, errors: [{ field: 'sku', error: expect.stringContaining('Change the product SKU in the Shared view') }] })
    expect(await productSku('U-CASE')).toBe('U-CASE')
    // Bravo's channel SKU and confirmed SKU are Bravo's: legal here.
    expect((await rename([['U-CASE', 'B-HELD-CH']])).errors ?? []).toEqual([])
    expect(await productSku('B-ONLY', B)).toBe('B-ONLY')
  })
})

describe('S9 — a listing\'s own SKU in a channel scope (`channel_sku`)', () => {
  it('a draft takes its own SKU: version CAS, the listing\'s version answered, a history row', async () => {
    const { version } = await row('wDraft')
    const out = await ownSku('wDraft', 'W-DRAFT-DE', 'AMAZON', 'DE', { expectedVersion: version, productSku: 'W-DRAFT' })
    expect(out).toMatchObject({ success: true, updated: 1, currentVersion: version + 1, versionOf: 'channelListing' })
    expect(await row('wDraft')).toMatchObject({ channelSku: 'W-DRAFT-DE', version: version + 1 })
    const history = await inside(A, () => db().channelListingOverride.findMany({ where: { channelListingId: lid.wDraft, fieldName: 'channelSku' } }))
    expect(history).toEqual([expect.objectContaining({ previousValue: null, newValue: 'W-DRAFT-DE', reason: 'Product sheet', changedBy: 'tester-s9' })])
    // The same value again is a no-op that spends no version.
    expect(await ownSku('wDraft', 'W-DRAFT-DE', 'AMAZON', 'DE', { expectedVersion: version + 1, productSku: 'W-DRAFT' })).toMatchObject({ success: true, updated: 0, currentVersion: version + 1 })
  })

  it('a stale version is a 409 with the listing\'s version; nothing written', async () => {
    const { version } = await row('wDraft')
    const out = await ownSku('wDraft', 'W-DRAFT-OTHER', 'AMAZON', 'DE', { expectedVersion: version - 1, productSku: 'W-DRAFT' })
    expect(out).toMatchObject({ status: 409, code: 'VERSION_CONFLICT', currentVersion: version, versionOf: 'channelListing' })
    expect((await row('wDraft')).channelSku).toBe('W-DRAFT-DE')
  })

  it('a deleted listing (a draft again) takes a new SKU; following the product SKU really follows it (its old copy says another)', async () => {
    expect((await ownSku('wDeleted', 'W-DELETED-NEW', 'AMAZON', 'DE', { productSku: 'W-DELETED' })).errors ?? []).toEqual([])
    expect((await row('wDeleted')).channelSku).toBe('W-DELETED-NEW')
    await inside(A, () => db().product.update({ where: { id: pid['W-DELETED'] }, data: { sku: 'W-DELETED-2' } }))
    expect((await ownSku('wDeleted', null, 'AMAZON', 'DE', { productSku: 'W-DELETED', reset: true })).errors ?? []).toEqual([])
    // The flat-file copy and the offer still say W-DELETED: "follow" stores the product SKU, so Publish lists W-DELETED-2.
    expect((await row('wDeleted')).channelSku).toBe('W-DELETED-2')
  })

  it('Amazon: a held single product or variation moves to its own SKU (Publish creates NEW, deletes OLD); a family\'s main row cannot', async () => {
    const before = await row('wHeld')
    const out = await ownSku('wHeld', 'W-HELD-NEW', 'AMAZON', 'DE', { expectedVersion: before.version, productSku: 'W-HELD' })
    expect(out.errors ?? []).toEqual([])
    expect(await row('wHeld')).toMatchObject({ channelSku: 'W-HELD-NEW', version: before.version + 1 })
    // Back to the SKU Amazon holds, and following the product SKU while Amazon holds it: no move.
    expect((await ownSku('wHeld', 'W-HELD', 'AMAZON', 'DE', { productSku: 'W-HELD' })).errors ?? []).toEqual([])
    expect((await ownSku('wHeld', null, 'AMAZON', 'DE', { productSku: 'W-HELD' })).errors ?? []).toEqual([])
    expect((await row('wHeld')).channelSku).toBeNull()
    expect((await ownSku('wFamC', 'W-FAM-C-NEW', 'AMAZON', 'DE', { productSku: 'W-FAM-C' })).errors ?? []).toEqual([])
    expect((await row('wFamC')).channelSku).toBe('W-FAM-C-NEW')
    expect((await ownSku('wFam', 'W-FAM-NEW', 'AMAZON', 'DE', { productSku: 'W-FAM' })).errors).toEqual([{ id: pid['W-FAM'], field: 'channel_sku', error: amazonMainRowMove('W-FAM', 'W-FAM-NEW') }])
    expect((await row('wFam')).channelSku).toBeNull()
  })

  it('eBay: a Trading item moves (following the product SKU is stored as that move); an Inventory item cannot, in a preview too', async () => {
    expect((await ownSku('wKept', null, 'EBAY', 'IT', { productSku: 'W-KEPT' })).errors ?? []).toEqual([])
    // eBay holds W-KEPT-OLD: "follow" is a move to W-KEPT, stored as the listing's own SKU so Publish renames it.
    expect((await row('wKept')).channelSku).toBe('W-KEPT')
    const refused = ebayInventoryMoveRefusal('W-INV', 'W-INV-NEW')
    expect(refused).toBe('eBay holds W-INV, Nexus holds W-INV-NEW. Nexus cannot move an eBay Inventory listing to a new SKU yet: Delete it, then list it again.')
    expect((await ownSku('wInv', 'W-INV-NEW', 'EBAY', 'IT', { productSku: 'W-INV' })).errors).toEqual([{ id: pid['W-INV'], field: 'channel_sku', error: refused }])
    expect(await ownSku('wInv', 'W-INV-NEW', 'EBAY', 'IT', { productSku: 'W-INV', dryRun: true })).toMatchObject({ dryRun: true, wouldUpdate: 0, errors: [{ error: refused }] })
    expect((await row('wInv')).channelSku).toBeNull()
  })

  it('Etsy cannot move a live listing: refused with the review\'s Etsy sentence', async () => {
    expect((await ownSku('wEtsy', 'W-ETSY-NEW', 'ETSY', 'GLOBAL', { productSku: 'W-ETSY' })).errors).toEqual([{ id: pid['W-ETSY'], field: 'channel_sku', error: etsySkuMoveSentence('W-ETSY', 'W-ETSY-NEW') }])
    expect((await row('wEtsy')).channelSku).toBeNull()
  })

  it('one listing at a time; another business\'s channel SKU is not this business\'s', async () => {
    const two = await save({ changes: [{ id: pid['W-CROSS'], field: 'channel_sku', value: 'X', target: 'channel' }],
      marketplaceContexts: [{ channel: 'AMAZON', marketplace: 'DE', accountId: acc.AMAZON, aliasKey: '' }, { channel: 'AMAZON', marketplace: 'IT', accountId: acc.AMAZON, aliasKey: '' }] })
    expect(two).toMatchObject({ status: 400, errors: [{ field: 'channel_sku', error: expect.stringContaining('one channel, marketplace and listing at a time') }] })
    expect((await ownSku('wCross', 'CROSS-1', 'AMAZON', 'DE', { productSku: 'W-CROSS' })).errors ?? []).toEqual([])
    expect((await row('wCross')).channelSku).toBe('CROSS-1')
  })

  it('setChannelSku is the one writer: a move Publish cannot carry is refused there too, recovery may allow it', async () => {
    const write = (liveMove?: 'allow') => inside(A, () => db().$transaction(tx => setChannelSku(tx as never, { listingId: lid.wEtsy, sku: 'W-ETSY-MOVE', actorId: null, ...(liveMove ? { liveMove } : {}) })))
    await expect(write()).rejects.toMatchObject({ code: 'LIVE_SKU_HELD' })
    await expect(write()).rejects.toBeInstanceOf(ChannelSkuError)
    await expect(write('allow')).resolves.toMatchObject({ channelSku: 'W-ETSY-MOVE', changed: true })
  })
})

describe('S9 — the Shopify SKU column is the listing\'s own SKU', () => {
  const column = (name: string, productName: string, value: string | null, reset = false) => ownSku(name, value, 'SHOPIFY', 'GLOBAL', { field: 'attr_listing_sku', productSku: productName, reset })

  it('a draft: the column writes `channelSku` (the old copy kept, nothing lost); a reset follows the product SKU', async () => {
    const out = await column('shDraft', 'SH-DRAFT', 'SH-NEW')
    expect(out.errors ?? []).toEqual([])
    expect(await row('shDraft')).toMatchObject({ channelSku: 'SH-NEW', platformAttributes: { sku: 'SH-OLD-COPY' } })
    // The cell shows the SKU Publish sends: the listing's own.
    const { resolveBatch } = await import('../pim/mapping/resolve-batch.service.js')
    const cell = async () => (await inside(A, () => resolveBatch({ channel: 'SHOPIFY', marketplace: 'GLOBAL', channelConnectionId: acc.SHOPIFY, aliasKey: '', locale: 'en',
      productIds: [pid['SH-DRAFT']], includeCatalogue: false } as never))).products[0]?.cells.listing_sku?.value
    expect(await cell()).toBe('SH-NEW')
    // Shopify's SKU is required, so an empty cell is refused as before; "follow" is the column's reset.
    expect((await column('shDraft', 'SH-DRAFT', null)).errors).toEqual([{ id: pid['SH-DRAFT'], field: 'attr_listing_sku', error: 'Enter a value for this field.' }])
    expect((await column('shDraft', 'SH-DRAFT', null, true)).errors ?? []).toEqual([])
    // Its old copy says SH-OLD-COPY: following stores the product SKU itself.
    expect((await row('shDraft')).channelSku).toBe('SH-DRAFT')
  })

  it('a listing Shopify holds takes a new SKU: Publish renames it in place', async () => {
    expect((await column('shHeld', 'SH-HELD', 'SH-HELD-NEW')).errors ?? []).toEqual([])
    expect((await row('shHeld')).channelSku).toBe('SH-HELD-NEW')
  })
})
