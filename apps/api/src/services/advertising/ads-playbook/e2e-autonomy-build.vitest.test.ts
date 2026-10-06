/**
 * ADS AUTONOMY final test, part 1 of 3 — strategy → template → enroll → build → START → STOP, end to end.
 *
 * Every step goes through Claude's MCP door (runToolForClaude, as /mcp calls a tool), the Approvals page's decide route
 * (with the Owner's real authenticator code where a change needs one) and the commit that runs an approved change, on
 * PGlite with the production schema and every business policy, business profiles ON. The ONLY stand-ins are Amazon's Ads
 * API client (a small Amazon that keeps what it was sent: test-support/ads-autonomy-e2e-amazon.ts) and the
 * infrastructure a test process has no server for (the job queue, the Redis cache, channel push destinations). The SP
 * Super Wizard launch, its read-back, the write gate, the mutation layer, the ads sync worker's drain, the playbook build,
 * START and STOP are the real ones. Two products of business A share the category
 * keyword "test jacket"; business B is the same Owner's second business with its own Claude connection.
 *
 *   1  the market's ads strategy (a new row: a raise, the code); a template captured from product B's live campaigns;
 *      the market row names it; product A enrolled (a raise, the code)
 *   2  apply-ads-playbook build: by rule the default limits (0 campaigns) refuse it, raised limits allow it; approved by a
 *      person it runs through the SP Super Wizard's launch — born at 2¢, off the allowlist, no placements, the change
 *      set on every audit row, the slot links, the compiled harvest / isolation rules and hourly plans born OFF
 *   3  product B buys the same category keyword: A's build neither skips nor blocks it (rule 3); no negative lands in B
 *   4  START: a plain approve does not run it; with the code: the allowlist, the planned bids back (at Amazon too), the
 *      placements, the rules and hourly plans on as the phase says — D1 (fixed): the captured template turns isolation off,
 *      and START's preview and answer say the isolation rule stays off
 *   11 STOP: bids floored, off the allowlist, artifacts off; its undo (a start) needs the code; restore-campaign and
 *      undo-ad-change refuse a playbook's campaign
 *   14 business B's Claude sees none of A's rows (playbook, build, campaigns, approvals), and A's none of B's
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
import { A_TERMS, atAmazon, drainAdWrites, seedBusinessA, seedBusinessB } from '../../../test-support/ads-autonomy-e2e-seed.js'

type Json = Record<string, any>
let door: Door
const launched = () => amazon.named('createCampaign').length
const db = () => database.client
const ids: Record<string, string> = {}
/** The build's approval (its change set) and its run. */
let approvalId = ''
let applicationId = ''
const TIMEOUT = 60_000

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
  vi.stubEnv('NEXUS_OAUTH_ISSUER', 'https://web.example.test')
  vi.stubEnv('NEXUS_AI_KILL_SWITCH', '')
  vi.stubEnv('ENABLE_QUEUE_WORKERS', '')
  door = await e2eDoor(database)
  // The template is captured from B's set as it is: B's campaigns carry no cross-negatives (isolation off).
  Object.assign(ids, await door.inside(() => seedBusinessA(db())))
  Object.assign(ids, await door.inside(() => seedBusinessB(db()), B))
}, 180_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await door?.close()
  await database?.close()
}, 30_000)

describe('1 — the strategy, a template captured from live campaigns, product A enrolled', { timeout: TIMEOUT }, () => {
  it('the market strategy: a new row raises what Claude may do alone, so the Owner approves it with his code', async () => {
    const { answer } = await door.call('set-ads-strategy', {
      channel: 'AMAZON', market: 'IT', level: 'market', reason: 'test: the IT strategy',
      values: { goal: 'PROFIT', target: { kind: 'ACOS', pct: 30 }, maxBidCents: 100, monthlySpendCapCents: 10_000_000, claudeMaxChangesPerDay: 10, claudeMaxRaisesPerDay: 10, claudeMaxBudgetIncreasePerDayCents: 100_000 },
    })
    expect(answer, JSON.stringify(answer)).toMatchObject({ status: 'waiting_for_approval', preview: { action: 'set-ads-strategy', direction: 'raise', version: { from: 0, to: 1 }, reachesAmazon: false, stepUp: { what: 'raises the ads strategy' } } })
    // No code: refused at the Approvals page, nothing scheduled.
    const plain = await door.decide(answer.approvalId)
    expect(plain.status).toBe(403)
    expect(plain.body).toMatchObject({ code: 'mfa_required' })
    expect(await door.approve(answer.approvalId, { code: true })).toMatchObject({ ok: true, status: 'executed' })
    expect(await door.inside(() => db().adsStrategy.findFirstOrThrow({ where: { market: 'IT', level: 'MARKET' } }))).toMatchObject({ goal: 'PROFIT', targetKind: 'ACOS', targetPct: 30, maxBidCents: 100, version: 1 })
  })

  it('a template captured from product B\'s live campaigns (Nexus only); the market row names it', async () => {
    const { answer } = await door.call('set-ads-playbook', { channel: 'AMAZON', kind: 'template', op: 'capture', name: 'Test funnel', market: 'IT', productToken: 'TESTE2EB', namePrefix: 'TESTE2EB | IT' })
    expect(answer.status).toBe('waiting_for_approval')
    const decided = await door.decide(answer.approvalId, { code: answer.preview.stepUp ? true : undefined })
    expect(decided.status, JSON.stringify(decided.body)).toBe(200)
    expect(await door.commit(answer.approvalId)).toMatchObject({ ok: true, status: 'executed' })
    const template = await door.inside(() => db().adsPlaybookTemplate.findFirstOrThrow({ where: { name: 'Test funnel' } }))
    ids.template = template.id
    // Each live campaign became one slot, its match type and intent read from its name, its hourly plan a rank role.
    expect((template.doc as Json).structure.slots.map((x: Json) => [x.key, x.targeting, x.match ?? null, x.intent, x.rankRole])).toEqual([
      ['auto', 'AUTO', null, 'ANY', 'research'], ['broad-category', 'KEYWORD', 'BROAD', 'CATEGORY', 'research'], ['exact-brand', 'KEYWORD', 'EXACT', 'BRAND', 'performance'],
      ['exact-category', 'KEYWORD', 'EXACT', 'CATEGORY', 'performance'], ['pat', 'PRODUCT', null, 'ANY', 'performance'],
    ])
    expect(template.capturedFrom).toMatchObject({ market: 'IT', productToken: 'TESTE2EB' })
    expect((template.capturedFrom as Json).campaignIds).toHaveLength(5)
    const market = await door.call('set-ads-playbook', { channel: 'AMAZON', kind: 'playbook', market: 'IT', level: 'market', values: { templateId: template.id } })
    const d2 = await door.decide(market.answer.approvalId, { code: market.answer.preview?.stepUp ? true : undefined })
    expect(d2.status, JSON.stringify(d2.body)).toBe(200)
    expect(await door.commit(market.answer.approvalId)).toMatchObject({ ok: true, status: 'executed' })
  })

  it('product A enrolled: a raise (the budget, the base bid, the terms), approved with the code; the playbook compiles', async () => {
    const terms = A_TERMS
    const { answer } = await door.call('set-ads-playbook', { channel: 'AMAZON', kind: 'playbook', market: 'IT', level: 'product', productId: ids.aParent, op: 'enroll', values: { nameToken: 'TESTE2EA', dailyBudgetCents: 2000, baseBidCents: 40, terms } })
    expect(answer.status).toBe('waiting_for_approval')
    expect(await door.approve(answer.approvalId, { code: true })).toMatchObject({ ok: true, status: 'executed' })
  })
})

const build = (extra: Record<string, unknown> = {}) => ({ op: 'build', market: 'IT', productId: ids.aParent, ...extra })
const approvalOf = (id: string, biz: typeof A | typeof B = A) => door.inside(() => db().agentApproval.findUniqueOrThrow({ where: { id } }), biz)
const finished = async (applicationId: string) => {
  await vi.waitFor(async () => {
    const row = await door.inside(() => db().adBlueprintApplication.findUniqueOrThrow({ where: { id: applicationId }, select: { status: true } }))
    if (row.status === 'RUNNING') throw new Error('still running')
  }, { timeout: 30_000, interval: 100 })
}
const builtCampaigns = () => door.inside(() => db().campaign.findMany({ where: { name: { startsWith: 'TESTE2EA | IT |' } }, orderBy: { name: 'asc' }, include: { adGroups: { include: { targets: true, productAds: true } } } }))

describe('2 — the build, through the SP Super Wizard\'s launch', { timeout: TIMEOUT }, () => {
  it('by rule: the default limits (0 campaigns) refuse it; raised limits allow it; a person stops the run by rule', async () => {
    expect(await door.rule('apply-ads-playbook', { level: 'auto' })).toMatchObject({ ok: true, rule: { level: 'auto', limits: { maxCampaigns: 0 } } })
    const held = await door.call('apply-ads-playbook', build())
    expect(held.answer).toMatchObject({
      status: 'waiting_for_approval',
      trust: { level: 'auto', why: expect.stringMatching(/it creates 5 campaigns, more than the 0 this tool's limits let a build create by rule \(0: every build waits for a person\)/) },
    })
    expect(await door.rule('apply-ads-playbook', { limits: { maxCampaigns: 5, maxDailyBudgetCents: 100_000, maxBidCents: 100 } })).toMatchObject({ ok: true, rule: { limits: { maxCampaigns: 5 } } })
    const allowed = await door.call('apply-ads-playbook', build())
    expect(allowed.answer).toMatchObject({ status: 'runs_by_rule', trust: { level: 'auto' }, runsAt: expect.any(String) })
    // The Owner wants this first build in his own hands: he stops the run by rule inside its window, and the held one.
    expect((await door.stop(allowed.answer.approvalId)).status).toBe(200)
    expect((await door.decide(held.answer.approvalId, { decision: 'reject' })).status).toBe(200)
    expect([(await approvalOf(allowed.answer.approvalId)).status, (await approvalOf(held.answer.approvalId)).status]).toEqual(['rejected', 'rejected'])
    expect(await door.rule('apply-ads-playbook', { level: 'ask', limits: null })).toMatchObject({ ok: true })
    expect(launched()).toBe(0)
  })
  it('approved by a person, it runs through the wizard\'s launch: born at 2¢, off the allowlist, no placements, never paused', async () => {
    amazon.reset()
    const asked = await door.call('apply-ads-playbook', build({ why: 'test: build product A' }))
    expect(asked.answer).toMatchObject({ status: 'waiting_for_approval', preview: { op: 'build', totals: { campaigns: 5 }, startsSuppressed: { floorCents: 2 }, liveWrites: false } })
    approvalId = asked.answer.approvalId
    const ran = await door.approve(approvalId) as Json
    expect(ran).toMatchObject({ ok: true, status: 'executed', result: { status: 'RUNNING', changeSetId: approvalId, reach: { reach: 'live' } } })
    applicationId = ran.result.applicationId
    await finished(applicationId)
    const run = await door.inside(() => db().adBlueprintApplication.findUniqueOrThrow({ where: { id: applicationId } }))
    expect(run).toMatchObject({ status: 'APPLIED', actor: `user:${door.people.owner.id}` })
    expect(run.options as Json).toMatchObject({ changeSetId: approvalId })
    // Every campaign came from the SP Super Wizard's launch, read back from Amazon after it (rule 1: Nexus's own builder).
    expect(amazon.named('createCampaign')).toHaveLength(5)
    expect(amazon.named('listCampaignsV3', 'listAdGroupsV3', 'listKeywords', 'listTargets', 'listProductAds').length).toBeGreaterThanOrEqual(5)
    expect(amazon.unexpected).toEqual([])
    // Born at Amazon's 2-cent floor: every bid Amazon was sent is 0.02; no placement was written.
    expect(amazon.bids().length).toBeGreaterThan(5)
    expect(amazon.bids().filter((b) => Number(b) !== 0.02)).toEqual([])
    expect(amazon.named('updateCampaign')).toEqual([])
    const camps = await builtCampaigns()
    expect(camps.map((c) => c.name)).toEqual(['TESTE2EA | IT | Auto', 'TESTE2EA | IT | Broad | Category', 'TESTE2EA | IT | Exact | Brand', 'TESTE2EA | IT | Exact | Category', 'TESTE2EA | IT | PAT'])
    for (const c of camps) {
      expect(c, c.name).toMatchObject({ liveBidWritesEnabled: false, bidsSuppressedFloorCents: 2, bidsSuppressedBy: `user:${door.people.owner.id}`, externalCampaignId: expect.stringMatching(/^AMZ-C-/) })
      expect(String(c.status)).toBe('ENABLED')
      expect(c.bidsSuppressedAt).toBeInstanceOf(Date)
      expect(amazon.store.campaigns.get(c.externalCampaignId!)?.dynamicBidding.placementBidding).toEqual([])
      for (const g of c.adGroups as Json[]) {
        expect(g.defaultBidCents).toBe(2)
        for (const t of g.targets.filter((x: Json) => !x.isNegative)) expect(t.bidCents, `${c.name} ${t.expressionValue}`).toBe(2)
      }
    }
    // The planned bids are remembered for START (the ladder on the base bid, clamped to the strategy's band).
    const exact = camps.find((c) => c.name.endsWith('Exact | Category'))!
    expect(exact.adGroups[0].targets.find((t: Json) => t.expressionValue === 'test jacket')).toMatchObject({ bidCents: 2, suppressedFromBidCents: 48 })
    // The change set on every audit row the launch wrote (its read-back receipt is the one row without it).
    const logs = await door.inside(() => db().advertisingActionLog.findMany({ where: { entityId: { in: [...camps.map((c) => c.id), ...camps.flatMap((c) => c.adGroups.map((g: Json) => g.id)), ...camps.flatMap((c) => c.adGroups.flatMap((g: Json) => [...g.targets, ...g.productAds].map((x: Json) => x.id)))] } }, select: { actionType: true, executionId: true } }))
    expect(logs.length).toBeGreaterThan(20)
    expect(logs.filter((l) => l.executionId !== approvalId).map((l) => l.actionType)).toEqual(['launch_verification'])
  })

  it('the links, the row BUILT, and the compiled harvest and isolation rules and hourly plans — every one born OFF', async () => {
    const row = await door.inside(() => db().adsPlaybook.findFirstOrThrow({ where: { market: 'IT', level: 'PRODUCT', scopeId: ids.aParent } }))
    ids.aRow = row.id
    expect(row).toMatchObject({ state: 'BUILT', enrolled: true })
    const links = await door.inside(() => db().adsPlaybookLink.findMany({ where: { playbookId: row.id }, orderBy: [{ kind: 'asc' }, { key: 'asc' }], select: { kind: true, key: true, refId: true, origin: true } }))
    expect(links.map((l) => [l.kind, l.key, l.origin])).toEqual([
      ['harvestRule', 'harvest', 'built'], ['isolationRule', 'isolation', 'built'], ['rankGroup', 'rank:performance', 'built'], ['rankGroup', 'rank:research', 'built'],
      ['slot', 'auto', 'built'], ['slot', 'broad-category', 'built'], ['slot', 'exact-brand', 'built'], ['slot', 'exact-category', 'built'], ['slot', 'pat', 'built'],
    ])
    const camps = await builtCampaigns()
    expect(links.filter((l) => l.kind === 'slot').map((l) => l.refId).sort()).toEqual(camps.map((c) => c.id).sort())
    const rules = await door.inside(() => db().automationRule.findMany({ where: { id: { in: links.filter((l) => l.kind.endsWith('Rule')).map((l) => l.refId) } } }))
    expect(rules).toHaveLength(2)
    for (const r of rules) expect(r, r.name).toMatchObject({ enabled: false, dryRun: true, autonomyLevel: 'PROPOSE' })
    const plans = await door.inside(() => db().rankScheduleGroup.findMany({ where: { id: { in: links.filter((l) => l.kind === 'rankGroup').map((l) => l.refId) } } }))
    expect(plans.map((g) => [g.name, g.enabled]).sort()).toEqual([['TESTE2EA | IT | Playbook Performance', false], ['TESTE2EA | IT | Playbook Research', false]])
    // Claude follows it with the build view; approval-status follows the run.
    const view = await door.call('ads-playbook', { view: 'build', market: 'IT', applicationId })
    expect(view.answer.data?.run ?? view.answer.run, JSON.stringify(view.answer).slice(0, 800)).toMatchObject({ applicationId, status: 'APPLIED' })
    const status = await door.call('approval-status', { approvalId })
    expect(status.answer, JSON.stringify(status.answer).slice(0, 800)).toMatchObject({ status: 'executed' })
  })
})

describe('3 — product B buys the same category keyword: never skipped, never blocked, never negated (rule 3)', { timeout: TIMEOUT }, () => {
  it('A\'s build kept "test jacket" in its own Exact and Broad slots; the preview only listed B as sharing it', async () => {
    const camps = await builtCampaigns()
    const kw = (slot: string) => camps.find((c) => c.name.endsWith(slot))!.adGroups[0].targets.filter((t: Json) => !t.isNegative).map((t: Json) => `${t.expressionType} ${t.expressionValue}`)
    expect(kw('Exact | Category')).toEqual(['EXACT test jacket'])
    expect(kw('Broad | Category').sort()).toEqual(['BROAD test coat', 'BROAD test jacket'])
  })

  it('no negative ever lands in B\'s ad groups: at Amazon or in Nexus, only the ones B always had', async () => {
    const bGroups = [ids.bAuto, ids.bBroad, ids.bExact, ids.bBrand, ids.bPat]
    const ext = await door.inside(() => db().adGroup.findMany({ where: { id: { in: bGroups } }, select: { externalAdGroupId: true } }))
    const bExt = new Set(ext.map((g) => g.externalAdGroupId))
    expect(amazon.named('createNegativeKeyword', 'createNegativeProductTarget').filter((c) => bExt.has((c.args[1] as Json).externalAdGroupId))).toEqual([])
    const negatives = await door.inside(() => db().adTarget.findMany({ where: { adGroupId: { in: bGroups }, isNegative: true }, select: { expressionValue: true } }))
    expect(negatives.map((n) => n.expressionValue)).toEqual(['test kids', 'test kids', 'test kids', 'test kids'])
    // B's own keyword is untouched.
    expect(await door.inside(() => db().adTarget.findFirstOrThrow({ where: { adGroupId: ids.bExact, expressionValue: 'test jacket', isNegative: false } }))).toMatchObject({ bidCents: 46, status: 'ENABLED' })
  })
})

const start = (extra: Record<string, unknown> = {}) => ({ op: 'start', market: 'IT', productId: ids.aParent, ...extra })
const stop = (extra: Record<string, unknown> = {}) => ({ op: 'stop', market: 'IT', productId: ids.aParent, ...extra })
let startApproval = ''
let startPreview: Json = {}
let startResult: Json = {}

const linksOf = (kind: string) => door.inside(() => db().adsPlaybookLink.findMany({ where: { playbookId: ids.aRow, kind }, select: { key: true, refId: true } }))
async function artifactsOn() {
  const rules = await door.inside(async () => db().automationRule.findMany({ where: { id: { in: [...(await linksOf('harvestRule')), ...(await linksOf('isolationRule'))].map((l) => l.refId) } }, select: { name: true, enabled: true } }))
  const plans = await door.inside(async () => db().rankScheduleGroup.findMany({ where: { id: { in: (await linksOf('rankGroup')).map((l) => l.refId) } }, select: { name: true, enabled: true } }))
  return Object.fromEntries([...rules, ...plans].map((x) => [x.name, x.enabled]))
}
const drain = () => drainAdWrites(door)

describe('4 — START: it adds spend, so it runs only with the approver\'s code', { timeout: TIMEOUT }, () => {
  it('the preview says what starts and that it needs the code; a plain approve is refused, nothing runs', async () => {
    amazon.reset()
    const asked = await door.call('apply-ads-playbook', start({ why: 'test: start product A' }))
    expect(asked.answer).toMatchObject({
      status: 'waiting_for_approval',
      preview: {
        op: 'start', starts: { campaigns: 5, spending: 5 }, highestRestoredBidCents: 48, dailyBudgetCents: 2000,
        stepUp: { what: expect.stringMatching(/^starts spending on 5 campaigns/), needs: expect.stringContaining('settings.security.manage') },
      },
    })
    expect((asked.answer.preview.campaigns as Json[]).every((c) => c.allowlist === 'on' && c.bids.does === 'restore')).toBe(true)
    startApproval = asked.answer.approvalId
    startPreview = asked.answer.preview
    const plain = await door.decide(startApproval)
    expect(plain).toMatchObject({ status: 403, body: { code: 'mfa_required', raises: expect.arrayContaining(['Bids', 'Spend']) } })
    expect((await approvalOf(startApproval)).status).toBe('pending')
    // The manager may use Claude but may not approve spend: his code is not enough.
    expect((await door.decide(startApproval, { who: 'manager', code: true })).status).toBe(403)
    expect((await builtCampaigns()).some((c) => c.liveBidWritesEnabled)).toBe(false)
    expect(amazon.calls).toEqual([])
  })

  it('with the code: on the allowlist, the planned bids back (at Amazon too, through the write gate), the placements, the rules and plans on', async () => {
    const coded = await door.decide(startApproval, { code: true })
    expect(coded).toMatchObject({ status: 200, body: { status: 'scheduled' } })
    expect((await approvalOf(startApproval)).decisionVia).toBe('nexus-step-up')
    const ran = await door.commit(startApproval) as Json
    expect(ran).toMatchObject({ ok: true, status: 'executed', result: { op: 'start', state: 'RUNNING', changeSetId: startApproval, started: ['auto', 'broad-category', 'exact-brand', 'exact-category', 'pat'] } })
    startResult = ran.result
    await drain()
    expect(amazon.unexpected).toEqual([])
    const camps = await builtCampaigns()
    for (const c of camps) expect(c, c.name).toMatchObject({ liveBidWritesEnabled: true, bidsSuppressedAt: null })
    const byName = (suffix: string) => camps.find((c) => c.name.endsWith(suffix))!
    // The planned bids, in Nexus and at Amazon; the placements the build deferred.
    expect(byName('Exact | Category').adGroups[0].targets.find((t: Json) => t.expressionValue === 'test jacket')).toMatchObject({ bidCents: 48, suppressedFromBidCents: null })
    expect(atAmazon(byName('Exact | Category').externalCampaignId!)).toEqual({ defaultBid: 0.48, bids: [0.48], placements: [{ placement: 'PLACEMENT_TOP', percentage: 25 }] })
    expect(atAmazon(byName('PAT').externalCampaignId!)).toEqual({ defaultBid: 0.4, bids: [0.4], placements: [{ placement: 'PLACEMENT_TOP', percentage: 10 }, { placement: 'PLACEMENT_PRODUCT_PAGE', percentage: 15 }] })
    expect(atAmazon(byName('Broad | Category').externalCampaignId!).bids).toEqual([0.34, 0.34])
    // Never above the strategy's highest bid (100 cents).
    expect(amazon.bids().filter((b) => Number(b) > 1)).toEqual([])
    // The harvest rule and the research plan on; the performance plan stays off in PROFIT (the phase table says so,
    // and the preview said it); the isolation rule stays off: the captured template turns every isolation switch off.
    expect(await artifactsOn()).toEqual({
      'TESTE2EA (IT) — playbook harvest': true, 'TESTE2EA (IT) — isolation': false,
      'TESTE2EA | IT | Playbook Research': true, 'TESTE2EA | IT | Playbook Performance': false,
    })
    expect((startPreview.artifacts as Json[]).find((x) => x.key === 'rank:performance')).toMatchObject({ does: 'keep' })
    expect((await door.inside(() => db().adsPlaybook.findUniqueOrThrow({ where: { id: ids.aRow } }))).state).toBe('RUNNING')
    expect(await door.inside(() => db().adsPlaybookVersion.findFirst({ where: { refId: ids.aRow, op: 'start' } }))).toMatchObject({ approvalId: startApproval, stepUpAt: expect.any(Date) })
  })

  // D1 (fixed) — the template's isolation switches are all off, so syncIsolationRule keeps the rule off at START. START's
  // preview line asks the compile and says it stays off (artifacts.ts ruleSwitchLines), and START's answer says it stayed
  // off (isolation-run.ts syncIsolationRule `keptOff`): the Approvals page never promises a rule that does not go on.
  it('D1 — a template with isolation off: START\'s preview and its answer say the isolation rule stays off', () => {
    const line = (startPreview.artifacts as Json[]).find((x) => x.kind === 'isolationRule')
    expect(line).toMatchObject({ does: 'keep', summary: expect.stringMatching(/isolation rule stays off: the template turns every isolation switch off \(START does not switch it on\)/) })
    expect(JSON.stringify(startResult)).toMatch(/isolation rule[^"]*(stays|kept) off/)
    // The harvest rule, which the template does not turn off, is still promised on (and went on, above).
    expect((startPreview.artifacts as Json[]).find((x) => x.kind === 'harvestRule')).toMatchObject({ does: 'enable' })
  })
})

let stopApproval = ''
describe('11 — STOP: the brake (low bids, never a pause); its undo is a start, which needs the code', { timeout: TIMEOUT }, () => {
  it('no code: every bid to the 2¢ floor (remembered), off the allowlist, the rules and plans off, the row STOPPED', async () => {
    amazon.reset()
    const asked = await door.call('apply-ads-playbook', stop({ why: 'test: the brake' }))
    expect(asked.answer).toMatchObject({ status: 'waiting_for_approval', preview: { op: 'stop', stops: { campaigns: 5 }, noCode: expect.any(String) } })
    expect(asked.answer.preview).not.toHaveProperty('stepUp')
    stopApproval = asked.answer.approvalId
    expect(await door.approve(stopApproval)).toMatchObject({ ok: true, status: 'executed', result: { op: 'stop', state: 'STOPPED' } })
    await drain()
    const camps = await builtCampaigns()
    for (const c of camps) {
      expect(c, c.name).toMatchObject({ liveBidWritesEnabled: false, bidsSuppressedFloorCents: 2 })
      expect(c.bidsSuppressedAt).toBeInstanceOf(Date)
      expect(String(c.status)).toBe('ENABLED')
      expect(atAmazon(c.externalCampaignId!).bids.every((b) => b === 0.02), c.name).toBe(true)
    }
    // Never a pause, never an archive at Amazon.
    expect(amazon.calls.filter((c) => c.name === 'archiveSpEntity' || (c.name === 'updateCampaign' && (c.args[2] as Json)?.state))).toEqual([])
    expect([...amazon.store.campaigns.values()].filter((c) => String(c.name).startsWith('TESTE2EA')).every((c) => c.state === 'ENABLED')).toBe(true)
    expect(Object.values(await artifactsOn()).every((x) => x === false)).toBe(true)
    expect((await door.inside(() => db().adsPlaybook.findUniqueOrThrow({ where: { id: ids.aRow } }))).state).toBe('STOPPED')
  })

  it('restore-campaign and undo-ad-change refuse a playbook\'s campaign: its bids go back only with op start', async () => {
    const one = (await builtCampaigns()).find((c) => c.name.endsWith('Auto'))!
    const restore = await door.call('restore-campaign', { campaignId: one.id })
    expect(JSON.stringify(restore.answer)).toMatch(/built by an ads playbook: its bids go back only with apply-ads-playbook op start/)
    const undo = await door.call('undo-ad-change', { changeSetId: stopApproval })
    expect(JSON.stringify(undo.answer)).toMatch(/built by an ads playbook: its bids go back only with apply-ads-playbook op start/)
    expect(await door.inside(() => db().agentApproval.count({ where: { toolName: { in: ['restore-campaign', 'undo-ad-change'] } } }))).toBe(0)
  })

  it('the undo of STOP is a start: Claude asks for it, and only the approver\'s code runs it', async () => {
    const change = await door.inside(() => db().agentChange.findFirstOrThrow({ where: { approvalId: stopApproval } }))
    const undo = await door.call('undo-change', { changeId: change.id })
    expect(undo.answer, JSON.stringify(undo.answer).slice(0, 1500)).toMatchObject({ status: 'waiting_for_approval', preview: { op: 'start', stepUp: expect.any(Object) } })
    expect((await door.decide(undo.answer.approvalId)).status).toBe(403)
    expect((await door.decide(undo.answer.approvalId, { code: true })).status).toBe(200)
    expect(await door.commit(undo.answer.approvalId)).toMatchObject({ ok: true, status: 'executed', result: { op: 'start', state: 'RUNNING' } })
    await drain()
    const exact = (await builtCampaigns()).find((c) => c.name.endsWith('Exact | Category'))!
    expect(exact).toMatchObject({ liveBidWritesEnabled: true, bidsSuppressedAt: null })
    expect(atAmazon(exact.externalCampaignId!).bids).toEqual([0.48])
  })
})

describe('14 — business B\'s Claude sees none of A\'s rows, and A\'s none of B\'s', { timeout: TIMEOUT }, () => {
  const text = (x: unknown) => JSON.stringify(x)
  const aMarks = () => [ids.aRow, ids.template, applicationId, approvalId, startApproval, 'TESTE2EA | IT', 'Test funnel'].filter(Boolean)

  it('B\'s Claude: A\'s playbook, template, build, approvals and campaigns are not there — the same SKU is B\'s own product', async () => {
    const effective = await door.call('ads-playbook', { market: 'IT', sku: 'TEST-TESTE2EA-PARENT' }, { biz: B })
    expect(effective.answer).toMatchObject({ business: { id: B }, markets: [{ market: 'IT', playbookRows: 0, enrolled: false, template: null }] })
    const templates = await door.call('ads-playbook', { view: 'templates' }, { biz: B })
    expect(templates.answer).toMatchObject({ business: { id: B }, templates: [] })
    const build = await door.call('ads-playbook', { view: 'build', market: 'IT', applicationId }, { biz: B })
    expect(build.answer.error).toMatch(/^Playbook build not found in this business/)
    const status = await door.call('approval-status', { approvalId }, { biz: B })
    expect(status.answer.error).toBe('Approval not found')
    const campaigns = await door.call('ad-campaigns', { market: 'IT' }, { biz: B })
    expect(campaigns.answer.items.map((c: Json) => c.name)).toEqual(['BRAVO | IT | Exact'])
    const strategy = await door.call('ads-strategy', { market: 'IT' }, { biz: B })
    expect(text(strategy.answer)).toContain('Bravo strategy (IT)')
    for (const answer of [effective.answer, templates.answer, build.answer, status.answer, campaigns.answer, strategy.answer]) {
      for (const mark of aMarks()) expect(text(answer), mark).not.toContain(mark)
    }
  })

  it('B\'s Claude cannot change A\'s playbook: A\'s product is not found there, and naming A\'s business is refused; nothing queued', async () => {
    const before = await door.inside(() => db().agentApproval.count())
    const stopA = await door.call('apply-ads-playbook', { op: 'stop', market: 'IT', productId: ids.aParent }, { biz: B })
    expect(stopA.answer.error).toBe('Product not found')
    const named = await door.call('apply-ads-playbook', { op: 'stop', market: 'IT', productId: ids.aParent }, { biz: B, business: door.names[A] })
    expect(text(named.answer)).toMatch(new RegExp(`This connection works in ${door.names[B]}; you named ${door.names[A]}`))
    expect(await door.inside(() => db().agentApproval.count())).toBe(before)
    expect(await door.inside(() => db().agentApproval.count({ where: { toolName: 'apply-ads-playbook' } }), B)).toBe(0)
  })

  it('A\'s Claude sees none of B\'s rows; under row security B holds none of A\'s; no Amazon call ever reached B\'s account', async () => {
    const lower = await door.call('set-ads-strategy', { channel: 'AMAZON', market: 'IT', level: 'market', values: { maxBidCents: 70 } }, { biz: B })
    expect(lower.answer.status).toBe('waiting_for_approval')
    const bMarks = [lower.answer.approvalId, ids.bizBCampaign, 'BRAVO | IT', 'Bravo strategy']
    const status = await door.call('approval-status', { approvalId: lower.answer.approvalId })
    const campaigns = await door.call('ad-campaigns', { market: 'IT' })
    const strategy = await door.call('ads-strategy', { market: 'IT' })
    expect(status.answer.error).toBe('Approval not found')
    expect(campaigns.answer.items.map((c: Json) => c.name)).not.toContain('BRAVO | IT | Exact')
    for (const answer of [status.answer, campaigns.answer, strategy.answer]) {
      for (const mark of bMarks) expect(text(answer), mark).not.toContain(mark)
    }
    const inB = await door.inside(async () => ({
      playbooks: await db().adsPlaybook.count(), templates: await db().adsPlaybookTemplate.count(), links: await db().adsPlaybookLink.count(),
      rules: await db().automationRule.count(), plans: await db().rankScheduleGroup.count(), runs: await db().adBlueprintApplication.count(),
      campaigns: (await db().campaign.findMany({ select: { name: true } })).map((c) => c.name),
    }), B)
    expect(inB).toEqual({ playbooks: 0, templates: 0, links: 0, rules: 0, plans: 0, runs: 0, campaigns: ['BRAVO | IT | Exact'] })
    expect((await door.inside(() => db().campaign.findMany({ where: { name: { startsWith: 'BRAVO' } } })))).toEqual([])
    expect([...amazon.profiles]).toEqual(['P-IT-E2E-A'])
  })
})
