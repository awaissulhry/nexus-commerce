/**
 * T4 — ebay-ad-details: what an eBay Promoted Listings campaign holds, read through the one door (call-tool.ts)
 * against a real PostgreSQL with the production schema and the business-isolation policies (PGlite). No mocked query;
 * the ads read cache is a pass-through and the job queue a stub (nothing here enqueues).
 *
 * Proven here: the read is the campaign page's own (ebayCampaignDetail): each promoted listing's ad rate (its own, or
 * the campaign's), its break-even and why it is unknown, a Priority campaign's ad groups and its keywords with bid,
 * status and metrics, in the campaign's own currency; every row names the ids the eBay change tools take, and those
 * tools preview exactly the rate, break-even and bid this read shows; without a campaign it opens the market's live
 * campaigns (an ended one only by id); a break-even is never borrowed from another market; lists page with no row twice;
 * another business's campaign is not found and never listed; and a person without the ad-spend money permission gets
 * the same answer minus exactly the money keys.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'
import { RESTRICTED_FIELDS } from '../../../lib/auth/financial-fields.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', async () => {
  const { contextualDatabase } = await import('../../../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_t, p) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), p) }) }
})
vi.mock('../../advertising/ads-cache.js', () => ({
  cached: async (_key: string, _ttl: number, work: () => Promise<unknown>) => work(),
  peekCached: async () => undefined, putCached: () => undefined, flushAdsCache: async () => undefined,
}))
vi.mock('../../../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: false, status: 'not-initialized' }), resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: { connection: null },
  }
})

import { callTool, type UserPrincipal } from '../call-tool.js'
import { getTool } from '../tool-registry.js'
import { resolveRange } from '../../ads-core/date-range.js'

const A = LEGACY_WORKSPACE_ID
const OTHER = 'ws_ebay_ad_details_other'
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(workspaceId: string, work: () => Promise<T>) => withWorkspace(business(workspaceId), work)

function principal(workspaceId: string, permissions: string[]): UserPrincipal {
  return {
    kind: 'user',
    userId: 'u-ebay-details',
    label: 'eBay details test',
    permissions: { isOwner: false, permissions: new Set(permissions) },
    workspace: business(workspaceId),
    via: 'claude',
  }
}
/** Sees every money field. */
const cleared = (workspaceId = A) => principal(workspaceId, [...Object.values(FEATURES), ...Object.values(FIELDS)])
/** May read ads, sees no money. */
const operator = (workspaceId = A) => principal(workspaceId, [FEATURES.aiRun, FEATURES.adsView])

type Row = Record<string, any>
interface Answer { ok: boolean; error?: string; data?: Row }
async function call(args: Record<string, unknown>, who: UserPrincipal = cleared()): Promise<Answer> {
  return (await callTool(who, 'ebay-ad-details', args)).visible as Answer
}
async function walk(args: Record<string, unknown>, limit: number) {
  const items: Row[] = []
  let cursor: string | null = null
  let pages = 0
  do {
    const answer: Answer = await call({ ...args, limit, ...(cursor ? { cursor } : {}) })
    expect(answer.ok, answer.error).toBe(true)
    expect(answer.data!.items.length).toBeLessThanOrEqual(limit)
    items.push(...answer.data!.items)
    cursor = answer.data!.nextCursor
    pages++
  } while (cursor && pages < 60)
  return { items, pages }
}

// ── The seed ─────────────────────────────────────────────────────────────────────────────────────────

const TODAY = resolveRange({ windowDays: 1 }).untilStr
const dayBefore = (n: number) => {
  const d = new Date(`${TODAY}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - n)
  return d
}
const ymd = (d: Date) => d.toISOString().slice(0, 10)
let account = ''

async function seedA() {
  await inside(A, async () => {
    const db = database.client
    await db.marketplace.create({ data: { channel: 'EBAY', code: 'IT', name: 'eBay Italy', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'], marketplaceId: 'EBAY_IT' } as never })
    account = (await db.channelConnection.create({ data: { channelType: 'EBAY', isActive: true, isPrimary: true, accountLabel: 'Main eBay', externalAccountId: 'SELLER-DETAILS' } as never })).id
    const campaign = (id: string, marketplace: string, name: string, extra: Record<string, unknown> = {}) =>
      db.ebayCampaign.create({ data: { id, channelConnectionId: account, marketplace, externalCampaignId: `EXT-${id}`, name, fundingStrategy: 'COST_PER_SALE', fundingModel: 'COST_PER_SALE', status: 'RUNNING', startDate: dayBefore(100), ...extra } as never })
    await campaign('ed-e1', 'EBAY_IT', 'Italia general', { bidPercentage: '6.55', adRateStrategy: 'FIXED', lastEntitySyncAt: new Date('2026-10-01T06:00:00Z') })
    await campaign('ed-e2', 'EBAY_GB', 'UK priority', { fundingStrategy: 'COST_PER_CLICK', fundingModel: 'COST_PER_CLICK', campaignTargetingType: 'MANUAL', dailyBudget: '15.50', budgetCurrency: 'GBP' })
    await campaign('ed-e3', 'EBAY_IT', 'Italia ended', { bidPercentage: '3.00', status: 'ENDED' })
    await campaign('ed-e4', 'EBAY_IT', 'Italia rules', { bidPercentage: '5.00', isRulesBased: true })
    // A market Nexus does not map for eBay: the page would read its break-even from Italy's listings.
    await campaign('ed-e5', 'EBAY_AT', 'Austria general', { bidPercentage: '4.00', adRateStrategy: 'FIXED' })

    const ad = (id: string, campaignId: string, marketplace: string, listingId: string, extra: Record<string, unknown> = {}) =>
      db.ebayAd.create({ data: { id, campaignId, marketplace, listingId, status: 'ACTIVE', ...extra } as never })
    await ad('ed-a1', 'ed-e1', 'EBAY_IT', '110000000001', { bidPercentage: '8.35', productId: 'p-jacket' })
    await ad('ed-a2', 'ed-e1', 'EBAY_IT', '110000000002')
    await ad('ed-a3', 'ed-e1', 'EBAY_IT', '110000000003', { bidPercentage: '4.00', hiddenReason: 'OUT_OF_STOCK' })
    await ad('ed-a5', 'ed-e3', 'EBAY_IT', '110000000005')
    await ad('ed-a6', 'ed-e4', 'EBAY_IT', '110000000006')
    await ad('ed-a7', 'ed-e5', 'EBAY_AT', '330000000001')

    const listing = (marketplace: string, itemId: string, title: string, price: string, quantity: number, extra: Record<string, unknown> = {}) =>
      db.ebayListingIndex.create({ data: { marketplace, itemId, title, price, currency: marketplace === 'UK' ? 'GBP' : 'EUR', quantity, ...extra } as never })
    await listing('IT', '110000000001', 'Alpha race jacket', '89.90', 4)
    await listing('IT', '110000000002', 'Bravo leather gloves', '39.90', 9)
    await listing('IT', '110000000003', 'Charlie boots', '129.00', 0, { endedAt: dayBefore(2) })
    await listing('UK', '220000000001', 'Delta helmet', '199.00', 3)
    const economics = (marketplace: string, itemId: string, breakEvenAdRatePct: string | null, dataStatus: string) =>
      db.ebayListingEconomics.create({ data: { marketplace, itemId, breakEvenAdRatePct, dataStatus } as never })
    await economics('IT', '110000000001', '7.25', 'OK')
    await economics('IT', '110000000002', null, 'MISSING_COGS')
    await economics('IT', '110000000003', '12.45', 'ESTIMATED')
    await economics('UK', '220000000001', '9.15', 'OK')
    // Italian economics for the Austrian campaign's item: it must not be shown as that listing's break-even.
    await economics('IT', '330000000001', '5.55', 'OK')

    // The Priority campaign: two ad groups, three keywords (one under dynamic bidding), a negative, a listing.
    const group = (id: string, name: string, defaultBidCents: number) =>
      db.ebayAdGroup.create({ data: { id, campaignId: 'ed-e2', externalAdGroupId: `EXT-${id}`, name, status: 'ACTIVE', defaultBidCents } })
    await group('ed-g1', 'Helmets', 3535)
    await group('ed-g2', 'Gloves', 2525)
    const keyword = (id: string, adGroupId: string, text: string, matchType: string, bidCents: number | null) =>
      db.ebayKeyword.create({ data: { id, campaignId: 'ed-e2', adGroupId, externalKeywordId: `EXT-${id}`, text, matchType, bidCents, status: 'ACTIVE' } })
    await keyword('ed-k1', 'ed-g1', 'race helmet', 'EXACT', 4747)
    await keyword('ed-k2', 'ed-g1', 'helmet', 'BROAD', null)
    await keyword('ed-k3', 'ed-g2', 'leather gloves', 'PHRASE', 3030)
    await db.ebayNegativeKeyword.create({ data: { campaignId: 'ed-e2', adGroupId: 'ed-g1', externalId: 'EXT-NEG-1', text: 'cheap', matchType: 'EXACT', status: 'ACTIVE' } })
    await ad('ed-a4', 'ed-e2', 'EBAY_GB', '220000000001', { adGroupId: 'ed-g1' })

    const perf = (data: Record<string, unknown>) =>
      db.ebayAdsDailyPerformance.create({ data: { fundingModel: 'COST_PER_SALE', currency: 'EUR', reportedAt: new Date(), ...data } as never })
    await perf({ marketplace: 'EBAY_IT', entityType: 'CAMPAIGN', entityId: 'EXT-ed-e1', date: dayBefore(1), impressions: 900, clicks: 30, adFeesCents: 1717, salesCents: 21212, soldQty: 1 })
    await perf({ marketplace: 'EBAY_IT', entityType: 'LISTING', entityId: '110000000001', date: dayBefore(1), impressions: 500, clicks: 20, adFeesCents: 1717, salesCents: 21212, soldQty: 1 })
    // Outside the 30-day window: not counted.
    await perf({ marketplace: 'EBAY_IT', entityType: 'LISTING', entityId: '110000000001', date: dayBefore(45), impressions: 50, clicks: 5, adFeesCents: 999, salesCents: 9999, soldQty: 1 })
    await perf({ marketplace: 'EBAY_GB', fundingModel: 'COST_PER_CLICK', currency: 'GBP', entityType: 'KEYWORD', entityId: 'EXT-ed-k1', date: dayBefore(3), impressions: 300, clicks: 12, adFeesCents: 540, salesCents: 8989, soldQty: 1 })
  })
}

async function seedOther() {
  await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, 'Other business', 'active', 'ads', $1, CURRENT_TIMESTAMP)`, [OTHER])
  await inside(OTHER, async () => {
    const db = database.client
    const other = await db.channelConnection.create({ data: { channelType: 'EBAY', isActive: true, accountLabel: 'Other eBay', externalAccountId: 'SELLER-OTHER-DETAILS' } as never })
    await db.ebayCampaign.create({ data: { id: 'ed-other-e', channelConnectionId: other.id, marketplace: 'EBAY_IT', externalCampaignId: 'EXT-OTHER-E', name: 'OTHERCANARY campaign', fundingStrategy: 'COST_PER_CLICK', fundingModel: 'COST_PER_CLICK', status: 'RUNNING', startDate: dayBefore(10) } as never })
    await db.ebayAdGroup.create({ data: { id: 'ed-other-g', campaignId: 'ed-other-e', externalAdGroupId: 'EXT-OTHER-G', name: 'OTHERCANARY group', status: 'ACTIVE' } })
    await db.ebayKeyword.create({ data: { id: 'ed-other-k', campaignId: 'ed-other-e', adGroupId: 'ed-other-g', externalKeywordId: 'EXT-OTHER-K', text: 'OTHERCANARY keyword', matchType: 'EXACT', bidCents: 50, status: 'ACTIVE' } })
    await db.ebayAd.create({ data: { campaignId: 'ed-other-e', marketplace: 'EBAY_IT', listingId: '990000000001', adGroupId: 'ed-other-g', status: 'ACTIVE' } as never })
  })
}

beforeAll(async () => {
  database = await formulaDatabase()
  await seedA()
  await seedOther()
}, 180_000)

afterAll(async () => {
  await database?.close()
}, 30_000)

const pick = (items: Row[], key: string) => items.map((item) => item[key])

// ── listings ─────────────────────────────────────────────────────────────────────────────────────────

describe('T4 — ebay-ad-details, view listings', () => {
  it('each promoted listing: its ad rate (its own or the campaign\'s), break-even and why unknown, metrics, under the change tools\' ids', async () => {
    const answer = await call({ campaignId: 'ed-e1', limit: 100 })
    expect(answer.ok, answer.error).toBe(true)
    const data = answer.data!
    expect(data).toMatchObject({ channel: 'ebay', view: 'listings', dataAsOf: ymd(dayBefore(1)), window: { to: TODAY, days: 30 }, writes: { mode: 'sandbox' } })
    expect(data.campaigns).toEqual([{
      ebayCampaignId: 'ed-e1', externalCampaignId: 'EXT-ed-e1', name: 'Italia general', market: 'EBAY_IT', fundingModel: 'COST_PER_SALE',
      targetingType: null, status: 'RUNNING', currency: 'EUR', ratePct: 6.55, adRateStrategy: 'FIXED', rulesBased: false, settingsSyncedAt: '2026-10-01T06:00:00.000Z',
    }])
    expect(pick(data.items, 'ebayItemId')).toEqual(['110000000001', '110000000002', '110000000003']) // by title
    const [jacket, gloves, boots] = data.items
    expect(jacket).toEqual({
      ebayItemId: '110000000001', title: 'Alpha race jacket', productId: 'p-jacket',
      ebayCampaignId: 'ed-e1', campaignName: 'Italia general', market: 'EBAY_IT', currency: 'EUR', fundingModel: 'COST_PER_SALE',
      ebayAdGroupId: null, adGroupName: null, status: 'ACTIVE', hiddenReason: null, listingEnded: false, priceCents: 8990, quantity: 4,
      ratePct: 8.35, rateFrom: 'listing', breakEvenPct: 7.25, economics: 'OK', rateAboveBreakEven: true,
      metrics: { impressions: 500, clicks: 20, soldQty: 1, spendCents: 1717, salesCents: 21212, acos: 1717 / 21212 },
    })
    expect(gloves).toMatchObject({ ratePct: 6.55, rateFrom: 'campaign', breakEvenPct: null, economics: 'MISSING_COGS', rateAboveBreakEven: null, metrics: { clicks: 0, spendCents: 0 } })
    expect(boots).toMatchObject({ ratePct: 4, rateFrom: 'listing', breakEvenPct: 12.45, economics: 'ESTIMATED', rateAboveBreakEven: false, hiddenReason: 'OUT_OF_STOCK', listingEnded: true, quantity: 0 })
  })

  it('round trip: set-ebay-ad-rates takes these ids and previews exactly the rate and break-even this read shows', async () => {
    const items = (await call({ campaignId: 'ed-e1', limit: 100 })).data!.items as Row[]
    for (const item of items.slice(0, 2)) {
      const preview = (await callTool(cleared(), 'set-ebay-ad-rates', { ebayCampaignId: item.ebayCampaignId, rates: [{ ebayItemId: item.ebayItemId, ratePct: 5 }] })).raw as Row
      expect(preview.ok, preview.error).toBe(true)
      expect(preview.preview.changes).toEqual([expect.objectContaining({ itemId: item.ebayItemId, fromPct: item.ratePct, toPct: 5, breakEvenPct: item.breakEvenPct })])
    }
  })

  it('a Priority campaign\'s listings: their ad group, no rate; the campaign says why set-ebay-ad-rates leaves it', async () => {
    const data = (await call({ campaignId: 'ed-e2' })).data!
    expect(data.items).toEqual([expect.objectContaining({
      ebayItemId: '220000000001', title: 'Delta helmet', ebayAdGroupId: 'ed-g1', adGroupName: 'Helmets', currency: 'GBP', priceCents: 19900,
      ratePct: null, rateFrom: null, breakEvenPct: 9.15, economics: 'OK', rateAboveBreakEven: null,
    })])
    expect(data.campaigns[0]).toMatchObject({ ebayCampaignId: 'ed-e2', currency: 'GBP', ratePct: null, rateNote: expect.stringMatching(/Priority .*ebay-keywords-change/) })
    expect((await call({ campaignId: 'ed-e3' })).data!.campaigns[0].rateNote).toMatch(/^ended/)
    expect((await call({ campaignId: 'ed-e4' })).data!.campaigns[0].rateNote).toMatch(/^rules-based/)
  })

  it('a market Nexus does not map shows no break-even, never another market\'s', async () => {
    const data = (await call({ campaignId: 'ed-e5' })).data!
    expect(data.items).toEqual([expect.objectContaining({ ebayItemId: '330000000001', ratePct: 4, breakEvenPct: null, economics: null, rateAboveBreakEven: null })])
    expect(JSON.stringify(data)).not.toContain('5.55')
  })
})

// ── ad groups and keywords ───────────────────────────────────────────────────────────────────────────

describe('T4 — ebay-ad-details, views ad-groups and keywords', () => {
  it('a Priority campaign\'s ad groups: ids, default bid in its own currency, what each holds', async () => {
    const data = (await call({ view: 'ad-groups', campaignId: 'ed-e2' })).data!
    expect(data.items).toEqual([
      { ebayAdGroupId: 'ed-g2', externalAdGroupId: 'EXT-ed-g2', name: 'Gloves', status: 'ACTIVE', ebayCampaignId: 'ed-e2', campaignName: 'UK priority', market: 'EBAY_GB', currency: 'GBP', defaultBidCents: 2525, counts: { keywords: 1, listings: 0, negativeKeywords: 0 } },
      { ebayAdGroupId: 'ed-g1', externalAdGroupId: 'EXT-ed-g1', name: 'Helmets', status: 'ACTIVE', ebayCampaignId: 'ed-e2', campaignName: 'UK priority', market: 'EBAY_GB', currency: 'GBP', defaultBidCents: 3535, counts: { keywords: 2, listings: 1, negativeKeywords: 1 } },
    ])
    expect(data.campaigns[0]).not.toHaveProperty('rateNote')
  })

  it('keywords: id, text, match type, bid (locked under dynamic bidding), status, ad group and metrics', async () => {
    const data = (await call({ view: 'keywords', campaignId: 'ed-e2' })).data!
    expect(pick(data.items, 'text')).toEqual(['leather gloves', 'helmet', 'race helmet']) // by ad group, then text
    expect(data.items[2]).toEqual({
      ebayKeywordId: 'ed-k1', externalKeywordId: 'EXT-ed-k1', text: 'race helmet', matchType: 'EXACT', status: 'ACTIVE', bidCents: 4747, bidLocked: false,
      ebayAdGroupId: 'ed-g1', adGroupName: 'Helmets', ebayCampaignId: 'ed-e2', campaignName: 'UK priority', market: 'EBAY_GB', currency: 'GBP',
      metrics: { impressions: 300, clicks: 12, soldQty: 1, spendCents: 540, salesCents: 8989, acos: 540 / 8989, cpcCents: 45 },
    })
    expect(data.items[1]).toMatchObject({ ebayKeywordId: 'ed-k2', bidCents: null, bidLocked: true })
    expect(pick((await call({ view: 'keywords', campaignId: 'ed-e2', adGroupId: 'ed-g2' })).data!.items, 'ebayKeywordId')).toEqual(['ed-k3'])
    expect(pick((await call({ view: 'keywords', search: 'RACE' })).data!.items, 'ebayKeywordId')).toEqual(['ed-k1'])
  })

  it('round trip: ebay-keywords-change takes these ids and previews the bid this read shows, in the ad group named', async () => {
    const items = (await call({ view: 'keywords', campaignId: 'ed-e2' })).data!.items as Row[]
    const race = items.find((k) => k.text === 'race helmet')!
    const preview = (await callTool(cleared(), 'ebay-keywords-change', {
      ebayCampaignId: race.ebayCampaignId, keywordBids: [{ ebayKeywordId: race.ebayKeywordId, bidCents: 50 }],
      ebayAdGroupId: race.ebayAdGroupId, addNegatives: [{ text: 'used', matchType: 'EXACT' }],
    })).raw as Row
    expect(preview.ok, preview.error).toBe(true)
    expect(preview.preview).toMatchObject({ currency: 'GBP', adGroup: { id: 'ed-g1', name: 'Helmets' }, bidChanges: [{ keywordId: 'ed-k1', fromCents: race.bidCents, toCents: 50 }] })
  })

  it('a General campaign has no ad groups or keywords: said, not an empty list', async () => {
    expect(await call({ view: 'keywords', campaignId: 'ed-e1' })).toEqual({ ok: false, error: expect.stringMatching(/Italia general is a General \(cost-per-sale\) campaign: it has no ad groups or keywords/) })
    expect((await call({ view: 'ad-groups', campaignId: 'ed-e1' })).ok).toBe(false)
  })
})

// ── scope, filters, paging ───────────────────────────────────────────────────────────────────────────

describe('T4 — ebay-ad-details without a campaign, filters and pages', () => {
  it('opens the live campaigns (of the market when given); an ended one only by id; keywords only in Priority campaigns', async () => {
    expect(pick((await call({ limit: 100 })).data!.campaigns, 'ebayCampaignId')).toEqual(['ed-e5', 'ed-e2', 'ed-e1', 'ed-e4']) // by market, then name
    const it_ = (await call({ market: 'it', limit: 100 })).data!
    expect(pick(it_.campaigns, 'ebayCampaignId')).toEqual(['ed-e1', 'ed-e4'])
    expect(pick(it_.items, 'ebayItemId')).toEqual(['110000000001', '110000000002', '110000000003', '110000000006'])
    expect(pick((await call({ market: 'UK', view: 'keywords' })).data!.campaigns, 'ebayCampaignId')).toEqual(['ed-e2'])
    expect(pick((await call({ view: 'keywords' })).data!.campaigns, 'ebayCampaignId')).toEqual(['ed-e2'])
    expect((await call({ market: 'FR' })).data!).toMatchObject({ items: [], campaigns: [], empty: 'No running, paused or system-paused eBay campaign in EBAY_FR.' })
    expect(pick((await call({ search: 'gloves' })).data!.items, 'ebayItemId')).toEqual(['110000000002'])
  })

  it('refuses what cannot be answered, with the reason', async () => {
    expect(await call({ campaignId: 'nope' })).toEqual({ ok: false, error: 'Campaign not found' })
    expect((await call({ campaignId: 'ed-e1', market: 'DE' })).error).toMatch(/Italia general is a EBAY_IT campaign, not EBAY_DE/)
    expect((await call({ view: 'keywords', adGroupId: 'ed-g1' })).error).toMatch(/adGroupId needs campaignId/)
    expect(await call({ view: 'keywords', campaignId: 'ed-e2', adGroupId: 'ed-other-g' })).toEqual({ ok: false, error: 'Ad group not found' })
  })

  it('every list walks page by page with no row twice and none missed', async () => {
    for (const [args, key] of [[{}, 'ebayItemId'], [{ view: 'keywords' }, 'ebayKeywordId'], [{ view: 'ad-groups' }, 'ebayAdGroupId']] as const) {
      const whole = (await call({ ...args, limit: 100 })).data!
      const { items, pages } = await walk(args, 1)
      expect(pick(items, key)).toEqual(pick(whole.items, key))
      expect(pages).toBe(whole.total)
    }
  })

  it('a cursor belongs to one view and one set of filters, and carries no money', async () => {
    const cursor = (await call({ limit: 1 })).data!.nextCursor as string
    expect(cursor).toBeTruthy()
    expect(await call({ view: 'keywords', limit: 1, cursor })).toMatchObject({ ok: false, error: expect.stringContaining('cursor') })
    expect(await call({ market: 'IT', limit: 1, cursor })).toMatchObject({ ok: false, error: expect.stringContaining('cursor') })
    const { k } = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { k: unknown[] }
    expect(k.map((v) => typeof v)).toEqual(['string', 'string', 'string', 'string'])
  })
})

// ── another business ─────────────────────────────────────────────────────────────────────────────────

describe('T4 — ebay-ad-details reads only its own business', () => {
  it('another business\'s campaign is not found and never listed; inside that business it reads (control)', async () => {
    expect(await call({ campaignId: 'ed-other-e' })).toEqual({ ok: false, error: 'Campaign not found' })
    for (const view of ['listings', 'ad-groups', 'keywords']) {
      expect(JSON.stringify(await call({ view, limit: 100 }))).not.toContain('OTHERCANARY')
    }
    const theirs = await call({ view: 'keywords', campaignId: 'ed-other-e' }, cleared(OTHER))
    expect(pick(theirs.data!.items, 'ebayKeywordId')).toEqual(['ed-other-k'])
    expect(JSON.stringify(theirs)).not.toContain('Italia')
  })
})

// ── money ────────────────────────────────────────────────────────────────────────────────────────────

describe('T4 — money a person may not see never comes back', () => {
  const CALLS: Array<Record<string, unknown>> = [
    { campaignId: 'ed-e1' }, { campaignId: 'ed-e2' }, { view: 'ad-groups' }, { view: 'keywords' },
  ]
  const restricted = (key: string) =>
    Object.prototype.hasOwnProperty.call(RESTRICTED_FIELDS, key) || Object.prototype.hasOwnProperty.call(getTool('ebay-ad-details')!.restrictedFields ?? {}, key)
  function keysOf(value: unknown, out = new Set<string>()): Set<string> {
    if (Array.isArray(value)) value.forEach((v) => keysOf(v, out))
    else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { out.add(k); keysOf(v, out) }
    return out
  }

  it('a person without the ad-spend permission gets the same answer minus exactly the money keys', async () => {
    for (const args of CALLS) {
      const full = await call(args, cleared())
      const partial = await call(args, operator())
      expect(full.ok, full.error).toBe(true)
      expect(partial.ok, partial.error).toBe(true)
      const stripped = JSON.parse(JSON.stringify(full, (key, value) => (key && restricted(key) ? undefined : value)))
      expect({ args, answer: partial }).toEqual({ args, answer: stripped })
      expect({ args, leaked: [...keysOf(partial)].filter(restricted) }).toEqual({ args, leaked: [] })
      // Positive control: the money-cleared answer really carries money keys.
      expect({ args, money: [...keysOf(full)].some(restricted) }).toEqual({ args, money: true })
    }
  })

  it('no rate, break-even, bid, fee or sale the cleared person sees appears anywhere in the operator\'s answer', async () => {
    const amounts = ['8.35', '6.55', '7.25', '12.45', '9.15', '1717', '21212', '4747', '3535', '2525', '3030', '8989']
    for (const args of CALLS) {
      const text = JSON.stringify(await call(args, operator()))
      expect({ args, found: amounts.filter((amount) => text.includes(amount)) }).toEqual({ args, found: [] })
    }
    // The cleared person does see them (the list above is not empty by mistake).
    expect(JSON.stringify(await call({ campaignId: 'ed-e1' }))).toContain('8.35')
  })

  it('a reader needs ads.view: without it the read is refused', async () => {
    await expect(callTool(principal(A, [FEATURES.aiRun]), 'ebay-ad-details', {})).rejects.toMatchObject({ code: 'forbidden' })
  })
})
