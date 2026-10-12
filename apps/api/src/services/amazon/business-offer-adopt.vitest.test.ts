/**
 * Amazon Business step 3b — copying the business offers Amazon already holds into Nexus. Real Matrix data over a real
 * PostgreSQL in-process (PGlite); Amazon's listings pages are faked. Every id and SKU is invented.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any, callAPI: vi.fn() }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client, prisma: state.db.client }
})
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn(async () => undefined) }))
vi.mock('../../lib/amazon-sp-client.js', () => ({ getAmazonSellerId: async () => 'SELLER-1', getAmazonSpClient: async () => ({ callAPI: state.callAPI }) }))

import { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { OFFER_AUDIENCE_FIELD_KEY } from '../categories/seller-offer-audience.service.js'
import { adoptAmazonBusinessOffers, adoptSummary, amazonBusinessInstance, businessSettingFromAmazon } from './business-offer-adopt.service.js'

const IT = 'APJ6JRA9NG5V4'
const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const price = (v: number) => [{ schedule: [{ value_with_tax: v }] }]
const all = (v: number) => ({ marketplace_id: IT, currency: 'EUR', audience: 'ALL', our_price: price(v) })
const b2b = (v: number, plan?: unknown) => ({ marketplace_id: IT, currency: 'EUR', audience: 'B2B', our_price: price(v), ...(plan ? { quantity_discount_plan: plan } : {}) })
const item = (sku: string, ...offers: unknown[]) => ({ sku, attributes: { purchasable_offer: offers } })
const percentPlan = [{ schedule: [{ discount_type: 'percent', levels: [{ lower_bound: 2, value: 3 }, { lower_bound: 5, value: 5 }] }] }]
const ids: Record<string, string> = {}

beforeAll(() => scoped(async () => {
  for (const code of ['IT', 'DE']) await prisma.marketplace.create({ data: { channel: 'AMAZON', code, name: `Amazon ${code}`, currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } })
  const account = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'adopt', isActive: true, isPrimary: true } as never })).id
  await prisma.product.create({ data: { id: 'ad-p', sku: 'TEST-AD-P', name: 'p', basePrice: 39.95, isParent: true, productType: 'OUTERWEAR' } as never })
  for (const n of [1, 2, 3]) {
    await prisma.product.create({ data: { id: `ad-${n}`, sku: `TEST-AD-${n}`, name: `c${n}`, basePrice: 39.95, parentId: 'ad-p' } as never })
    ids[n] = (await prisma.channelListing.create({ data: {
      productId: `ad-${n}`, channel: 'AMAZON', marketplace: 'IT', channelMarket: 'AMAZON_IT', region: 'EU', channelConnectionId: account,
      listingStatus: 'ACTIVE', isPublished: true, externalListingId: `ASIN-${n}`, price: 39.95, priceOverride: 39.95, followMasterPrice: false, quantity: 3,
      ...(n === 2 ? { businessPriceRule: 'PERCENT_OFF', businessPricePercent: 5 } : {}),
    } as never })).id
  }
  for (const [marketplace, labels] of [['IT', { B2B: 'Amazon Business (B2B)', ALL: 'Vendita su Amazon' }], ['DE', { ALL: 'Bei Amazon verkaufen' }]] as const) {
    await prisma.sellerReferenceLabel.create({ data: { channel: 'AMAZON', connectionId: account, marketplace, productType: 'OUTERWEAR', fieldKey: OFFER_AUDIENCE_FIELD_KEY, labels } as never })
  }
}), 120_000)
afterAll(async () => { await state.db?.close() }, 60_000)

describe('reading an Amazon business offer', () => {
  it('an exact price with its tiers; no price → nothing', () => {
    expect(businessSettingFromAmazon(b2b(32.95, percentPlan))).toEqual({ rule: 'FIXED', percent: null, price: 32.95, tiers: { type: 'percent', levels: [{ minQty: 2, value: 3 }, { minQty: 5, value: 5 }] } })
    expect(businessSettingFromAmazon(b2b(30))).toEqual({ rule: 'FIXED', percent: null, price: 30, tiers: null })
    expect(businessSettingFromAmazon({ audience: 'B2B', marketplace_id: IT })).toBeNull()
  })
  it('only a B2B instance for this market with a price counts — never the normal offer', () => {
    expect(amazonBusinessInstance({ purchasable_offer: [all(39.95), b2b(32.95)] }, IT)).toMatchObject({ audience: 'B2B' })
    expect(amazonBusinessInstance({ purchasable_offer: [all(39.95)] }, IT)).toBeNull()
    expect(amazonBusinessInstance({ purchasable_offer: [{ ...b2b(32.95), marketplace_id: 'A1PA6795UKMFR9' }] }, IT)).toBeNull()
  })
})

describe('adoptAmazonBusinessOffers', () => {
  const rowOf = (n: number) => scoped(() => prisma.channelListing.findUnique({ where: { id: ids[n] }, select: { version: true, businessPriceRule: true, businessPrice: true, businessTiers: true, platformAttributes: true } }))
  const businessRows = (n: number) => scoped(() => prisma.outboundSyncQueue.findMany({ where: { channelListingId: ids[n], syncType: 'BUSINESS_PRICE_UPDATE' } }))
  const pages = (first: unknown[], second: unknown[]) => state.callAPI.mockImplementation(async ({ query }: { query: { pageToken?: string } }) =>
    query.pageToken === 'page-2' ? { items: second } : { items: first, pagination: { nextToken: 'page-2' } })

  it('copies a real business offer in; VERIFIES the one Nexus keeps (differs → queued to be sent again); skips the normal-only offer and an unknown SKU; only B2B markets are read', async () => {
    await scoped(() => prisma.channelListing.update({ where: { id: ids[2] }, data: { platformAttributes: { keep: 'me' } } }))
    pages([item('TEST-AD-1', all(39.95), b2b(32.95, percentPlan)), item('TEST-AD-3', all(39.95))], [item('TEST-AD-2', all(39.95), b2b(30)), item('UNKNOWN-SKU', b2b(10))])
    const counts = await scoped(() => adoptAmazonBusinessOffers({ throttleMs: 0 }))
    expect(adoptSummary(counts)).toBe('markets=1 scanned=4 found=2 adopted=1 managed=0 noListing=1 unreadable=0 refused=0 verified=0 differs=1 missing=0 resent=1 failedPages=0')
    expect(state.callAPI.mock.calls.map((c) => [c[0].path.sellerId, c[0].query.marketplaceIds[0], c[0].query.pageToken ?? null])).toEqual([['SELLER-1', IT, null], ['SELLER-1', IT, 'page-2']])
    const one = await rowOf(1)
    expect({ ...one, businessPrice: Number(one!.businessPrice) }).toMatchObject({ businessPriceRule: 'FIXED', businessPrice: 32.95, businessTiers: { type: 'percent', levels: [{ minQty: 2, value: 3 }, { minQty: 5, value: 5 }] } })
    const two = await rowOf(2)
    expect(two).toMatchObject({ businessPriceRule: 'PERCENT_OFF', businessPrice: null })
    // The verification is kept on the listing, beside its other keys, without moving its version.
    expect(two!.platformAttributes).toMatchObject({ keep: 'me', amazonBusinessLive: { status: 'DIFFERS', amazonPrice: 30, nexusPrice: 37.95 } })
    expect((await businessRows(2)).map((r) => [r.syncStatus, (r.payload as any).source])).toEqual([['PENDING', 'BUSINESS_PRICE_VERIFY']])
    expect((await rowOf(3))!.businessPriceRule).toBeNull()
    const audit = await scoped(() => prisma.channelListingOverride.findFirst({ where: { channelListingId: ids[1], fieldName: 'businessPrice' } }))
    expect(audit).toMatchObject({ newValue: '32.95 · 2 tiers (percent: 2+ 3, 5+ 5)', changedBy: 'amazon-business-offer-adopt', reason: 'Copied from the business offer Amazon holds' })
  })

  it('a second run: what it copied is now Nexus\'s and agrees with Amazon (verified); nothing is copied again', async () => {
    const before = (await rowOf(2))!.version
    const counts = await scoped(() => adoptAmazonBusinessOffers({ throttleMs: 0 }))
    expect(counts).toMatchObject({ found: 1, adopted: 0, managed: 0, noListing: 1, verified: 1, differs: 1, resent: 1 })
    expect((await rowOf(1))!.platformAttributes).toMatchObject({ amazonBusinessLive: { status: 'MATCH', amazonPrice: 32.95 } })
    expect((await rowOf(2))!.version).toBe(before)
    // One waiting business row per listing: the newer send replaced the one still waiting.
    expect((await businessRows(2)).filter((r) => r.syncStatus === 'PENDING')).toHaveLength(1)
  })

  it('a person removed it: Amazon still shows the old offer while the removal is on its way — never copied back', async () => {
    await scoped(async () => {
      await prisma.channelListing.update({ where: { id: ids[1] }, data: { businessPriceRule: null, businessPrice: null, businessTiers: Prisma.DbNull } })
      await prisma.channelListingOverride.create({ data: { channelListingId: ids[1], fieldName: 'businessPrice', previousValue: '32.95 · no tiers', newValue: null, reason: 'business price', changedBy: 'owner@example.test' } })
    })
    const counts = await scoped(() => adoptAmazonBusinessOffers({ throttleMs: 0 }))
    expect(counts).toMatchObject({ adopted: 0, managed: 1 })
    expect((await rowOf(1))!.businessPriceRule).toBeNull()
  })

  it('a managed listing Amazon does not list at all is MISSING (a complete scan only) and queued; an unreadable plan is never copied', async () => {
    pages([item('TEST-AD-3', all(39.95), { ...b2b(20), quantity_discount_plan: [{ schedule: [{ discount_type: 'mystery', levels: [] }] }] })], [])
    const counts = await scoped(() => adoptAmazonBusinessOffers({ throttleMs: 0 }))
    expect(counts).toMatchObject({ unreadable: 1, adopted: 0, missing: 1 })
    expect((await rowOf(2))!.platformAttributes).toMatchObject({ amazonBusinessLive: { status: 'MISSING' } })
    expect((await rowOf(3))!.businessPriceRule).toBeNull()
  })

  it('a page that fails is counted, the run goes on, and nothing is called MISSING from a part scan', async () => {
    state.callAPI.mockReset().mockRejectedValue(new Error('QuotaExceeded'))
    const before = JSON.stringify((await rowOf(2))!.platformAttributes)
    expect(await scoped(() => adoptAmazonBusinessOffers({ throttleMs: 0 }))).toMatchObject({ markets: 1, failedPages: 1, adopted: 0, missing: 0 })
    expect(JSON.stringify((await rowOf(2))!.platformAttributes)).toBe(before)
  })
})
