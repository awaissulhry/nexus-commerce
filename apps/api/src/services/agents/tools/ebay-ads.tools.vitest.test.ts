/**
 * MCP full control A14/A15 — Claude's eBay ad changes, run for real through the door and the approval gate (PGlite,
 * production schema; the job queue a stub; eBay ad writes off, so the eBay write layer runs in sandbox and nothing
 * leaves Nexus). The write layer's functions are wrapped so the test sees exactly what each tool hands them.
 *
 * Proven for each: the preview says SANDBOX — nothing reaches eBay — while eBay ad writes are off, and live (the
 * campaign's own account) when they are on; the kill switch and what the campaign cannot take refuse and queue
 * nothing; approved, it writes as the approver and every CampaignAction carries the approval (approval-status counts
 * them, in sandbox too); the margin override is never passed and a keyword's status never is; undo asks for the old
 * values (or, where Nexus never removes, for the lowest).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { seedAdsFixture } from '../../../test-support/ads-fixtures.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', async () => {
  const { contextualDatabase } = await import('../../../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_t, p) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), p) }) }
})
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
// On PGlite's single connection the queue row's account lookup cannot run beside the open enqueue transaction; an ads
// row names no listing account anyway (the ads worker resolves its Amazon Ads profile).
vi.mock('../../outbound-destination.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveDestinations: async (_db: unknown, rows: unknown[]) => rows.map(() => ({ connectionId: null, reason: 'NO_ACCOUNT' })),
}))

vi.mock('../../marketing/ebay-ads-write.service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../marketing/ebay-ads-write.service.js')>()
  return {
    ...real,
    setAdRates: vi.fn(real.setAdRates),
    promoteListings: vi.fn(real.promoteListings),
    updateBudget: vi.fn(real.updateBudget),
    updateKeywords: vi.fn(real.updateKeywords),
    addKeywords: vi.fn(real.addKeywords),
    addNegatives: vi.fn(real.addNegatives),
    createCampaign: vi.fn(real.createCampaign),
  }
})

import { callTool, type UserPrincipal } from '../call-tool.js'
import { decideApproval, runOrQueueTool } from '../approval-gate.service.js'
import { undoRequestFor } from '../change-record.service.js'
import { getTool } from '../tool-registry.js'
import * as ebayWrites from '../../marketing/ebay-ads-write.service.js'

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const person = (userId: string, via: 'claude' | 'app'): UserPrincipal => ({
  kind: 'user', userId, label: `Person ${userId}`, via, workspace: business,
  permissions: { isOwner: false, permissions: new Set([...Object.values(FEATURES), ...Object.values(FIELDS)]) },
})
const claude = person('u-asker', 'claude')
const approver = person('u-approver', 'app')

type Row = Record<string, any>
const preview = async (tool: string, args: Record<string, unknown>) => (await inside(() => callTool(claude, tool, args))).raw
async function ask(tool: string, args: Record<string, unknown>) {
  return inside(async () => {
    const run = await database.client.agentRun.create({ data: { agentKey: 'mcp', trigger: 'manual', status: 'done', via: 'claude', userId: claude.userId } })
    return runOrQueueTool(tool, args, claude, run.id, { forceAsk: true })
  })
}
const approve = (approvalId: string) => inside(() => decideApproval(approvalId, 'approve', approver))
const sql = <T = Row>(text: string, params: unknown[] = []) => inside(async () => (await database.client.$queryRawUnsafe(text, ...params)) as T[])
const status = async (approvalId: string) => (await inside(() => callTool(claude, 'approval-status', { approvalId }))).visible.data as Row
const tagged = (approvalId: string) => sql<{ a: string; u: string | null; reason: string | null; mode: string | null }>(
  'SELECT "actionType" AS a, "userId" AS u, "payloadAfter"->>\'_reason\' AS reason, "payloadAfter"->>\'_mode\' AS mode FROM "CampaignAction" WHERE "executionId" = $1 ORDER BY "createdAt"', [approvalId])
const SANDBOX_NOTE = 'SANDBOX: eBay ad writes are off (NEXUS_MARKETING_WRITES_EBAY), so after approval it is recorded in Nexus only — nothing reaches eBay.'
const ITEM = (n: number) => `11000000000${n}`

let account = ''
beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    const db = database.client
    account = (await db.channelConnection.create({ data: { channelType: 'EBAY', isActive: true, isPrimary: true, accountLabel: 'Test eBay account', externalAccountId: 'TEST-SELLER-1' } })).id
    for (const [code, marketplaceId, currency] of [['IT', 'EBAY_IT', 'EUR'], ['UK', 'EBAY_GB', 'GBP'], ['DE', 'EBAY_DE', 'EUR']]) {
      await db.marketplace.create({ data: { channel: 'EBAY', code, name: `eBay ${code}`, region: 'EU', currency, language: 'en', marketplaceId } })
    }
    for (const n of [1, 2, 3, 4, 5]) {
      const product = await db.product.create({ data: { sku: `TEST-EBAY-${n}`, name: `Test eBay ${n}`, basePrice: '50.00' } })
      await db.channelListing.create({ data: { productId: product.id, channelMarket: 'EBAY_IT', channel: 'EBAY', region: 'IT', marketplace: n === 5 ? 'DE' : 'IT', title: `Test ${n}`, price: '50.00', quantity: 3, listingStatus: 'ACTIVE', isPublished: true, externalListingId: ITEM(n) } })
    }
    const campaign = (id: string, extra: Record<string, unknown>) => db.ebayCampaign.create({
      data: { id, channelConnectionId: account, marketplace: 'EBAY_IT', externalCampaignId: `EXT-${id}`, name: `Test ${id}`, fundingStrategy: 'STANDARD', fundingModel: 'COST_PER_SALE', status: 'RUNNING', startDate: new Date('2026-01-01T00:00:00Z'), ...extra },
    })
    await campaign('e-cps', { bidPercentage: '5.0', adRateStrategy: 'FIXED' })
    await campaign('e-rules', { bidPercentage: '5.0', isRulesBased: true })
    await campaign('e-cpc', { fundingStrategy: 'ADVANCED', fundingModel: 'COST_PER_CLICK', campaignTargetingType: 'MANUAL', dailyBudget: '10.00', budgetCurrency: 'EUR' })
    await campaign('e-gb', { marketplace: 'EBAY_GB', fundingStrategy: 'ADVANCED', fundingModel: 'COST_PER_CLICK', campaignTargetingType: 'MANUAL', dailyBudget: '8.00', budgetCurrency: 'GBP' })
    await db.ebayAd.create({ data: { campaignId: 'e-cps', marketplace: 'EBAY_IT', listingId: ITEM(1), bidPercentage: '6.0', status: 'ACTIVE' } })
    await db.ebayAd.create({ data: { campaignId: 'e-cps', marketplace: 'EBAY_IT', listingId: ITEM(2), status: 'ACTIVE' } })
    for (const [n, be] of [[1, '10.00'], [2, '10.00'], [4, '10.00']] as const) {
      await db.ebayListingEconomics.create({ data: { marketplace: 'IT', itemId: ITEM(n), breakEvenAdRatePct: be, dataStatus: 'ESTIMATED' } })
    }
    await db.ebayAdGroup.create({ data: { id: 'eg-1', campaignId: 'e-cpc', externalAdGroupId: 'EXT-eg-1', name: 'Gloves', status: 'ACTIVE' } })
    await db.ebayKeyword.create({ data: { id: 'ek-1', campaignId: 'e-cpc', adGroupId: 'eg-1', externalKeywordId: 'EXT-ek-1', text: 'leather gloves', matchType: 'EXACT', bidCents: 40, status: 'ACTIVE' } })
    await db.ebayAdGroup.create({ data: { id: 'eg-gb', campaignId: 'e-gb', externalAdGroupId: 'EXT-eg-gb', name: 'Gloves GB', status: 'ACTIVE' } })
    await db.ebayKeyword.create({ data: { id: 'ek-gb', campaignId: 'e-gb', adGroupId: 'eg-gb', externalKeywordId: 'EXT-ek-gb', text: 'motorbike gloves', matchType: 'PHRASE', bidCents: 50, status: 'ACTIVE' } })
    await db.ebayKeyword.create({ data: { id: 'ek-2', campaignId: 'e-cpc', adGroupId: 'eg-1', externalKeywordId: 'EXT-ek-2', text: 'gloves', matchType: 'BROAD', bidCents: null, status: 'ACTIVE' } })
    await db.marketingSpendCeiling.create({ data: { channel: 'EBAY', marketplace: 'EBAY_IT', monthlyCapCents: 100_000 } })
  })
}, 180_000)
afterAll(async () => { vi.unstubAllEnvs(); await database?.close() }, 30_000)
beforeEach(() => { vi.unstubAllEnvs(); vi.mocked(ebayWrites.setAdRates).mockClear(); vi.mocked(ebayWrites.promoteListings).mockClear(); vi.mocked(ebayWrites.updateKeywords).mockClear() })

describe('A14 — set-ebay-ad-rates', () => {
  it('previews each rate now and after, what is left alone and why, and SANDBOX: nothing reaches eBay', async () => {
    const r = await preview('set-ebay-ad-rates', { ebayCampaignId: 'e-cps', rates: [
      { ebayItemId: ITEM(1), ratePct: 8 }, { ebayItemId: ITEM(2), ratePct: 4 }, { ebayItemId: ITEM(3), ratePct: 5 }, { ebayItemId: ITEM(1).replace(/1$/, '9'), ratePct: 5 },
    ] })
    expect(r.error).toBeUndefined()
    expect(r.preview).toMatchObject({
      campaign: { id: 'e-cps', name: 'Test e-cps', marketplace: 'EBAY_IT' },
      changes: [{ itemId: ITEM(1), fromPct: 6, toPct: 8, breakEvenPct: 10 }, { itemId: ITEM(2), fromPct: 5, toPct: 4, breakEvenPct: 10 }],
      left: { noAd: [ITEM(3), '110000000009'], same: [], aboveBreakEven: [] },
      reach: { reach: 'sandbox' }, reachNote: SANDBOX_NOTE,
      effect: expect.stringMatching(/^Sets the ad rate of 2 listings in Test e-cps \(1 up, 1 down\); left as they are: 2 listings not promoted in it\./),
    })
    expect(getTool('set-ebay-ad-rates')).toMatchObject({ alwaysAsk: true, maxClaudeTrust: 'ask', reversibility: 'full', openWorld: true, requires: ['ads.bids.edit', FIELDS.financialsAdspendView] })
  })

  it('a rate above break-even is never set (no override), and what the campaign cannot take is refused', async () => {
    expect((await preview('set-ebay-ad-rates', { ebayCampaignId: 'e-cps', rates: [{ ebayItemId: ITEM(1), ratePct: 12 }] })).error).toBe('Test e-cps: nothing changes — 1 above break-even (never set here).')
    expect((await preview('set-ebay-ad-rates', { ebayCampaignId: 'e-cpc', rates: [{ ebayItemId: ITEM(1), ratePct: 8 }] })).error).toMatch(/^Test e-cpc is a Priority \(cost-per-click\) campaign: its ads have no rate/)
    expect((await preview('set-ebay-ad-rates', { ebayCampaignId: 'e-rules', rates: [{ ebayItemId: ITEM(1), ratePct: 8 }] })).error).toMatch(/is rules-based/)
    expect((await preview('set-ebay-ad-rates', { ebayCampaignId: 'nope', rates: [{ ebayItemId: ITEM(1), ratePct: 8 }] })).error).toBe('eBay campaign nope not found')
    await expect(inside(() => callTool(claude, 'set-ebay-ad-rates', { ebayCampaignId: 'e-cps', rates: [{ ebayItemId: ITEM(1), ratePct: 8.25 }] }))).rejects.toThrow(/one decimal at most/)
  })

  it('live when eBay ad writes are on (the campaign\'s own account); the kill switch refuses and queues nothing', async () => {
    vi.stubEnv('NEXUS_MARKETING_WRITES_EBAY', '1')
    expect((await preview('set-ebay-ad-rates', { ebayCampaignId: 'e-cps', rates: [{ ebayItemId: ITEM(1), ratePct: 8 }] })).preview)
      .toMatchObject({ reach: { reach: 'live', account }, reachNote: expect.stringMatching(/^live: after approval it is sent to eBay at once, on the campaign's own eBay account/) })
    vi.unstubAllEnvs()
    await sql('UPDATE "MarketingSpendCeiling" SET "killSwitch" = true WHERE marketplace = $1 RETURNING id', ['EBAY_IT'])
    expect((await preview('set-ebay-ad-rates', { ebayCampaignId: 'e-cps', rates: [{ ebayItemId: ITEM(1), ratePct: 8 }] })).error).toBe('Not queued: kill switch is ON for EBAY/EBAY_IT — all ad writes are halted.')
    await sql('UPDATE "MarketingSpendCeiling" SET "killSwitch" = false WHERE marketplace = $1 RETURNING id', ['EBAY_IT'])
  })

  it('approved: the write layer gets no override; every write carries the approval; approval-status says sandbox; undo asks for the old rates', async () => {
    const asked = await ask('set-ebay-ad-rates', { ebayCampaignId: 'e-cps', rates: [{ ebayItemId: ITEM(1), ratePct: 8 }, { ebayItemId: ITEM(2), ratePct: 4 }], why: 'margins allow it' })
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed', result: { changed: 2, failed: [], mode: 'sandbox' } })
    expect(vi.mocked(ebayWrites.setAdRates)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(ebayWrites.setAdRates).mock.calls[0]).toHaveLength(3)
    expect(await sql('SELECT "listingId" AS item, "bidPercentage"::text AS rate FROM "EbayAd" WHERE "campaignId" = $1 ORDER BY "listingId"', ['e-cps'])).toEqual([{ item: ITEM(1), rate: '8.00' }, { item: ITEM(2), rate: '4.00' }])
    expect(await tagged(asked.approvalId!)).toEqual([{ a: 'bulk_update_ad_rates', u: 'u-approver', reason: `Claude request ${asked.approvalId}: margins allow it`, mode: 'sandbox' }])
    const s = await status(asked.approvalId!)
    expect(s.ebay).toEqual({ writes: 1, sent: 0, sandbox: 1, partly: 0, failed: 0, waiting: 0 })
    expect(s.meaning).toBe('Approved and written in Nexus. Sandbox: 1 write recorded in Nexus only — eBay ad writes are off, so nothing reached eBay.')
    expect(await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))).toMatchObject({ request: { tool: 'set-ebay-ad-rates', args: { ebayCampaignId: 'e-cps', rates: [{ ebayItemId: ITEM(1), ratePct: 6 }, { ebayItemId: ITEM(2), ratePct: 5 }] } } })
  })

  it('a rate that moved after approval is not run', async () => {
    const asked = await ask('set-ebay-ad-rates', { ebayCampaignId: 'e-cps', rates: [{ ebayItemId: ITEM(1), ratePct: 7 }] })
    await sql('UPDATE "EbayAd" SET "bidPercentage" = 9 WHERE "listingId" = $1 RETURNING id', [ITEM(1)])
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: false, error: expect.stringMatching(/changes changed/) })
    expect(vi.mocked(ebayWrites.setAdRates)).not.toHaveBeenCalled()
    await sql('UPDATE "EbayAd" SET "bidPercentage" = 8 WHERE "listingId" = $1 RETURNING id', [ITEM(1)])
  })
})

describe('A14 — promote-ebay-listings', () => {
  it('adds at a rate per listing, leaves out what it must and says why; approved, no override; undo lowers to 2% (an ad is never removed)', async () => {
    const args = { ebayCampaignId: 'e-cps', ads: [{ ebayItemId: ITEM(3) }, { ebayItemId: ITEM(4), ratePct: 15 }, { ebayItemId: ITEM(1) }, { ebayItemId: ITEM(5) }, { ebayItemId: '119999999999' }] }
    const r = await preview('promote-ebay-listings', args)
    expect(r.preview).toMatchObject({
      adds: [{ itemId: ITEM(3), sku: 'TEST-EBAY-3', ratePct: 5, breakEvenPct: null, warning: expect.stringMatching(/break-even unknown/) }],
      left: { notListed: ['119999999999'], otherMarket: [ITEM(5)], already: [ITEM(1)], noRate: [], aboveBreakEven: [{ itemId: ITEM(4), ratePct: 15, breakEvenPct: 10 }] },
      reach: { reach: 'sandbox' }, reachNote: SANDBOX_NOTE,
    })
    expect(getTool('promote-ebay-listings')).toMatchObject({ reversibility: 'partial', maxClaudeTrust: 'ask', requires: ['ads.campaigns.manage', FIELDS.financialsAdspendView] })
    expect((await preview('promote-ebay-listings', { ebayCampaignId: 'e-cpc', ads: [{ ebayItemId: ITEM(3) }] })).error).toMatch(/manual Priority campaign: listings join an ad group — give ebayAdGroupId/)
    const asked = await ask('promote-ebay-listings', { ...args, defaultRatePct: 3 })
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed', result: { promoted: 1 } })
    const handed = vi.mocked(ebayWrites.promoteListings).mock.calls[0][1]
    expect(handed).toEqual({ campaignId: 'e-cps', items: [{ listingId: ITEM(3), ratePct: 3 }] })
    expect(await sql('SELECT status, "bidPercentage"::text AS rate FROM "EbayAd" WHERE "listingId" = $1', [ITEM(3)])).toEqual([{ status: 'SANDBOX', rate: '3.00' }])
    expect((await tagged(asked.approvalId!)).map((t) => t.a)).toEqual(['bulk_create_ads'])
    expect(await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))).toMatchObject({ request: { tool: 'set-ebay-ad-rates', args: { ebayCampaignId: 'e-cps', rates: [{ ebayItemId: ITEM(3), ratePct: 2 }] } } })
  })
})

describe('A14 — set-ebay-campaign-budget', () => {
  it('a Priority campaign\'s budget in its own currency; approved, tagged; undo sets the old one; the daily quota refuses', async () => {
    expect((await preview('set-ebay-campaign-budget', { ebayCampaignId: 'e-cpc', dailyBudgetCents: 1500 })).preview).toMatchObject({
      currency: 'EUR', currentBudgetCents: 1000, proposedBudgetCents: 1500, deltaCents: 500, budgetChangesToday: 0, reach: { reach: 'sandbox' },
      effect: 'Sets the daily budget of Test e-cpc from EUR 10.00 to EUR 15.00 (budget change 1 of 15 today).',
    })
    expect((await preview('set-ebay-campaign-budget', { ebayCampaignId: 'e-gb', dailyBudgetCents: 900 })).preview).toMatchObject({ currency: 'GBP', effect: expect.stringContaining('GBP 8.00 to GBP 9.00') })
    expect((await preview('set-ebay-campaign-budget', { ebayCampaignId: 'e-cps', dailyBudgetCents: 900 })).error).toMatch(/General \(cost-per-sale\) campaign: it has no daily budget/)
    const asked = await ask('set-ebay-campaign-budget', { ebayCampaignId: 'e-cpc', dailyBudgetCents: 1500 })
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, result: { dailyBudgetCents: 1500, mode: 'sandbox' } })
    expect(await sql('SELECT "dailyBudget"::text AS b, "budgetUpdatesToday" AS n FROM "EbayCampaign" WHERE id = $1', ['e-cpc'])).toEqual([{ b: '15.00', n: 1 }])
    expect((await tagged(asked.approvalId!)).map((t) => t.a)).toEqual(['set_campaign_budget'])
    expect(await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))).toMatchObject({ request: { tool: 'set-ebay-campaign-budget', args: { ebayCampaignId: 'e-cpc', dailyBudgetCents: 1000 } } })
    await sql('UPDATE "EbayCampaign" SET "budgetUpdatesToday" = 15 WHERE id = $1 RETURNING id', ['e-cpc'])
    expect((await preview('set-ebay-campaign-budget', { ebayCampaignId: 'e-cpc', dailyBudgetCents: 1200 })).error).toMatch(/changed 15 times today/)
    await sql('UPDATE "EbayCampaign" SET "budgetUpdatesToday" = 1 WHERE id = $1 RETURNING id', ['e-cpc'])
  })
})

describe('A14 — ebay-keywords-change (bid only, never a status)', () => {
  it('previews bids, new keywords and negatives; approved, never passes a status; tagged; undo restores bids and floors what it added', async () => {
    const args = {
      ebayCampaignId: 'e-cpc', ebayAdGroupId: 'eg-1',
      keywordBids: [{ ebayKeywordId: 'ek-1', bidCents: 55 }, { ebayKeywordId: 'ek-2', bidCents: 30 }],
      addKeywords: [{ text: 'winter gloves', matchType: 'EXACT', bidCents: 30 }, { text: 'leather gloves', matchType: 'EXACT', bidCents: 30 }],
      addNegatives: [{ text: 'cheap', matchType: 'PHRASE' }],
    }
    expect((await preview('ebay-keywords-change', args)).preview).toMatchObject({
      currency: 'EUR', adGroup: { id: 'eg-1', name: 'Gloves' },
      bidChanges: [{ keywordId: 'ek-1', text: 'leather gloves', fromCents: 40, toCents: 55 }],
      adds: [{ text: 'winter gloves', matchType: 'EXACT', bidCents: 30 }], negatives: [{ text: 'cheap', matchType: 'PHRASE' }],
      left: { dynamic: ['ek-2'], already: ['leather gloves'] }, reach: { reach: 'sandbox' }, reachNote: SANDBOX_NOTE,
      effect: expect.stringMatching(/nothing is paused\.$/),
    })
    // A GB campaign's bids are in pounds, as the write layer sends them (never converted).
    expect((await preview('ebay-keywords-change', { ebayCampaignId: 'e-gb', keywordBids: [{ ebayKeywordId: 'ek-gb', bidCents: 60 }] })).preview)
      .toMatchObject({ currency: 'GBP', bidChanges: [{ keywordId: 'ek-gb', fromCents: 50, toCents: 60 }] })
    expect((await preview('ebay-keywords-change', { ebayCampaignId: 'e-cps', keywordBids: [{ ebayKeywordId: 'ek-1', bidCents: 50 }] })).error).toMatch(/keywords exist only in manual Priority/)
    expect((await preview('ebay-keywords-change', { ebayCampaignId: 'e-cpc', addKeywords: [{ text: 'x', matchType: 'EXACT', bidCents: 30 }] })).error).toMatch(/need ebayAdGroupId/)
    const asked = await ask('ebay-keywords-change', args)
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, result: { bids: 1, added: 1, negatives: 1 } })
    for (const update of vi.mocked(ebayWrites.updateKeywords).mock.calls[0][2]) expect(update).not.toHaveProperty('status')
    expect(await sql('SELECT text, "bidCents" AS bid, status FROM "EbayKeyword" WHERE "adGroupId" = $1 ORDER BY text', ['eg-1'])).toEqual([
      { text: 'gloves', bid: null, status: 'ACTIVE' }, { text: 'leather gloves', bid: 55, status: 'ACTIVE' }, { text: 'winter gloves', bid: 30, status: 'SANDBOX' },
    ])
    expect((await tagged(asked.approvalId!)).map((t) => t.a)).toEqual(['bulk_update_keywords', 'bulk_create_keywords', 'bulk_create_negative_keywords'])
    const added = (await sql<{ id: string }>('SELECT id FROM "EbayKeyword" WHERE text = $1', ['winter gloves']))[0].id
    expect(await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))).toMatchObject({
      request: { tool: 'ebay-keywords-change', args: { ebayCampaignId: 'e-cpc', keywordBids: [{ ebayKeywordId: 'ek-1', bidCents: 40 }, { ebayKeywordId: added, bidCents: 2 }] } },
    })
  })
})

describe('A15 — create-ebay-campaign (as low as eBay allows)', () => {
  it('a General campaign starts at eBay\'s 2% minimum with no listings; approved, it is created and tagged', async () => {
    const r = await preview('create-ebay-campaign', { market: 'EBAY_IT', name: 'Gloves launch' })
    expect(r.preview).toMatchObject({
      plan: { market: 'EBAY_IT', name: 'Gloves launch', fundingModel: 'COST_PER_SALE', ratePct: 2, adRateStrategy: 'FIXED', currency: 'EUR' },
      account: { connectionId: account, name: 'Test eBay account' }, ceiling: null, reach: { reach: 'sandbox' }, reachNote: SANDBOX_NOTE,
      effect: expect.stringMatching(/at eBay's lowest ad rate, 2%, with no listings: it spends nothing until a person approves promote-ebay-listings/),
    })
    expect(getTool('create-ebay-campaign')).toMatchObject({ reversibility: 'none', maxClaudeTrust: 'ask', alwaysAsk: true, requires: ['ads.campaigns.manage', 'ads.budgets.edit', FIELDS.financialsAdspendView] })
    const asked = await ask('create-ebay-campaign', { market: 'IT', name: 'Gloves launch' })
    const done = await approve(asked.approvalId!)
    expect(done).toMatchObject({ ok: true, status: 'executed', result: { mode: 'sandbox' } })
    expect(await sql('SELECT status, "bidPercentage"::text AS rate, "fundingModel" AS f, "channelConnectionId" AS acc FROM "EbayCampaign" WHERE id = $1', [(done as Row).result.ebayCampaignId]))
      .toEqual([{ status: 'DRAFT', rate: '2.00', f: 'COST_PER_SALE', acc: account }])
    expect((await tagged(asked.approvalId!)).map((t) => t.a)).toEqual(['create_campaign'])
    expect((await preview('create-ebay-campaign', { market: 'EBAY_IT', name: 'gloves LAUNCH' })).error).toMatch(/already has an eBay campaign named "gloves LAUNCH"/)
  })

  it('a Priority campaign has no low start: refused without an eBay spend ceiling that holds a month of its budget, and outside euros', async () => {
    expect((await preview('create-ebay-campaign', { market: 'EBAY_DE', name: 'P1', fundingModel: 'COST_PER_CLICK', dailyBudgetCents: 1000 })).error)
      .toMatch(/^Set an eBay spend ceiling for EBAY_DE first: a Priority \(cost-per-click\) campaign has no low start on eBay/)
    expect((await preview('create-ebay-campaign', { market: 'EBAY_IT', name: 'P1', fundingModel: 'COST_PER_CLICK', dailyBudgetCents: 5000 })).error)
      .toBe('A daily budget of EUR 50.00 runs to EUR 1550.00 in a month, above EBAY_IT\'s eBay spend ceiling of EUR 1000.00 a month.')
    // GB: a Priority campaign in pounds, inside a ceiling in pounds; a ceiling in another currency is not compared.
    const gb = { market: 'EBAY_GB', name: 'P1', fundingModel: 'COST_PER_CLICK', dailyBudgetCents: 1000 }
    expect((await preview('create-ebay-campaign', gb)).error).toMatch(/^Set an eBay spend ceiling for EBAY_GB first/)
    await inside(() => database.client.marketingSpendCeiling.create({ data: { channel: 'EBAY', marketplace: 'EBAY_GB', monthlyCapCents: 50_000, currency: 'EUR' } }))
    expect((await preview('create-ebay-campaign', gb)).error).toMatch(/^EBAY_GB's eBay spend ceiling is in EUR and its budgets are in GBP: they cannot be compared/)
    await sql('UPDATE "MarketingSpendCeiling" SET currency = $1 WHERE marketplace = $2 RETURNING id', ['GBP', 'EBAY_GB'])
    expect((await preview('create-ebay-campaign', gb)).preview).toMatchObject({ plan: { currency: 'GBP', dailyBudgetCents: 1000 }, effect: expect.stringContaining('GBP 10.00') })
    expect((await preview('create-ebay-campaign', { market: 'EBAY_IT', name: 'P1', fundingModel: 'COST_PER_CLICK' })).error).toMatch(/needs dailyBudgetCents/)
    expect((await preview('create-ebay-campaign', { market: 'EBAY_IT', name: 'P1', fundingModel: 'COST_PER_CLICK', dailyBudgetCents: 3000 })).preview)
      .toMatchObject({ plan: { fundingModel: 'COST_PER_CLICK', targeting: 'MANUAL', dailyBudgetCents: 3000 }, ceiling: { monthlyCapCents: 100_000 } })
    expect((await preview('create-ebay-campaign', { market: 'EBAY_XX', name: 'P1' })).error).toMatch(/^eBay marketplace EBAY_XX not found in Nexus/)
  })
})
