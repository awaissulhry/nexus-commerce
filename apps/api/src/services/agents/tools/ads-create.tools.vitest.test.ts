/**
 * MCP full control A11 — create-ad-campaign, run for real through the door and the approval gate (PGlite, production
 * schema; the job queue a stub; the ads write gate the real one, sandbox unless a test goes live).
 *
 * Proven: the plan preview (campaign, ad group, products, targeting, budget in the market's own currency) with where
 * it lands; refused and not queued without a market spend ceiling ("Set a spend ceiling for this market first"), above
 * it, on a taken name, an unknown SKU, a bid above the budget, or where the gate refuses; approved, the campaign is
 * created ENABLED (never paused), OFF the live-write allowlist and born suppressed — every bid at the 2-cent floor, the
 * planned bid remembered, `bidsSuppressedBy` the person who asked — so restore-campaign puts the planned bids back;
 * approval-status counts what it created; a plan or ceiling that moved after approval is not run.
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

import { callTool, type UserPrincipal } from '../call-tool.js'
import { decideApproval, runOrQueueTool } from '../approval-gate.service.js'
import { undoRequestFor } from '../change-record.service.js'
import { getTool } from '../tool-registry.js'

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

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    await seedAdsFixture(database.client)
    for (const sku of ['TEST-JACKET-1', 'TEST-JACKET-2']) await database.client.product.create({ data: { sku, name: `Test ${sku}`, basePrice: '99.00', amazonAsin: `B0${sku.slice(-1)}TESTASN` } })
    for (const [code, currency] of [['IT', 'EUR'], ['UK', 'GBP'], ['DE', 'EUR'], ['ES', 'EUR']]) {
      await database.client.marketplace.create({ data: { channel: 'AMAZON', code, name: `Amazon ${code}`, region: 'EU', currency, language: 'en' } })
    }
    for (const [market, cap] of [['IT', 5000], ['UK', 3000], ['ES', 5000]] as const) {
      await database.client.adSpendCeiling.create({ data: { grain: 'MARKET', scopeId: market, label: `the ${market} market`, dailyCapCents: cap } })
    }
  })
}, 180_000)
afterAll(async () => { vi.unstubAllEnvs(); await database?.close() }, 30_000)
beforeEach(() => { vi.unstubAllEnvs() })

const plan = (extra: Record<string, unknown> = {}) => ({
  market: 'IT', name: 'Italy jackets launch', skus: ['TEST-JACKET-1', 'TEST-JACKET-2'], dailyBudgetCents: 1500, defaultBidCents: 60,
  keywords: [{ text: 'race jacket', matchType: 'EXACT', bidCents: 90 }, { text: 'moto jacket', matchType: 'PHRASE' }],
  negativeKeywords: [{ text: 'cheap', matchType: 'PHRASE' }],
  ...extra,
})

describe('A11 — create-ad-campaign: the plan, and what refuses it', () => {
  it('previews the whole plan in the market\'s currency, born at the floor and off the allowlist, and where it lands', async () => {
    const r = await preview('create-ad-campaign', plan())
    expect(r.ok).toBe(true)
    expect(r.preview).toMatchObject({
      plan: {
        market: 'IT', name: 'Italy jackets launch', type: 'SP', targeting: 'MANUAL', biddingStrategy: 'down', currency: 'EUR', dailyBudgetCents: 1500,
        adGroup: { name: 'Italy jackets launch Ad Group', defaultBidCents: 60 },
        products: [{ sku: 'TEST-JACKET-1', asin: 'B01TESTASN' }, { sku: 'TEST-JACKET-2', asin: 'B02TESTASN' }],
        keywords: [{ text: 'race jacket', matchType: 'EXACT', bidCents: 90 }, { text: 'moto jacket', matchType: 'PHRASE', bidCents: 60 }],
        productTargets: [], negativeKeywords: [{ text: 'cheap', matchType: 'PHRASE' }],
      },
      startsSuppressed: { floorCents: 2 }, liveWrites: false, ceiling: { label: 'the IT market', dailyCapCents: 5000 }, reach: { reach: 'sandbox' },
      effect: expect.stringMatching(/daily budget of EUR 15\.00, one ad group, 2 products and 2 keywords, 1 negative keyword\. It is born with every bid at the 2-cent floor \(suppressed, not paused\) and off the live-write allowlist/),
    })
    expect((await preview('create-ad-campaign', plan({ market: 'UK', name: 'UK targets', keywords: undefined, productTargets: ['B0TESTPT01'] }))).preview)
      .toMatchObject({ plan: { currency: 'GBP', productTargets: [{ asin: 'B0TESTPT01', bidCents: 60 }], keywords: [] }, effect: expect.stringContaining('GBP 15.00') })
    // AA-W2-13 — undo archives it (in part: what it spent stays spent); it may run by rule inside the strategy and its limits.
    expect(getTool('create-ad-campaign')).toMatchObject({
      alwaysAsk: true, maxClaudeTrust: 'auto', strategyBound: 'amazon-ads', reversibility: 'partial', openWorld: true, readOnly: false,
      requires: ['ads.campaigns.manage', 'ads.budgets.edit', FIELDS.financialsAdspendView],
    })
  })

  it('refuses, and queues nothing: no spend ceiling, above it, a taken name, an unknown SKU, both or no targeting, a bid above the budget, no currency', async () => {
    const error = async (extra: Record<string, unknown>) => (await preview('create-ad-campaign', plan(extra))).error
    expect(await error({ market: 'DE' })).toMatch(/^Set a spend ceiling for this market first: DE has no daily spend ceiling/)
    expect(await error({ dailyBudgetCents: 5001 })).toBe('A daily budget of EUR 50.01 is above the IT market\'s spend ceiling of EUR 50.00 a day.')
    expect(await error({ name: 'italy EXACT' })).toMatch(/^IT already has a campaign named "italy EXACT" \(c-it\)/)
    expect(await error({ skus: ['TEST-JACKET-1', 'NOT-OURS-9'] })).toBe('SKU not found: NOT-OURS-9.')
    expect(await error({ productTargets: ['B0TESTPT01'] })).toMatch(/^Give either keywords or productTargets/)
    expect(await error({ keywords: [] })).toMatch(/^Give either keywords or productTargets/)
    expect(await error({ keywords: [{ text: 'Race Jacket', matchType: 'EXACT' }, { text: 'race jacket', matchType: 'EXACT' }] })).toBe('Listed twice: exact race jacket.')
    expect(await error({ dailyBudgetCents: 80 })).toBe('A bid of EUR 0.90 is above the daily budget of EUR 0.80.')
    expect(await error({ market: 'FR' })).toMatch(/No currency is configured for AMAZON\/FR/)
    expect((await sql<{ n: number }>('SELECT count(*)::int AS n FROM "AgentApproval"'))[0].n).toBe(0)
  })

  it('live: where it lands at Amazon, or refused and not queued where the gate refuses', async () => {
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
    expect((await preview('create-ad-campaign', plan())).preview).toMatchObject({ reach: { reach: 'live', profileId: 'P-IT-TEST' }, reachNote: expect.stringMatching(/^live: after approval it is sent to Amazon/) })
    expect((await preview('create-ad-campaign', plan({ market: 'ES' }))).error).toMatch(/^Not queued: Amazon's write gate refuses it — no active Amazon Ads profile for marketplace=ES/)
  })
})

describe('A11 — approved, it is born safe', () => {
  it('creates it ENABLED, off the allowlist, every bid at the floor remembered for the person who asked; restore-campaign puts them back', async () => {
    const asked = await ask('create-ad-campaign', plan({ why: 'launch the jackets in Italy' }))
    expect(asked).toMatchObject({ ok: true, mode: 'queued' })
    const done = await approve(asked.approvalId!)
    expect(done).toMatchObject({ ok: true, status: 'executed', result: { status: 'ENABLED', liveWrites: false, suppressed: { by: 'user:u-asker', floorCents: 2 }, created: { adGroups: 1, productAds: 2, targets: 2, negatives: 1 }, currency: 'EUR' } })
    const campaignId = (done as Row).result.campaignId as string
    expect((await sql('SELECT status, "liveBidWritesEnabled" AS live, "dailyBudget"::text AS budget, "dailyBudgetCurrency" AS cur, "bidsSuppressedBy" AS by, "bidsSuppressedFloorCents" AS floor FROM "Campaign" WHERE id = $1', [campaignId]))[0])
      .toEqual({ status: 'ENABLED', live: false, budget: '15.00', cur: 'EUR', by: 'user:u-asker', floor: 2 })
    expect(await sql('SELECT g."defaultBidCents" AS bid, g."suppressedFromBidCents" AS kept FROM "AdGroup" g WHERE g."campaignId" = $1', [campaignId])).toEqual([{ bid: 2, kept: 60 }])
    expect(await sql('SELECT t."expressionValue" AS text, t."bidCents" AS bid, t."suppressedFromBidCents" AS kept FROM "AdTarget" t JOIN "AdGroup" g ON g.id = t."adGroupId" WHERE g."campaignId" = $1 ORDER BY t."expressionValue"', [campaignId]))
      .toEqual([{ text: 'cheap', bid: 0, kept: null }, { text: 'moto jacket', bid: 2, kept: 60 }, { text: 'race jacket', bid: 2, kept: 90 }])
    // Written as the approver, never as Claude.
    expect(await sql(`SELECT DISTINCT l."userId" AS who FROM "AdvertisingActionLog" l WHERE l."actionType" LIKE 'create_%' AND (l."entityId" = $1
      OR l."entityId" IN (SELECT id FROM "AdGroup" WHERE "campaignId" = $1)
      OR l."entityId" IN (SELECT t.id FROM "AdTarget" t JOIN "AdGroup" g ON g.id = t."adGroupId" WHERE g."campaignId" = $1)
      OR l."entityId" IN (SELECT a.id FROM "AdProductAd" a JOIN "AdGroup" g ON g.id = a."adGroupId" WHERE g."campaignId" = $1))`, [campaignId])).toEqual([{ who: 'user:u-approver' }])

    // The campaign, its ad group, 2 product ads, 2 keywords and 1 negative.
    const s = await status(asked.approvalId!)
    expect(s).toMatchObject({ status: 'executed', ads: { reach: 'sandbox', created: { total: 7, atAmazon: 0 } }, meaning: expect.stringMatching(/^Approved and written in Nexus \(7 created\)\. Sandbox/) })
    expect(s.change).toMatchObject({ reversibility: 'partial' })
    // AA-W2-13 — its undo archives the campaign: a new request a person approves, permanent at Amazon.
    expect(await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))).toMatchObject({ request: { tool: 'archive-ads', args: { campaignIds: [campaignId] } } })
    expect((await preview('archive-ads', { campaignIds: [campaignId] })).preview).toMatchObject({ permanent: expect.stringMatching(/^PERMANENT: Amazon cannot switch an archived ad on again/) })
    // Asking again for the same campaign is refused: the name is taken now.
    expect((await preview('create-ad-campaign', plan())).error).toMatch(/already has a campaign named "Italy jackets launch"/)

    // The person who asked may have its planned bids put back (a person's suppression), after a person approves it.
    const r = await preview('restore-campaign', { campaignId })
    expect(r.preview).toMatchObject({ suppressedBy: 'user:u-asker', restores: { targets: 2, adGroups: 1 }, effect: expect.stringContaining('the highest EUR 0.90') })
    const restore = await ask('restore-campaign', { campaignId })
    expect(await approve(restore.approvalId!)).toMatchObject({ ok: true, status: 'executed', result: { restored: 3 } })
    expect(await sql('SELECT t."bidCents" AS bid FROM "AdTarget" t JOIN "AdGroup" g ON g.id = t."adGroupId" WHERE g."campaignId" = $1 AND NOT t."isNegative" ORDER BY t."expressionValue"', [campaignId])).toEqual([{ bid: 60 }, { bid: 90 }])
  })

  it('a UK campaign is labelled in pounds', async () => {
    const asked = await ask('create-ad-campaign', plan({ market: 'UK', name: 'UK jackets', keywords: [{ text: 'bike jacket', matchType: 'BROAD' }] }))
    const done = await approve(asked.approvalId!)
    expect(done).toMatchObject({ ok: true, result: { currency: 'GBP' } })
    expect((await sql('SELECT "dailyBudgetCurrency" AS cur FROM "Campaign" WHERE id = $1', [(done as Row).result.campaignId]))[0]).toEqual({ cur: 'GBP' })
  })

  it('a ceiling or a plan that moved after approval is not run, and nothing is created', async () => {
    const asked = await ask('create-ad-campaign', plan({ name: 'Italy moved ceiling' }))
    await sql('UPDATE "AdSpendCeiling" SET "dailyCapCents" = 4000 WHERE grain = $1 AND "scopeId" = $2 RETURNING id', ['MARKET', 'IT'])
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: false, error: expect.stringMatching(/ceiling changed/) })
    const second = await ask('create-ad-campaign', plan({ name: 'Italy moved plan' }))
    await sql('UPDATE "Product" SET "amazonAsin" = $1 WHERE sku = $2 RETURNING id', ['B0MOVEDASN', 'TEST-JACKET-2'])
    expect(await approve(second.approvalId!)).toMatchObject({ ok: false, error: expect.stringMatching(/plan changed/) })
    expect(await sql('SELECT name FROM "Campaign" WHERE name LIKE $1', ['Italy moved%'])).toEqual([])
  })
})

/**
 * ADS AUTONOMY AA-W2-13 (D-W2-6 = A) — creating is a kind of its own: it may run by the business's rule only inside the
 * ads strategy where its products are and Claude's limits for a new campaign (its daily budget: 0 by default), never as
 * the first campaign of a market, and never with a planned bid above the strategy's highest bid. Allowlisting it and
 * starting it are separate kinds (set-campaign-live-writes, restore-campaign).
 */
describe('AA-W2-13 — create-ad-campaign by rule: inside the strategy and its limits only', () => {
  const judge = (p: unknown, limits: Record<string, unknown> = {}) => {
    const t = getTool('create-ad-campaign')!
    return t.withinLimits!(p, t.limits!.parse(limits) as Record<string, unknown>)
  }

  it('says undo archives it, for good; no strategy, the default budget limit 0, a new market or a bid above the band: a person decides', async () => {
    const p = (await preview('create-ad-campaign', plan({ name: 'Italy rule launch' }))).preview as Row
    expect(p).toMatchObject({ undoNote: expect.stringMatching(/Undo archives it \(archive-ads\), and that is permanent at Amazon/), plannedHighestBidCents: 90, limitFacts: { tool: 'create-ad-campaign', action: 'create' } })
    expect(p.newMarket).toBeUndefined()
    expect(judge(p, { maxDailyBudgetCents: 5000 })).toMatch(/there is no ads strategy for IT/)
    const row = await inside(() => database.client.adsStrategy.create({ data: {
      market: 'IT', level: 'MARKET', scopeId: '*', label: 'Test market (IT)', updatedBy: 'user:test',
      claudeMaxChangesPerDay: 10, claudeMaxRaisesPerDay: 10, claudeMaxBudgetIncreasePerDayCents: 5000, maxBidCents: 100,
    } }))
    try {
      const allowed = (await preview('create-ad-campaign', plan({ name: 'Italy rule launch' }))).preview
      expect(judge(allowed)).toMatch(/its daily budget EUR 15\.00 is more than the EUR 0\.00 this tool's limits let a new campaign start with \(0: every new campaign waits for a person\)/)
      expect(judge(allowed, { maxDailyBudgetCents: 1500 })).toBeNull()
      expect(judge(allowed, { maxDailyBudgetCents: 1500, maxProducts: 1 })).toMatch(/advertises 2 products, more than the 1/)
      await inside(() => database.client.adsStrategy.update({ where: { id: row.id }, data: { maxBidCents: 80, version: 2 } }))
      expect(judge((await preview('create-ad-campaign', plan({ name: 'Italy rule launch' }))).preview, { maxDailyBudgetCents: 1500 }))
        .toMatch(/its highest planned bid EUR 0\.90 is above the highest bid EUR 0\.80 \(ads strategy: Test market \(IT\)/)
    } finally {
      await inside(() => database.client.adsStrategy.delete({ where: { id: row.id } }))
    }
    // ES has a spend ceiling and no campaign yet: the first campaign of a market is a person's.
    const es = (await preview('create-ad-campaign', plan({ market: 'ES', name: 'Spain first' }))).preview as Row
    expect(es).toMatchObject({ newMarket: true, newMarketNote: 'NEW MARKET: the first campaign in ES.' })
  })
})

