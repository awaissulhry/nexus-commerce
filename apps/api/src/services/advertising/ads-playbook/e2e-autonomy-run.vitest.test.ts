/**
 * ADS AUTONOMY final test, part 2 of 3 — a running playbook, day to day: harvest, isolation, stock, drift, winners, phase.
 *
 * As part 1 (e2e-autonomy-build.vitest.test.ts): every change through Claude's MCP door and the Approvals page's decide
 * route (the Owner's real authenticator code where a change needs one), the engines through the entry points their
 * crons call (the advertising rule tick, the budget engine's apply, the ads sync worker's drain), on PGlite with the
 * production schema and every business policy, business profiles ON. The only stand-ins are Amazon's Ads API client
 * (test-support/ads-autonomy-e2e-amazon.ts) and the infrastructure a test process has no server for (the job queue, the
 * Redis cache and engine lock). What Amazon's reports would bring (search terms, daily spend, FBA numbers) is written as
 * the reports write it. Product A is built and started through the door first (throughStart); product B buys the same
 * category keyword "test jacket"; business B is the Owner's second business.
 *
 *   5  harvest: the scheduler's tick proposes ONE card; a term converting in A's Auto graduates to A's own Exact |
 *      Category (the intent router) at its CPC; its source keeps running it until the new home proves (handover B); a
 *      term winning where it runs is neither moved nor negated (rule 2). DEFECT D2: once applied, the card swallows
 *      every later proposal of its rule
 *   6  the isolation card negates only inside A's own ad groups; B, which buys the same keyword, gets nothing (rule 3)
 *   7  stock: short of stock, a product's bids step down by the strategy's largest change (a plain lowering, never a
 *      pause); the market's monthly cap still floors every campaign (the budget engine); the cap raised gives back only
 *      the engine's own floors; a give-back after cover returns waits for a person; no stock is ever written. DEFECT D3:
 *      a playbook-built product ad names no product, so A itself is never judged (product B is)
 *   9  drift (run before step 8, in PROFIT): a person's placement change is his — keep or revert, never put back by
 *      sync; a revert of a lifted negative waits for a person even by rule; sync only adds
 *   10 winners (before step 8): a declining term → bid → placement → its own campaign (the REAL SP Super Wizard launch,
 *      born at 2¢, off the allowlist), START with the code; once it proves, its old exact keyword is PROPOSED at low
 *      bids — never a negative. DEFECT D4: that proposal is clamped to one step by the bid tool it names
 *   8  phase: PROFIT → LAUNCH adds spend (the code); a switch that lets Claude do more alone never runs by rule
 *   14 business B's Claude and engines see none of A's rows, and A's none of B's
 *
 * Values are made up (public repo).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { amazon } from '../../../test-support/ads-autonomy-e2e-amazon.js'

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
    readinessQueue: queue, agentPlanQueue: queue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: false, status: 'not-initialized' }), resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: { connection: null },
  }
})
vi.mock('../../outbound-destination.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveDestinations: async (_db: unknown, rows: unknown[]) => rows.map(() => ({ connectionId: null, reason: 'NO_ACCOUNT' })),
}))
vi.mock('../ads-cache.js', () => ({ cached: async (_k: string, _t: number, work: () => Promise<unknown>) => work(), peekCached: async () => undefined, putCached: () => undefined, flushAdsCache: async () => undefined }))
vi.mock('../../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn() } }))
vi.mock('../../pim/readiness-index.service.js', async () => (await import('../../../test-support/readiness-module-mock.js')).readinessModuleMock(vi.fn()))
// The only stand-ins of the flow: Amazon's Ads API client and the e-mail transport.
vi.mock('../ads-api-client.js', async (importOriginal) => (await import('../../../test-support/ads-autonomy-e2e-amazon.js')).amazonAdsClient(await importOriginal()))
vi.mock('../../email/transport.js', async (importOriginal) => (await import('../../../test-support/ads-autonomy-e2e-amazon.js')).emailTransport(await importOriginal()))

import { A, B, e2eDoor, type Door } from '../../../test-support/ads-autonomy-e2e.js'
import { atAmazon, drainAdWrites, seedBusinessA, seedBusinessB, throughStart } from '../../../test-support/ads-autonomy-e2e-seed.js'

type Json = Record<string, any>
let door: Door
const db = () => database.client
const ids: Record<string, string> = {}
let flow: Awaited<ReturnType<typeof throughStart>>
const TIMEOUT = 60_000
const DAY = 86_400_000

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
  vi.stubEnv('NEXUS_OAUTH_ISSUER', 'https://web.example.test')
  vi.stubEnv('NEXUS_AI_KILL_SWITCH', '')
  vi.stubEnv('ENABLE_QUEUE_WORKERS', '')
  door = await e2eDoor(database)
  Object.assign(ids, await door.inside(() => seedBusinessA(db(), { isolation: true })))
  Object.assign(ids, await door.inside(() => seedBusinessB(db()), B))
  // A's and B's children sit at Amazon FBA (Amazon's number, read only by Nexus), selling about one a day each, a
  // 10-day lead time.
  await door.inside(async () => {
    const fba = await db().stockLocation.create({ data: { type: 'AMAZON_FBA', code: 'TEST-FBA-IT', name: 'Test FBA IT' } })
    for (const productId of [ids.aV1, ids.aV2, ids.bV1, ids.bV2]) {
      const sku = (await db().product.findUniqueOrThrow({ where: { id: productId } })).sku
      ids[`fba-${productId}`] = (await db().stockLevel.create({ data: { productId, locationId: fba.id, quantity: 30, reserved: 0, available: 30 } })).id
      await db().replenishmentRecommendation.create({ data: {
        productId, sku, velocity: '1', velocitySource: 'TRAILING_VELOCITY', leadTimeDays: 10, leadTimeSource: 'SUPPLIER_DEFAULT', safetyDays: 5,
        totalAvailable: 30, inboundWithinLeadTime: 0, effectiveStock: 30, reorderPoint: 15, reorderQuantity: 20, urgency: 'LOW', needsReorder: false,
      } })
    }
  })
  // B's PAT and Exact | Category campaigns have no hourly plan of their own: the captured slots play no rank role, so
  // their placements are the playbook's to compare and their terms' next steps are open (a performance slot's are rank's).
  await door.inside(async () => {
    const own = await db().adGroup.findMany({ where: { id: { in: [ids.bPat, ids.bExact] } }, select: { campaignId: true } })
    await db().adSchedule.deleteMany({ where: { campaignId: { in: own.map((g) => g.campaignId) } } })
  })
  // The market strategy also holds the largest bid change per action (20 %): a short product's step.
  flow = await throughStart(door, db, ids, { strategy: { maxChangePct: 20 } })
}, 240_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await door?.close()
  await database?.close()
}, 30_000)

/** One search term as Amazon's search-term report brings it: one row per day over `days` days, ending `endDaysAgo` back. */
async function reported(slot: { externalCampaignId: string; externalAdGroupId: string }, query: string, r: { orders: number; clicks: number; costCents: number; salesCents: number }, opts: { days?: number; endDaysAgo?: number; biz?: string; profileId?: string } = {}) {
  const days = opts.days ?? 10
  const end = opts.endDaysAgo ?? 9
  await door.inside(async () => {
    for (let d = 0; d < days; d++) {
      const at = new Date(Date.now() - (end + d) * DAY)
      const day = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()))
      await db().amazonAdsSearchTerm.create({ data: {
        profileId: opts.profileId ?? 'P-IT-E2E-A', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: day, campaignId: slot.externalCampaignId, adGroupId: slot.externalAdGroupId,
        query, impressions: Math.ceil(r.clicks / days) * 20, clicks: Math.round(r.clicks / days), costMicros: BigInt(Math.round(r.costCents / days) * 10_000), currencyCode: 'EUR',
        sales7dCents: Math.round(r.salesCents / days), orders7d: d < r.orders ? 1 : 0,
      } })
    }
  }, (opts.biz ?? A) as never)
}
async function tick() {
  // As the scheduler boots its ads crons (runtime/scheduler.ts): the action handlers first, then the tick.
  await import('../automation-action-handlers.js')
  const { runAdvertisingRuleEvaluatorOnce } = await import('../../../jobs/advertising-rule-evaluator.job.js')
  return door.inside(() => runAdvertisingRuleEvaluatorOnce())
}

/** Days pass for the rules: their past runs move back, so a cadence or a daily cap no longer holds the next one. */
const daysPass = (days: number) => door.inside(() => db().automationRuleExecution.updateMany({ data: { startedAt: new Date(Date.now() - days * DAY) } }))
const cardOf = async (proposedKey: string) => door.inside(() => db().adsRuleSuggestion.findFirst({ where: { proposedKey, status: 'pending' }, orderBy: { lastSeenAt: 'desc' } }))
/** The tick writes its cards after the run (fire and forget): wait for the rule's newest pending card. */
async function nextCard(proposedKey: string, after: Date) {
  let card: Json | null = null
  await vi.waitFor(async () => {
    card = await door.inside(() => db().adsRuleSuggestion.findFirst({ where: { proposedKey, status: 'pending', lastSeenAt: { gte: after } }, orderBy: { lastSeenAt: 'desc' } }))
    if (!card) throw new Error(`no ${proposedKey} card yet`)
  }, { timeout: 10_000, interval: 100 })
  return card as unknown as Json
}
/** Claude asks to apply cards (decide-automation-suggestions); a person approves it in Nexus; it runs. */
async function applyCards(suggestionIds: string[]) {
  const asked = await door.call('decide-automation-suggestions', { kind: 'amazon-ads', decisions: suggestionIds.map((suggestionId) => ({ suggestionId, decide: 'apply' })) })
  expect(asked.answer, JSON.stringify(asked.answer).slice(0, 800)).toMatchObject({ status: 'waiting_for_approval' })
  const ran = await door.approve(asked.answer.approvalId, { code: !!asked.answer.preview?.stepUp }) as Json
  expect(ran, JSON.stringify(ran)).toMatchObject({ ok: true, status: 'executed', result: { refused: 0 } })
  return { approvalId: asked.answer.approvalId as string, preview: asked.answer.preview as Json, result: ran.result as Json }
}
const targetsIn = (adGroupId: string, biz: string = A) => door.inside(() => db().adTarget.findMany({ where: { adGroupId }, select: { expressionType: true, expressionValue: true, isNegative: true, bidCents: true, externalTargetId: true } }), biz as never)
const has = (rows: Json[], type: string, text: string) => rows.some((r) => r.expressionType === type && r.expressionValue === text)
/** B's own ad groups: product B's five in business A and the other business's one. */
const bAdGroups = () => [ids.bAuto, ids.bBroad, ids.bExact, ids.bBrand, ids.bPat]
async function bSnapshot() {
  const inA = await door.inside(() => db().adTarget.findMany({ where: { adGroupId: { in: bAdGroups() } }, orderBy: { id: 'asc' }, select: { id: true, expressionType: true, expressionValue: true, bidCents: true, status: true, isNegative: true } }))
  const inB = await door.inside(() => db().adTarget.findMany({ orderBy: { id: 'asc' }, select: { id: true, expressionType: true, expressionValue: true, bidCents: true, status: true, isNegative: true } }), B)
  return { inA, inB }
}
let bBefore: Awaited<ReturnType<typeof bSnapshot>>
/** No Amazon write ever named one of B's ad groups (product B's, or the other business's). */
async function noWriteReachedB() {
  const ext = new Set((await door.inside(() => db().adGroup.findMany({ where: { id: { in: bAdGroups() } }, select: { externalAdGroupId: true } }))).map((g) => g.externalAdGroupId))
  ext.add('EXT-G-BRAVO-1')
  const writes = amazon.calls.filter((c) => /^(create|update|archive)/.test(c.name) && ext.has(String((c.args[1] as Json)?.externalAdGroupId ?? '')))
  expect(writes).toEqual([])
}

describe('5 — harvest: a winner graduates to A\'s own exact slot, its source keeps running it until the new home proves', { timeout: TIMEOUT }, () => {
  let card: Json
  it('the scheduler\'s own tick proposes ONE card for A: "test parka" from A\'s Auto to A\'s Exact | Category (the router), a waster negated; a winner where it runs is not in it', async () => {
    bBefore = await bSnapshot()
    amazon.reset()
    // What Amazon's search-term report brings: "test parka" converts in A's Auto; "teste2ea jacket" converts at home, in
    // A's own Exact | Brand; "test junk" only spends in A's Broad.
    await reported(flow.slots.auto, 'test parka', { orders: 6, clicks: 40, costCents: 1200, salesCents: 30_000 })
    await reported(flow.slots['exact-brand'], 'teste2ea jacket', { orders: 8, clicks: 50, costCents: 1500, salesCents: 40_000 })
    await reported(flow.slots['broad-category'], 'test junk', { orders: 0, clicks: 40, costCents: 2000, salesCents: 0 })
    const at = new Date()
    expect(await tick()).toMatchObject({ totalFailed: 0 })
    card = await nextCard('harvest_and_negate', at)
    expect(card).toMatchObject({ ruleName: 'TESTE2EA (IT) — playbook harvest', marketplace: 'IT' })
    expect((card.proposedAction as Json).items).toEqual([
      { kind: 'negative', step: 'negate', query: 'test junk', externalAdGroupId: flow.slots['broad-category'].externalAdGroupId },
      { kind: 'graduation', step: 'create', query: 'test parka', intent: 'CATEGORY', externalAdGroupId: flow.slots.auto.externalAdGroupId },
    ])
    expect(JSON.stringify(card.proposedAction)).not.toContain('teste2ea jacket\",\"externalAdGroupId')
    // A proposal: nothing reached Amazon yet.
    expect(amazon.named('createKeyword', 'createNegativeKeyword')).toEqual([])
  })

  it('Claude applies the card, a person approves it: "test parka" exact lands in A\'s Exact | Category at its CPC; the Auto source still runs it', async () => {
    amazon.reset()
    await applyCards([card.id])
    expect(amazon.named('createKeyword').map((c) => c.args[1])).toEqual([
      expect.objectContaining({ externalAdGroupId: flow.slots['exact-category'].externalAdGroupId, keywordText: 'test parka', matchType: 'EXACT', bid: 0.3 }),
    ])
    expect(amazon.named('createNegativeKeyword').map((c) => [(c.args[1] as Json).externalAdGroupId, (c.args[1] as Json).keywordText])).toEqual([[flow.slots['broad-category'].externalAdGroupId, 'test junk']])
    expect(has(await targetsIn(flow.slots['exact-category'].adGroupId), 'EXACT', 'test parka')).toBe(true)
    // Handover B: the source keeps the term until its new home proves itself — no negative "test parka" in A's Auto.
    expect(has(await targetsIn(flow.slots.auto.adGroupId), 'NEGATIVE_EXACT', 'test parka')).toBe(false)
    // Rule 2: the term converting where it runs is neither moved nor negated.
    const brand = await targetsIn(flow.slots['exact-brand'].adGroupId)
    expect(brand.filter((t) => t.expressionValue === 'teste2ea jacket').map((t) => t.expressionType)).toEqual(['EXACT'])
    expect(amazon.calls.filter((c) => (c.args[1] as Json)?.keywordText === 'teste2ea jacket')).toEqual([])
    await noWriteReachedB()
  })

  it('a day later, before its exact home proves: "test parka" stays where it wins (A\'s Auto) — sent home only from A\'s Broad, where it does not win', async () => {
    await daysPass(2)
    const at = new Date()
    expect(await tick()).toMatchObject({ totalFailed: 0 })
    const iso = await nextCard('isolate_product_terms', at)
    const action = iso.proposedAction as Json
    expect((action.items as Json[]).filter((i) => i.text === 'test parka').map((i) => [i.slot, i.match])).toEqual([['broad-category', 'EXACT']])
    expect(action.topLeftAlone).toEqual([expect.objectContaining({ slot: 'auto', text: 'test parka', why: expect.stringMatching(/wins here .* its exact keyword has not met that bar yet, so it keeps running where it wins/) })])
    expect(has(await targetsIn(flow.slots.auto.adGroupId), 'NEGATIVE_EXACT', 'test parka')).toBe(false)
  })

  let handoverAt = new Date()
  it('once "test parka" proves itself in its exact home, the isolation card closes it in A\'s research slots, the Auto too (handover B)', async () => {
    await reported(flow.slots['exact-category'], 'test parka', { orders: 5, clicks: 30, costCents: 900, salesCents: 25_000 })
    await daysPass(8)
    handoverAt = new Date()
    expect(await tick()).toMatchObject({ totalFailed: 0 })
    const iso = await nextCard('isolate_product_terms', handoverAt)
    expect(((iso.proposedAction as Json).items as Json[]).filter((i) => i.text === 'test parka').map((i) => [i.slot, i.match]).sort()).toEqual([['auto', 'EXACT'], ['broad-category', 'EXACT']])
    // The harvest rule's own run proposes the same handover for its source (step "handover").
    const harvestRule = await door.inside(() => db().automationRule.findFirstOrThrow({ where: { name: 'TESTE2EA (IT) — playbook harvest' } }))
    const run = await door.inside(() => db().automationRuleExecution.findFirstOrThrow({ where: { ruleId: harvestRule.id, startedAt: { gte: handoverAt } } }))
    expect((run.actionResults as Json[])[0].output).toMatchObject({ wouldHandOver: 1, items: [{ kind: 'graduation', step: 'handover', query: 'test parka', externalAdGroupId: flow.slots.auto.externalAdGroupId }] })
  })

  // 🔴 DEFECT D2 (medium) — a playbook's harvest card is a SWEEP card, one row per rule (entity "account", key
  // harvest_and_negate; ads-suggestions.service.ts:199-201). Once a person applied it, every later proposal of that rule —
  // here the handover that closes "test parka" in its Auto source — is written INTO the applied row (the upsert's update
  // branch replaces proposedAction and lastSeenAt and keeps status "applied", ads-suggestions.service.ts:223-232), and the
  // lifecycle sweep re-opens only expired or dismissed rows, never an applied one (ads-suggestions.service.ts:1130-1136).
  // So after the first apply the harvest never reaches a person again (and the record of what was applied is
  // overwritten). The isolation rule's card has the same shape. Fails today; passes once a new proposal opens a card.
  it.fails('DEFECT D2 — after its first card was applied, the harvest\'s handover proposal reaches no person', async () => {
    const { sweepSuggestionLifecycle } = await import('../ads-suggestions.service.js')
    await door.inside(() => sweepSuggestionLifecycle())
    const pending = await door.inside(() => db().adsRuleSuggestion.findMany({ where: { proposedKey: 'harvest_and_negate', status: 'pending' } }))
    expect(pending.map((c) => (c.proposedAction as Json).items)).toEqual([[expect.objectContaining({ step: 'handover', query: 'test parka' })]])
  })
})

describe('6 — the isolation card keeps apart A\'s own campaigns only; B buys the same keyword and gets nothing (rule 3)', { timeout: TIMEOUT }, () => {
  it('every negative the card lists is in one of A\'s own slot ad groups; none in B\'s, though B buys "test jacket" too', async () => {
    const card = (await cardOf('isolate_product_terms'))!
    const aGroups = new Set(Object.values(flow.slots).map((x) => x.adGroupId))
    const items = (card.proposedAction as Json).items as Json[]
    expect(items.length).toBeGreaterThan(0)
    expect(items.every((i) => aGroups.has(i.adGroupId))).toBe(true)
    expect(items.some((i) => bAdGroups().includes(i.adGroupId))).toBe(false)
    expect((card.proposedAction as Json).scope).toMatchObject({ adGroups: 5, excluded: [] })
  })

  it('Claude applies it, a person approves: the negatives land at Amazon in A\'s ad groups only; B\'s rows and keyword unchanged', async () => {
    amazon.reset()
    const card = (await cardOf('isolate_product_terms'))!
    await applyCards([card.id])
    const aExt = new Set(Object.values(flow.slots).map((x) => x.externalAdGroupId))
    const negs = amazon.named('createNegativeKeyword').map((c) => c.args[1] as Json)
    expect(negs.map((n) => [n.keywordText, n.matchType]).sort()).toEqual([['TESTE2EA', 'PHRASE'], ['TESTE2EA', 'PHRASE'], ['test parka', 'EXACT'], ['test parka', 'EXACT']])
    expect(negs.every((n) => aExt.has(n.externalAdGroupId))).toBe(true)
    expect(has(await targetsIn(flow.slots.auto.adGroupId), 'NEGATIVE_EXACT', 'test parka')).toBe(true)
    await noWriteReachedB()
    expect(await bSnapshot()).toEqual(bBefore)
  })
})

/** Amazon's FBA report brings a new number for these children (Nexus only stores what Amazon says). */
const fbaReport = (productIds: string[], units: number) => door.inside(async () => {
  for (const p of productIds) await db().stockLevel.update({ where: { id: ids[`fba-${p}`] }, data: { quantity: units, available: units } })
})
/** What a stock write would leave: every stock level, movement and non-ad outbound row of business A. */
const stockState = () => door.inside(async () => ({
  levels: (await db().stockLevel.findMany({ orderBy: { id: 'asc' }, select: { id: true, quantity: true, reserved: true, available: true } })),
  movements: await db().stockMovement.count(),
  totalStock: (await db().product.findMany({ orderBy: { id: 'asc' }, select: { id: true, totalStock: true } })),
  outbound: await db().outboundSyncQueue.count({ where: { NOT: { syncType: { startsWith: 'AD_' } } } }),
}))
/**
 * The budget engine's tick (jobs/ad-budget-enforce.job.ts budgetEnforceTick) as it runs inside its engine lock: its gate,
 * then its own apply. The lock itself is Redis, which a test process has none of (the cron then skips the run).
 */
async function enforceCaps() {
  const { applyBudgetEnforcement, budgetEnforceGate } = await import('../ads-budget-enforce.service.js')
  return door.inside(async () => {
    const gate = await budgetEnforceGate()
    expect(gate.mode).toBe('AUTO')
    return applyBudgetEnforcement({ dryRun: false, actor: 'automation:budget-manager-cron' })
  })
}
/** The send delay of a person's bid write passes (OutboundSyncQueue.holdUntil), then the worker's own drain sends it. */
async function sendQueued() {
  await door.inside(() => db().outboundSyncQueue.updateMany({ where: { syncStatus: 'PENDING' }, data: { holdUntil: new Date(Date.now() - 1000) } }))
  return drainAdWrites(door)
}
const bidsOf = (adGroupIds: string[]) => door.inside(async () => {
  const groups = await db().adGroup.findMany({ where: { id: { in: adGroupIds } }, orderBy: { id: 'asc' }, include: { targets: { where: { isNegative: false }, orderBy: { id: 'asc' } }, campaign: true } })
  return groups.map((g) => ({ group: [g.defaultBidCents, g.suppressedFromBidCents], targets: g.targets.map((t) => [t.bidCents, t.suppressedFromBidCents]), floorBy: g.campaign.bidsSuppressedAt ? g.campaign.bidsSuppressedBy : null, status: String(g.campaign.status) }))
})

describe('7 — stock: a short product\'s bids step down (never a pause, never a stock write); a stop still floors; a give-back needs a person', { timeout: TIMEOUT }, () => {
  const bGroups = () => [ids.bAuto, ids.bBroad, ids.bExact, ids.bBrand, ids.bPat]
  let stockBefore: Awaited<ReturnType<typeof stockState>>
  let bidsBefore: Awaited<ReturnType<typeof bidsOf>>
  let lowerApproval = ''
  let stepped: Awaited<ReturnType<typeof bidsOf>>
  let aPlanned: Awaited<ReturnType<typeof bidsOf>>
  const aGroups = () => Object.values(flow.slots).map((x) => x.adGroupId)

  it('Amazon\'s FBA report: A\'s and B\'s children fall to 4 units (4 days of cover, below the 10-day lead time); ad-stock-risk says so for B', async () => {
    await fbaReport([ids.aV1, ids.aV2, ids.bV1, ids.bV2], 4)
    stockBefore = await stockState()
    bidsBefore = await bidsOf(bGroups())
    const risk = await door.call('ad-stock-risk', { market: 'IT' })
    expect(risk.answer.stockNote).toMatch(/Nothing here changes a stock quantity: Amazon's FBA number is Amazon's, and Nexus only reads it/)
    const b = (risk.answer.adGroups as Json[]).filter((g) => bGroups().includes(g.adGroupId))
    expect(b.map((g) => [g.risk, g.suggestedTool])).toEqual(bGroups().map(() => ['low-stock', 'lower-ad-bids-for-stock']))
    expect((risk.answer.products as Json[]).find((x) => x.sku === 'TEST-TESTE2EB-V1')).toMatchObject({ risk: 'low-stock', units: 4, amazonFbaUnits: 4, daysOfCover: 4, shortBelowDays: 10, backAtDays: 15 })
  })

  // 🔴 DEFECT D3 (high) — a product ad the playbook builds names no product: the build hands the SP Super Wizard only SKU
  // and ASIN (ads-playbook/build.ts:82 `products: … ({ sku, asin })`), the wizard passes `productId: p.productId`
  // (undefined; ads-sp-wizard-launch.service.ts:183) and createProductAdLocal stores `productId: input.productId ?? null`
  // (ads-create.service.ts:889). Everything that ties an ad to its product by AdProductAd.productId is then blind to a
  // playbook product: stock-aware bids (ads-stock-risk.service.ts:167-199 — "an ad Nexus cannot tie to a product", risk
  // unknown, never lowered) and a product's or category's own monthly cap (ads-strategy/spend.ts:105-115 — its spend is
  // "unattributed", so the cap never floors it). Product B, whose ads name their products, is lowered below; product A,
  // short of stock the same way, is not. Fails today; passes once a built product ad carries its productId.
  it.fails('DEFECT D3 — A\'s built ad groups are short of stock like B\'s, but Nexus cannot tie their ads to A', async () => {
    const risk = await door.call('ad-stock-risk', { campaignIds: Object.values(flow.slots).map((x) => x.campaignId) })
    expect((risk.answer.adGroups as Json[]).map((g) => g.risk)).toEqual(Object.values(flow.slots).map(() => 'low-stock'))
  })

  it('lower-ad-bids-for-stock: one step down by the strategy\'s largest change (20 %), a plain lowering — never paused, no floor marker', async () => {
    amazon.reset()
    const asked = await door.call('lower-ad-bids-for-stock', { adGroupIds: bGroups(), why: 'test: B is short of stock' })
    expect(asked.answer).toMatchObject({ status: 'waiting_for_approval', preview: { totals: { adGroups: 5, stepped: 5, floored: 0 } } })
    expect(asked.answer.preview.effect).toMatch(/never pausing them/)
    expect(asked.answer.preview.effect).toMatch(/Nothing here changes a stock quantity/)
    lowerApproval = asked.answer.approvalId
    expect(await door.approve(lowerApproval)).toMatchObject({ ok: true, status: 'executed', result: { lowered: 5, stepped: 5, floored: 0, bidsMoved: 12, failed: 0, reach: { reach: 'live' } } })
    const after = await bidsOf(bGroups())
    // 20 % down, rounded; no bid remembered, no floor owner: a plain lowering, and every campaign still ENABLED.
    expect(after).toEqual(bidsBefore.map((g) => ({
      group: [Math.round(g.group[0]! * 0.8), null], targets: g.targets.map((t) => [Math.round(t[0]! * 0.8), null]), floorBy: null, status: 'ENABLED',
    })))
    // Sent to Amazon after the send delay, as the approver's own lowering, through the write gate.
    await sendQueued()
    const sent = amazon.named('updateTarget', 'updateAdGroup').map((c) => Number(((c.args[2] ?? {}) as Json).bid ?? ((c.args[2] ?? {}) as Json).defaultBid))
    expect(sent.sort()).toEqual(after.flatMap((g) => [g.group[0]!, ...g.targets.map((t) => t[0]!)]).map((c) => c / 100).sort())
    expect(amazon.calls.filter((c) => (c.args[2] as Json)?.state)).toEqual([])
    stepped = after
    aPlanned = await bidsOf(aGroups())
  })


  it('a stop still floors it: the market\'s monthly cap is reached and the budget engine\'s own run floors every campaign at 2¢ — never paused', async () => {
    // A lower cap is a lowering: no code.
    const cap = await door.call('set-ads-strategy', { channel: 'AMAZON', market: 'IT', level: 'market', values: { monthlySpendCapCents: 1000 }, reason: 'test: a tight month' })
    expect(cap.answer.preview).toMatchObject({ direction: 'lower', stepUp: null })
    expect(await door.approve(cap.answer.approvalId)).toMatchObject({ ok: true, status: 'executed' })
    // Amazon's daily campaign report: 15 EUR spent on the 1st of this month across the market.
    await door.inside(async () => {
      const now = new Date()
      const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
      const all = await db().campaign.findMany({ where: { marketplace: 'IT' }, select: { id: true, externalCampaignId: true } })
      for (const c of all) {
        await db().amazonAdsDailyPerformance.create({ data: { profileId: 'P-IT-E2E-A', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: day, entityType: 'CAMPAIGN', entityId: c.externalCampaignId ?? c.id, localEntityId: c.id, costMicros: 1_500_000n, sales7dCents: 0, orders7d: 0, currencyCode: 'EUR', reportedAt: new Date(), reportRunId: 'TEST-REPORT-RUN-1' } })
      }
    })
    // The engine applies on this server (NEXUS_BUDGET_ENFORCE_APPLY) and the Owner's account ads dial is at AUTO, as he
    // set it on the Control Room (its own path); at SUGGEST the engine sets no new floor.
    vi.stubEnv('NEXUS_BUDGET_ENFORCE_APPLY', '1')
    const { changeAutonomy } = await import('../ads-automation-state.service.js')
    await door.inside(() => changeAutonomy('AUTO', `user:${door.people.owner.id}`))
    amazon.reset()
    expect(await enforceCaps()).toMatchObject({ dryRun: false, suppressed: 10, failed: 0, guard: { posture: 'auto' } })
    await sendQueued()
    // Every campaign of the market at the 2-cent floor, its bid remembered — B's at its stock step, A's at its plan —
    // the campaigns still ENABLED (low bids, never a pause), at Amazon too.
    const floored = (rows: Awaited<ReturnType<typeof bidsOf>>, remembered: Awaited<ReturnType<typeof bidsOf>>) => rows.map((g, i) => ({
      group: [2, remembered[i].group[0]], targets: g.targets.map((t, j) => [2, remembered[i].targets[j][0] === 2 ? null : remembered[i].targets[j][0]]), floorBy: 'automation:budget-manager-cron', status: 'ENABLED',
    }))
    expect(await bidsOf(bGroups())).toEqual(floored(await bidsOf(bGroups()), stepped))
    expect(await bidsOf(aGroups())).toEqual(floored(await bidsOf(aGroups()), aPlanned))
    expect(amazon.bids().every((b) => Number(b) === 0.02)).toBe(true)
    expect(amazon.calls.filter((c) => (c.args[2] as Json)?.state)).toEqual([])
  })

  it('the cap raised again (a raise: the Owner\'s code): the engine gives back only its own floors — B to its stock step, A to its plan', async () => {
    const cap = await door.call('set-ads-strategy', { channel: 'AMAZON', market: 'IT', level: 'market', values: { monthlySpendCapCents: 10_000_000 } })
    expect(cap.answer.preview).toMatchObject({ direction: 'raise', stepUp: expect.any(Object) })
    expect((await door.decide(cap.answer.approvalId)).status).toBe(403)
    expect(await door.approve(cap.answer.approvalId, { code: true })).toMatchObject({ ok: true, status: 'executed' })
    expect(await enforceCaps()).toMatchObject({ restored: 10, failed: 0 })
    await sendQueued()
    expect(await bidsOf(bGroups())).toEqual(stepped)
    expect(await bidsOf(aGroups())).toEqual(aPlanned)
  })

  it('cover returns: the give-back waits for a person even with the rule at auto (its default limits give back nothing alone); approved, the bids before the step', async () => {
    expect((await door.call('restore-ad-bids-after-stock', { adGroupIds: bGroups() })).answer.error).toMatch(/still short of stock/)
    await fbaReport([ids.aV1, ids.aV2, ids.bV1, ids.bV2], 40)
    expect(await door.rule('restore-ad-bids-after-stock', { level: 'auto' })).toMatchObject({ ok: true })
    try {
      const asked = await door.call('restore-ad-bids-after-stock', { adGroupIds: bGroups(), why: 'test: cover is back' })
      // Held for a person by the rule's own limits (here: B's campaigns are also moved by their hourly plans, and the
      // default limits give back no bid alone).
      expect(asked.answer).toMatchObject({ status: 'waiting_for_approval', trust: { level: 'auto', why: expect.stringMatching(/a person approves it in Nexus/) }, preview: { totals: { adGroups: 5 } } })
      const { getTool } = await import('../../agents/tool-registry.js')
      const tool = getTool('restore-ad-bids-after-stock')!
      expect(tool.withinLimits!(asked.answer.preview, { ...(tool.limits!.parse({}) as Json), allowEngineOwned: true })).toMatch(/\(0: every give-back waits for a person\)/)
      amazon.reset()
      expect(await door.approve(asked.answer.approvalId)).toMatchObject({ ok: true, status: 'executed', result: { gaveBack: 5 } })
      await sendQueued()
      expect(await bidsOf(bGroups())).toEqual(bidsBefore)
      expect(amazon.bids().map(Number).sort()).toEqual(bidsBefore.flatMap((g) => [g.group[0]!, ...g.targets.map((t) => t[0]!)]).map((c) => c / 100).sort())
    } finally {
      await door.rule('restore-ad-bids-after-stock', { level: 'ask', limits: null })
    }
  })

  it('no stock write anywhere: Amazon\'s FBA numbers are only what its report said, no stock movement, no stock push, no inventory call', async () => {
    const now = await stockState()
    expect(now.movements).toBe(stockBefore.movements)
    expect(now.outbound).toBe(stockBefore.outbound)
    expect(now.totalStock).toEqual(stockBefore.totalStock)
    const fbaLevels = new Set([ids.aV1, ids.aV2, ids.bV1, ids.bV2].map((p) => ids[`fba-${p}`]))
    expect(now.levels.filter((l) => fbaLevels.has(l.id)).map((l) => l.quantity)).toEqual([40, 40, 40, 40])
    expect(now.levels.filter((l) => !fbaLevels.has(l.id))).toEqual(stockBefore.levels.filter((l) => !fbaLevels.has(l.id)))
    expect(amazon.unexpected).toEqual([])
  })
})

describe('9 — drift (run while A is in PROFIT, before step 8 switches its phase): a person\'s change is his to keep or revert; sync only adds', { timeout: TIMEOUT }, () => {
  const drift = async () => (await door.call('ads-playbook', { view: 'drift', market: 'IT', productId: ids.aParent })).answer
  const PLACEMENT = 'placement_differs|pat'
  const NEGATIVE = 'negative_missing|auto|isolation:exact:test jacket'

  it('the Owner raises A\'s PAT top-of-search himself (the Campaign page\'s own path): drift names it his, with keep and revert; sync never puts it back', async () => {
    const { updatePlacementBidding } = await import('../ads-create.service.js')
    amazon.reset()
    // As PATCH /advertising/campaigns/:id/placements calls it: a person's own edit (manual), his name on it.
    const out = await door.inside(() => updatePlacementBidding({ campaignId: flow.slots.pat.campaignId, adjustments: [{ placement: 'PLACEMENT_TOP', percentage: 30 }], partial: true, actor: `user:${door.people.owner.id}` as never, reason: 'more top of search', manual: true }))
    expect(out).toMatchObject({ ok: true, mode: 'live' })
    expect(amazon.store.campaigns.get(flow.slots.pat.externalCampaignId)!.dynamicBidding.placementBidding).toEqual([{ placement: 'PLACEMENT_TOP', percentage: 30 }, { placement: 'PLACEMENT_PRODUCT_PAGE', percentage: 15 }])
    const d = await drift()
    const item = (d.items as Json[]).find((i) => i.key === PLACEMENT)
    expect(item).toMatchObject({
      kind: 'placement_differs', slot: 'pat', byPerson: { userId: `user:${door.people.owner.id}`, action: 'update_placement_bidding' },
      fix: { by: 'tool', tool: 'set-placement-multipliers', note: expect.stringMatching(/sync never changes them/) },
      keep: { tool: 'set-ads-playbook', args: { values: { overrides: { placements: expect.objectContaining({ pat: { top: 30, productPage: 15, restOfSearch: 0 } }) } } } },
      revert: { by: 'tool', tool: 'set-placement-multipliers', args: { topOfSearchPct: 10 } },
    })
    // The hourly plans' slots are theirs: never compared.
    expect((d.heldBack as Json[]).map((h) => h.slot).sort()).toEqual(['auto', 'broad-category'])
    expect((await door.call('apply-ads-playbook', { op: 'sync', market: 'IT', productId: ids.aParent })).answer.error).toMatch(/^Nothing to sync for TEST-TESTE2EA-PARENT in IT: what drifts is 1 change a person made himself \(keep it, or name it in revert\)/)
    expect((await door.call('apply-ads-playbook', { op: 'sync', market: 'IT', productId: ids.aParent, revert: [PLACEMENT] })).answer.error).toMatch(/is not put back by sync — set-placement-multipliers does it/)
    expect(amazon.named('updateCampaign')).toHaveLength(1)
  })

  it('a negative lifted at Amazon (no record of who): his to keep or revert; even with the rule at auto, a revert waits for a person — then sync only ADDS', async () => {
    // Amazon's entity sync found the isolation negative gone at Amazon and archived its row; no person is on record.
    await door.inside(() => db().adTarget.updateMany({ where: { adGroupId: flow.slots.auto.adGroupId, isNegative: true, expressionValue: 'test jacket' }, data: { status: 'ARCHIVED' } }))
    const item = ((await drift()).items as Json[]).find((i) => i.key === NEGATIVE)
    expect(item).toMatchObject({ kind: 'negative_missing', byPerson: { unknownAuthor: true }, revert: { by: 'sync', part: 'negatives' }, keep: { tool: 'set-ads-playbook' } })
    expect((await door.call('apply-ads-playbook', { op: 'sync-negatives', market: 'IT', productId: ids.aParent })).answer.error).toMatch(/^Nothing to sync .*2 changes a person made himself/)
    expect(await door.rule('apply-ads-playbook', { level: 'auto', limits: { maxItems: 10, maxChangesPerEntityPerDay: 10 } })).toMatchObject({ ok: true })
    let asked: Json = {}
    try {
      asked = (await door.call('apply-ads-playbook', { op: 'sync-negatives', market: 'IT', productId: ids.aParent, revert: [NEGATIVE] })).answer
      expect(asked).toMatchObject({ status: 'waiting_for_approval', trust: { level: 'auto', why: expect.stringMatching(/it puts back 1 change a person made himself .*a person approves it in Nexus/) }, preview: { op: 'sync-negatives', addsSpend: false, personsChanges: 1, negatives: [{ key: NEGATIVE, reverted: true }], left: { byPerson: [{ key: PLACEMENT }] } } })
    } finally {
      await door.rule('apply-ads-playbook', { level: 'ask', limits: null })
    }
    amazon.reset()
    expect(await door.approve(asked.approvalId)).toMatchObject({ ok: true, status: 'executed' })
    // Added back at Amazon in A's Auto; nothing deleted, archived or paused anywhere; the person's placement untouched.
    expect(amazon.named('createNegativeKeyword').map((c) => [(c.args[1] as Json).externalAdGroupId, (c.args[1] as Json).keywordText, (c.args[1] as Json).matchType])).toEqual([[flow.slots.auto.externalAdGroupId, 'test jacket', 'EXACT']])
    expect(amazon.calls.filter((c) => c.name === 'archiveSpEntity' || (c.args[2] as Json)?.state || c.name === 'updateCampaign')).toEqual([])
    expect(((await drift()).items as Json[]).map((i) => i.key)).toEqual([PLACEMENT])
  })

  it('the Owner keeps his placement: written into A\'s playbook (a raise: his code); then it is no longer drift', async () => {
    const item = ((await drift()).items as Json[]).find((i) => i.key === PLACEMENT)!
    const asked = (await door.call('set-ads-playbook', { channel: 'AMAZON', ...item.keep.args })).answer
    expect(asked).toMatchObject({ status: 'waiting_for_approval', preview: { direction: 'raise', stepUp: expect.any(Object) } })
    expect((await door.decide(asked.approvalId)).status).toBe(403)
    expect(await door.approve(asked.approvalId, { code: true })).toMatchObject({ ok: true, status: 'executed' })
    expect(((await drift()).items as Json[])).toEqual([])
    expect(amazon.store.campaigns.get(flow.slots.pat.externalCampaignId)!.dynamicBidding.placementBidding).toEqual([{ placement: 'PLACEMENT_TOP', percentage: 30 }, { placement: 'PLACEMENT_PRODUCT_PAGE', percentage: 15 }])
  })
})

describe('10 — winners (run in PROFIT, before step 8): a declining term → bid → placement → its own campaign; once that proves, its old keyword is PROPOSED at the floor', { timeout: TIMEOUT }, () => {
  const TERM = 'test jacket'
  const winners = async () => (await door.call('ads-playbook', { view: 'winners', market: 'IT', productId: ids.aParent })).answer
  const entryOf = (view: Json, slot: string) => (view.entries as Json[]).find((e) => e.term === TERM && e.slot === slot)
  let hero: { campaignId: string; adGroupId: string; externalCampaignId: string; externalAdGroupId: string }
  let oldKeyword = ''
  let rulesBefore: Json
  let floorAsked = { wanted: 0, previewed: 0 }

  it('"test jacket" declines in A\'s own Exact | Category: the ladder in the Owner\'s order — bid, placement, then a campaign of its own', async () => {
    // The market's harvest bar, whole (W1-7): 2 orders over 30 days (a lowering of what may be harvested: no code).
    const bar = await door.call('set-ads-strategy', { channel: 'AMAZON', market: 'IT', level: 'market', values: { harvest: { minOrders: 2, minClicks: 0, maxAcosPct: null, windowDays: 30 } } })
    expect(bar.answer.preview).toMatchObject({ direction: 'lower', stepUp: null })
    expect(await door.approve(bar.answer.approvalId)).toMatchObject({ ok: true, status: 'executed' })
    // Strong in the 30 days before the settled window, weak in it.
    await reported(flow.slots['exact-category'], TERM, { orders: 5, clicks: 30, costCents: 900, salesCents: 9000 }, { days: 10, endDaysAgo: 40 })
    await reported(flow.slots['exact-category'], TERM, { orders: 1, clicks: 10, costCents: 300, salesCents: 1500 }, { days: 5, endDaysAgo: 10 })
    const view = await winners()
    const e = entryOf(view, 'exact-category')
    expect(e).toMatchObject({ state: 'declining', servedBy: { text: TERM, match: 'EXACT', bidCents: 48 }, current: { orders: 1 }, previous: { orders: 5 }, nextStep: 'ownCampaign', ownCampaign: { tool: 'apply-ads-playbook', args: { op: 'hero', term: TERM } } })
    expect(e.ladder.map((r: Json) => [r.step, r.open])).toEqual([['bid', false], ['placement', false], ['ownCampaign', true]])
    // Each closed rung says why, honestly: auto-bid does not run on this test server; an Exact slot's placements move every term.
    expect(e.ladder[0].why).toMatch(/^auto-bid does not run/)
    expect(e.ladder[1].why).toMatch(/placements move only on a research slot .* or the term's own campaign/)
    // A term winning where it runs is kept there: no step at all (rule 2).
    expect((view.entries as Json[]).filter((x) => x.state === 'winning').every((x) => x.nextStep === 'none' && x.ladder.length === 0)).toBe(true)
    oldKeyword = e.servedBy.adTargetId
    rulesBefore = await door.inside(async () => Object.fromEntries((await db().automationRule.findMany({ select: { name: true, enabled: true } })).map((r) => [r.name, r.enabled])))
  })

  it('its own campaign, built through the SP Super Wizard\'s launch: ONE exact keyword, born at 2¢, off the allowlist; the term keeps running where it runs', async () => {
    const before = await targetsIn(flow.slots['exact-category'].adGroupId)
    const asked = await door.call('apply-ads-playbook', { op: 'hero', market: 'IT', productId: ids.aParent, term: TERM, why: 'test: its own campaign' })
    expect(asked.answer).toMatchObject({
      status: 'waiting_for_approval',
      preview: {
        op: 'hero', term: TERM, liveWrites: false, startsSuppressed: { floorCents: 2 }, frozen: { bidCents: 30, dailyBudgetCents: 100 },
        hero: { key: `hero:${TERM}`, modelSlot: 'exact-category', keyword: { text: TERM, match: 'EXACT' } },
        current: [{ slot: 'exact-category', state: 'declining' }], keepsRunning: expect.stringMatching(/no negative, no lower bid, no pause anywhere/),
      },
    })
    // Rule 3: product B buys "test jacket" too — only listed, never a reason to refuse or to negate.
    expect(asked.answer.preview.sharedWithOtherProducts).toEqual([{ term: TERM, existing: expect.arrayContaining([expect.objectContaining({ campaignName: 'TESTE2EB | IT | Exact | Category' })]) }])
    amazon.reset()
    const ran = await door.approve(asked.answer.approvalId) as Json
    expect(ran).toMatchObject({ ok: true, status: 'executed', result: { status: 'RUNNING', key: `hero:${TERM}`, changeSetId: asked.answer.approvalId } })
    await vi.waitFor(async () => {
      const row = await door.inside(() => db().adBlueprintApplication.findUniqueOrThrow({ where: { id: ran.result.applicationId }, select: { status: true } }))
      if (row.status === 'RUNNING') throw new Error('still running')
    }, { timeout: 30_000, interval: 100 })
    expect(amazon.named('createCampaign').map((c) => (c.args[1] as Json).name)).toEqual([`TESTE2EA | IT | Exact | Category | Hero | ${TERM}`])
    expect(amazon.named('createKeyword').map((c) => [(c.args[1] as Json).keywordText, (c.args[1] as Json).matchType, (c.args[1] as Json).bid])).toEqual([[TERM, 'EXACT', 0.02]])
    expect(amazon.bids().every((b) => Number(b) === 0.02)).toBe(true)
    expect(amazon.named('updateCampaign')).toEqual([])
    const link = await door.inside(() => db().adsPlaybookLink.findFirstOrThrow({ where: { playbookId: flow.rowId, kind: 'slot', key: `hero:${TERM}` } }))
    const c = await door.inside(() => db().campaign.findUniqueOrThrow({ where: { id: link.refId }, include: { adGroups: true } }))
    expect(c).toMatchObject({ liveBidWritesEnabled: false, bidsSuppressedFloorCents: 2, bidsSuppressedBy: `user:${door.people.owner.id}`, externalCampaignId: expect.stringMatching(/^AMZ-C-/) })
    expect(String(c.status)).toBe('ENABLED')
    hero = { campaignId: c.id, adGroupId: c.adGroups[0].id, externalCampaignId: c.externalCampaignId!, externalAdGroupId: c.adGroups[0].externalAdGroupId! }
    // Rule 2: where the term runs now, nothing moved — no negative, no lower bid, no pause.
    expect(await targetsIn(flow.slots['exact-category'].adGroupId)).toEqual(before)
    // The running playbook's rules stay as they were (a hero's build compiles them again, never switches them off).
    expect(await door.inside(async () => Object.fromEntries((await db().automationRule.findMany({ select: { name: true, enabled: true } })).map((r) => [r.name, r.enabled])))).toEqual(rulesBefore)
    await noWriteReachedB()
  })

  it('START of the hero alone (slots ["hero:<term>"]) carries the code; then its bid is the term\'s cost per click', async () => {
    const asked = await door.call('apply-ads-playbook', { op: 'start', market: 'IT', productId: ids.aParent, slots: [`hero:${TERM}`] })
    expect(asked.answer.preview.campaigns.map((x: Json) => [x.slot, x.allowlist])).toEqual([[`hero:${TERM}`, 'on']])
    expect((await door.decide(asked.answer.approvalId)).status).toBe(403)
    expect(await door.approve(asked.answer.approvalId, { code: true })).toMatchObject({ ok: true, status: 'executed', result: { op: 'start', started: [`hero:${TERM}`] } })
    await drainAdWrites(door)
    expect(atAmazon(hero.externalCampaignId).bids).toEqual([0.3])
    expect((await door.inside(() => db().campaign.findUniqueOrThrow({ where: { id: hero.campaignId } }))).liveBidWritesEnabled).toBe(true)
  })

  it('the hero proves itself: ONE proposal — the old exact keyword to the floor, a bid change a person decides; never a negative', async () => {
    const before = await targetsIn(flow.slots['exact-category'].adGroupId)
    await reported(hero, TERM, { orders: 6, clicks: 30, costCents: 900, salesCents: 9000 })
    const view = await winners()
    const old = entryOf(view, 'exact-category')
    expect(old).toMatchObject({
      nextStep: 'closeOldPlace', heroOf: { key: `hero:${TERM}`, proven: true },
      closeOldPlace: { how: 'floor', request: { tool: 'bulk-ad-bid-change', args: { bids: [{ targetId: oldKeyword, bidCents: expect.any(Number) }] } } },
      nextWhy: expect.stringMatching(/^hero proven → old keyword to the floor: .*never a negative/),
    })
    const floorBid = old.closeOldPlace.request.args.bids[0].bidCents
    expect(floorBid).toBeLessThanOrEqual(5)
    // Claude asks for exactly that proposal; it waits for a person, and nothing moved yet.
    // Claude asks for exactly that proposal; it waits for a person, and nothing moved yet.
    const asked = await door.call('bulk-ad-bid-change', old.closeOldPlace.request.args)
    expect(asked.answer).toMatchObject({ status: 'waiting_for_approval', preview: { totals: { changing: 1 } } })
    floorAsked = { wanted: floorBid, previewed: asked.answer.preview.changes[0].toCents }
    expect(await targetsIn(flow.slots['exact-category'].adGroupId)).toEqual(before)
    // L1: a negative over the product's own old keyword is refused, whoever asks.
    const { ownKeywordRefusal } = await import('../ads-winner-lock.js')
    expect(await door.inside(() => ownKeywordRefusal({ scope: 'AD_GROUP', adGroupId: flow.slots['exact-category'].adGroupId, campaignId: flow.slots['exact-category'].campaignId }, TERM, 'EXACT'))).toMatchObject({ deniedAt: 'own_keyword' })
    // Approved by a person: the value that lands is the one the Approvals preview showed; a lower bid, never a negative.
    expect(await door.approve(asked.answer.approvalId, { code: !!asked.answer.preview?.stepUp })).toMatchObject({ ok: true, status: 'executed' })
    const after = await targetsIn(flow.slots['exact-category'].adGroupId)
    expect(after.find((t) => t.expressionValue === TERM && !t.isNegative)).toMatchObject({ bidCents: floorAsked.previewed })
    expect(after.filter((t) => t.isNegative && t.expressionValue === TERM)).toEqual([])
    await noWriteReachedB()
  })

  // 🔴 DEFECT D4 (low-medium) — the winners view's handover proposal says the old exact keyword "goes to low bids (the
  // strategy's stop bid or the tool's lowest)" and asks bulk-ad-bid-change for 5¢ (ads-playbook/winners.ts:545-550,
  // lowBidOf), but that tool holds every bid to the strategy's largest change per action (stepClamp,
  // agents/tools/ads-change-kit.ts:222-225): with a 20 % step the request lands at 38¢ from 48¢, not at the floor — the
  // old place keeps spending. The Approvals preview says 38 (honest), the winners view's words and its request do not
  // match it. Fails today; passes once the proposal is a stop the step does not clamp (as a stock floor is), or says so.
  it.fails('DEFECT D4 — "old keyword to the floor" is clamped to one 20 % step by the bid tool it proposes', () => {
    expect(floorAsked.previewed).toBe(floorAsked.wanted)
  })
})

describe('8 — a phase switch that adds spend needs the code; one that lets Claude do more alone never runs by rule', { timeout: TIMEOUT }, () => {
  const phase = (to: string, extra: Record<string, unknown> = {}) => ({ op: 'phase', market: 'IT', productId: ids.aParent, phase: to, ...extra })
  const productStrategy = () => door.inside(() => db().adsStrategy.findFirst({ where: { market: 'IT', level: 'PRODUCT', scopeId: ids.aParent } }))

  it('PROFIT → LAUNCH raises (the target, the performance plan on): no code is refused, the manager\'s code too; the Owner\'s code runs it', async () => {
    const asked = await door.call('apply-ads-playbook', phase('LAUNCH', { why: 'test: relaunch' }))
    expect(asked.answer).toMatchObject({
      status: 'waiting_for_approval',
      preview: { op: 'phase', phase: { from: 'PROFIT', to: 'LAUNCH' }, direction: 'raise', raisesClaude: false, stepUp: expect.any(Object) },
    })
    expect(asked.answer.preview.raises).toEqual(expect.arrayContaining(['Target', 'the performance hourly plan switched on']))
    const id = asked.answer.approvalId
    expect(await door.decide(id)).toMatchObject({ status: 403, body: { code: 'mfa_required' } })
    expect((await door.decide(id, { who: 'manager', code: true })).status).toBe(403)
    expect(await productStrategy()).toBeNull()
    expect(await door.approve(id, { code: true })).toMatchObject({ ok: true, status: 'executed', result: { phase: { from: 'PROFIT', to: 'LAUNCH' }, direction: 'raise' } })
    // The phase is the product's strategy goal, with its recipe's numbers — and LAUNCH holds Claude's budget changes at ask.
    expect(await productStrategy()).toMatchObject({ goal: 'LAUNCH', targetKind: 'ACOS', targetPct: 45, claudeAutonomy: { budget: 'ask' } })
    const version = await door.inside(() => db().adsStrategyVersion.findFirstOrThrow({ where: { level: 'PRODUCT', scopeId: ids.aParent }, orderBy: { version: 'desc' } }))
    expect(version).toMatchObject({ direction: 'raise', approvalId: id, stepUpAt: expect.any(Date) })
  })

  it('LAUNCH → GROW would let Claude do more alone (it lifts LAUNCH\'s hold on budgets): never by rule, even with allowPhaseUp', async () => {
    // The Owner lets raising phase moves run by rule (a loosening: his code, through the harness's rule setter).
    expect(await door.rule('apply-ads-playbook', { level: 'auto', limits: { allowPhaseUp: true, maxBidCents: 100, maxItems: 10, maxChangesPerEntityPerDay: 10 } })).toMatchObject({ ok: true, rule: { level: 'auto', limits: { allowPhaseUp: true } } })
    try {
      const asked = await door.call('apply-ads-playbook', phase('GROW'))
      expect(asked.answer).toMatchObject({
        status: 'waiting_for_approval',
        preview: { phase: { from: 'LAUNCH', to: 'GROW' }, raisesClaude: true, stepUp: expect.any(Object) },
        trust: { level: 'auto', why: expect.stringMatching(/it lets Claude do more alone .*always needs a person with settings\.security\.manage and their authenticator code, never a rule/) },
      })
      expect((asked.answer.preview.strategy.changes as Json[]).find((c) => c.field === 'claudeAutonomy')).toMatchObject({ direction: 'raise' })
      expect((await door.decide(asked.answer.approvalId, { decision: 'reject' })).status).toBe(200)
      expect(await productStrategy()).toMatchObject({ goal: 'LAUNCH', claudeAutonomy: { budget: 'ask' } })
    } finally {
      await door.rule('apply-ads-playbook', { level: 'ask', limits: null })
    }
  })
})

describe('14 — business B sees none of A\'s rows for these steps, and A none of B\'s', { timeout: TIMEOUT }, () => {
  const text = (x: unknown) => JSON.stringify(x)

  it('B\'s Claude: A\'s cards, stock risk, winners, drift, product and ad groups are not there; nothing queued in either business', async () => {
    const card = await door.inside(() => db().adsRuleSuggestion.findFirstOrThrow({ where: { proposedKey: 'isolate_product_terms' } }))
    const approvalsA = await door.inside(() => db().agentApproval.count())
    const risk = (await door.call('ad-stock-risk', { market: 'IT' }, { biz: B })).answer
    expect(risk).toMatchObject({ business: { id: B } })
    for (const id of [...Object.values(flow.slots).map((x) => x.adGroupId), ...bAdGroups()]) expect(text(risk)).not.toContain(id)
    expect(text(risk)).not.toContain('TESTE2EA')
    expect((await door.call('ads-playbook', { view: 'winners', market: 'IT', sku: 'TEST-TESTE2EA-PARENT' }, { biz: B })).answer.error).toMatch(/has no product playbook row in IT/)
    expect((await door.call('ads-playbook', { view: 'drift', market: 'IT', sku: 'TEST-TESTE2EA-PARENT' }, { biz: B })).answer.error).toMatch(/has no product playbook row in IT/)
    expect((await door.call('decide-automation-suggestions', { kind: 'amazon-ads', decisions: [{ suggestionId: card.id, decide: 'apply' }] }, { biz: B })).answer.error).toMatch(/^Suggestions not found in this business/)
    expect((await door.call('apply-ads-playbook', { op: 'hero', market: 'IT', productId: ids.aParent, term: 'test jacket' }, { biz: B })).answer.error).toBe('Product not found')
    expect((await door.call('apply-ads-playbook', { op: 'phase', market: 'IT', productId: ids.aParent, phase: 'GROW' }, { biz: B })).answer.error).toBe('Product not found')
    expect((await door.call('lower-ad-bids-for-stock', { adGroupIds: [ids.bAuto, flow.slots.auto.adGroupId] }, { biz: B })).answer.error).toMatch(/were not found in this business/)
    expect(await door.inside(() => db().agentApproval.count())).toBe(approvalsA)
    expect(await door.inside(() => db().agentApproval.count({ where: { toolName: { in: ['decide-automation-suggestions', 'apply-ads-playbook', 'lower-ad-bids-for-stock'] } } }), B)).toBe(0)
  })

  it('B\'s own engines run in B and find nothing of A; under row security B holds none of A\'s rows; its own keyword never moved', async () => {
    await import('../automation-action-handlers.js')
    const { runAdvertisingRuleEvaluatorOnce } = await import('../../../jobs/advertising-rule-evaluator.job.js')
    expect(await door.inside(() => runAdvertisingRuleEvaluatorOnce(), B)).toMatchObject({ totalEvaluations: 0 })
    const inB = await door.inside(async () => ({
      cards: await db().adsRuleSuggestion.count(), runs: await db().automationRuleExecution.count(), rules: await db().automationRule.count(),
      terms: await db().amazonAdsSearchTerm.count(), stock: await db().stockLevel.count(), strategies: (await db().adsStrategy.findMany({ select: { label: true } })).map((x) => x.label),
      keyword: await db().adTarget.findMany({ select: { expressionValue: true, bidCents: true, isNegative: true, status: true } }),
    }), B)
    expect(inB).toEqual({ cards: 0, runs: 0, rules: 0, terms: 0, stock: 0, strategies: ['Bravo strategy (IT)'], keyword: [{ expressionValue: 'test jacket', bidCents: 30, isNegative: false, status: 'ENABLED' }] })
  })

  it('A\'s Claude sees none of B\'s rows; no Amazon call ever reached B\'s account', async () => {
    const bAsk = await door.call('set-ads-strategy', { channel: 'AMAZON', market: 'IT', level: 'market', values: { maxBidCents: 70 } }, { biz: B })
    expect(bAsk.answer.status).toBe('waiting_for_approval')
    expect((await door.call('approval-status', { approvalId: bAsk.answer.approvalId })).answer.error).toBe('Approval not found')
    const campaigns = (await door.call('ad-campaigns', { market: 'IT' })).answer
    expect(text(campaigns)).not.toContain('BRAVO')
    expect(text((await door.call('ads-strategy', { market: 'IT' })).answer)).not.toContain('Bravo strategy')
    expect([...amazon.profiles]).toEqual(['P-IT-E2E-A'])
  })
})
