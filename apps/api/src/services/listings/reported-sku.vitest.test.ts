/**
 * S7 — a listing's own channel SKU where Amazon's FBA stock is read back (the FBA inventory sweep, the SQS FBA
 * notification) and the lane's helper (`reported-sku.ts`), on real PostgreSQL (PGlite: production schema and
 * row-level security). Amazon's FBA report is stubbed; nothing leaves the machine.
 *
 *   · parity: a listing with no SKU of its own is matched exactly as before (by its product SKU);
 *   · an own SKU (confirmed, wanted, or an old store) names its listing's product;
 *   · another account's or another business's listing is never matched; two products on one SKU are reported, never picked;
 *   · FBA quantities: written the same way (one SYNC_RECONCILIATION movement at the FBA mirror, nothing at an own
 *     warehouse); an FBA notification is still never applied; an own SKU never makes a second number overwrite a
 *     product's FBA number in one sweep.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any, account: null as string | null, sellerA: '' as string, fbaRows: [] as any[] }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../../utils/logger.js', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }))
vi.mock('../../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: false, status: 'disabled' }),
    resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: { connection: null },
  }
})
vi.mock('../advertising/ads-cache.js', () => ({
  cached: async (_key: string, _ttl: number, work: () => Promise<unknown>) => work(),
  peekCached: async () => undefined, putCached: () => undefined, flushAdsCache: async () => undefined,
}))
// The account chooser: the default account is `state.account`; a seller id names its own account only.
vi.mock('../../lib/amazon-sp-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/amazon-sp-client.js')>()),
  amazonAccount: vi.fn(async (input: { sellerId?: string } = {}) => {
    if (input.sellerId) { if (input.sellerId === 'SELLER-A') return { id: state.sellerA }; throw new Error('no such seller') }
    if (!state.account) throw new Error('no Amazon account')
    return { id: state.account }
  }),
}))
vi.mock('../marketplaces/amazon.service.js', () => ({
  AmazonService: class { isConfigured = async () => true; fetchFBAInventory = async () => state.fbaRows },
}))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { amazonMarketCode, amazonSkusInMarket, productByOwnSku, reportedSkuOf } from './reported-sku.js'
import { amazonInventoryService } from '../amazon-inventory.service.js'
import { recordChannelStockEvent } from '../channel-stock-event.service.js'

const OTHER_BUSINESS = 's7-other-business'
const as = (workspaceId: string) => <T>(work: () => Promise<T>) => withWorkspace({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const scoped = as(LEGACY_WORKSPACE_ID)
const other = as(OTHER_BUSINESS)

const acc = { a: '', b: '', other: '' }
const loc = { main: '', fba: '' }
const pid: Record<string, string> = {}
const lid: Record<string, string> = {}

async function product(sku: string, data: Record<string, unknown> = {}) {
  pid[sku] = (await prisma.product.create({ data: { sku, name: sku, basePrice: 10, ...data } as never })).id
  return pid[sku]
}
type Seed = { name: string; productSku: string; marketplace?: string; account?: string | null; data?: Record<string, unknown>; offers?: Array<{ sku: string; isActive: boolean; method?: 'FBA' | 'FBM' }> }
async function listing(seed: Seed) {
  const marketplace = seed.marketplace ?? 'IT'
  const row = await prisma.channelListing.create({ data: {
    productId: pid[seed.productSku], channel: 'AMAZON', marketplace, region: marketplace, channelMarket: `AMAZON_${marketplace}`,
    channelConnectionId: seed.account === undefined ? acc.a : seed.account, aliasKey: '', listingStatus: 'ACTIVE', isPublished: true, ...seed.data,
  } as never })
  for (const o of seed.offers ?? []) await prisma.offer.create({ data: { channelListingId: row.id, sku: o.sku, fulfillmentMethod: o.method ?? 'FBA', isActive: o.isActive } })
  lid[seed.name] = row.id
  return row.id
}
const connection = (label: string) => prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: label, externalAccountId: label, isActive: true, isPrimary: false } as never }).then(c => c.id)
const DRAFT = { listingStatus: 'DRAFT', isPublished: false, externalListingId: null }

beforeAll(async () => {
  await scoped(async () => {
    acc.a = await connection('s7-amazon-a')
    acc.b = await connection('s7-amazon-b')
    state.sellerA = acc.a
    loc.main = (await prisma.stockLocation.create({ data: { type: 'WAREHOUSE', code: 'IT-MAIN', name: 'Own warehouse (test)' } })).id
    loc.fba = (await prisma.stockLocation.create({ data: { type: 'AMAZON_FBA', code: 'AMAZON-EU-FBA', name: 'Amazon FBA (test)' } })).id
    await prisma.marketplace.create({ data: { channel: 'AMAZON', code: 'IT', name: 'Italy', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'], marketplaceId: 'TEST-MKT-IT' } as never })

    await product('PLAIN'); await listing({ name: 'plain', productSku: 'PLAIN' })
    await product('OWNP')
    await listing({ name: 'ownIT', productSku: 'OWNP', data: { liveChannelSku: 'OWNP-IT', channelSku: 'OWNP-IT' } })
    await listing({ name: 'ownDE', productSku: 'OWNP', marketplace: 'DE', data: { ...DRAFT, channelSku: 'OWNP-DE' } })
    await product('AMB-A'); await listing({ name: 'ambA', productSku: 'AMB-A', data: { channelSku: 'AMB-1' } })
    await product('AMB-B'); await listing({ name: 'ambB', productSku: 'AMB-B', data: { channelSku: 'AMB-1' } })
    await product('ONLYB'); await listing({ name: 'onlyB', productSku: 'ONLYB', account: acc.b, data: { liveChannelSku: 'ONLY-B' } })
    await product('ALIASED'); await listing({ name: 'aliasedMain', productSku: 'ALIASED' })
    await listing({ name: 'aliasedExtra', productSku: 'ALIASED', data: { aliasKey: 'extra-1', liveChannelSku: 'ALIASED-X' } })
    await product('SOLO'); await listing({ name: 'solo', productSku: 'SOLO', offers: [{ sku: 'SOLO-OWN', isActive: true }] })
    await product('TWO-OFF'); await listing({ name: 'twoOff', productSku: 'TWO-OFF', offers: [{ sku: 'TWO-A', isActive: true }, { sku: 'TWO-B', isActive: true, method: 'FBM' }] })
    await product('MIXED')
    await listing({ name: 'mixedA', productSku: 'MIXED' })
    await listing({ name: 'mixedB', productSku: 'MIXED', account: acc.b, data: { liveChannelSku: 'MIXED-ON-B' } })
    await product('UNATTR'); await listing({ name: 'unattr', productSku: 'UNATTR', account: null, data: { liveChannelSku: 'UNATTR-OWN' } })
  })
  await prisma.workspace.create({ data: { id: OTHER_BUSINESS, name: 'Other business', createdByUserId: 's7', creationKey: 's7-other' } as never })
  await other(async () => {
    acc.other = await connection('s7-other-amazon')
    await product('FOREIGN')
    await listing({ name: 'foreign', productSku: 'FOREIGN', account: acc.other, data: { liveChannelSku: 'FOREIGN-1' } })
  })
}, 120_000)
afterAll(async () => { await state.db?.close() })

const own = (sku: string, account: string | null = acc.a) => scoped(() => productByOwnSku(prisma, { channel: 'AMAZON', channelConnectionId: account, sku }))
const skusIn = (marketplace: string, skus: string[], accountId: string | null = acc.a) => scoped(async () => {
  const products = await prisma.product.findMany({ where: { sku: { in: skus } }, select: { id: true, sku: true } })
  const map = await amazonSkusInMarket(prisma, { accountId, marketplace, products })
  return Object.fromEntries(products.map(p => [p.sku, map.get(p.id)]))
})

describe('reportedSkuOf — the SKU a channel knows a listing by', () => {
  it('parity: no own SKU → the product SKU; a live listing → its confirmed SKU; a still-draft → the SKU Publish would send', () => {
    expect(reportedSkuOf({ channel: 'AMAZON', listingStatus: 'ACTIVE', isPublished: true }, 'P-1')).toEqual({ sku: 'P-1', source: 'product' })
    expect(reportedSkuOf({ channel: 'AMAZON', listingStatus: 'ACTIVE', isPublished: true, liveChannelSku: 'LIVE', channelSku: 'WANT' }, 'P-1')).toEqual({ sku: 'LIVE', source: 'live' })
    expect(reportedSkuOf({ channel: 'AMAZON', ...DRAFT, channelSku: 'WANT' }, 'P-1')).toEqual({ sku: 'WANT', source: 'channel' })
    expect(reportedSkuOf({ channel: 'AMAZON', ...DRAFT }, 'P-1')).toEqual({ sku: 'P-1', source: 'product' })
  })
})

describe('productByOwnSku — a reported SKU back to a product', () => {
  it('parity: a master SKU is left to the caller\'s own lookup (null), so a listing without its own SKU is matched as before', async () => {
    expect(await own('PLAIN')).toBeNull()
    expect(await own('NOPE')).toBeNull()
  })
  it('an own SKU names its product: confirmed, wanted (a draft), an old store', async () => {
    expect(await own('OWNP-IT')).toEqual({ ambiguous: false, productId: pid.OWNP, listingId: lid.ownIT, via: 'live' })
    expect(await own('OWNP-DE')).toEqual({ ambiguous: false, productId: pid.OWNP, listingId: lid.ownDE, via: 'channel' })
    expect(await own('SOLO-OWN')).toEqual({ ambiguous: false, productId: pid.SOLO, listingId: lid.solo, via: 'offer' })
  })
  it('🔴 two products on one SKU: reported with a sentence, never picked', async () => {
    expect(await own('AMB-1')).toEqual({ ambiguous: true, productIds: [pid['AMB-A'], pid['AMB-B']].sort(),
      sentence: 'AMB-1 is the SKU of 2 products on this Amazon account. Nexus did not pick one: give each listing its own SKU.' })
  })
  it('🔴 another account\'s and another business\'s listing are never matched; no account → no match', async () => {
    expect(await own('ONLY-B')).toBeNull()
    expect(await own('ONLY-B', acc.b)).toEqual({ ambiguous: false, productId: pid.ONLYB, listingId: lid.onlyB, via: 'live' })
    expect(await own('FOREIGN-1')).toBeNull()
    expect(await own('FOREIGN-1', acc.other)).toBeNull()
    expect(await own('OWNP-IT', null)).toBeNull()
  })
})

describe('amazonSkusInMarket — what Amazon knows a product by in one market of one account', () => {
  it('parity: a listing without its own SKU → the product SKU (own: false)', async () => {
    expect(await skusIn('IT', ['PLAIN'])).toEqual({ PLAIN: { ok: true, sku: 'PLAIN', listingId: lid.plain, own: false } })
  })
  it('the main listing\'s own SKU, per market; an extra listing (alias) is not the product\'s main SKU', async () => {
    expect(await skusIn('IT', ['OWNP', 'ALIASED', 'SOLO'])).toEqual({
      OWNP: { ok: true, sku: 'OWNP-IT', listingId: lid.ownIT, own: true },
      ALIASED: { ok: true, sku: 'ALIASED', listingId: lid.aliasedMain, own: false },
      SOLO: { ok: true, sku: 'SOLO-OWN', listingId: lid.solo, own: true },
    })
    expect(await skusIn('DE', ['OWNP'])).toEqual({ OWNP: { ok: true, sku: 'OWNP-DE', listingId: lid.ownDE, own: true } })
  })
  it('no listing in the market → NO_LISTING; two active seller SKUs → CONFLICT, never a guess', async () => {
    expect(await skusIn('FR', ['PLAIN'])).toEqual({ PLAIN: { ok: false, code: 'NO_LISTING', sentence: 'PLAIN has no Amazon FR listing in Nexus.' } })
    expect(await skusIn('IT', ['TWO-OFF'])).toEqual({ 'TWO-OFF': { ok: false, code: 'CONFLICT',
      sentence: 'TWO-OFF: its Amazon IT listing has more than one seller SKU on record (TWO-A, TWO-B). Nexus did not pick one: set the listing\'s own SKU first.' } })
  })
  it('🔴 another account\'s listing is not this account\'s: the account\'s own listing wins; an unattributed one counts when it has none', async () => {
    expect(await skusIn('IT', ['MIXED', 'ONLYB', 'UNATTR'])).toEqual({
      MIXED: { ok: true, sku: 'MIXED', listingId: lid.mixedA, own: false },
      ONLYB: { ok: false, code: 'NO_LISTING', sentence: 'ONLYB has no Amazon IT listing in Nexus.' },
      UNATTR: { ok: true, sku: 'UNATTR-OWN', listingId: lid.unattr, own: true },
    })
    expect(await skusIn('IT', ['MIXED', 'ONLYB'], acc.b)).toEqual({
      MIXED: { ok: true, sku: 'MIXED-ON-B', listingId: lid.mixedB, own: true },
      ONLYB: { ok: true, sku: 'ONLY-B', listingId: lid.onlyB, own: true },
    })
    // No account known: every account's listing counts, and they must agree.
    expect(await skusIn('IT', ['MIXED'], null)).toEqual({ MIXED: { ok: false, code: 'CONFLICT',
      sentence: 'MIXED has Amazon IT listings with different seller SKUs (MIXED, MIXED-ON-B). Nexus did not pick one.' } })
  })
  it('amazonMarketCode: the Marketplace row first, then the market catalogue; unknown → null', async () => {
    expect(await scoped(() => amazonMarketCode(prisma, 'TEST-MKT-IT'))).toBe('IT')
    expect(await scoped(() => amazonMarketCode(prisma, 'A1PA6795UKMFR9'))).toBe('DE')
    expect(await scoped(() => amazonMarketCode(prisma, 'NOPE'))).toBeNull()
  })
})

const fbaLevel = (sku: string) => scoped(async () => (await prisma.stockLevel.findFirst({ where: { productId: pid[sku], locationId: loc.fba }, select: { quantity: true } }))?.quantity ?? null)
const movements = (sku: string) => scoped(() => prisma.stockMovement.findMany({ where: { productId: pid[sku] }, select: { change: true, reason: true, locationId: true, referenceType: true, referenceId: true }, orderBy: { createdAt: 'asc' } }))
const row = (sku: string, fulfillableQuantity: number, asin: string | null = null) => ({ sku, asin, fnsku: null, fulfillableQuantity, inboundQuantity: 0, reservedQuantity: 0, unfulfillableQuantity: 0, totalQuantity: fulfillableQuantity, lastUpdatedTime: null })
const sweep = (rows: any[]) => { state.fbaRows = rows; return scoped(() => amazonInventoryService.syncFBAInventoryForSkus(rows.map(r => r.sku))) }

describe('FBA stock ingest (amazon-inventory.service) — which product an FBA number belongs to', () => {
  it('parity: with no own-SKU match (no account), the sweep matches by product SKU exactly as before; an own SKU is unmatched as before', async () => {
    state.account = null
    const summary = await sweep([row('PLAIN', 5), row('OWNP-IT', 7)])
    expect(summary).toMatchObject({ productsUpdated: 1, skusNotFoundInDb: 1, unmatchedSampleSkus: ['OWNP-IT'], errors: [] })
    expect(await fbaLevel('PLAIN')).toBe(5)
    expect(await fbaLevel('OWNP')).toBeNull()
  })

  it('an own seller SKU lands on its product; the master SKU still lands as before; FBA written the same way (one movement at the FBA mirror)', async () => {
    state.account = acc.a
    const summary = await sweep([row('PLAIN', 8), row('OWNP-IT', 7), row('SOLO-OWN', 6)])
    expect(summary).toMatchObject({ productsUpdated: 3, skusNotFoundInDb: 0, errors: [] })
    expect([await fbaLevel('PLAIN'), await fbaLevel('OWNP'), await fbaLevel('SOLO')]).toEqual([8, 7, 6])
    expect(await movements('OWNP')).toEqual([{ change: 7, reason: 'SYNC_RECONCILIATION', locationId: loc.fba, referenceType: 'AmazonFBASync', referenceId: 'OWNP-IT' }])
    expect(await movements('PLAIN')).toEqual([
      { change: 5, reason: 'SYNC_RECONCILIATION', locationId: loc.fba, referenceType: 'AmazonFBASync', referenceId: 'PLAIN' },
      { change: 3, reason: 'SYNC_RECONCILIATION', locationId: loc.fba, referenceType: 'AmazonFBASync', referenceId: 'PLAIN' },
    ])
  })

  it('🔴 two products on one SKU, another account\'s SKU: nothing written to a guessed product', async () => {
    state.account = acc.a
    const summary = await sweep([row('AMB-1', 2), row('ONLY-B', 4)])
    expect(summary.productsUpdated).toBe(0)
    expect(summary.errors).toEqual([{ sku: 'AMB-1', error: 'AMB-1 is the SKU of 2 products on this Amazon account. Nexus did not pick one: give each listing its own SKU.' }])
    expect(summary.unmatchedSampleSkus).toEqual(['ONLY-B'])
    expect([await fbaLevel('AMB-A'), await fbaLevel('AMB-B'), await fbaLevel('ONLYB')]).toEqual([null, null, null])
  })

  it('🔴 FBA: an own SKU never makes a second number overwrite a product\'s FBA number in one sweep (the master SKU row is written as before)', async () => {
    state.account = acc.a
    const summary = await sweep([row('ALIASED', 2), row('ALIASED-X', 3)])
    expect(await fbaLevel('ALIASED')).toBe(2)
    expect(summary.productsUpdated).toBe(1)
    expect(summary.errors).toEqual([{ sku: 'ALIASED-X',
      error: 'FBA units for one product come under 2 seller SKUs (ALIASED, ALIASED-X). Nexus keeps one FBA number per product, so the number under ALIASED-X was not written.' }])
    expect((await movements('ALIASED')).map(m => m.change)).toEqual([2])
  })
})

const event = (sku: string, channelConnectionId?: string | null) => scoped(() => recordChannelStockEvent({
  channel: 'AMAZON', channelEventId: `s7-${sku}-${channelConnectionId ?? 'none'}-${Math.random()}`, sku, channelConnectionId, channelReportedQty: 9, rawPayload: { sku },
}))

describe('FBA notification (recordChannelStockEvent with the reporting account)', () => {
  it('parity: a master SKU names its product with or without the account; without the account an own SKU is unmatched as before', async () => {
    expect((await event('PLAIN', acc.a)).productId).toBe(pid.PLAIN)
    expect((await event('PLAIN')).productId).toBe(pid.PLAIN)
    expect((await event('OWNP-IT')).productId).toBeNull()
  })
  it('an own SKU on the reporting account names its product; FBA is still never applied (observed at the mirror, settled as Amazon\'s)', async () => {
    const before = await movements('OWNP')
    const out = await event('OWNP-IT', acc.a)
    expect(out).toMatchObject({ productId: pid.OWNP, status: 'IGNORED', localQtyAtObservation: 7, drift: 2 })
    expect(await scoped(() => prisma.channelStockEvent.findUnique({ where: { id: out.id }, select: { sku: true, locationId: true, resultingMovementId: true } })))
      .toEqual({ sku: 'OWNP', locationId: loc.fba, resultingMovementId: null })
    expect(await movements('OWNP')).toEqual(before)
    expect(await fbaLevel('OWNP')).toBe(7)
  })
  it('🔴 two products on one SKU, another account\'s SKU, another business\'s SKU: recorded unmatched', async () => {
    expect((await event('AMB-1', acc.a)).productId).toBeNull()
    expect((await event('ONLY-B', acc.a)).productId).toBeNull()
    expect((await event('FOREIGN-1', acc.a)).productId).toBeNull()
  })
})
