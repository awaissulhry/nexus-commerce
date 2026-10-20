/**
 * SD CREATE P2a — Claude creates Amazon Sponsored Display parts through create-ad-campaign (adProduct SD),
 * create-ad-group, add-product-ads, add-ad-targets and add-negative-targets, run for real through the door and the
 * approval gate (PGlite, production schema; the job queue a stub; the ads write gate the real one). Sandbox unless a
 * test goes live; live, every Amazon call goes through the REAL Ads client and channel gateway with `fetch` stubbed and
 * the documented SD 3.0 answers (HTTP 207, `[{ code, description, <entity>Id }]`), so each request body Amazon would get
 * is asserted. Nothing leaves this machine. Fake ids, SKUs, names and amounts only (fake ASINs start B0FX).
 *
 * Proven: each preview lists the campaign, the ad group, each product (SKU → ASIN, in stock or not — out of stock
 * advertised on purpose), each target in words with its bid, the budget, "born PAUSED" and "SPENDS MONEY when switched
 * on"; what Amazon or the tactic would refuse is refused before anything is queued; an SD create never runs by rule;
 * approved, the campaign is created PAUSED and off the allowlist with its ad group, product ads and targets; Amazon's
 * refusal reaches the person in its own words; undo archives (campaign, ad group) or pauses (targets).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { seedAdsFixture } from '../../../test-support/ads-fixtures.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'

const h = vi.hoisted(() => ({ calls: [] as Array<{ method: string; path: string; body: unknown }>, refuse: new Map<string, unknown>() }))
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
    readinessQueue: queue, agentPlanQueue: null, queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: false, status: 'not-initialized' }), resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: { connection: null },
  }
})
vi.mock('../../outbound-destination.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveDestinations: async (_db: unknown, rows: unknown[]) => rows.map(() => ({ connectionId: null, reason: 'NO_ACCOUNT' })),
}))
// Live: the Ads client's token, app and account, and the gateway's ledger, stand in; `fetch` answers as Amazon would.
vi.mock('../../gateway/account.js', () => import('../../../test-support/gateway-stubs.js').then((m) => m.accountModule))
vi.mock('../../gateway/ledger.js', () => import('../../../test-support/gateway-stubs.js').then((m) => m.ledgerModule))
vi.mock('../../connection-resolver.service.js', async (original) => ({
  ...(await original<object>()),
  resolveConnectionForProfile: vi.fn(async () => ({ id: 'ads-1', connectionMetadata: {} })),
}))
vi.mock('../../cx/apps.service.js', () => ({ getChannelApp: vi.fn(async () => ({ clientId: 'amzn1.application-oa2-client.x' })) }))
vi.mock('../../cx/token.service.js', () => ({ getAccessToken: vi.fn(async () => 'ads-token') }))
vi.mock('../../outbound-api-call-log.service.js', async (original) => ({
  ...(await original<object>()),
  recordApiCall: async (_ctx: unknown, run: () => Promise<unknown>) => run(),
}))

import { callTool, type UserPrincipal } from '../call-tool.js'
import { decideApproval, runOrQueueTool } from '../approval-gate.service.js'
import { undoRequestFor } from '../change-record.service.js'
import { getTool } from '../tool-registry.js'
import { __rateTest } from '../../gateway/rate.js'
import { SD_BY_RULE } from './ads-sd-create-kit.js'

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const EVERYTHING = new Set<string>([...Object.values(FEATURES), ...Object.values(FIELDS)])
const person = (userId: string, via: 'claude' | 'app'): UserPrincipal => ({
  kind: 'user', userId, label: `Person ${userId}`, via, workspace: business, permissions: { isOwner: false, permissions: EVERYTHING },
})
const claude = person('u-asker', 'claude')
const approver = person('u-approver', 'app')

type Row = Record<string, any>
const preview = async (tool: string, args: Record<string, unknown>) => (await inside(() => callTool(claude, tool, args))).raw as Row
async function ask(tool: string, args: Record<string, unknown>) {
  return inside(async () => {
    const run = await database.client.agentRun.create({ data: { agentKey: 'mcp', trigger: 'manual', status: 'done', via: 'claude', userId: claude.userId } })
    return runOrQueueTool(tool, args, claude, run.id, { forceAsk: true })
  })
}
const approve = (approvalId: string) => inside(() => decideApproval(approvalId, 'approve', approver)) as Promise<Row>
const status = async (approvalId: string) => (await inside(() => callTool(claude, 'approval-status', { approvalId }))).visible.data as Row
const sql = <T = Row>(text: string, params: unknown[] = []) => inside(async () => (await database.client.$queryRawUnsafe(text, ...params)) as T[])
/** A tool's own rule check on a stored preview, with its default limits: what a run by rule would meet. */
const byRule = (tool: string, p: unknown) => { const t = getTool(tool)!; return t.withinLimits!(p, t.limits!.parse({})) }

const FUTURE = '2099-01-10'
let nextId = 900000000001
/** Amazon's 207 for an SD create: an id per item, unless a test told the path (or the target's value) to refuse. */
function amazonAnswer(method: string, path: string, body: unknown): unknown {
  if (method !== 'POST') return []
  const items = Array.isArray(body) ? body : []
  const idField = { '/sd/campaigns': 'campaignId', '/sd/adGroups': 'adGroupId', '/sd/productAds': 'adId', '/sd/targets': 'targetId', '/sd/negativeTargets': 'targetId' }[path]
  return items.map((item) => {
    const refusal = h.refuse.get(path) ?? h.refuse.get(JSON.stringify((item as Row).expression ?? ''))
    return refusal ?? { code: 'SUCCESS', [idField ?? 'id']: nextId++ }
  })
}
const goLive = () => {
  // The Ads client's live door resolves the business's Ads account (profiles on), its app and its token: stubbed above.
  vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live'); vi.stubEnv('NEXUS_AMAZON_ADS_QUOTA_MODE', 'off'); vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const path = new URL(String(url)).pathname
    const method = String(init.method ?? 'GET').toUpperCase()
    const body = init.body == null ? null : JSON.parse(String(init.body))
    h.calls.push({ method, path, body })
    return new Response(JSON.stringify(amazonAnswer(method, path, body)), { status: method === 'POST' ? 207 : 200 })
  }))
}
const posted = (path: string) => h.calls.filter((c) => c.method === 'POST' && c.path === path).flatMap((c) => c.body as Row[])

/**
 * Beside the fixture: IT in euros with a 50-euro spend ceiling; an SD campaign PAUSED with no ad group (contextual, cpc)
 * — the Owner's case of 2026-10-20; an SD audiences campaign ON (vcpm) with an ad group; an SD contextual campaign ON
 * (cpc) with an ad group; products listed on Amazon IT — one in stock, one out of stock (its offer inactive), one only a
 * draft there.
 */
beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    const db = database.client
    await seedAdsFixture(db)
    await db.marketplace.create({ data: { channel: 'AMAZON', code: 'IT', name: 'Amazon IT', region: 'EU', currency: 'EUR', language: 'it' } })
    await db.marketplace.create({ data: { channel: 'AMAZON', code: 'DE', name: 'Amazon DE', region: 'EU', currency: 'EUR', language: 'de' } })
    await db.adSpendCeiling.create({ data: { grain: 'MARKET', scopeId: 'IT', label: 'the IT market', dailyCapCents: 5000 } })
    const campaign = (id: string, name: string, extra: Record<string, unknown>) => db.campaign.create({
      data: { id, name, type: 'SD', adProduct: 'SPONSORED_DISPLAY', marketplace: 'IT', dailyBudget: '20.00', startDate: new Date('2026-01-01T00:00:00Z'), ...extra } as never,
    })
    await campaign('c-sd-paused', 'Test display paused', { externalCampaignId: '300000000001', status: 'PAUSED', tactic: 'T00020', costType: 'cpc' })
    await campaign('c-sd-aud', 'Test display audiences', { externalCampaignId: '300000000002', status: 'ENABLED', tactic: 'T00030', costType: 'vcpm' })
    await campaign('c-sd-ctx', 'Test display contextual', { externalCampaignId: '300000000003', status: 'ENABLED', tactic: 'T00020', costType: 'cpc' })
    await db.adGroup.create({ data: { id: 'g-sd-aud', campaignId: 'c-sd-aud', name: 'audiences group', defaultBidCents: 150, externalAdGroupId: '300000000102' } })
    await db.adGroup.create({ data: { id: 'g-sd-ctx', campaignId: 'c-sd-ctx', name: 'contextual group', defaultBidCents: 40, externalAdGroupId: '300000000103' } })
    const product = async (sku: string, asin: string, totalStock: number, listing: string | null) => {
      const p = await db.product.create({ data: { sku, name: `Test ${sku}`, basePrice: '49.00', amazonAsin: asin, totalStock } })
      if (listing) await db.channelListing.create({ data: { productId: p.id, channel: 'AMAZON', marketplace: 'IT', region: 'IT', channelMarket: 'AMAZON_IT', listingStatus: listing } })
    }
    await product('TEST-SD-1', 'B0FXSD0001', 7, 'ACTIVE')
    await product('TEST-SD-2', 'B0FXSD0002', 0, 'INACTIVE')
    await product('TEST-SD-3', 'B0FXSD0003', 3, 'ACTIVE')
    await product('TEST-SD-4', 'B0FXSD0004', 2, 'ACTIVE')
    await product('TEST-SD-DRAFT', 'B0FXSD0009', 5, 'DRAFT')
  })
}, 180_000)
afterAll(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); await database?.close() }, 30_000)
beforeEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); __rateTest.useMemory(); h.calls = []; h.refuse.clear() })

const contextual = (extra: Record<string, unknown> = {}) => ({
  adProduct: 'SD', market: 'IT', name: 'Test SD contextual', tactic: 'T00020', dailyBudgetCents: 2000, startDate: FUTURE, endDate: '2099-03-31',
  defaultBidCents: 45, skus: ['TEST-SD-1', 'TEST-SD-2'],
  sdTargets: [
    { type: 'similarProducts' },
    { type: 'product', asin: 'B0FXRIVAL1', bidCents: 55 },
    { type: 'category', categoryId: '12345', brandId: '45678', priceMinCents: 5000, priceMaxCents: 10000, prime: true },
  ],
  ...extra,
})

describe('create-ad-campaign, adProduct SD — the preview says everything, and what refuses it', () => {
  it('lists the campaign, the ad group, each product (SKU → ASIN, in stock or not), each target in words with its bid, born PAUSED, SPENDS MONEY when on', async () => {
    const r = await preview('create-ad-campaign', contextual())
    expect(r.ok, r.error).toBe(true)
    expect(r.preview).toMatchObject({
      action: 'create-ad-campaign', adProduct: 'SD',
      plan: {
        adProduct: 'SD', market: 'IT', name: 'Test SD contextual', currency: 'EUR', tactic: 'T00020', costType: 'cpc', dailyBudgetCents: 2000,
        startDate: FUTURE, endDate: '2099-03-31', portfolio: null,
        adGroup: { name: 'Test SD contextual Ad Group', defaultBidCents: 45, bidOptimization: 'conversions', creativeType: 'IMAGE' },
        products: [{ sku: 'TEST-SD-1', asin: 'B0FXSD0001' }, { sku: 'TEST-SD-2', asin: 'B0FXSD0002' }],
      },
      products: [
        { sku: 'TEST-SD-1', asin: 'B0FXSD0001', inStock: true, units: 7, line: 'TEST-SD-1 → B0FXSD0001: in stock (7)' },
        { sku: 'TEST-SD-2', asin: 'B0FXSD0002', inStock: false, line: expect.stringMatching(/out of stock — advertised on purpose/) },
      ],
      outOfStock: { count: 1 },
      changes: [
        { label: 'products similar to the advertised ones', toLabel: 'at EUR 0.45 per click' },
        { label: 'the product page of B0FXRIVAL1', toLabel: 'at EUR 0.55 per click' },
        { label: 'products in category 12345 (brand 45678, priced between EUR 50.00 and EUR 100.00, Prime only)', value: '12345 brand=45678 price=50-100 prime=true', toLabel: 'at EUR 0.45 per click' },
      ],
      bornPaused: { note: expect.stringMatching(/^Born PAUSED/) },
      liveWrites: false,
      spendsMoney: 'SPENDS MONEY when switched on: up to EUR 20.00 a day once a person switches it on (enable-ads); nothing while it is paused.',
      ceiling: { label: 'the IT market', dailyCapCents: 5000 },
      reach: { reach: 'sandbox' },
      effect: expect.stringMatching(/^Creates the Sponsored Display campaign "Test SD contextual" in IT: contextual \(T00020.*paying per click \(CPC\), a daily budget of EUR 20\.00, from 2099-01-10 to 2099-03-31, and the ad group "Test SD contextual Ad Group" .* with 2 product ads and 3 targets\. It is born PAUSED and off the live-write allowlist/),
      undoNote: expect.stringMatching(/archive-ads.*permanent at Amazon/),
      nextSteps: [expect.stringMatching(/^enable-ads .*SPENDS MONEY/), expect.any(String)],
    })
    // An SD create never runs by the business's rule, whatever its limits say.
    expect(byRule('create-ad-campaign', r.preview)).toBe(SD_BY_RULE)
    // The campaign alone (no ad group yet) is a request too.
    const alone = await preview('create-ad-campaign', { adProduct: 'SD', market: 'IT', name: 'Test SD alone', tactic: 'T00030', costType: 'vcpm', dailyBudgetCents: 1000 })
    expect(alone.ok, alone.error).toBe(true)
    expect(alone.preview).toMatchObject({ plan: { adGroup: null, products: [], costType: 'vcpm' }, effect: expect.stringContaining('(no ad group yet: create-ad-group adds one)') })
  })

  it('refuses, and queues nothing: what Amazon, the tactic or the cost type would refuse, and every argument of the wrong ad product', async () => {
    const err = async (args: Record<string, unknown>) => (await preview('create-ad-campaign', args)).error as string
    expect(await err(contextual({ tactic: undefined }))).toMatch(/names its tactic: T00020 \(contextual\) or T00030 \(audiences\)/)
    expect(await err(contextual({ sdTargets: [{ type: 'views', scope: 'exactProduct', lookbackDays: 30 }] }))).toMatch(/a contextual \(T00020\) campaign takes product, category and similar-products targets only/)
    expect(await err(contextual({ bidOptimization: 'reach' }))).toMatch(/pays per click \(cpc\) optimises for clicks or conversions, not reach/)
    expect(await err(contextual({ tactic: 'T00030', costType: 'vcpm', bidOptimization: 'clicks', sdTargets: [] }))).toMatch(/optimises for reach only, not clicks/)
    // Amazon's SD vCPM minimum is EUR 1.00 in IT.
    expect(await err(contextual({ tactic: 'T00030', costType: 'vcpm', defaultBidCents: 50, sdTargets: [] }))).toMatch(/below Amazon's minimum of €1\.00 in IT/)
    expect(await err(contextual({ sdTargets: [{ type: 'views', scope: 'relatedProduct' }], tactic: 'T00030' }))).toMatch(/"relatedProduct" is not a views audience Amazon knows/)
    expect(await err(contextual({ sdTargets: [{ type: 'purchases', lookbackDays: 45 }], tactic: 'T00030' }))).toMatch(/purchases window of 7, 14, 30, 60, 90, 180, 365 days, not 45/)
    expect(await err(contextual({ sdTargets: [{ type: 'product', asin: 'B0FXRIVAL1', brandId: '1' }] }))).toMatch(/a product target does not take brandId \(brand, price, rating and Prime refine a category\)/)
    expect(await err(contextual({ sdTargets: [{ type: 'similarProducts' }, { type: 'similarProducts' }] }))).toMatch(/asked for twice — products similar to the advertised ones/)
    expect(await err(contextual({ skus: ['TEST-SD-DRAFT'] }))).toMatch(/^Not on Amazon IT: TEST-SD-DRAFT/)
    expect(await err(contextual({ skus: ['TEST-SD-2'], includeOutOfStock: false }))).toMatch(/every product named is out of stock \(TEST-SD-2\) and includeOutOfStock is false/)
    expect(await err(contextual({ name: 'Test SD — launch' }))).toMatch(/contains "—", which Amazon refuses in names/)
    expect(await err(contextual({ startDate: '2020-01-01' }))).toMatch(/start date 2020-01-01 is in the past/)
    expect(await err(contextual({ endDate: '2099-01-01' }))).toMatch(/end date 2099-01-01 is before the start date 2099-01-10/)
    expect(await err(contextual({ market: 'DE' }))).toMatch(/^Set a spend ceiling for this market first: DE/)
    expect(await err(contextual({ dailyBudgetCents: 6000 }))).toMatch(/above the IT market's spend ceiling of EUR 50\.00/)
    expect(await err(contextual({ skus: ['TEST-SD-1'], defaultBidCents: undefined }))).toMatch(/Name the ad group's default bid/)
    expect(await err(contextual({ keywords: [{ text: 'jacket', matchType: 'EXACT' }] }))).toMatch(/^keywords is for a Sponsored Products campaign/)
    // A Sponsored Display argument is never dropped from a Sponsored Products request.
    expect(await err({ market: 'IT', name: 'Test SP', skus: ['TEST-SD-1'], dailyBudgetCents: 1500, defaultBidCents: 60, keywords: [{ text: 'jacket', matchType: 'EXACT' }], tactic: 'T00020' }))
      .toMatch(/^tactic is for a Sponsored Display campaign: ask with adProduct "SD"/)
  })
})

describe('create-ad-campaign, adProduct SD — approved', () => {
  it('sandbox: born PAUSED and off the allowlist, with its ad group, both product ads (out of stock too) and its targets; approval-status counts them; undo archives it', async () => {
    const asked = await ask('create-ad-campaign', contextual({ name: 'Test SD sandbox', why: 'test' }))
    expect(asked).toMatchObject({ ok: true, mode: 'queued' })
    const done = await approve(asked.approvalId!)
    expect(done).toMatchObject({ ok: true, status: 'executed', result: { status: 'PAUSED', liveWrites: false, created: { adGroups: 1, productAds: 2, targets: 3 } } })
    const [c] = await sql(`SELECT id, status, "adProduct", tactic, "costType", "liveBidWritesEnabled", "endDate" FROM "Campaign" WHERE name = 'Test SD sandbox'`)
    expect(c).toMatchObject({ status: 'PAUSED', adProduct: 'SPONSORED_DISPLAY', tactic: 'T00020', costType: 'cpc', liveBidWritesEnabled: false })
    expect(new Date(c.endDate).toISOString().slice(0, 10)).toBe('2099-03-31')
    const [g] = await sql(`SELECT id, name, "creativeType", "defaultBidCents" FROM "AdGroup" WHERE "campaignId" = $1`, [c.id])
    expect(g).toMatchObject({ name: 'Test SD sandbox Ad Group', creativeType: 'IMAGE', defaultBidCents: 45 })
    expect((await sql(`SELECT sku FROM "AdProductAd" WHERE "adGroupId" = $1 ORDER BY sku`, [g.id])).map((r) => r.sku)).toEqual(['TEST-SD-1', 'TEST-SD-2'])
    expect(await sql(`SELECT kind, "expressionType", "expressionValue", "bidCents" FROM "AdTarget" WHERE "adGroupId" = $1 ORDER BY "expressionValue"`, [g.id])).toEqual([
      { kind: 'CATEGORY', expressionType: 'CATEGORY', expressionValue: '12345 brand=45678 price=50-100 prime=true', bidCents: 45 },
      { kind: 'PRODUCT', expressionType: 'ASIN', expressionValue: 'B0FXRIVAL1', bidCents: 55 },
      { kind: 'PRODUCT', expressionType: 'SIMILAR_PRODUCT', expressionValue: 'similarProduct', bidCents: 45 },
    ])
    expect(await status(asked.approvalId!)).toMatchObject({ status: 'executed', ads: { reach: 'sandbox', created: { total: 7, atAmazon: 0 } } })
    expect(await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))).toMatchObject({ request: { tool: 'archive-ads', args: { campaignIds: [c.id] } } })
  })

  it('live: the bodies Amazon gets (born paused, tactic, cost type, days; bidOptimization reach; seller SKUs; nested audiences) and a target Amazon refuses, in its words', async () => {
    goLive()
    const views = [{ type: 'views', value: [{ type: 'exactProduct' }, { type: 'lookback', value: '30' }] }]
    h.refuse.set(JSON.stringify([{ type: 'audience', value: [{ type: 'audienceSameAs', value: '424242' }] }]), { code: 'INVALID_ARGUMENT', description: 'Cannot create targeting clause: audience size is too small' })
    const args = {
      adProduct: 'SD', market: 'IT', name: 'Test SD live', tactic: 'T00030', costType: 'vcpm', dailyBudgetCents: 3000, startDate: FUTURE,
      adGroupName: 'Test SD live group', defaultBidCents: 150, creativeType: 'IMAGE', skus: ['TEST-SD-3', 'TEST-SD-2'],
      sdTargets: [{ type: 'views' }, { type: 'purchases', scope: 'relatedProduct', lookbackDays: 365, bidCents: 200 }, { type: 'audience', audienceId: '424242' }, { type: 'category', categoryId: '777', ratingMin: 4 }],
      why: 'test',
    }
    const p = await preview('create-ad-campaign', args)
    expect(p.preview).toMatchObject({ reach: { reach: 'live', profileId: 'P-IT-TEST' }, changes: expect.arrayContaining([expect.objectContaining({ label: 'people who viewed the advertised products in the last 30 days', toLabel: 'at EUR 1.50 per 1,000 viewable impressions' })]) })
    expect(h.calls).toEqual([]) // a preview sends nothing
    const asked = await ask('create-ad-campaign', args)
    const done = await approve(asked.approvalId!)
    expect(done, JSON.stringify(done)).toMatchObject({ ok: true, status: 'executed', result: { status: 'PAUSED', created: { adGroups: 1, productAds: 2, targets: 3 }, partial: true } })
    expect(done.result.notCreated).toEqual([expect.stringMatching(/^target the Amazon audience 424242 \(Amazon refused it: INVALID_ARGUMENT — Cannot create targeting clause: audience size is too small\)/)])
    expect(posted('/sd/campaigns')).toEqual([{ name: 'Test SD live', budgetType: 'daily', budget: 30, costType: 'vcpm', startDate: '20990110', state: 'paused', tactic: 'T00030' }])
    const [group] = posted('/sd/adGroups')
    expect(group).toEqual({ campaignId: expect.any(Number), name: 'Test SD live group', defaultBid: 1.5, state: 'enabled', bidOptimization: 'reach', creativeType: 'IMAGE' })
    expect(posted('/sd/productAds').map((b) => ({ sku: b.sku, asin: b.asin, state: b.state }))).toEqual([
      { sku: 'TEST-SD-3', asin: undefined, state: 'enabled' }, { sku: 'TEST-SD-2', asin: undefined, state: 'enabled' },
    ])
    expect(posted('/sd/targets').map((b) => [b.expressionType, b.expression, b.bid])).toEqual([
      ['manual', views, 1.5],
      ['manual', [{ type: 'purchases', value: [{ type: 'relatedProduct' }, { type: 'lookback', value: '365' }] }], 2],
      ['manual', [{ type: 'audience', value: [{ type: 'audienceSameAs', value: '424242' }] }], 1.5],
      ['manual', [{ type: 'asinCategorySameAs', value: '777' }, { type: 'asinReviewRatingGreaterThan', value: '4' }], 1.5],
    ])
    // The refused target left no row; the others carry Amazon's ids.
    const rows = await sql(`SELECT t."expressionValue", t."externalTargetId" FROM "AdTarget" t JOIN "AdGroup" g ON g.id = t."adGroupId" JOIN "Campaign" c ON c.id = g."campaignId" WHERE c.name = 'Test SD live' ORDER BY t."expressionValue"`)
    expect(rows.map((r) => [r.expressionValue, !!r.externalTargetId])).toEqual([['777 rating>4', true], ['exactProduct lookback=30', true], ['relatedProduct lookback=365', true]])
  })

  it('live: Amazon refuses the campaign — not run, its words said, nothing else sent', async () => {
    goLive()
    h.refuse.set('/sd/campaigns', { code: 'INVALID_ARGUMENT', description: 'Budget is below the minimum' })
    const asked = await ask('create-ad-campaign', contextual({ name: 'Test SD refused', why: 'test' }))
    const done = await approve(asked.approvalId!)
    expect(JSON.stringify(done)).toMatch(/Amazon did not take the campaign — Amazon refused it: INVALID_ARGUMENT — Budget is below the minimum/)
    expect(h.calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual(['/sd/campaigns'])
  })
})

describe('create-ad-group — an ad group in an existing SD campaign (the paused one with none, 2026-10-20)', () => {
  it('previews it in words, refuses a bidOptimization the campaign\'s cost type does not take and Sponsored Products arguments; approved, it is made with its creative type', async () => {
    const args = { campaignId: 'c-sd-paused', name: 'Test SD group', defaultBidCents: 35, bidOptimization: 'clicks', creativeType: 'VIDEO', skus: ['TEST-SD-1'], sdTargets: [{ type: 'product', asin: 'B0FXRIVAL2' }] }
    const r = await preview('create-ad-group', args)
    expect(r.ok, r.error).toBe(true)
    expect(r.preview).toMatchObject({
      adProduct: 'SD', campaign: { id: 'c-sd-paused', tactic: 'T00020', costType: 'cpc', status: 'PAUSED' },
      plan: { name: 'Test SD group', defaultBidCents: 35, bidOptimization: 'clicks', creativeType: 'VIDEO', start: 'live' },
      products: [{ sku: 'TEST-SD-1', asin: 'B0FXSD0001', inStock: true }],
      changes: [{ label: 'the product page of B0FXRIVAL2', toLabel: 'at EUR 0.35 per click' }],
      raises: [], spendsMoney: expect.stringMatching(/^SPENDS MONEY when switched on: when its campaign is switched on/),
      effect: expect.stringMatching(/Its campaign is paused: nothing of it serves until a person switches the campaign on/),
    })
    expect(byRule('create-ad-group', r.preview)).toBe(SD_BY_RULE)
    expect((await preview('create-ad-group', { ...args, bidOptimization: 'reach' })).error).toMatch(/pays per click \(cpc\) optimises for clicks or conversions, not reach/)
    expect((await preview('create-ad-group', { ...args, keywords: [{ text: 'jacket', matchType: 'EXACT' }] })).error).toMatch(/keywords is for a Sponsored Products ad group/)
    expect((await preview('create-ad-group', { ...args, campaignId: 'c-sd-aud', sdTargets: [{ type: 'views' }], bidOptimization: undefined, defaultBidCents: 150 })).preview)
      .toMatchObject({ plan: { bidOptimization: 'reach' }, spendsMoney: expect.stringMatching(/at once — its campaign is on/), raises: [expect.stringMatching(/1 product ad and 1 target/)] })
    // An SD argument for a Sponsored Products campaign is refused, not dropped.
    expect((await preview('create-ad-group', { campaignId: 'c-it', name: 'x', defaultBidCents: 40, skus: ['TEST-SD-1'], keywords: [{ text: 'a', matchType: 'EXACT' }], sdTargets: [{ type: 'similarProducts' }] })).error)
      .toMatch(/sdTargets is for an ad group of a Sponsored Display campaign; this campaign is not one/)
    const asked = await ask('create-ad-group', { ...args, why: 'test' })
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed', result: { created: { productAds: 1, targets: 1 } } })
    const [g] = await sql(`SELECT id, "creativeType" FROM "AdGroup" WHERE "campaignId" = 'c-sd-paused' AND name = 'Test SD group'`)
    expect(g.creativeType).toBe('VIDEO')
    expect(await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))).toMatchObject({ request: { tool: 'archive-ads', args: { adGroupIds: [g.id] } } })
  })
})

describe('add-product-ads — SKUs into an SD ad group', () => {
  it('out of stock included by default (said in the preview), left out only when asked; refuses the SD flag for a Sponsored Products ad group', async () => {
    const r = await preview('add-product-ads', { adGroupId: 'g-sd-ctx', skus: ['TEST-SD-3', 'TEST-SD-2'] })
    expect(r.ok, r.error).toBe(true)
    expect(r.preview).toMatchObject({
      adProduct: 'SD', totals: { productAds: 2 }, outOfStock: { count: 1 },
      productLines: [{ sku: 'TEST-SD-3', inStock: true }, { sku: 'TEST-SD-2', inStock: false, line: expect.stringMatching(/advertised on purpose/) }],
      spendsMoney: expect.stringMatching(/at once/),
    })
    expect(byRule('add-product-ads', r.preview)).toBe(SD_BY_RULE)
    expect((await preview('add-product-ads', { adGroupId: 'g-sd-ctx', skus: ['TEST-SD-3', 'TEST-SD-2'], includeOutOfStock: false })).preview).toMatchObject({ totals: { productAds: 1 }, leftOut: ['TEST-SD-2'] })
    expect((await preview('add-product-ads', { adGroupId: 'g-c-it', skus: ['TEST-SD-3'], includeOutOfStock: false })).error).toMatch(/includeOutOfStock is for an ad group of a Sponsored Display campaign/)
    const asked = await ask('add-product-ads', { adGroupId: 'g-sd-ctx', skus: ['TEST-SD-3', 'TEST-SD-2'], why: 'test' })
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed', result: { created: 2 } })
    // The same product twice in one campaign is refused.
    expect((await preview('add-product-ads', { adGroupId: 'g-sd-ctx', skus: ['TEST-SD-3'] })).error).toMatch(/the same product twice in one campaign/)
    expect(await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))).toMatchObject({ request: { tool: 'pause-ads' } })
  })
})

describe('add-ad-targets — SD targets in plain words', () => {
  it('builds each target, judges the tactic and the cost type, refuses Sponsored Products arguments; approved, its undo pauses them', async () => {
    const r = await preview('add-ad-targets', { adGroupId: 'g-sd-aud', sdTargets: [{ type: 'views', scope: 'similarProduct', lookbackDays: 14 }, { type: 'purchases', scope: 'category', categoryId: '55', brandId: '66', lookbackDays: 90, bidCents: 300 }] })
    expect(r.ok, r.error).toBe(true)
    expect(r.preview).toMatchObject({
      adProduct: 'SD', campaign: { tactic: 'T00030', costType: 'vcpm' }, totals: { targets: 2, audiences: 2, contextual: 0 },
      changes: [
        { label: 'people who viewed products similar to the advertised ones in the last 14 days', toLabel: 'at EUR 1.50 per 1,000 viewable impressions' },
        { label: 'people who bought products in category 55 (brand 66) in the last 90 days', value: '55 brand=66 lookback=90', toLabel: 'at EUR 3.00 per 1,000 viewable impressions' },
      ],
      spendsMoney: expect.stringMatching(/at once/), highestBidCents: 300,
    })
    expect(byRule('add-ad-targets', r.preview)).toBe(SD_BY_RULE)
    expect((await preview('add-ad-targets', { adGroupId: 'g-sd-ctx', sdTargets: [{ type: 'audience', audienceId: '1' }] })).error).toMatch(/a contextual \(T00020\) campaign takes product, category and similar-products targets only/)
    expect((await preview('add-ad-targets', { adGroupId: 'g-sd-aud', sdTargets: [{ type: 'similarProducts', bidCents: 20 }] })).error).toMatch(/below Amazon's minimum of €1\.00 in IT/)
    expect((await preview('add-ad-targets', { adGroupId: 'g-sd-ctx', keywords: [{ text: 'jacket', matchType: 'EXACT' }], sdTargets: [{ type: 'similarProducts' }] })).error).toMatch(/keywords is for a Sponsored Products ad group/)
    expect((await preview('add-ad-targets', { adGroupId: 'g-c-it', sdTargets: [{ type: 'similarProducts' }] })).error).toMatch(/sdTargets is for an ad group of a Sponsored Display campaign; this ad group is not one/)
    const asked = await ask('add-ad-targets', { adGroupId: 'g-sd-ctx', sdTargets: [{ type: 'similarProducts' }, { type: 'category', categoryId: '99', ratingMin: 3, ratingMax: 5 }], why: 'test' })
    const done = await approve(asked.approvalId!)
    expect(done).toMatchObject({ ok: true, status: 'executed', result: { added: 2 } })
    // Already in the ad group now: refused by name.
    expect((await preview('add-ad-targets', { adGroupId: 'g-sd-ctx', sdTargets: [{ type: 'similarProducts' }] })).error).toMatch(/products similar to the advertised ones is already in this ad group/)
    const ids = (done.result.targets as Row[]).map((t) => t.targetId).sort()
    const undo = await inside(() => undoRequestFor({ approvalId: asked.approvalId! })) as Row
    expect(undo.request.tool).toBe('pause-ads')
    expect([...undo.request.args.targetIds].sort()).toEqual(ids)
  })
})

describe('add-negative-targets — an SD negative brand beside the negative ASIN', () => {
  it('adds a negative brand to an SD ad group (sandbox), refuses one for a Sponsored Products ad group, and live sends asinBrandSameAs', async () => {
    const r = await preview('add-negative-targets', { adGroupIds: ['g-sd-aud'], brands: ['45678'], asins: ['B0FXOTHER1'] })
    expect(r.ok, r.error).toBe(true)
    expect(r.preview).toMatchObject({ totals: { negatives: 2, asins: 1, brands: 1 }, effect: expect.stringMatching(/1 negative product target and 1 negative brand/) })
    expect((await preview('add-negative-targets', { adGroupIds: ['g-c-it'], brands: ['45678'] })).error).toMatch(/negative brand 45678: a negative brand goes into an ad group of a Sponsored Display campaign only/)
    expect((await preview('add-negative-targets', { adGroupIds: ['g-c-sb'], brands: ['45678'] })).error).toMatch(/a negative brand goes into an ad group of a Sponsored Display campaign only/)
    const asked = await ask('add-negative-targets', { negatives: [{ adGroupId: 'g-sd-ctx', brandId: '45678' }], why: 'test' })
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed', result: { added: 1 } })
    expect(await sql(`SELECT kind, "expressionType", "expressionValue", "negativeLevel" FROM "AdTarget" WHERE "isNegative" AND "adGroupId" = 'g-sd-ctx'`))
      .toEqual([{ kind: 'BRAND', expressionType: 'BRAND', expressionValue: '45678', negativeLevel: 'AD_GROUP' }])
    expect((await preview('add-negative-targets', { adGroupIds: ['g-sd-ctx'], brands: ['45678'] })).error).toMatch(/negative brand 45678 is already negated/)

    goLive()
    const live = await ask('add-negative-targets', { adGroupIds: ['g-sd-aud'], brands: ['98765'], why: 'test' })
    expect(await approve(live.approvalId!)).toMatchObject({ ok: true, status: 'executed', result: { added: 1, reachedAmazon: 1 } })
    expect(posted('/sd/negativeTargets')).toEqual([{ adGroupId: 300000000102, expressionType: 'manual', expression: [{ type: 'asinBrandSameAs', value: '98765' }], state: 'enabled' }])
  })
})
