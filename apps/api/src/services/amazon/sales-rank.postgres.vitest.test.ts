/**
 * The Best Sellers Rank feed and the sales-rank tool on a real PostgreSQL (PGlite, production schema, business scoping).
 *
 * Pinned: only live Amazon listings are read (a closed offer, a draft, an eBay listing are not), 20 ASINs a call at most,
 * one call per market; a row names the product its listing sells; the same ranks are not stored twice within a day,
 * a changed rank or a day-old heartbeat is; an ASIN with no rank writes nothing; rows past 180 days are pruned; an
 * account whose call was not sent is not asked again in the run; another business's rows are never read or pruned; and
 * the tool answers a family with its best ASIN per category and the trend. Fake ASINs and numbers only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))

import { runSalesRankFeed, type BatchAnswer, type SalesRankFeedDeps } from './sales-rank.service.js'
import { SALES_RANK_TOOLS } from '../agents/tools/sales-rank.tools.js'

const A = LEGACY_WORKSPACE_ID
const OTHER = 'ws_sales_rank_other'
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(work: () => Promise<T>, workspaceId = A) => withWorkspace(business(workspaceId), work)
const db = () => database.client
const DAY = 86_400_000
const T0 = new Date('2026-10-09T03:17:00Z')

const CHILD_ASINS = Array.from({ length: 23 }, (_, i) => `B0SRTEST${String(i).padStart(2, '0')}`)
const PARENT_ASIN = 'B0SRPARENT'
let parentId = ''
let firstChildId = ''

/** Amazon's answer: a rank for every asked ASIN except the last child (no rank); rank = its index + `shift`. */
function amazon(shift: number) {
  const calls: Array<{ accountId: string; asins: string[]; marketplaceId: string }> = []
  const readBatch = async (accountId: string, asins: readonly string[], marketplaceId: string): Promise<BatchAnswer> => {
    calls.push({ accountId, asins: [...asins], marketplaceId })
    return {
      success: true, httpStatus: 200,
      body: {
        items: asins.map((asin) => ({
          asin,
          salesRanks: asin === CHILD_ASINS[22] ? [] : [{
            marketplaceId,
            classificationRanks: [{ classificationId: '900001', title: 'Test Jackets', rank: (CHILD_ASINS.indexOf(asin) + 2) + shift }],
            displayGroupRanks: [{ websiteDisplayGroup: 'test_display_on_website', title: 'Test Department', rank: 1000 + shift }],
          }],
        })),
      },
    }
  }
  return { calls, readBatch }
}
const deps = (readBatch: SalesRankFeedDeps['readBatch'], now: Date): SalesRankFeedDeps => ({
  readBatch, now: () => now,
  marketplaceIdOf: async (code) => (code === 'IT' ? 'TESTMARKET01' : undefined),
  defaultAccountId: async () => 'acc-default',
})

beforeAll(async () => {
  database = await formulaDatabase()
  await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING`, [OTHER])
  await inside(async () => {
    const parent = await db().product.create({ data: { sku: 'SR-PARENT', name: 'Test jacket', isParent: true, basePrice: '1.00' } as never })
    parentId = parent.id
    const listing = (productId: string, asin: string, extra: Record<string, unknown> = {}) => db().channelListing.create({
      data: { productId, channel: 'AMAZON', channelMarket: 'AMAZON_IT', marketplace: 'IT', region: 'IT', listingStatus: 'ACTIVE', isPublished: true, externalListingId: asin, channelConnectionId: null, ...extra } as never,
    })
    await listing(parent.id, PARENT_ASIN)
    for (const [i, asin] of CHILD_ASINS.entries()) {
      const child = await db().product.create({ data: { sku: `SR-CHILD-${i}`, name: `Test jacket ${i}`, parentId: parent.id, basePrice: '1.00' } as never })
      if (i === 0) firstChildId = child.id
      await listing(child.id, asin)
    }
    // Not read: a closed offer in another market, a draft, an eBay listing.
    const other = await db().product.create({ data: { sku: 'SR-OTHER', name: 'Other', basePrice: '1.00' } as never })
    await listing(other.id, 'B0SRCLOSED', { marketplace: 'DE', channelMarket: 'AMAZON_DE', region: 'DE', offerClosedAt: new Date() })
    await listing(other.id, 'B0SRDRAFT0', { marketplace: 'FR', channelMarket: 'AMAZON_FR', region: 'FR', listingStatus: 'DRAFT', isPublished: false })
    await db().channelListing.create({ data: { productId: other.id, channel: 'EBAY', channelMarket: 'EBAY_IT', marketplace: 'IT', region: 'IT', listingStatus: 'ACTIVE', externalListingId: '123456789012' } as never })
    // A read 200 days old: pruned by the next run.
    await db().amazonSalesRank.create({ data: { marketplace: 'IT', asin: CHILD_ASINS[0], productId: firstChildId, classificationRanks: [], displayGroupRanks: [], bestRank: null, runId: 'old', capturedAt: new Date(T0.getTime() - 200 * DAY) } })
  })
  // Another business: its own listing and a read, both out of reach.
  await inside(async () => {
    const p = await db().product.create({ data: { sku: 'SR-B', name: 'B jacket', basePrice: '1.00' } as never })
    await db().channelListing.create({ data: { productId: p.id, channel: 'AMAZON', channelMarket: 'AMAZON_IT', marketplace: 'IT', region: 'IT', listingStatus: 'ACTIVE', isPublished: true, externalListingId: 'B0SROTHERB' } as never })
    await db().amazonSalesRank.create({ data: { marketplace: 'IT', asin: 'B0SROTHERB', productId: p.id, classificationRanks: [], displayGroupRanks: [], bestRank: null, runId: 'b', capturedAt: new Date(T0.getTime() - 200 * DAY) } })
  }, OTHER)
}, 120_000)

afterAll(async () => { await database?.close() })

describe('the sales-rank feed', () => {
  it('reads every live Amazon ASIN of the business, 20 a call, and stores the ones with a rank', async () => {
    const fake = amazon(0)
    const r = await inside(() => runSalesRankFeed(deps(fake.readBatch, T0)))
    expect(fake.calls.map((c) => c.asins.length)).toEqual([20, 4])
    expect(new Set(fake.calls.flatMap((c) => c.asins))).toEqual(new Set([PARENT_ASIN, ...CHILD_ASINS]))
    expect(fake.calls.every((c) => c.accountId === 'acc-default' && c.marketplaceId === 'TESTMARKET01')).toBe(true)
    expect(r).toMatchObject({ asins: 24, batches: 2, written: 23, noRank: 1, unchanged: 0, failedBatches: 0, pruned: 1 })
    const row = await inside(() => db().amazonSalesRank.findFirst({ where: { asin: CHILD_ASINS[0] }, orderBy: { capturedAt: 'desc' } }))
    expect(row).toMatchObject({ productId: firstChildId, marketplace: 'IT', bestRank: 2 })
  })

  it('the same ranks are not stored again within a day; a changed rank is', async () => {
    const same = await inside(() => runSalesRankFeed(deps(amazon(0).readBatch, new Date(T0.getTime() + 3 * 3_600_000))))
    expect(same).toMatchObject({ written: 0, unchanged: 23, noRank: 1 })
    const moved = await inside(() => runSalesRankFeed(deps(amazon(-1).readBatch, new Date(T0.getTime() + 6 * 3_600_000))))
    expect(moved).toMatchObject({ written: 23, unchanged: 0 })
  })

  it('an account whose call was not sent is not asked again in this run; nothing throws', async () => {
    let calls = 0
    const held = async (): Promise<BatchAnswer> => { calls += 1; return { success: false, httpStatus: 0, error: 'needs sign-in', heldOrRefused: true } }
    const r = await inside(() => runSalesRankFeed(deps(held, new Date(T0.getTime() + 7 * 3_600_000))))
    expect(calls).toBe(1)
    expect(r).toMatchObject({ batches: 1, failedBatches: 1, written: 0, skipped: 4 })
  })

  it('never reads, writes or prunes another business\'s rows', async () => {
    const theirs = await inside(() => db().amazonSalesRank.findMany({ select: { asin: true } }), OTHER)
    expect(theirs).toEqual([{ asin: 'B0SROTHERB' }])
    const ours = await inside(() => db().amazonSalesRank.findMany({ where: { asin: 'B0SROTHERB' } }))
    expect(ours).toEqual([])
  })
})

describe('the sales-rank tool', () => {
  const tool = SALES_RANK_TOOLS[0]

  it('a family: the best ASIN per category now, with its climb since the first read', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(T0.getTime() + 29 * 3_600_000)) // 24 h before = T0 + 5 h: the first read (rank 2)
    try {
      const res = await inside(() => tool.handler({ productId: parentId, market: 'it' }, {} as never))
      expect(res.ok).toBe(true)
      const data = (res as { data: { scope: unknown; bestPerCategory: Array<Record<string, unknown>>; asins: Array<Record<string, unknown>> } }).data
      expect(data.scope).toMatchObject({ productId: parentId, sku: 'SR-PARENT', variations: 23, market: 'IT', days: 14 })
      expect(data.bestPerCategory[0]).toMatchObject({ marketplace: 'IT', kind: 'subcategory', categoryId: '900001', title: 'Test Jackets', rank: 1, asin: CHILD_ASINS[0], productId: firstChildId, change24h: 1 })
      // 22 ranked children and the parent ASIN (the last child has no rank, so it is not stored).
      expect(data.asins).toHaveLength(23)
      expect(data.asins.map((a) => a.asin)).toContain(PARENT_ASIN)
      expect(data.asins.map((a) => a.asin)).not.toContain(CHILD_ASINS[22])
    } finally {
      vi.useRealTimers()
    }
  })

  it('a SKU or an ASIN works too; a scope with no read says so; an unknown product is not found', async () => {
    const bySku = await inside(() => tool.handler({ sku: 'SR-CHILD-1' }, {} as never))
    expect((bySku as { data: { asins: unknown[] } }).data.asins).toHaveLength(1)
    const byAsin = await inside(() => tool.handler({ asin: CHILD_ASINS[2].toLowerCase() }, {} as never))
    expect((byAsin as { data: { asins: Array<{ asin: string }> } }).data.asins[0].asin).toBe(CHILD_ASINS[2])
    const none = await inside(() => tool.handler({ sku: 'SR-OTHER' }, {} as never))
    expect((none as { data: { hint: string } }).data.hint).toMatch(/^No rank stored for this scope/)
    expect(await inside(() => tool.handler({ productId: 'nope' }, {} as never))).toEqual({ ok: false, error: 'Product not found' })
    expect(await inside(() => tool.handler({}, {} as never))).toMatchObject({ ok: false })
  })

  it('another business sees none of these ranks', async () => {
    const res = await inside(() => tool.handler({ asin: CHILD_ASINS[0] }, {} as never), OTHER)
    expect((res as { data: { asins: unknown[] } }).data.asins).toEqual([])
  })
})
