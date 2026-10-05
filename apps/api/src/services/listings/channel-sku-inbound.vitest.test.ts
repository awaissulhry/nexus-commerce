/**
 * S6 — the one inbound match (orders and returns name a marketplace SKU; which product is it?) on PGlite with the
 * production schema and row-level security policies, business profiles ON. The helper's steps, and both return
 * ingests through it. The order writers' arms (stock included) live with their real-PostgreSQL suites:
 * ebay-order-writer-postgres, stock-model-postgres (Amazon, Shopify), etsy/etsy-order-ingest-postgres.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../../utils/logger.js', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }))
// The returns modules import the queue module, which opens Redis at import; nothing here enqueues.
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, channelSyncQueue: null, bulkJobQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn() }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { matchInboundSku, shopifyVariantListingStore, type InboundSkuStore } from './channel-sku-inbound.js'
import { ingestAmazonReturnRow } from '../amazon-returns/ingest.service.js'
import { ingestEbayReturn } from '../ebay-returns/ingest.service.js'

const OTHER_BUSINESS = 'skurows-inbound-other'
const as = (workspaceId: string) => <T>(work: () => Promise<T>) => withWorkspace({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const scoped = as(LEGACY_WORKSPACE_ID)
const other = as(OTHER_BUSINESS)
const flagBefore = process.env.NEXUS_WORKSPACES_ENABLED

const acc = { amazonA: '', amazonB: '', ebayA: '', ebayB: '', shopify: '', otherAmazon: '' }
const pid: Record<string, string> = {}
const lid: Record<string, string> = {}

async function product(sku: string, data: Record<string, unknown> = {}) {
  pid[sku] = (await prisma.product.create({ data: { sku, name: sku, basePrice: 10, ...data } as never })).id
  return pid[sku]
}
type ListingSeed = { name: string; productSku: string; channel?: string; marketplace?: string; account: string; data?: Record<string, unknown> }
async function listing(seed: ListingSeed) {
  const channel = seed.channel ?? 'AMAZON'
  const marketplace = seed.marketplace ?? 'IT'
  const row = await prisma.channelListing.create({ data: {
    productId: pid[seed.productSku], channel, marketplace, region: marketplace, channelMarket: `${channel}_${marketplace}`,
    channelConnectionId: seed.account, aliasKey: '', listingStatus: 'ACTIVE', isPublished: true, ...seed.data,
  } as never })
  lid[seed.name] = row.id
  return row.id
}
const connection = (channelType: string, label: string) => prisma.channelConnection.create({ data: { channelType, accountLabel: label, externalAccountId: label, isActive: true, isPrimary: false } as never }).then(c => c.id)
const order = (channel: string, channelOrderId: string, data: Record<string, unknown> = {}) => prisma.order.create({ data: {
  channel, channelOrderId, totalPrice: 10, customerName: 'Buyer', customerEmail: 'buyer@example.test', shippingAddress: {}, ...data,
} as never })

beforeAll(async () => {
  process.env.NEXUS_WORKSPACES_ENABLED = '1'
  await scoped(async () => {
    acc.amazonA = await connection('AMAZON', 'inbound-amazon-a')
    acc.amazonB = await connection('AMAZON', 'inbound-amazon-b')
    acc.ebayA = await connection('EBAY', 'inbound-ebay-a')
    acc.ebayB = await connection('EBAY', 'inbound-ebay-b')
    acc.shopify = await connection('SHOPIFY', 'inbound-shopify')
    // (a) a listing that follows the master SKU.
    await product('M-PLAIN'); await listing({ name: 'plain', productSku: 'M-PLAIN', account: acc.amazonA })
    // (b) a listing's own SKU, on this account and market.
    await product('M-OWN'); await listing({ name: 'ownIT', productSku: 'M-OWN', account: acc.amazonA, data: { channelSku: 'OWN-IT' } })
    // A SKU only another market's listing holds (one Amazon EU seller SKU sells in several markets).
    await product('M-DE'); await listing({ name: 'de', productSku: 'M-DE', marketplace: 'DE', account: acc.amazonA, data: { channelSku: 'DE-ONLY' } })
    // (c) another account of this business.
    await product('M-ACC-B'); await listing({ name: 'accB', productSku: 'M-ACC-B', account: acc.amazonB, data: { channelSku: 'ACC-B-1' } })
    // (d) two products, one SKU on one account.
    await product('AMB-A'); await listing({ name: 'ambA', productSku: 'AMB-A', account: acc.amazonA, data: { channelSku: 'AMB-1' } })
    await product('AMB-B'); await listing({ name: 'ambB', productSku: 'AMB-B', marketplace: 'DE', account: acc.amazonA, data: { channelSku: 'AMB-1' } })
    await product('AMB-C'); await listing({ name: 'ambC', productSku: 'AMB-C', account: acc.amazonA, data: { channelSku: 'AMB-2' } })
    await product('AMB-D'); await listing({ name: 'ambD', productSku: 'AMB-D', account: acc.amazonA, data: { channelSku: 'AMB-2' } })
    // (e) renamed in Nexus (OLD-SKU → NEW-SKU) while the channel still holds OLD-SKU.
    await product('NEW-SKU'); await listing({ name: 'renamed', productSku: 'NEW-SKU', account: acc.amazonA, data: { channelSku: 'OLD-SKU', liveChannelSku: 'OLD-SKU' } })
    // A product in the trash keeps its master SKU, and matches by it exactly as before S6 (parity).
    await product('M-GONE', { deletedAt: new Date() })
    // …but a listing SKU of a trashed product is not read (the resolver's listing steps leave the trash out).
    await listing({ name: 'gone', productSku: 'M-GONE', account: acc.amazonA, data: { channelSku: 'GONE-OWN' } })
    // eBay: its own SKU on account A; the same SKU text on account B for another product.
    await product('E-OWN'); await listing({ name: 'ebayOwn', productSku: 'E-OWN', channel: 'EBAY', account: acc.ebayA, data: { channelSku: 'EBAY-OWN-1' } })
    await product('E-OTHER'); await listing({ name: 'ebayOther', productSku: 'E-OTHER', channel: 'EBAY', account: acc.ebayB, data: { channelSku: 'EBAY-B-ONLY' } })
    await product('E-AMB-A'); await listing({ name: 'ebayAmbA', productSku: 'E-AMB-A', channel: 'EBAY', account: acc.ebayA, data: { channelSku: 'EBAY-AMB' } })
    await product('E-AMB-B'); await listing({ name: 'ebayAmbB', productSku: 'E-AMB-B', channel: 'EBAY', marketplace: 'DE', account: acc.ebayA, data: { channelSku: 'EBAY-AMB' } })
    await product('E-NEW'); await listing({ name: 'ebayRenamed', productSku: 'E-NEW', channel: 'EBAY', account: acc.ebayA, data: { liveChannelSku: 'E-OLD' } })
    // Shopify: the variant a listing records.
    await product('S-VARIANT'); await listing({ name: 'shopifyVariant', productSku: 'S-VARIANT', channel: 'SHOPIFY', marketplace: 'GLOBAL', account: acc.shopify, data: { platformAttributes: { variantId: '4401' } } })
    // Orders the returns name.
    await order('AMAZON', 'AMZ-RET-1', { channelConnectionId: acc.amazonA, marketplace: 'IT' })
    await order('EBAY', 'EBAY-RET-ORDER', { channelConnectionId: acc.ebayA })
  })
  await prisma.workspace.create({ data: { id: OTHER_BUSINESS, name: 'Other business', createdByUserId: 'inbound', creationKey: 'inbound-other' } as never })
  await other(async () => {
    acc.otherAmazon = await connection('AMAZON', 'inbound-other-amazon')
    await product('FOREIGN-P'); await listing({ name: 'foreign', productSku: 'FOREIGN-P', account: acc.otherAmazon, data: { channelSku: 'FOREIGN-CH' } })
  })
}, 120_000)
afterAll(async () => {
  if (flagBefore === undefined) delete process.env.NEXUS_WORKSPACES_ENABLED
  else process.env.NEXUS_WORKSPACES_ENABLED = flagBefore
  await state.db?.close()
})

type MatchInput = Parameters<typeof matchInboundSku>[1]
const match = (input: Partial<MatchInput> & { sku?: string | null }) =>
  scoped(() => prisma.$transaction(tx => matchInboundSku(tx, { channel: 'AMAZON', channelConnectionId: acc.amazonA, marketplace: 'IT', ...input })))
const store = (name: string, ids: () => string[], label?: string): InboundSkuStore & { calls: number } => {
  const s = { name, ...(label ? { label } : {}), calls: 0, find: async () => { s.calls++; return ids() } }
  return s
}

describe('matchInboundSku — one way back from a marketplace SKU to a product', () => {
  it('(a) parity: a SKU equal to the master SKU matches that product, with its listing in the market', async () => {
    expect(await match({ sku: 'M-PLAIN' })).toEqual({ productId: pid['M-PLAIN'], listingId: lid.plain, via: 'product' })
    // Without an account (an order with no account link) the master SKU still matches, as before.
    expect(await match({ sku: 'M-PLAIN', channelConnectionId: null })).toEqual({ productId: pid['M-PLAIN'], listingId: null, via: 'product' })
    expect(await match({ sku: ' M-PLAIN ', channelConnectionId: null, marketplace: null })).toMatchObject({ productId: pid['M-PLAIN'] })
  })

  it('(b) a listing\'s own SKU on this account matches its product; another market\'s own SKU too, when the market has none', async () => {
    expect(await match({ sku: 'OWN-IT' })).toEqual({ productId: pid['M-OWN'], listingId: lid.ownIT, via: 'channel' })
    expect(await match({ sku: 'DE-ONLY' })).toEqual({ productId: pid['M-DE'], listingId: lid.de, via: 'channel' })
    expect(await match({ sku: 'DE-ONLY', marketplace: 'FR' })).toEqual({ productId: pid['M-DE'], listingId: lid.de, via: 'channel' })
    // A listing SKU needs the account: without one, only the master SKU is read.
    expect(await match({ sku: 'OWN-IT', channelConnectionId: null })).toEqual({ productId: null, listingId: null, via: null })
  })

  it('(c) 🔴 another account of this business, or another business, never matches', async () => {
    expect(await match({ sku: 'ACC-B-1' })).toEqual({ productId: null, listingId: null, via: null })
    expect(await match({ sku: 'ACC-B-1', channelConnectionId: acc.amazonB })).toMatchObject({ productId: pid['M-ACC-B'], via: 'channel' })
    expect(await match({ sku: 'FOREIGN-CH' })).toEqual({ productId: null, listingId: null, via: null })
    expect(await match({ sku: 'FOREIGN-CH', channelConnectionId: acc.otherAmazon })).toEqual({ productId: null, listingId: null, via: null })
    expect(await match({ sku: 'FOREIGN-P', channelConnectionId: null })).toEqual({ productId: null, listingId: null, via: null })
    // Positive control: the rows exist, in the other business.
    expect(await other(() => prisma.$transaction(tx => matchInboundSku(tx, { channel: 'AMAZON', channelConnectionId: acc.otherAmazon, sku: 'FOREIGN-CH' }))))
      .toMatchObject({ productId: pid['FOREIGN-P'], via: 'channel' })
  })

  it('(d) two products: not linked, never picked, one plain sentence naming their SKUs', async () => {
    const found = await match({ sku: 'AMB-1', marketplace: 'FR' })
    expect(found).toEqual({ productId: null, listingId: null, via: 'channel', problem: {
      code: 'AMBIGUOUS', productIds: [pid['AMB-A'], pid['AMB-B']].sort(), productSkus: expect.arrayContaining(['AMB-A', 'AMB-B']),
      sentence: expect.stringMatching(/^The Amazon SKU AMB-1 matches more than one product \((AMB-A, AMB-B|AMB-B, AMB-A)\)\. Nexus did not pick one, so this line is not linked to a product\. Give each product its own SKU on this Amazon account\.$/),
    } })
    // Inside a market that holds it once, that market's listing decides.
    expect(await match({ sku: 'AMB-1', marketplace: 'IT' })).toMatchObject({ productId: pid['AMB-A'], listingId: lid.ambA })
  })

  it('(e) a SKU renamed in Nexus that the channel still holds (live = OLD) still matches; the new master SKU too', async () => {
    expect(await match({ sku: 'OLD-SKU' })).toEqual({ productId: pid['NEW-SKU'], listingId: lid.renamed, via: 'live' })
    expect(await match({ sku: 'NEW-SKU' })).toMatchObject({ productId: pid['NEW-SKU'], via: 'product' })
  })

  it('parity: a product in the trash still matches by its master SKU, with or without an account, as before; not by a listing SKU', async () => {
    expect(await match({ sku: 'M-GONE' })).toEqual({ productId: pid['M-GONE'], listingId: null, via: 'product' })
    expect(await match({ sku: 'M-GONE', channelConnectionId: null })).toEqual({ productId: pid['M-GONE'], listingId: null, via: 'product' })
    expect(await match({ sku: 'GONE-OWN' })).toEqual({ productId: null, listingId: null, via: null })
    // The master SKU still comes after the writer's account stores and before its fallbacks.
    expect(await match({ sku: 'M-GONE', accountStores: [store('accountStore', () => [pid['M-OWN']])] })).toMatchObject({ productId: pid['M-OWN'], via: 'accountStore' })
    const fallback = store('asin', () => [pid['M-OWN']])
    expect(await match({ sku: 'M-GONE', fallbacks: [fallback] })).toMatchObject({ productId: pid['M-GONE'], via: 'product' })
    expect(fallback.calls).toBe(0)
  })

  it('an unknown or empty SKU: no match', async () => {
    expect(await match({ sku: 'NOPE' })).toEqual({ productId: null, listingId: null, via: null })
    expect(await match({ sku: '   ' })).toEqual({ productId: null, listingId: null, via: null })
    expect(await match({ sku: null })).toEqual({ productId: null, listingId: null, via: null })
  })

  it('a writer\'s account stores come before the master SKU; its fallbacks after it, in order, and only when needed', async () => {
    const account = store('accountStore', () => [pid['M-OWN']])
    expect(await match({ sku: 'M-PLAIN', accountStores: [account] })).toEqual({ productId: pid['M-OWN'], listingId: null, via: 'accountStore' })
    // A listing step still comes first.
    expect(await match({ sku: 'OWN-IT', accountStores: [store('accountStore', () => [pid['M-PLAIN']])] })).toMatchObject({ productId: pid['M-OWN'], via: 'channel' })
    // Account store ambiguity: not linked, and the master SKU is not used.
    expect(await match({ sku: 'M-PLAIN', accountStores: [store('accountStore', () => [pid['AMB-A'], pid['AMB-B']])] }))
      .toMatchObject({ productId: null, via: 'accountStore', problem: { code: 'AMBIGUOUS', productIds: [pid['AMB-A'], pid['AMB-B']].sort() } })
    const unused = store('asin', () => [pid['M-OWN']])
    expect(await match({ sku: 'M-PLAIN', fallbacks: [unused] })).toMatchObject({ productId: pid['M-PLAIN'], via: 'product' })
    expect(unused.calls).toBe(0)
    const empty = store('first', () => []), second = store('asin', () => [pid['M-OWN']], 'ASIN B0TEST')
    expect(await match({ sku: 'NOPE', fallbacks: [empty, second] })).toEqual({ productId: pid['M-OWN'], listingId: null, via: 'asin' })
    expect(empty.calls).toBe(1)
    // A line with no SKU still reaches the fallbacks (an Amazon line with only an ASIN).
    expect(await match({ sku: null, fallbacks: [store('asin', () => [pid['M-OWN']])] })).toMatchObject({ productId: pid['M-OWN'], via: 'asin' })
    expect((await match({ sku: null, fallbacks: [store('asin', () => [pid['AMB-A'], pid['AMB-B']], 'ASIN B0TEST')] })).problem?.sentence)
      .toMatch(/^The Amazon ASIN B0TEST matches more than one product/)
  })

  it('Shopify: a line\'s variant id names the listing on THIS store that records it; nothing without a store', async () => {
    const variant = (connectionId: string | null, variantId: unknown) =>
      scoped(() => prisma.$transaction(tx => matchInboundSku(tx, { channel: 'SHOPIFY', channelConnectionId: connectionId, sku: 'UNKNOWN-TITLE', fallbacks: [shopifyVariantListingStore(tx, connectionId, variantId)] })))
    expect(await variant(acc.shopify, 4401)).toEqual({ productId: pid['S-VARIANT'], listingId: null, via: 'shopifyVariant' })
    expect(await variant(acc.shopify, 'gid://shopify/ProductVariant/4401')).toMatchObject({ productId: pid['S-VARIANT'] })
    expect(await variant(acc.shopify, 9999)).toEqual({ productId: null, listingId: null, via: null })
    expect(await variant(acc.amazonA, 4401)).toEqual({ productId: null, listingId: null, via: null })
    expect(await variant(null, 4401)).toEqual({ productId: null, listingId: null, via: null })
    expect(await variant(acc.shopify, null)).toEqual({ productId: null, listingId: null, via: null })
  })
})

const returnItems = (returnId: string) => scoped(() => prisma.returnItem.findMany({ where: { returnId }, select: { sku: true, productId: true } }))
const auditOf = async (returnId: string) => (await scoped(() => prisma.auditLog.findFirst({ where: { entityType: 'Return', entityId: returnId }, select: { metadata: true } })))?.metadata as Record<string, any>
let rowSeq = 0
const amazonRow = (sku: string, orderId = 'AMZ-RET-1') => ({ 'order-id': orderId, sku, quantity: '1', 'return-date': `2026-10-0${1 + (rowSeq++ % 8)}T00:00:${String(rowSeq).padStart(2, '0')}Z`, status: 'Returned' })
const amazonReturn = async (sku: string, orderId?: string) => {
  const out = await scoped(() => ingestAmazonReturnRow(amazonRow(sku, orderId), { isFba: false, marketplace: 'APJ6JRA9NG5V4' }))
  expect(out.outcome).toBe('created')
  return { items: await returnItems(out.returnId!), audit: await auditOf(out.returnId!) }
}

describe('Amazon returns report → the inbound match on the order\'s account and market', () => {
  it('(a) master SKU, (b) the listing\'s own SKU, (e) the SKU Amazon still holds after a rename', async () => {
    expect((await amazonReturn('M-PLAIN')).items).toEqual([{ sku: 'M-PLAIN', productId: pid['M-PLAIN'] }])
    expect((await amazonReturn('OWN-IT')).items).toEqual([{ sku: 'OWN-IT', productId: pid['M-OWN'] }])
    expect((await amazonReturn('OLD-SKU')).items).toEqual([{ sku: 'OLD-SKU', productId: pid['NEW-SKU'] }])
  })

  it('parity: a return of a trashed product\'s master SKU links to it, as before (with and without its order)', async () => {
    expect((await amazonReturn('M-GONE')).items).toEqual([{ sku: 'M-GONE', productId: pid['M-GONE'] }])
    expect((await amazonReturn('M-GONE', 'AMZ-NO-SUCH-ORDER')).items).toEqual([{ sku: 'M-GONE', productId: pid['M-GONE'] }])
  })

  it('(c) another account\'s SKU is not linked; a return without its order reads the master SKU only, as before', async () => {
    expect((await amazonReturn('ACC-B-1')).items).toEqual([{ sku: 'ACC-B-1', productId: null }])
    expect((await amazonReturn('OWN-IT', 'AMZ-NO-SUCH-ORDER')).items).toEqual([{ sku: 'OWN-IT', productId: null }])
    expect((await amazonReturn('M-PLAIN', 'AMZ-NO-SUCH-ORDER')).items).toEqual([{ sku: 'M-PLAIN', productId: pid['M-PLAIN'] }])
  })

  it('(d) a SKU two products hold: not linked, and the return\'s audit row says why', async () => {
    const { items, audit } = await amazonReturn('AMB-2')
    expect(items).toEqual([{ sku: 'AMB-2', productId: null }])
    expect(audit.unlinkedReason).toMatch(/^The Amazon SKU AMB-2 matches more than one product \(AMB-[CD], AMB-[CD]\)/)
    // The order's market holds AMB-1 once: that market's listing decides.
    expect((await amazonReturn('AMB-1')).items).toEqual([{ sku: 'AMB-1', productId: pid['AMB-A'] }])
  })
})

const ebayReturn = async (sku: string, opts: { connectionId?: string | null } = {}, transactionId?: string) => {
  const out = await scoped(() => ingestEbayReturn({ returnId: `EBAY-RET-${++rowSeq}`, state: 'RETURN_REQUESTED', creationInfo: { item: { sku, quantity: 1, transactionId } } }, opts))
  expect(out.outcome).toBe('created')
  return { items: await returnItems(out.returnId!), audit: await auditOf(out.returnId!) }
}

describe('eBay returns → the inbound match on the account the return came from', () => {
  it('(a) master SKU, (b) the listing\'s own SKU, (e) the SKU eBay still holds after a rename', async () => {
    expect((await ebayReturn('M-PLAIN', { connectionId: acc.ebayA })).items).toEqual([{ sku: 'M-PLAIN', productId: pid['M-PLAIN'] }])
    expect((await ebayReturn('EBAY-OWN-1', { connectionId: acc.ebayA })).items).toEqual([{ sku: 'EBAY-OWN-1', productId: pid['E-OWN'] }])
    expect((await ebayReturn('E-OLD', { connectionId: acc.ebayA })).items).toEqual([{ sku: 'E-OLD', productId: pid['E-NEW'] }])
    // No account given (the test route): the order's account is used.
    expect((await ebayReturn('EBAY-OWN-1', {}, 'EBAY-RET-ORDER')).items).toEqual([{ sku: 'EBAY-OWN-1', productId: pid['E-OWN'] }])
  })

  it('parity: a return of a trashed product\'s master SKU links to it, as before (with and without an account)', async () => {
    expect((await ebayReturn('M-GONE', { connectionId: acc.ebayA })).items).toEqual([{ sku: 'M-GONE', productId: pid['M-GONE'] }])
    expect((await ebayReturn('M-GONE')).items).toEqual([{ sku: 'M-GONE', productId: pid['M-GONE'] }])
  })

  it('(c) another eBay account\'s SKU is not linked; without any account only the master SKU is read', async () => {
    expect((await ebayReturn('EBAY-B-ONLY', { connectionId: acc.ebayA })).items).toEqual([{ sku: 'EBAY-B-ONLY', productId: null }])
    expect((await ebayReturn('EBAY-B-ONLY', { connectionId: acc.ebayB })).items).toEqual([{ sku: 'EBAY-B-ONLY', productId: pid['E-OTHER'] }])
    expect((await ebayReturn('EBAY-OWN-1')).items).toEqual([{ sku: 'EBAY-OWN-1', productId: null }])
  })

  it('(d) a SKU two products hold: not linked, and the return\'s audit row says why', async () => {
    const { items, audit } = await ebayReturn('EBAY-AMB', { connectionId: acc.ebayA })
    expect(items).toEqual([{ sku: 'EBAY-AMB', productId: null }])
    expect(audit.unlinked).toEqual([{ sku: 'EBAY-AMB', reason: expect.stringMatching(/^The eBay SKU EBAY-AMB matches more than one product \(E-AMB-., E-AMB-.\)/) }])
  })
})
