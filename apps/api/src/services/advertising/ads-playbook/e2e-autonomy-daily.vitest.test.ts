/**
 * ADS AUTONOMY final test, part 3 of 3 — the daily Claude ads run on a running playbook, end to end.
 *
 * As part 1 (e2e-autonomy-build.vitest.test.ts): Claude's MCP door, the Approvals page's decide route with the Owner's
 * real authenticator code where a change needs one, the commit and the change-plan runner, on PGlite with the production
 * schema and every business policy, business profiles ON. The ONLY stand-ins are Amazon's Ads API client (a small
 * Amazon that keeps what it was sent) and the e-mail transport; the engines that recommend (the bid optimizer, the
 * harvest), the overview builder, the run record, the bell, the watchdog and the watch level are the real ones, reading
 * made-up rows as Amazon's reports would bring them. Product A's playbook is built and started through the door first.
 *
 *   12 W3-1 — the engines' recommendations by id as ONE change plan: the value that lands (in Nexus and at Amazon, through
 *      the ads sync worker's drain) is the value previewed; the undo of one step puts back only that step
 *   13 W4 — report-ads-run start and finish are journal entries (no approval); the figures are Nexus's own (the same as
 *      ads-overview's), a figure in Claude's own words is refused; one bell notice, one e-mail a day; the watch level
 *      judges a request as by rule and records the verdict while nothing runs; ads-manager-runs shows it; the watchdog
 *      with no report sends one danger notice, once
 *   14 business B's Claude sees none of it, and A's none of B's
 *
 * Values are made up (public repo).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { amazon, mailbox } from '../../../test-support/ads-autonomy-e2e-amazon.js'

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
    readinessQueue: queue, agentPlanQueue: null,
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
import { runPlan } from '../../agents/change-plan.service.js'

type Json = Record<string, any>
let door: Door
const db = () => database.client
const ids: Record<string, string> = {}
let pb: Awaited<ReturnType<typeof throughStart>>
const TIMEOUT = 60_000
const DAY = 86_400_000
/**
 * A report day n days back on the business's calendar (Europe/Rome), as ads-overview counts its days: a UTC day would
 * fall a day short of its 7-day window between midnight in Rome and midnight UTC.
 */
const dayAgo = (n: number) => {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d - n))
}

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
  vi.stubEnv('NEXUS_OAUTH_ISSUER', 'https://web.example.test')
  vi.stubEnv('NEXUS_AI_KILL_SWITCH', '')
  vi.stubEnv('ENABLE_QUEUE_WORKERS', '')
  vi.stubEnv('NEXUS_ADS_DIGEST_RECIPIENTS', 'owner@example.test')
  door = await e2eDoor(database)
  Object.assign(ids, await door.inside(() => seedBusinessA(db())))
  Object.assign(ids, await door.inside(() => seedBusinessB(db()), B))
  pb = await throughStart(door, db, ids)
  // What Amazon's reports bring for A's running playbook, made up: the brand keyword spends with a poor return (the bid
  // optimizer's cut), a search term in A's Auto spends with no order (the harvest's negative), and each campaign's days.
  await door.inside(async () => {
    const brand = await db().adTarget.findFirstOrThrow({ where: { adGroupId: pb.slots['exact-brand'].adGroupId, expressionValue: 'teste2ea jacket', isNegative: false } })
    ids.brandTarget = brand.id
    await db().adTarget.update({ where: { id: brand.id }, data: { spendCents: 1500, salesCents: 1500, clicks: 30, ordersCount: 1 } })
    for (const d of [9, 11, 13]) {
      await db().amazonAdsSearchTerm.create({ data: {
        profileId: 'P-IT-E2E-A', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: dayAgo(d), campaignId: pb.slots.auto.externalCampaignId, adGroupId: pb.slots.auto.externalAdGroupId,
        query: 'test junk', currencyCode: 'EUR', impressions: 400, clicks: 12, costMicros: 6_000_000n, orders7d: 0, sales7dCents: 0,
      } })
    }
    for (let d = 1; d <= 14; d++) {
      await db().amazonAdsDailyPerformance.create({ data: {
        profileId: 'P-IT-E2E-A', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: dayAgo(d), entityType: 'CAMPAIGN', entityId: pb.slots.auto.externalCampaignId,
        localEntityId: pb.slots.auto.campaignId, impressions: 500, clicks: 10, costMicros: 2_000_000n, currencyCode: 'EUR', sales7dCents: 700, orders7d: 1, reportedAt: new Date(),
      } })
    }
  })
}, 240_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await door?.close()
  await database?.close()
}, 30_000)

const bidId = () => `bid:${ids.brandTarget}`
const negId = () => `neg:${pb.slots.auto.externalAdGroupId}:test junk`
const bidOf = async (id: string) => (await door.inside(() => db().adTarget.findUniqueOrThrow({ where: { id }, select: { bidCents: true } }))).bidCents
let planId = ''
/** The ads sync worker's drain once a person's write is past its hold (an approved bid waits 5 minutes before it goes). */
async function drainLater(minutes = 6) {
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + minutes * 60_000 })
  try { return await drainAdWrites(door) } finally { vi.useRealTimers() }
}
let landedCents = 0

describe('12 — W3-1: the engines\' recommendations, carried out by id', { timeout: TIMEOUT }, () => {
  it('ad-recommendations: the real bid optimizer and harvest recommend for A\'s running playbook, inside the strategy', async () => {
    const recs = await door.call('ad-recommendations', { market: 'IT' })
    const items = recs.answer.items as Json[]
    expect(items.find((r) => r.recommendationId === bidId())).toMatchObject({
      category: 'bid', title: 'Lower bid on “teste2ea jacket” (EXACT)', detail: expect.stringMatching(/target 30% \(ads strategy: IT market/), proposedBidCents: 21, campaignId: pb.slots['exact-brand'].campaignId,
    })
    expect(items.find((r) => r.recommendationId === negId())).toMatchObject({ category: 'negative', title: 'Negate wasteful search term “test junk”', campaignId: pb.slots.auto.campaignId })
    // Nothing recommends a pause: an unsellable campaign is information or low bids.
    for (const r of items.filter((x) => x.category === 'retail')) expect(r.noPause).toMatch(/^Nexus never pauses it/)
  })

  it('apply-ad-recommendations: ONE change plan; approved, the value that lands is the value previewed — in Nexus and at Amazon', async () => {
    const before = await bidOf(ids.brandTarget)
    expect(before).toBe(42)
    const asked = await door.call('apply-ad-recommendations', { recommendationIds: [bidId(), negId()], why: 'test: the daily run carries out two recommendations' })
    expect(asked.answer).toMatchObject({ status: 'waiting_for_approval', preview: { title: 'Apply 2 ad recommendations (1 bid, 1 negative)' } })
    planId = asked.answer.approvalId
    const steps = await door.inside(() => db().agentPlanStep.findMany({ where: { approvalId: planId }, orderBy: { position: 'asc' } }))
    expect(steps.map((x) => x.toolName)).toEqual(['set-target-bid', 'create-negative-keyword'])
    const [bidStep, negStep] = steps as Array<{ args: Json; preview: Json }>
    expect(bidStep.args).toMatchObject({ targetId: ids.brandTarget, proposedBidCents: 21, source: { kind: 'recommendation', id: bidId() } })
    expect(bidStep.preview).toMatchObject({ currentBidCents: 42, proposedBidCents: 21, reach: { reach: 'live' } })
    landedCents = bidStep.preview.proposedBidCents
    expect(negStep.args).toMatchObject({ externalAdGroupId: pb.slots.auto.externalAdGroupId, keywordText: 'test junk', source: { id: negId() } })
    // Nothing moved yet: it waits for a person.
    expect(await bidOf(ids.brandTarget)).toBe(42)
    expect((await door.decide(planId)).status).toBe(200)
    expect(await door.commit(planId)).toMatchObject({ ok: true, status: 'executing' })
    // The plan runner, as the worker runs it.
    expect(await door.inside(() => runPlan(planId))).toMatchObject({ ran: 2, finished: true, counts: { done: 2 } })
    expect(await bidOf(ids.brandTarget)).toBe(landedCents)
    amazon.reset()
    await drainLater()
    expect(amazon.named('updateTarget').map((c) => (c.args[2] as Json).bid)).toEqual([landedCents / 100])
    expect(atAmazon(pb.slots['exact-brand'].externalCampaignId).bids).toEqual([landedCents / 100])
    // The negative landed in A's Auto ad group only, at Amazon and in Nexus.
    const negatives = [...amazon.store.negativeKeywords.values()].filter((n) => n.keywordText === 'test junk')
    expect(negatives.map((n) => [n.adGroupId, n.matchType])).toEqual([[pb.slots.auto.externalAdGroupId, 'NEGATIVE_EXACT']])
  })

  it('the undo of one step puts back only that step: the bid comes back, the negative stays', async () => {
    const changes = await door.inside(() => db().agentChange.findMany({ where: { approvalId: planId }, select: { id: true, toolName: true } }))
    expect(changes.map((c) => c.toolName).sort()).toEqual(['create-negative-keyword', 'set-target-bid'])
    const undo = await door.call('undo-change', { changeId: changes.find((c) => c.toolName === 'set-target-bid')!.id })
    expect(undo.answer).toMatchObject({ status: 'waiting_for_approval', preview: { action: 'set-target-bid', currentBidCents: landedCents, proposedBidCents: 42 } })
    expect(await door.approve(undo.answer.approvalId)).toMatchObject({ ok: true, status: 'executed', result: { bidCents: 42 } })
    amazon.reset()
    await drainLater()
    expect(await bidOf(ids.brandTarget)).toBe(42)
    expect(atAmazon(pb.slots['exact-brand'].externalCampaignId).bids).toEqual([0.42])
    // Only that step: the negative stands, in Nexus and at Amazon; nothing else was written.
    expect(await door.inside(() => db().adTarget.findMany({ where: { isNegative: true, expressionValue: 'test junk' }, select: { status: true } }))).toEqual([{ status: 'ENABLED' }])
    expect([...amazon.store.negativeKeywords.values()].filter((n) => n.keywordText === 'test junk').map((n) => n.state)).toEqual(['ENABLED'])
    expect(amazon.calls.map((c) => c.name)).toEqual(['updateTarget'])
  })
})

let runId = ''
let watchedId = ''
const RUN_KEY = 'claude-ads-manager'
describe('13 — W4: the daily run reports to Nexus', { timeout: TIMEOUT }, () => {
  it('start: a journal entry — it runs at once, nothing waits for a person', async () => {
    const before = await door.inside(() => db().agentApproval.count({ where: { toolName: 'report-ads-run' } }))
    const started = await door.call('report-ads-run', { op: 'start' })
    expect(started.answer).toMatchObject({ status: 'running', recorded: true, mode: 'ask', facts: { paused: false, levels: { ask: expect.arrayContaining(['apply-ads-playbook', 'set-target-bid', 'lower-ad-bids-for-stock']) } } })
    runId = started.answer.runId
    expect(await door.inside(() => db().agentRun.findUniqueOrThrow({ where: { id: runId } }))).toMatchObject({ agentKey: RUN_KEY, status: 'running' })
    expect(await door.inside(() => db().agentApproval.count({ where: { toolName: 'report-ads-run' } }))).toBe(before)
  })

  it('a figure in Claude\'s own words is refused, and nothing is recorded', async () => {
    const runs = await door.inside(() => db().agentRun.count({ where: { agentKey: RUN_KEY } }))
    for (const line of ['Spend was €40 yesterday', 'ACoS moved to 31%']) {
      const refused = await door.call('report-ads-run', { op: 'finish', runId, markets: [{ market: 'IT', lines: [line] }] })
      expect(refused.isError, line).toBe(true)
      expect(refused.answer.error, line).toMatch(/states an amount or a percentage .* Nexus adds every figure of a report itself.* Nothing was recorded\./)
    }
    expect(await door.inside(() => db().agentRun.count({ where: { agentKey: RUN_KEY } }))).toBe(runs)
    expect(await door.inside(() => db().agentRun.findUniqueOrThrow({ where: { id: runId } }))).toMatchObject({ status: 'running' })
  })

  it('the watch level: Claude\'s request is judged as if by rule and the verdict recorded; nothing runs', async () => {
    expect(await door.rule('set-target-bid', { level: 'watch' })).toMatchObject({ ok: true, rule: { level: 'watch' } })
    const asked = await door.call('set-target-bid', { targetId: ids.brandTarget, proposedBidCents: 35, why: 'test: a watched cut' })
    expect(asked.answer).toMatchObject({ status: 'waiting_for_approval', preview: { currentBidCents: 42, proposedBidCents: 35 } })
    watchedId = asked.answer.approvalId
    const row = await door.inside(() => db().agentApproval.findUniqueOrThrow({ where: { id: watchedId } }))
    expect(row).toMatchObject({ status: 'pending', decisionVia: null, ruleVerdict: { level: 'watch', wouldRun: true, changes: 1 } })
    // Nothing ran: the bid is where it was, nothing is queued for Amazon.
    expect(await bidOf(ids.brandTarget)).toBe(42)
    expect(await door.inside(() => db().outboundSyncQueue.count({ where: { syncStatus: 'PENDING' } }))).toBe(0)
    expect(await door.rule('set-target-bid', { level: 'ask' })).toMatchObject({ ok: true })
  })

  it('finish: Nexus\'s figures (the same as ads-overview\'s) and Nexus\'s reading of each approval; the bell; one e-mail', async () => {
    mailbox.reset()
    const finished = await door.call('report-ads-run', {
      op: 'finish', runId,
      markets: [{ market: 'IT', lines: ['Carried out the engines\' bid cut and one negative', 'One watched bid cut waits for you'] }],
      // Claude lists the person-approved plan as run by rule: Nexus reads each approval as it is.
      ranByRule: [planId], wouldDo: [watchedId], nextFocus: 'Check the new negative after three days',
    })
    expect(finished.answer).toMatchObject({
      runId, status: 'done', counts: { ranByRule: 0, waitingForYou: 1, wouldHaveRun: 1, declined: 0, expired: 0 }, email: { status: 'sent', recipients: 1 },
    })
    const output = (await door.inside(() => db().agentRun.findUniqueOrThrow({ where: { id: runId } }))).output as Json
    expect(output.approvals).toEqual(expect.arrayContaining([
      expect.objectContaining({ approvalId: planId, fate: 'ran', byRule: false, mismatch: expect.stringMatching(/listed as run by rule, but Nexus says it approved/) }),
      expect.objectContaining({ approvalId: watchedId, fate: 'waiting', watch: { why: null, wouldRun: true } }),
    ]))
    // Every figure is Nexus's own: the report's equal ads-overview's, built from the reports Amazon sent.
    const overview = (await door.call('ads-overview', { market: 'IT', days: 7 })).answer.markets[0]
    const figures = output.markets[0].figures
    expect(figures.last7Days).toMatchObject({ spendCents: overview.totals.spendCents, salesCents: overview.totals.salesCents, orders: overview.totals.orders, clicks: overview.totals.clicks })
    expect(figures.last7Days).toMatchObject({ spendCents: 1400, salesCents: 4900, orders: 7 })
    expect(output.markets[0].lines).toEqual(['Carried out the engines\' bid cut and one negative', 'One watched bid cut waits for you'])
    // The bell for each person of A who may see the ad money, in money words; one e-mail to the digest list.
    const bell = await door.inside(() => db().notification.findMany({ where: { type: 'claude-ads-run' }, select: { userId: true, title: true, body: true } }))
    expect(bell.map((n) => n.userId).sort()).toEqual([door.people.owner.id, door.people.manager.id].sort())
    expect(bell[0]).toMatchObject({ title: 'Claude ads run · 0 ran by rule · 1 wait for you', body: expect.stringContaining('7 days: €14.00 spend, €49.00 sales') })
    expect(mailbox.sent.map((m) => [m.to, m.subject])).toEqual([[['owner@example.test'], `Claude ads · ${door.names[A]} — 0 ran, 1 wait for you`]])
  })

  it('one e-mail a day: a second report the same day is recorded and sends none', async () => {
    const again = await door.call('report-ads-run', { op: 'finish', markets: [{ market: 'IT', lines: ['Nothing more to change'] }] })
    expect(again.answer).toMatchObject({ status: 'done', email: { status: 'skipped' } })
    expect(mailbox.sent).toHaveLength(1)
  })

  it('ads-manager-runs: the runs, each named approval read again now, and the watch week with the watched verdict', async () => {
    const runs = (await door.call('ads-manager-runs', { days: 7 })).answer
    const run = (runs.runs as Json[]).find((r) => r.runId === runId)
    expect(run).toMatchObject({ status: 'done', mode: 'ask', counts: { ranByRule: 0, waitingForYou: 1, wouldHaveRun: 1 } })
    expect(run.approvals).toEqual(expect.arrayContaining([
      expect.objectContaining({ approvalId: planId, fate: 'ran', byRule: false }),
      expect.objectContaining({ approvalId: watchedId, fate: 'waiting' }),
    ]))
    expect(runs.watchWeek, JSON.stringify(runs.watchWeek).slice(0, 800)).toMatchObject({
      label: 'observed, not proof of cause',
      steps: expect.arrayContaining([expect.objectContaining({ approvalId: watchedId, tool: 'set-target-bid', verdict: expect.objectContaining({ wouldRun: true }) })]),
    })
  })

  it('the watchdog: no report by the expected time → one danger notice and one e-mail, once', async () => {
    // Claude never sets its own watchdog alone: the expected time waits for a person.
    const asked = await door.call('set-ads-report-time', { time: '08:00', timeZone: 'Europe/Rome' })
    expect(asked.answer).toMatchObject({ status: 'waiting_for_approval', consequences: { reaches: 'Nexus only' } })
    expect(await door.approve(asked.answer.approvalId)).toMatchObject({ ok: true, status: 'executed' })
    const { runWatchdogOnce, zonedMoment } = await import('../../agents/ads-manager-watchdog.service.js')
    const later = new Date(Date.now() + 2 * DAY)
    const due = zonedMoment({ y: later.getUTCFullYear(), m: later.getUTCMonth() + 1, d: later.getUTCDate() }, '08:00', 'Europe/Rome')
    mailbox.reset()
    // Two days on, the run has not reported by 08:00 + 30 minutes on the business's own clock.
    const tick = await door.inside(() => runWatchdogOnce(new Date(due.getTime() + 40 * 60_000)))
    expect(tick).toMatchObject({ missing: { due: due.toISOString(), alert: { email: 'sent' } }, stuck: null })
    // The next tick says nothing again for the same day.
    expect(await door.inside(() => runWatchdogOnce(new Date(due.getTime() + 100 * 60_000)))).toMatchObject({ missing: null, stuck: null })
    const notices = await door.inside(() => db().notification.findMany({ where: { type: 'claude-ads-watchdog' }, select: { severity: true, title: true, userId: true } }))
    expect(notices.map((n) => n.userId).sort()).toEqual([door.people.owner.id, door.people.manager.id].sort())
    for (const n of notices) expect(n).toMatchObject({ severity: 'danger', title: `Claude ads: the daily run did not report — ${door.names[A]}` })
    expect(mailbox.sent.map((m) => [m.to, m.subject])).toEqual([[['owner@example.test'], `Claude ads: the daily run did not report — ${door.names[A]}`]])
  })
})

describe('14 — business B\'s Claude sees none of the daily run, and A\'s none of B\'s', { timeout: TIMEOUT }, () => {
  const text = (x: unknown) => JSON.stringify(x)

  it('B\'s Claude: A\'s recommendations, plan, runs and watched request are not there, and cannot be carried out from B', async () => {
    const marks = () => [planId, watchedId, runId, ids.brandTarget, bidId(), negId(), 'TESTE2EA']
    const recs = await door.call('ad-recommendations', { market: 'IT' }, { biz: B })
    const runs = await door.call('ads-manager-runs', { days: 7 }, { biz: B })
    const plan = await door.call('approval-status', { approvalId: planId }, { biz: B })
    for (const answer of [recs.answer, runs.answer, plan.answer]) for (const mark of marks()) expect(text(answer), mark).not.toContain(mark)
    expect(plan.answer.error).toBe('Approval not found')
    expect(runs.answer.runs).toEqual([])
    const before = await door.inside(() => db().agentApproval.count(), B)
    const carried = await door.call('apply-ad-recommendations', { recommendationIds: [bidId(), negId()], why: 'test: from the wrong business' }, { biz: B })
    expect(carried.isError).toBe(true)
    expect(carried.answer.error).toMatch(/^Nothing was queued — /)
    const finish = await door.call('report-ads-run', { op: 'finish', runId, markets: [{ market: 'IT', lines: ['Nothing to change'] }] }, { biz: B })
    expect(finish.isError).toBe(true)
    expect(await door.inside(() => db().agentApproval.count(), B)).toBe(before)
  })

  it('B\'s bell and watchdog are B\'s own: no A notice there; B set no report time, so its watchdog checks nothing', async () => {
    const { runWatchdogOnce } = await import('../../agents/ads-manager-watchdog.service.js')
    expect(await door.inside(() => runWatchdogOnce(new Date(Date.now() + 2 * DAY)), B)).toMatchObject({ expected: null, missing: null, stuck: null })
    expect(await door.inside(() => db().notification.count({ where: { type: { in: ['claude-ads-run', 'claude-ads-watchdog'] } } }), B)).toBe(0)
    expect(await door.inside(() => db().agentRun.count({ where: { agentKey: RUN_KEY } }), B)).toBe(0)
    // And A's Claude sees nothing of B: B's campaign, B's account.
    const campaigns = await door.call('ad-campaigns', { market: 'IT' })
    expect((campaigns.answer.items as Json[]).map((c) => c.name)).not.toContain('BRAVO | IT | Exact')
    expect([...amazon.profiles]).toEqual(['P-IT-E2E-A'])
  })
})
