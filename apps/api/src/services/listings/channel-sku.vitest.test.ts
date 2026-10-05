/**
 * S2 — the per-listing channel SKU on real PostgreSQL (PGlite: production schema and row-level security policies):
 * matching a channel's SKU back (order of the steps, account scope, market, ambiguity, trashed products, another
 * business) and the one writer (validation, uniqueness refusals, version, history), plus the live-SKU writers.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../../utils/logger.js', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { ChannelSkuError, clearLiveChannelSku, confirmLiveChannelSku, productForChannelSku, setChannelSku } from './channel-sku.js'

const OTHER_BUSINESS = 'skurows-other-business'
const as = (workspaceId: string) => <T>(work: () => Promise<T>) => withWorkspace({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const scoped = as(LEGACY_WORKSPACE_ID)
const other = as(OTHER_BUSINESS)

const acc = { amazonA: '', amazonB: '', ebay: '', otherBusiness: '' }
const pid: Record<string, string> = {}
const lid: Record<string, string> = {}

async function product(sku: string, data: Record<string, unknown> = {}) {
  pid[sku] = (await prisma.product.create({ data: { sku, name: sku, basePrice: 10, ...data } as never })).id
  return pid[sku]
}
type ListingSeed = { name: string; productSku: string; channel?: string; marketplace?: string; account?: string | null; data?: Record<string, unknown>; offers?: Array<{ sku: string; isActive: boolean; method?: 'FBA' | 'FBM' }> }
async function listing(seed: ListingSeed) {
  const channel = seed.channel ?? 'AMAZON'
  const marketplace = seed.marketplace ?? 'IT'
  const row = await prisma.channelListing.create({ data: {
    productId: pid[seed.productSku], channel, marketplace, region: marketplace, channelMarket: `${channel}_${marketplace}`,
    channelConnectionId: seed.account === undefined ? acc.amazonA : seed.account, aliasKey: '', listingStatus: 'ACTIVE', isPublished: true,
    ...seed.data,
  } as never })
  for (const o of seed.offers ?? []) await prisma.offer.create({ data: { channelListingId: row.id, sku: o.sku, fulfillmentMethod: o.method ?? 'FBM', isActive: o.isActive } })
  lid[seed.name] = row.id
  return row.id
}
const connection = (channelType: string, label: string) => prisma.channelConnection.create({ data: { channelType, accountLabel: label, externalAccountId: label, isActive: true, isPrimary: false } as never }).then(c => c.id)

beforeAll(async () => {
  await scoped(async () => {
    acc.amazonA = await connection('AMAZON', 'skurows-amazon-a')
    acc.amazonB = await connection('AMAZON', 'skurows-amazon-b')
    acc.ebay = await connection('EBAY', 'skurows-ebay')
    // Match-back: one step each.
    await product('P-LIVE'); await listing({ name: 'live', productSku: 'P-LIVE', data: { liveChannelSku: 'LIVE-1', channelSku: 'WANT-1' } })
    await product('P-CHAN'); await listing({ name: 'chan', productSku: 'P-CHAN', data: { channelSku: 'CHAN-1' } })
    await product('P-OFFER')
    await listing({ name: 'offerIT', productSku: 'P-OFFER', offers: [{ sku: 'OFF-1', isActive: true }] })
    await listing({ name: 'offerDE', productSku: 'P-OFFER', marketplace: 'DE', offers: [{ sku: 'OFF-1', isActive: true }] })
    await product('P-OLD'); await listing({ name: 'old', productSku: 'P-OLD', offers: [{ sku: 'OLD-OFF', isActive: false }] })
    await product('P-ATTR'); await listing({ name: 'attr', productSku: 'P-ATTR', data: { platformAttributes: { seller_sku: 'ATTR-1' } } })
    await product('P-FF'); await listing({ name: 'ff', productSku: 'P-FF', data: { flatFileSnapshot: { item_sku: 'FF-1' } } })
    await product('PLAIN-1'); await listing({ name: 'plain', productSku: 'PLAIN-1' })
    // DE has its own SKU, confirmed by the channel: the master SKU no longer names that listing.
    await listing({ name: 'plainOwn', productSku: 'PLAIN-1', marketplace: 'DE', data: { channelSku: 'PLAIN-1-DE', liveChannelSku: 'PLAIN-1-DE' } })
    // Order of the steps: the confirmed SKU beats a wanted one; a wanted one beats an old store; an old store beats a master SKU.
    await product('Q-A'); await listing({ name: 'qa', productSku: 'Q-A', data: { liveChannelSku: 'ORDER-X' } })
    await product('Q-B'); await listing({ name: 'qb', productSku: 'Q-B', data: { channelSku: 'ORDER-X' } })
    await product('Q-C'); await listing({ name: 'qc', productSku: 'Q-C', offers: [{ sku: 'ORDER-Y', isActive: true }] })
    await product('Q-D'); await listing({ name: 'qd', productSku: 'Q-D', data: { channelSku: 'ORDER-Y' } })
    await product('LEG-WINS')
    await product('Q-E'); await listing({ name: 'qe', productSku: 'Q-E', data: { platformAttributes: { sellerSku: 'LEG-WINS' } } })
    // Ambiguity, account scope, trash.
    await product('DUP-A'); await listing({ name: 'dupA', productSku: 'DUP-A', data: { channelSku: 'DUP-1' } })
    await product('DUP-B'); await listing({ name: 'dupB', productSku: 'DUP-B', data: { channelSku: 'DUP-1' } })
    await product('P-SCOPED'); await listing({ name: 'scoped', productSku: 'P-SCOPED', account: acc.amazonB, data: { channelSku: 'SCOPED-1' } })
    await product('P-GONE', { deletedAt: new Date() }); await listing({ name: 'gone', productSku: 'P-GONE', data: { channelSku: 'GONE-1' } })
    // Shopify and an eBay alias on their own accounts.
    await product('P-EBAY', { isParent: true })
    const alias = await prisma.productListingAlias.create({ data: { productId: pid['P-EBAY'], channel: 'EBAY', marketplace: 'IT', channelConnectionId: acc.ebay, label: 'Second', position: 1, sku: 'EBAY-ALIAS-1' } })
    await listing({ name: 'ebayAlias', productSku: 'P-EBAY', channel: 'EBAY', account: acc.ebay, data: { aliasId: alias.id, aliasKey: alias.id } })
    // Writer fixtures.
    await product('W-ME'); await listing({ name: 'me', productSku: 'W-ME' }); await listing({ name: 'meDE', productSku: 'W-ME', marketplace: 'DE' })
    await listing({ name: 'meOtherAccount', productSku: 'W-ME', account: acc.amazonB })
    await listing({ name: 'unattributed', productSku: 'W-ME', marketplace: 'FR', account: null })
    await product('W-HOLDER'); await listing({ name: 'holder', productSku: 'W-HOLDER', data: { channelSku: 'Held-1' }, offers: [{ sku: 'HELD-BY-OFFER', isActive: false }] })
    await listing({ name: 'holderB', productSku: 'W-HOLDER', account: acc.amazonB, data: { channelSku: 'ONLY-ON-B' } })
    await product('W-MASTER')
    await product('W-ALIAS-ROOT', { isParent: true })
    await prisma.productListingAlias.create({ data: { productId: pid['W-ALIAS-ROOT'], channel: 'EBAY', marketplace: 'IT', channelConnectionId: acc.ebay, label: 'Extra', position: 1, sku: 'W-ALIAS-SKU' } })
    // The live-SKU writers.
    await product('W-LIVE'); await listing({ name: 'liveWriter', productSku: 'W-LIVE' })
  })
  // Another business: a product and a listing whose SKUs exist only there.
  await prisma.workspace.create({ data: { id: OTHER_BUSINESS, name: 'Other business', createdByUserId: 'skurows', creationKey: 'skurows-other' } as never })
  await other(async () => {
    acc.otherBusiness = await connection('AMAZON', 'skurows-other-amazon')
    await product('FOREIGN-P')
    await listing({ name: 'foreign', productSku: 'FOREIGN-P', account: acc.otherBusiness, data: { channelSku: 'FOREIGN-1' } })
    await product('W-FREE-ELSEWHERE')
  })
}, 120_000)
afterAll(async () => { await state.db?.close() })

const match = (sku: string, extra: { account?: string; marketplace?: string; channel?: string } = {}) =>
  scoped(() => prisma.$transaction(tx => productForChannelSku(tx, { channel: extra.channel ?? 'AMAZON', channelConnectionId: extra.account ?? acc.amazonA, marketplace: extra.marketplace, sku })))

describe('productForChannelSku — matching a channel\'s SKU back', () => {
  it('each step finds its product and listing, and says which store matched', async () => {
    expect(await match('LIVE-1')).toEqual({ productId: pid['P-LIVE'], listingId: lid.live, via: 'live' })
    expect(await match('CHAN-1')).toEqual({ productId: pid['P-CHAN'], listingId: lid.chan, via: 'channel' })
    expect(await match('ATTR-1')).toEqual({ productId: pid['P-ATTR'], listingId: lid.attr, via: 'attributes' })
    expect(await match('FF-1')).toEqual({ productId: pid['P-FF'], listingId: lid.ff, via: 'flatFile' })
    expect(await match(' OLD-OFF ')).toEqual({ productId: pid['P-OLD'], listingId: lid.old, via: 'offer' })
    expect(await match('PLAIN-1')).toEqual({ productId: pid['PLAIN-1'], listingId: lid.plain, via: 'product' })
  })

  it('one product in two markets: no single listing without a market; the market names it', async () => {
    expect(await match('OFF-1')).toEqual({ productId: pid['P-OFFER'], listingId: null, via: 'offer' })
    expect(await match('OFF-1', { marketplace: 'DE' })).toEqual({ productId: pid['P-OFFER'], listingId: lid.offerDE, via: 'offer' })
    // The own SKU of the DE listing; the master SKU matches the IT listing that follows it, and no DE listing.
    expect(await match('PLAIN-1-DE')).toEqual({ productId: pid['PLAIN-1'], listingId: lid.plainOwn, via: 'live' })
    expect(await match('PLAIN-1', { marketplace: 'DE' })).toEqual({ productId: pid['PLAIN-1'], listingId: null, via: 'product' })
  })

  it('the first step that matches decides: confirmed → wanted → old stores → master SKU', async () => {
    expect(await match('ORDER-X')).toEqual({ productId: pid['Q-A'], listingId: lid.qa, via: 'live' })
    expect(await match('ORDER-Y')).toEqual({ productId: pid['Q-D'], listingId: lid.qd, via: 'channel' })
    expect(await match('LEG-WINS')).toEqual({ productId: pid['Q-E'], listingId: lid.qe, via: 'attributes' })
    // A wanted-but-not-confirmed SKU still matches (the channel may have taken it before Nexus heard back).
    expect(await match('WANT-1')).toEqual({ productId: pid['P-LIVE'], listingId: lid.live, via: 'channel' })
  })

  it('two products at the same step: ambiguous, never picked', async () => {
    expect(await match('DUP-1')).toEqual({ ambiguous: true, productIds: [pid['DUP-A'], pid['DUP-B']].sort(), via: 'channel' })
  })

  it('another account\'s listing, a trashed product, an unknown SKU: no match; the exact SKU is required', async () => {
    expect(await match('SCOPED-1')).toBeNull()
    expect(await match('SCOPED-1', { account: acc.amazonB })).toEqual({ productId: pid['P-SCOPED'], listingId: lid.scoped, via: 'channel' })
    expect(await match('GONE-1')).toBeNull()
    expect(await match('NOPE')).toBeNull()
    expect(await match('chan-1')).toBeNull()
    expect(await match('   ')).toBeNull()
  })

  it('an eBay alias\'s own SKU names its main row', async () => {
    expect(await match('EBAY-ALIAS-1', { account: acc.ebay, channel: 'EBAY' })).toEqual({ productId: pid['P-EBAY'], listingId: lid.ebayAlias, via: 'alias' })
  })

  it('🔴 another business is never matched — its listing, its account, its product', async () => {
    // Positive control: the rows exist, in the other business.
    expect(await other(() => prisma.$transaction(tx => productForChannelSku(tx, { channel: 'AMAZON', channelConnectionId: acc.otherBusiness, sku: 'FOREIGN-1' }))))
      .toEqual({ productId: pid['FOREIGN-P'], listingId: lid.foreign, via: 'channel' })
    expect(await match('FOREIGN-1', { account: acc.otherBusiness })).toBeNull()
    expect(await match('FOREIGN-P')).toBeNull()
  })
})

// These fixtures are live listings (ACTIVE, published); this block is about validation, uniqueness, version and
// history, so it allows the live move. S9's live-move rule has its own tests (channel-sku-writes.vitest.test.ts).
const write = (name: string, sku: string | null, extra: { expectedVersion?: number } = {}) =>
  scoped(() => prisma.$transaction(tx => setChannelSku(tx, { listingId: lid[name], sku, actorId: 'user-1', liveMove: 'allow', ...extra })))
const refusal = async (promise: Promise<unknown>) => {
  try { await promise } catch (error) { return error instanceof ChannelSkuError ? { code: error.code, message: error.message } : { thrown: String(error) } }
  return null
}
const readListing = (name: string) => scoped(() => prisma.channelListing.findUnique({ where: { id: lid[name] }, select: { channelSku: true, version: true, liveChannelSku: true } }))

describe('setChannelSku — the one writer', () => {
  it('stores the trimmed SKU, bumps the version once, leaves a history row; the same SKU again changes nothing', async () => {
    const before = await readListing('me')
    expect(await write('me', '  ME-OWN-1 ', { expectedVersion: before!.version })).toEqual({ listingId: lid.me, channelSku: 'ME-OWN-1', previous: null, version: before!.version + 1, changed: true })
    expect(await readListing('me')).toMatchObject({ channelSku: 'ME-OWN-1', version: before!.version + 1 })
    const history = await scoped(() => prisma.channelListingOverride.findMany({ where: { channelListingId: lid.me, fieldName: 'channelSku' } }))
    expect(history).toMatchObject([{ previousValue: null, newValue: 'ME-OWN-1', changedBy: 'user-1' }])
    expect(await write('me', 'ME-OWN-1')).toMatchObject({ changed: false, version: before!.version + 1 })
  })

  it('a stale version is refused; empty or null follows the product SKU again', async () => {
    const now = (await readListing('me'))!.version
    expect(await refusal(write('me', 'ME-OWN-2', { expectedVersion: now - 1 }))).toMatchObject({ code: 'VERSION_CONFLICT' })
    expect(await write('me', '   ')).toMatchObject({ channelSku: null, previous: 'ME-OWN-1', changed: true, version: now + 1 })
    expect(await readListing('me')).toMatchObject({ channelSku: null })
  })

  it('the product-SKU rule: at most 100 characters, letters, numbers, dots, hyphens and underscores', async () => {
    expect(await refusal(write('me', 'A'.repeat(101)))).toEqual({ code: 'INVALID_SKU', message: 'A SKU can have up to 100 characters. This one has 101.' })
    for (const bad of ['HAS SPACE', 'A/B', 'é-1']) {
      expect(await refusal(write('me', bad))).toEqual({ code: 'INVALID_SKU', message: 'Use only letters, numbers, dots (.), hyphens (-) and underscores (_). No spaces.' })
    }
    expect(await write('me', 'A'.repeat(100))).toMatchObject({ changed: true })
    await write('me', null)
  })

  it('🔴 another product holds it on the same account (its own SKU, any case; or an old offer): refused, naming that product', async () => {
    expect(await refusal(write('me', 'held-1'))).toEqual({ code: 'SKU_TAKEN',
      message: 'held-1 is already the SKU of W-HOLDER on this Amazon account (Amazon IT). Within one channel account a SKU names one product: choose another SKU.' })
    expect(await refusal(write('me', 'HELD-BY-OFFER'))).toMatchObject({ code: 'SKU_TAKEN', message: expect.stringContaining('the SKU of W-HOLDER on this Amazon account') })
    expect((await readListing('me'))!.channelSku).toBeNull()
  })

  it('🔴 another product\'s own SKU in this business (any case), or another product\'s extra-listing SKU: refused', async () => {
    expect(await refusal(write('me', 'w-master'))).toEqual({ code: 'SKU_TAKEN',
      message: 'w-master is the SKU of another product (W-MASTER) in this business. One SKU names one product: choose another SKU for this listing.' })
    expect(await refusal(write('me', 'W-ALIAS-SKU'))).toEqual({ code: 'SKU_TAKEN',
      message: 'SKU "W-ALIAS-SKU" is already the SKU of an extra listing ("Extra" of W-ALIAS-ROOT). One SKU for two things is confused by imports and channels — choose another SKU.' })
  })

  it('allowed: the same product in another market, another account\'s holder, another business\'s SKU, the product\'s own SKU', async () => {
    expect(await write('me', 'SHARED-ACROSS-MARKETS')).toMatchObject({ changed: true })
    expect(await write('meDE', 'SHARED-ACROSS-MARKETS')).toMatchObject({ changed: true })
    expect(await write('me', 'ONLY-ON-B')).toMatchObject({ changed: true })
    expect(await write('me', 'W-FREE-ELSEWHERE')).toMatchObject({ changed: true })
    expect(await write('me', 'W-ME')).toMatchObject({ channelSku: 'W-ME', changed: true })
    // …and the account that DOES hold it still refuses.
    expect(await refusal(write('meOtherAccount', 'ONLY-ON-B'))).toMatchObject({ code: 'SKU_TAKEN' })
  })

  it('a listing with no account cannot be checked: refused; clearing it is fine', async () => {
    expect(await refusal(write('unattributed', 'UNATTR-1'))).toMatchObject({ code: 'NO_ACCOUNT' })
    expect(await write('unattributed', null)).toMatchObject({ changed: false })
  })

  it('an unknown listing is refused', async () => {
    expect(await refusal(scoped(() => prisma.$transaction(tx => setChannelSku(tx, { listingId: 'nope', sku: 'X', actorId: null }))))).toMatchObject({ code: 'LISTING_NOT_FOUND' })
  })
})

describe('confirmLiveChannelSku / clearLiveChannelSku', () => {
  const run = <T>(work: (tx: any) => Promise<T>) => scoped(() => prisma.$transaction(tx => work(tx)))
  it('records the trimmed SKU once, clears it once, and refuses an empty one; no version bump', async () => {
    const version = (await readListing('liveWriter'))!.version
    expect(await run(tx => confirmLiveChannelSku(tx, lid.liveWriter, ' LIVE-W '))).toBe(true)
    expect(await run(tx => confirmLiveChannelSku(tx, lid.liveWriter, 'LIVE-W'))).toBe(false)
    expect(await readListing('liveWriter')).toEqual({ channelSku: null, liveChannelSku: 'LIVE-W', version })
    expect(await match('LIVE-W')).toEqual({ productId: pid['W-LIVE'], listingId: lid.liveWriter, via: 'live' })
    expect(await run(tx => clearLiveChannelSku(tx, lid.liveWriter))).toBe(true)
    expect(await run(tx => clearLiveChannelSku(tx, lid.liveWriter))).toBe(false)
    expect(await refusal(run(tx => confirmLiveChannelSku(tx, lid.liveWriter, '  ')))).toMatchObject({ code: 'INVALID_SKU' })
    expect(await readListing('liveWriter')).toEqual({ channelSku: null, liveChannelSku: null, version })
  })
})
