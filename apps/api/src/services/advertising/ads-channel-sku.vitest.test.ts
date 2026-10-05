/**
 * S8 — advertising uses the listing's channel SKU, on real PostgreSQL (PGlite: production schema and row-level security).
 *
 * A Sponsored Products ad is created from the seller SKU Amazon holds in the campaign's market, which may be a listing's
 * own channel SKU (per market), not the product SKU (`resolveSellerSku`); an ad read back from Amazon names that SKU and
 * is matched to its product through the resolver (`productsForAdSkus`). Parity, own SKU, another business never
 * involved, conflicts reported (never a guess). No Amazon call is made: the ad groups here have no Amazon id.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))
vi.mock('../../utils/logger.js', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }))

import { AdSkuConflictError, createProductAdLocal, resolveSellerSku } from './ads-create.service.js'
import { productsForAdSkus } from './ads-v1-sync.service.js'

const A = LEGACY_WORKSPACE_ID
const OTHER = 'ws-ads-s8-other'
const inside = <T>(work: () => Promise<T>, workspaceId = A) => withWorkspace({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const ids: Record<string, string> = {}

beforeAll(async () => {
  database = await formulaDatabase()
  await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, 'Other', 'active', 'ads-s8', $1, CURRENT_TIMESTAMP)`, [OTHER])
  const seed = async (workspaceId: string, work: (db: any) => Promise<void>) => inside(() => work(database.client), workspaceId)
  const product = (db: any) => async (sku: string, extra: Record<string, unknown> = {}) => { ids[sku] = (await db.product.create({ data: { sku, name: sku, basePrice: '10.00', ...extra } })).id }
  const listing = (db: any) => async (name: string, sku: string, account: string, extra: Record<string, unknown> = {}, offers: Array<{ sku: string; method: 'FBA' | 'FBM' }> = []) => {
    const row = await db.channelListing.create({ data: {
      productId: ids[sku], channel: 'AMAZON', marketplace: extra.marketplace ?? 'IT', region: extra.marketplace ?? 'IT', channelMarket: `AMAZON_${extra.marketplace ?? 'IT'}`,
      listingStatus: 'ACTIVE', isPublished: true, externalListingId: `B0${name.toUpperCase().replace(/[^A-Z0-9]/g, '').padEnd(8, '0').slice(0, 8)}`, channelConnectionId: account, aliasKey: '', ...extra,
    } })
    for (const o of offers) await db.offer.create({ data: { channelListingId: row.id, sku: o.sku, fulfillmentMethod: o.method, isActive: true } })
    ids[`L:${name}`] = row.id
  }
  await seed(A, async (db) => {
    ids.accA = (await db.channelConnection.create({ data: { channelType: 'AMAZON', isActive: true, externalAccountId: 'ADS-S8-A' } })).id
    ids.accB = (await db.channelConnection.create({ data: { channelType: 'AMAZON', isActive: true, externalAccountId: 'ADS-S8-B' } })).id
    const p = product(db), l = listing(db)
    await p('AD-PLAIN'); await l('plain', 'AD-PLAIN', ids.accA)
    await p('AD-OWN', { amazonAsin: 'B0ADOWN001' })
    await l('ownIT', 'AD-OWN', ids.accA, { channelSku: 'AD-OWN-IT', liveChannelSku: 'AD-OWN-IT' })
    await l('ownDE', 'AD-OWN', ids.accA, { marketplace: 'DE' })
    await p('AD-NEW'); await l('new', 'AD-NEW', ids.accA, { channelSku: 'AD-NEW-IT' })
    await p('AD-TWO'); await l('two', 'AD-TWO', ids.accA, {}, [{ sku: 'AD-TWO-FBA', method: 'FBA' }, { sku: 'AD-TWO-FBM', method: 'FBM' }])
    await p('AD-TWIN'); await l('twin', 'AD-TWIN', ids.accA, {}, [{ sku: 'AD-TWIN-FBA', method: 'FBA' }, { sku: 'AD-TWIN', method: 'FBM' }])
    await p('AD-CF'); await l('cfA', 'AD-CF', ids.accA, { liveChannelSku: 'AD-CF-A' }); await l('cfB', 'AD-CF', ids.accB, { liveChannelSku: 'AD-CF-B' })
    await p('AD-AMB-1'); await l('amb1', 'AD-AMB-1', ids.accA, { channelSku: 'AD-AMB', liveChannelSku: 'AD-AMB' })
    await p('AD-AMB-2'); await l('amb2', 'AD-AMB-2', ids.accB, { channelSku: 'AD-AMB', liveChannelSku: 'AD-AMB' })
    await p('AD-DRAFT'); await l('draft', 'AD-DRAFT', ids.accA, { listingStatus: 'DRAFT', isPublished: false, externalListingId: null, channelSku: 'AD-DRAFT-IT' })
    await db.amazonAdsConnection.create({ data: { profileId: 'PROFILE-S8-IT', marketplace: 'IT', isActive: true } })
    const campaign = await db.campaign.create({ data: { name: 'S8 local', type: 'SP', dailyBudget: '10.00', startDate: new Date(), marketplace: 'IT' } })
    ids.adGroup = (await db.adGroup.create({ data: { campaignId: campaign.id, name: 'S8 group' } })).id
  })
  // Another business: the same product SKU, its own listing SKU there. Never read from A.
  await seed(OTHER, async (db) => {
    const account = await db.channelConnection.create({ data: { channelType: 'AMAZON', isActive: true, externalAccountId: 'ADS-S8-X' } })
    const foreign = await db.product.create({ data: { sku: 'AD-PLAIN', name: 'Foreign', basePrice: '10.00' } })
    await db.channelListing.create({ data: {
      productId: foreign.id, channel: 'AMAZON', marketplace: 'IT', region: 'IT', channelMarket: 'AMAZON_IT', listingStatus: 'ACTIVE', isPublished: true,
      externalListingId: 'B0FOREIGN1', channelConnectionId: account.id, aliasKey: '', liveChannelSku: 'AD-FOREIGN-LIVE',
    } })
  })
}, 120_000)

afterAll(async () => { await database?.close() }, 30_000)

const resolve = (input: Parameters<typeof resolveSellerSku>[0]) => inside(() => resolveSellerSku(input))

describe('resolveSellerSku — the SKU Amazon holds in the campaign\'s market', () => {
  it('parity: no market, or a listing without its own SKU → as before', async () => {
    expect(await resolve({ sku: 'AD-PLAIN' })).toEqual({ sku: 'AD-PLAIN', asin: null })
    expect(await resolve({ sku: 'AD-OWN' })).toEqual({ sku: 'AD-OWN', asin: null })
    expect(await resolve({ sku: 'AD-PLAIN', marketplace: 'IT' })).toEqual({ sku: 'AD-PLAIN', asin: null })
    expect(await resolve({ sku: 'NOT-IN-NEXUS', marketplace: 'IT' })).toEqual({ sku: 'NOT-IN-NEXUS', asin: null })
  })
  it('a listing\'s own SKU, confirmed by Amazon, is the ad SKU in that market — from the product SKU, the ASIN or the product', async () => {
    expect(await resolve({ sku: 'AD-OWN', marketplace: 'IT' })).toEqual({ sku: 'AD-OWN-IT', asin: 'B0ADOWN001' })
    expect(await resolve({ asin: 'B0ADOWN001', marketplace: 'IT' })).toEqual({ sku: 'AD-OWN-IT', asin: 'B0ADOWN001' })
    expect(await resolve({ productId: ids['AD-OWN'], sku: 'AD-OWN', marketplace: 'IT' })).toEqual({ sku: 'AD-OWN-IT', asin: 'B0ADOWN001' })
    // The own SKU itself is matched back; an Amazon marketplace id reads as its code.
    // (Already the SKU Amazon holds: the answer is exactly the old one.)
    expect(await resolve({ sku: 'AD-OWN-IT', marketplace: 'APJ6JRA9NG5V4' })).toEqual({ sku: 'AD-OWN-IT', asin: null })
    // Per market: DE follows the product SKU — exactly the old answer.
    expect(await resolve({ sku: 'AD-OWN', marketplace: 'DE' })).toEqual({ sku: 'AD-OWN', asin: null })
  })
  it('an own SKU not yet live, or a draft listing, is not advertised: the SKU Amazon holds (or as before)', async () => {
    expect(await resolve({ sku: 'AD-NEW', marketplace: 'IT' })).toEqual({ sku: 'AD-NEW', asin: null })
    expect(await resolve({ sku: 'AD-DRAFT', marketplace: 'IT' })).toEqual({ sku: 'AD-DRAFT', asin: null })
  })
  it('two active offers: the one named like the product SKU (as before); neither is → refused, never a guess (not FBA)', async () => {
    expect(await resolve({ sku: 'AD-TWIN', marketplace: 'IT' })).toEqual({ sku: 'AD-TWIN', asin: null })
    await expect(resolve({ sku: 'AD-TWO', marketplace: 'IT' })).rejects.toThrow(AdSkuConflictError)
    await expect(resolve({ sku: 'AD-TWO', marketplace: 'IT' })).rejects.toThrow(
      'AD-TWO has more than one seller SKU on Amazon IT (AD-TWO-FBA, AD-TWO-FBM) and none of them is AD-TWO. Nothing was sent to Amazon Ads: an ad on a guessed SKU would not work. Choose the offer to advertise first.')
  })
  it('conflicts are reported, never guessed: two live SKUs in the market; a SKU two products answer to', async () => {
    await expect(resolve({ sku: 'AD-CF', marketplace: 'IT' })).rejects.toThrow(AdSkuConflictError)
    await expect(resolve({ sku: 'AD-CF', marketplace: 'IT' })).rejects.toThrow(/AD-CF has more than one Amazon SKU in IT \(AD-CF-A, AD-CF-B\)/)
    await expect(resolve({ sku: 'AD-AMB', marketplace: 'IT' })).rejects.toThrow(/AD-AMB names more than one product on Amazon IT/)
  })
  it('another business\'s listing is never read', async () => {
    expect(await resolve({ sku: 'AD-PLAIN', marketplace: 'IT' })).toEqual({ sku: 'AD-PLAIN', asin: null })
    expect(await resolve({ sku: 'AD-FOREIGN-LIVE', marketplace: 'IT' })).toEqual({ sku: 'AD-FOREIGN-LIVE', asin: null })
  })
})

describe('createProductAdLocal — the local ad row carries the SKU Amazon holds', () => {
  it('own SKU in the campaign\'s market; a conflict does not stop a local-only row (it refuses only an SP push)', async () => {
    const own = await inside(() => createProductAdLocal({ adGroupId: ids.adGroup, sku: 'AD-OWN' }))
    const conflict = await inside(() => createProductAdLocal({ adGroupId: ids.adGroup, sku: 'AD-CF' }))
    const rows = await inside(() => database.client.adProductAd.findMany({ where: { id: { in: [own.id, conflict.id] } }, select: { id: true, sku: true } }))
    expect(Object.fromEntries(rows.map(r => [r.id === own.id ? 'own' : 'conflict', r.sku]))).toEqual({ own: 'AD-OWN-IT', conflict: 'AD-CF' })
  })
})

describe('productsForAdSkus — an ad\'s SKU matched back through the resolver', () => {
  it('own SKU → its product; product SKU → its product; two products → null; unknown → left out', async () => {
    const map = await inside(() => productsForAdSkus('PROFILE-S8-IT', ['AD-OWN-IT', 'AD-PLAIN', 'AD-AMB', 'UNKNOWN-SKU', 'AD-FOREIGN-LIVE']))
    expect(Object.fromEntries(map)).toEqual({ 'AD-OWN-IT': ids['AD-OWN'], 'AD-PLAIN': ids['AD-PLAIN'], 'AD-AMB': null })
  })
  it('a profile with no market maps nothing (the caller keeps the product-SKU match)', async () => {
    expect((await inside(() => productsForAdSkus('NO-SUCH-PROFILE', ['AD-OWN-IT']))).size).toBe(0)
  })
})
