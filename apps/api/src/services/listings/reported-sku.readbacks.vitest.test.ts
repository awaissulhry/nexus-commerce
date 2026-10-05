/**
 * S7 — read-backs and reconcile jobs key each listing by the SKU the channel knows it by (its own SKU, else its product
 * SKU), on real PostgreSQL (PGlite: production schema and row-level security). Every channel answer is stubbed;
 * nothing leaves the machine. These jobs COMPARE or HEAL by pushing, so a wrong SKU map heals the wrong listing.
 *
 *   · parity: a listing without its own SKU is asked, compared and healed exactly as before (under its product SKU);
 *   · an own SKU is asked/compared under that SKU; an extra listing (alias) no longer collides with its main listing;
 *   · another account's listing is never laid on this account's report; no single SKU is reported, never guessed;
 *   · FBA: the drift detector never auto-restores a drift found under an own SKU (the restore sends the product SKU).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const s = vi.hoisted(() => ({
  db: null as any,
  account: null as string | null,
  catalog: {} as Record<string, Array<{ sku: string; quantity?: number; price?: number; fulfillmentChannel?: string | null }>>,
  heals: [] as Array<{ channelListingId: string; quantity: number }>,
  restored: [] as any[],
  cron: [] as string[],
  ebayAsked: [] as string[],
  ebayOffers: {} as Record<string, unknown[] | 404>,
  inventoryAsked: [] as string[],
  events: [] as Array<{ sku?: string; productId?: string }>,
  groups: {} as Record<string, unknown>,
}))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  s.db = await formulaDatabase()
  return { default: s.db.client, prisma: s.db.client }
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
vi.mock('../../lib/amazon-sp-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/amazon-sp-client.js')>()),
  amazonAccount: vi.fn(async () => { if (!s.account) throw new Error('no Amazon account'); return { id: s.account } }),
}))
vi.mock('../marketplaces/amazon.service.js', () => ({
  AmazonService: class { isConfigured = async () => true; fetchActiveCatalog = async (mp: string) => s.catalog[mp] ?? [] },
}))
vi.mock('../marketplaces/ebay.service.js', () => ({
  EbayService: class {
    async getPublishedInventoryItem(sku: string) { s.inventoryAsked.push(sku); return { availability: { shipToLocationAvailability: { quantity: 3 } } } }
  },
}))
vi.mock('../outbound-rows.js', () => ({ createOutboundRow: vi.fn(async (_db: unknown, args: any) => { s.heals.push({ channelListingId: args.data.channelListingId, quantity: args.data.payload.quantity }); return {} }) }))
vi.mock('../sync-health.service.js', () => ({ syncHealthService: { logConflict: vi.fn(async () => undefined) } }))
vi.mock('../channel-drift.service.js', () => ({ recordChannelReadback: vi.fn(async () => undefined) }))
vi.mock('../fba-restore.service.js', () => ({ restoreFbaListings: vi.fn(async (options: unknown) => { s.restored.push(options); return { sent: 0, processed: 0, skippedNoFba: 0, results: [] } }) }))
vi.mock('../channel-stock-event.service.js', () => ({ recordChannelStockEvent: vi.fn(async (input: any) => { s.events.push({ sku: input.sku, productId: input.productId }); return {} }) }))
vi.mock('../../lib/cron/clustered.js', () => ({ default: { schedule: vi.fn(), validate: () => true }, schedulePlatform: vi.fn() }))
vi.mock('../../utils/cron-observability.js', () => ({ recordCronRun: vi.fn(async (_name: string, work: () => Promise<unknown>) => { const out = await work(); s.cron.push(String(out)); return out }) }))
vi.mock('../ebay-auth.service.js', () => ({ ebayAuthService: { getValidToken: vi.fn(async () => 'token') } }))
vi.mock('../gateway/ebay.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../gateway/ebay.js')>()),
  ebaySend: vi.fn(async (_connectionId: string, url: string) => {
    const offer = /offer\?sku=([^&]+)/.exec(url)
    if (offer) {
      const sku = decodeURIComponent(offer[1]); s.ebayAsked.push(sku)
      const offers = s.ebayOffers[sku] ?? 404
      return offers === 404 ? new Response('', { status: 404 }) : new Response(JSON.stringify({ offers }), { status: 200 })
    }
    const group = /inventory_item_group\/([^?]+)/.exec(url)
    if (group) return new Response(JSON.stringify(s.groups[decodeURIComponent(group[1])] ?? {}), { status: 200 })
    throw new Error(`unexpected eBay call ${url}`)
  }),
}))
vi.mock('../gateway/channels.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../gateway/channels.js')>()), ebayListingLanguage: async () => 'it-IT' }))
vi.mock('../ebay-variation-push.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ebay-variation-push.service.js')>()),
  resolvePerMarketContent: () => ({ title: 'Family title' }),
}))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { keyReadbackRows, runAmazonQtyReadback } from '../../jobs/amazon-qty-readback.job.js'
import { runEbayStatusReconcile } from '../../jobs/ebay-status-reconcile.job.js'
import { runFbaDriftDetector } from '../../jobs/fba-drift-detector.job.js'
import { readBackEbayInventory } from '../ebay-inventory-readback.service.js'
import { collectInventoryDrift } from '../ebay-inventory-drift.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const acc = { a: '', b: '', ebay: '', ebay2: '' }
const pid: Record<string, string> = {}
const lid: Record<string, string> = {}

async function product(sku: string, data: Record<string, unknown> = {}) {
  pid[sku] = (await prisma.product.create({ data: { sku, name: sku, basePrice: 10, ...data } as never })).id
  return pid[sku]
}
type Seed = { name: string; productSku: string; channel?: string; marketplace?: string; account: string | null; data?: Record<string, unknown>; offers?: Array<[string, 'FBA' | 'FBM']> }
async function listing(seed: Seed) {
  const channel = seed.channel ?? 'AMAZON'
  const marketplace = seed.marketplace ?? 'IT'
  const row = await prisma.channelListing.create({ data: {
    productId: pid[seed.productSku], channel, marketplace, region: marketplace, channelMarket: `${channel}_${marketplace}`,
    channelConnectionId: seed.account, aliasKey: '', listingStatus: 'ACTIVE', isPublished: true, ...seed.data,
  } as never })
  for (const [sku, method] of seed.offers ?? []) await prisma.offer.create({ data: { channelListingId: row.id, sku, fulfillmentMethod: method, isActive: true } })
  lid[seed.name] = row.id
  return row.id
}
const connection = (channelType: string, label: string, isPrimary = false) =>
  prisma.channelConnection.create({ data: { channelType, accountLabel: label, externalAccountId: label, isActive: true, isPrimary, authStatus: 'connected', managedBy: 'oauth' } as never }).then(c => c.id)
const FBM = { fulfillmentMethod: 'FBM' }

beforeAll(async () => {
  await scoped(async () => {
    acc.a = await connection('AMAZON', 's7-rb-amazon-a')
    acc.b = await connection('AMAZON', 's7-rb-amazon-b')
    acc.ebay = await connection('EBAY', 's7-rb-ebay', true)
    acc.ebay2 = await connection('EBAY', 's7-rb-ebay-2')

    // Amazon quantity read-back (FBM listings).
    await product('Q-PLAIN'); await listing({ name: 'qPlain', productSku: 'Q-PLAIN', account: acc.a, data: { ...FBM, quantity: 4 } })
    await product('Q-OWN'); await listing({ name: 'qOwn', productSku: 'Q-OWN', account: acc.a, data: { ...FBM, quantity: 5, liveChannelSku: 'Q-OWN-IT' } })
    await product('Q-ALIAS')
    await listing({ name: 'qAliasMain', productSku: 'Q-ALIAS', account: acc.a, data: { ...FBM, quantity: 6 } })
    await listing({ name: 'qAliasExtra', productSku: 'Q-ALIAS', account: acc.a, data: { ...FBM, quantity: 2, aliasKey: 'extra-1', liveChannelSku: 'Q-ALIAS-X' } })
    await product('Q-B'); await listing({ name: 'qB', productSku: 'Q-B', account: acc.b, data: { ...FBM, quantity: 9 } })
    await product('Q-DUP-1'); await listing({ name: 'qDup1', productSku: 'Q-DUP-1', account: acc.a, data: { ...FBM, quantity: 1, liveChannelSku: 'Q-DUP' } })
    await product('Q-DUP-2'); await listing({ name: 'qDup2', productSku: 'Q-DUP-2', account: acc.a, data: { ...FBM, quantity: 1, liveChannelSku: 'Q-DUP' } })

    // eBay status reconcile + inventory read-back.
    await product('E-PLAIN'); await listing({ name: 'ePlain', productSku: 'E-PLAIN', channel: 'EBAY', account: acc.ebay })
    await product('E-OWN'); await listing({ name: 'eOwn', productSku: 'E-OWN', channel: 'EBAY', account: acc.ebay, data: { liveChannelSku: 'E-OWN-IT' } })
    await product('E-B'); await listing({ name: 'eB', productSku: 'E-B', channel: 'EBAY', account: acc.ebay2 })
    await product('E-ALIAS'); await listing({ name: 'eAliasMain', productSku: 'E-ALIAS', channel: 'EBAY', account: acc.ebay })
    const alias = await prisma.productListingAlias.create({ data: { productId: pid['E-ALIAS'], channel: 'EBAY', marketplace: 'IT', channelConnectionId: acc.ebay, label: 'Second', position: 1, sku: 'E-ALIAS-X' } })
    // S4 — an eBay extra listing's alias SKU was never sent to eBay (wanted only): eBay holds it once it is confirmed.
    await listing({ name: 'eAliasExtra', productSku: 'E-ALIAS', channel: 'EBAY', account: acc.ebay, data: { aliasId: alias.id, aliasKey: alias.id, liveChannelSku: 'E-ALIAS-X' } })
    await product('E-SHARED'); await listing({ name: 'eShared', productSku: 'E-SHARED', channel: 'EBAY', account: acc.ebay, data: { liveChannelSku: 'E-SHARED-OWN' } })
    await prisma.sharedListingMembership.create({ data: { marketplace: 'IT', sku: 'E-SHARED-OWN', itemId: '7000001', parentSku: 'E-SHARED', productId: pid['E-SHARED'], variationSpecifics: { Taglia: 'M' } } })

    // eBay inventory drift: an Inventory-managed family.
    await product('FAM', { isParent: true })
    await listing({ name: 'fam', productSku: 'FAM', channel: 'EBAY', account: acc.ebay, data: { externalListingId: '9100000001', platformAttributes: { __offerIds: { EBAY_IT: 'offer-1' } } } })
    await product('FAM-S', { parentId: pid.FAM }); await listing({ name: 'famS', productSku: 'FAM-S', channel: 'EBAY', account: acc.ebay, data: { channelSku: 'FAM-S-OWN' } })
    await product('FAM-M', { parentId: pid.FAM }); await listing({ name: 'famM', productSku: 'FAM-M', channel: 'EBAY', account: acc.ebay })
    await listing({ name: 'famMOther', productSku: 'FAM-M', channel: 'EBAY', account: acc.ebay2, data: { channelSku: 'FAM-M-ON-2' } })
    await product('FAM-L', { parentId: pid.FAM })

    // FBA drift detector: FBA stock on hand.
    const fba = (await prisma.stockLocation.create({ data: { type: 'AMAZON_FBA', code: 'AMAZON-EU-FBA', name: 'Amazon FBA (test)' } })).id
    for (const sku of ['D-PLAIN', 'D-OWN', 'D-B', 'D-TWO']) {
      await product(sku, { fulfillmentMethod: 'FBA' })
      await prisma.stockLevel.create({ data: { productId: pid[sku], locationId: fba, quantity: 5, reserved: 0, available: 5 } })
    }
    await listing({ name: 'dPlain', productSku: 'D-PLAIN', account: acc.a, data: { fulfillmentMethod: 'FBA' } })
    await listing({ name: 'dOwn', productSku: 'D-OWN', account: acc.a, data: { fulfillmentMethod: 'FBA', liveChannelSku: 'D-OWN-IT' } })
    await listing({ name: 'dB', productSku: 'D-B', account: acc.b, data: { fulfillmentMethod: 'FBA' } })
    await listing({ name: 'dTwo', productSku: 'D-TWO', account: acc.a, data: { fulfillmentMethod: 'FBA' }, offers: [['D-TWO-A', 'FBA'], ['D-TWO-B', 'FBM']] })
  })
}, 120_000)
afterAll(async () => { await s.db?.close() })

describe('Amazon quantity read-back — our listings keyed by the seller SKU Amazon knows each by', () => {
  it('pure: parity (no own SKU → the product SKU); an own SKU; two listings on one SKU and an alias with no SKU of its own are left out with a sentence', () => {
    const base = { channel: 'AMAZON', listingStatus: 'ACTIVE', isPublished: true, quantity: 1, price: 10 }
    const keyed = keyReadbackRows([
      { ...base, id: 'l1', productId: 'p1', product: { sku: 'P1' } },
      { ...base, id: 'l2', productId: 'p2', product: { sku: 'P2' }, liveChannelSku: 'P2-OWN' },
      { ...base, id: 'l3', productId: 'p3', product: { sku: 'P3' }, liveChannelSku: 'SAME' },
      { ...base, id: 'l4', productId: 'p4', product: { sku: 'P4' }, liveChannelSku: 'SAME' },
      { ...base, id: 'l5', productId: 'p1', product: { sku: 'P1' }, aliasKey: 'extra' },
    ])
    expect(keyed.rows).toEqual([
      { sku: 'P1', quantity: 1, price: 10, channelListingId: 'l1', productId: 'p1' },
      { sku: 'P2-OWN', quantity: 1, price: 10, channelListingId: 'l2', productId: 'p2' },
    ])
    expect(keyed.skipped).toEqual([
      { channelListingId: 'l5', reason: 'P1: this alias needs its own Amazon seller SKU before publishing.' },
      { channelListingId: 'l3', reason: 'SAME is the seller SKU of 2 listings in this market. Nexus did not pick one.' },
      { channelListingId: 'l4', reason: 'SAME is the seller SKU of 2 listings in this market. Nexus did not pick one.' },
    ])
  })

  it('🔴 end to end: each mismatch heals ITS listing — parity for the master SKU, the own SKU, the alias (no collision); another account and ambiguous rows never', async () => {
    s.account = acc.a; s.heals.length = 0; s.cron.length = 0
    process.env.NEXUS_QTY_READBACK_MARKETS = 'IT'
    s.catalog = { APJ6JRA9NG5V4: [
      { sku: 'Q-PLAIN', quantity: 1 }, { sku: 'Q-OWN-IT', quantity: 2 }, { sku: 'Q-OWN', quantity: 0 },
      { sku: 'Q-ALIAS', quantity: 6 }, { sku: 'Q-ALIAS-X', quantity: 0 }, { sku: 'Q-B', quantity: 0 }, { sku: 'Q-DUP', quantity: 0 },
    ] }
    const summary = await scoped(() => runAmazonQtyReadback())
    expect(s.heals.sort((x, y) => x.channelListingId.localeCompare(y.channelListingId))).toEqual([
      { channelListingId: lid.qPlain, quantity: 4 },
      { channelListingId: lid.qOwn, quantity: 5 },
      { channelListingId: lid.qAliasExtra, quantity: 2 },
    ].sort((x, y) => x.channelListingId.localeCompare(y.channelListingId)))
    expect(summary).toContain('compared=4 mismatches=3')
    expect(summary).toContain('sku: notCompared=2')
    delete process.env.NEXUS_QTY_READBACK_MARKETS
  })
})

describe('eBay inventory read-back — each listing read under its own SKU, recorded on its product', () => {
  it('parity for a master SKU; an own SKU and an extra listing\'s SKU are read and recorded on the listing\'s product; a shared member is skipped by its own SKU', async () => {
    s.inventoryAsked.length = 0; s.events.length = 0
    await scoped(() => readBackEbayInventory())
    expect(s.inventoryAsked).not.toContain('E-SHARED-OWN')
    expect(s.inventoryAsked).not.toContain('E-SHARED')
    expect(s.inventoryAsked).not.toContain('E-OWN')
    const recorded = Object.fromEntries(s.events.map(e => [e.sku, e.productId]))
    expect(recorded).toMatchObject({ 'E-PLAIN': pid['E-PLAIN'], 'E-OWN-IT': pid['E-OWN'], 'E-ALIAS': pid['E-ALIAS'], 'E-ALIAS-X': pid['E-ALIAS'] })
  })
})

describe('eBay inventory drift — the variant SKUs a Full Publish would send', () => {
  it('each variant\'s own SKU on this account (else its product SKU, as before); another account\'s own SKU is not this account\'s', async () => {
    s.groups = { FAM: { title: 'Family title', variantSKUs: ['FAM-S-OWN', 'FAM-M', 'FAM-L'] } }
    const report = await scoped(() => collectInventoryDrift(prisma as never, { marketplace: 'IT', oauthToken: 't', connectionId: acc.ebay }))
    const family = report.families.find(f => f.parentSku === 'FAM')!
    expect(family).toMatchObject({ ok: true, drift: false })
    expect(family.fields.find(f => f.field === 'variantSKUs')).toMatchObject({ wouldPush: ['FAM-L', 'FAM-M', 'FAM-S-OWN'], drift: false })
    // Parity: eBay still holding the product SKU of the renamed variant is a drift (Full Publish would send the own SKU).
    s.groups = { FAM: { title: 'Family title', variantSKUs: ['FAM-S', 'FAM-M', 'FAM-L'] } }
    const before = await scoped(() => collectInventoryDrift(prisma as never, { marketplace: 'IT', oauthToken: 't', connectionId: acc.ebay }))
    expect(before.families.find(f => f.parentSku === 'FAM')).toMatchObject({ ok: true, drift: true })
  })
})

describe('eBay status reconcile — each listing asked under its own SKU, on its own account', () => {
  it('🔴 own SKU and an extra listing\'s SKU are asked; the master SKU of a renamed listing is not; another account\'s listing is never asked or changed', async () => {
    process.env.NEXUS_ENABLE_EBAY_STATUS_RECONCILE_CRON = '1'
    s.ebayAsked.length = 0
    const fixed = (sku: string, status: string) => [{ offerId: `o-${sku}`, sku, marketplaceId: 'EBAY_IT', format: 'FIXED_PRICE', status }]
    s.ebayOffers = { 'E-PLAIN': fixed('E-PLAIN', 'PUBLISHED'), 'E-OWN-IT': fixed('E-OWN-IT', 'UNPUBLISHED'), 'E-ALIAS': fixed('E-ALIAS', 'PUBLISHED'), 'E-B': fixed('E-B', 'UNPUBLISHED'),
      'E-SHARED-OWN': fixed('E-SHARED-OWN', 'PUBLISHED'), FAM: fixed('FAM', 'PUBLISHED'), 'FAM-S': fixed('FAM-S', 'PUBLISHED'), 'FAM-M': fixed('FAM-M', 'PUBLISHED') }
    await scoped(() => runEbayStatusReconcile())
    // FAM-S WANTS its own SKU but eBay has not confirmed it: eBay still knows it by FAM-S, so it is asked under FAM-S.
    expect(new Set(s.ebayAsked)).toEqual(new Set(['E-PLAIN', 'E-OWN-IT', 'E-ALIAS', 'E-ALIAS-X', 'E-SHARED-OWN', 'FAM', 'FAM-S', 'FAM-M']))
    const status = async (name: string) => (await scoped(() => prisma.channelListing.findUniqueOrThrow({ where: { id: lid[name] }, select: { listingStatus: true } }))).listingStatus
    expect({ plain: await status('ePlain'), own: await status('eOwn'), main: await status('eAliasMain'), extra: await status('eAliasExtra'), other: await status('eB') })
      .toEqual({ plain: 'ACTIVE', own: 'DRAFT', main: 'ACTIVE', extra: 'REMOVED', other: 'ACTIVE' })
    delete process.env.NEXUS_ENABLE_EBAY_STATUS_RECONCILE_CRON
  })
})

describe('FBA drift detector — expected-FBA seller SKUs are each listing\'s own', () => {
  it('🔴 a drift under the master SKU is restored as before; under an own SKU it is reported for a person, never auto-restored; the master SKU of a renamed listing, another account\'s listing and a listing with two seller SKUs are not checked', async () => {
    s.account = acc.a; s.restored.length = 0; s.cron.length = 0
    s.catalog = { APJ6JRA9NG5V4: [
      { sku: 'D-PLAIN', fulfillmentChannel: 'DEFAULT' }, { sku: 'D-OWN-IT', fulfillmentChannel: 'DEFAULT' }, { sku: 'D-OWN', fulfillmentChannel: 'DEFAULT' },
      { sku: 'D-B', fulfillmentChannel: 'DEFAULT' }, { sku: 'D-TWO-A', fulfillmentChannel: 'DEFAULT' },
    ] }
    await scoped(() => runFbaDriftDetector())
    expect(s.restored).toEqual([{ skus: ['D-PLAIN'], marketplaces: ['IT'], dryRun: false }])
    expect(s.cron).toEqual(['DRIFT: 2 FBA→FBM across 1 market(s); checked 2; 0 pull(s) failed; 1 listing(s) without one seller SKU not checked'])
  })

  it('parity: Amazon reporting the expected SKUs as FBA is no drift; nothing restored', async () => {
    s.account = acc.a; s.restored.length = 0; s.cron.length = 0
    s.catalog = { APJ6JRA9NG5V4: [{ sku: 'D-PLAIN', fulfillmentChannel: 'AMAZON_EU' }, { sku: 'D-OWN-IT', fulfillmentChannel: 'AMAZON_EU' }] }
    await scoped(() => runFbaDriftDetector())
    expect(s.restored).toEqual([])
    expect(s.cron[0]).toMatch(/^ok — no drift \(checked 2 sku\(s\)/)
  })
})
