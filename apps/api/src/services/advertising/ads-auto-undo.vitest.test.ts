/**
 * ADS AUTONOMY — auto-undo (automation A19): pure rules, then whole runs on PGlite with the production schema and the
 * business policies. Values and ids are made up (public repo).
 *
 *   lever       which writes it judges (bids, budgets, placements) and which it never touches (a status change, a create,
 *               a stop to the floor, the no-pause floor's memory)
 *   origin      an engine, a rule at AUTO (a live run covers the write), a Claude change the business's rule ran — never a
 *               person's own change, a request a person approved, a rule suggestion a person applied, a brake
 *   verdict     the shared watch-week outcome first; clearly worse by ACoS (points up, sales not up) or a raise that sold
 *               nothing; too little data is never worse; nothing settled yet waits
 *   asymmetry   undoing a raise (a cut) is always allowed; undoing a cut (a raise) only when the cut made its ACoS worse
 *               and inside the raise limits
 *   caps        at most N undos a market a day
 *   levels      born OBSERVE (records would-undo, writes nothing at Amazon); PROPOSE asks a person (a request a person
 *               approves, then the value goes back as his request); AUTO puts it back itself through the Undo's path,
 *               with the 5-minute window to cancel; a superseded change is never undone; a dry run writes nothing
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', async () => {
  const { contextualDatabase } = await import('../../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_t, p) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), p) }) }
})
vi.mock('../../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true, workersOff: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    readinessQueue: queue, agentPlanQueue: null, queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: false, status: 'not-initialized' }), resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: { connection: null },
  }
})
vi.mock('../outbound-destination.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveDestinations: async (_db: unknown, rows: unknown[]) => rows.map(() => ({ connectionId: null, reason: 'NO_ACCOUNT' })),
}))

import {
  autoUndoSummaryLine, decideAction, judgeChange, leverChangeOf, originOf, raiseRefusal, runAutoUndo, settledThroughOf, settledWindows,
  type LeverChange, type OriginFacts,
} from './ads-auto-undo.service.js'
import { AUTO_UNDO_DEFAULTS, autoUndoThresholds } from './ads-auto-undo-thresholds.js'
import { reverseJudgedWrite } from './rollback.service.js'
import { setEngineSwitch } from '../automation/engine-switch.service.js'
import type { WatchWindow } from '../agents/ads-watch-week.service.js'
import { callTool, type UserPrincipal } from '../agents/call-tool.js'
import { commitScheduledApproval, decideFleetApproval } from '../agent-fleet/approval-inbox.service.js'

const T = AUTO_UNDO_DEFAULTS
const DAY = 86_400_000
const HOUR = 3_600_000
const TIMEOUT = 120_000

// ── Pure ──────────────────────────────────────────────────────────────────────────────────────────

const period = (spendCents: number, salesCents: number, clicks: number) => ({ spendCents, salesCents, clicks, orders: salesCents ? 1 : 0, acos: salesCents > 0 ? spendCents / salesCents : null })
const win = (days: number, before: ReturnType<typeof period>, after: ReturnType<typeof period>, complete = true, peers: { before: ReturnType<typeof period>; after: ReturnType<typeof period> } | null = null): WatchWindow => ({
  days, before: { from: '2026-09-01', to: '2026-09-03' }, after: { from: '2026-09-05', to: '2026-09-07' }, complete, entity: { before, after }, peers: peers ? { count: 3, ...peers } : null,
})
const bid = (direction: 'raise' | 'cut', from: number, to: number): LeverChange => ({ lever: 'bid', direction, from, to })

describe('auto-undo — which writes it judges (pure)', () => {
  it('a bid, an ad group default bid, a budget and one placement; never a status change, a create or a stop', () => {
    expect(leverChangeOf({ entityType: 'AD_TARGET', actionType: 'AD_BID_UPDATE', payloadBefore: { bidCents: 50, status: 'ENABLED' }, payloadAfter: { bidCents: 70, status: 'ENABLED' } }))
      .toEqual({ lever: 'bid', direction: 'raise', from: 50, to: 70 })
    expect(leverChangeOf({ entityType: 'AD_GROUP', actionType: 'AD_BID_UPDATE', payloadBefore: { defaultBidCents: 80 }, payloadAfter: { defaultBidCents: 60 } }))
      .toEqual({ lever: 'bid', direction: 'cut', from: 80, to: 60 })
    expect(leverChangeOf({ entityType: 'CAMPAIGN', actionType: 'AD_BUDGET_UPDATE', payloadBefore: { dailyBudget: 20, status: 'ENABLED' }, payloadAfter: { dailyBudget: 30, status: 'ENABLED' } }))
      .toEqual({ lever: 'dailyBudget', direction: 'raise', from: 2000, to: 3000 })
    expect(leverChangeOf({ entityType: 'CAMPAIGN', actionType: 'update_placement_bidding', payloadBefore: { adjustments: [{ placement: 'PLACEMENT_TOP', percentage: 20 }] }, payloadAfter: { adjustments: [{ placement: 'PLACEMENT_TOP', percentage: 60 }] } }))
      .toEqual({ lever: 'placement:PLACEMENT_TOP', direction: 'raise', from: 20, to: 60 })
    expect(leverChangeOf({ entityType: 'CAMPAIGN', actionType: 'update_placement_bidding', payloadBefore: { adjustments: [{ placement: 'PLACEMENT_TOP', percentage: 20 }, { placement: 'PLACEMENT_PRODUCT_PAGE', percentage: 30 }] }, payloadAfter: { adjustments: [{ placement: 'PLACEMENT_TOP', percentage: 60 }, { placement: 'PLACEMENT_PRODUCT_PAGE', percentage: 0 }] } }))
      .toMatchObject({ excluded: 'not-a-lever', why: expect.stringContaining('both ways') })
    expect(leverChangeOf({ entityType: 'AD_TARGET', actionType: 'AD_ENTITY_STATE_UPDATE', payloadBefore: { bidCents: 50, status: 'ENABLED' }, payloadAfter: { bidCents: 50, status: 'PAUSED' } }))
      .toMatchObject({ excluded: 'not-a-lever', why: expect.stringContaining('status change') })
    expect(leverChangeOf({ entityType: 'AD_TARGET', actionType: 'create_keyword', payloadBefore: {}, payloadAfter: { bidCents: 50 } })).toMatchObject({ excluded: 'not-a-lever' })
    expect(leverChangeOf({ entityType: 'AD_TARGET', actionType: 'AD_BID_UPDATE', payloadBefore: { bidCents: 50 }, payloadAfter: { bidCents: 2 } })).toMatchObject({ excluded: 'stop' })
    expect(leverChangeOf({ entityType: 'AD_TARGET', actionType: 'AD_BID_UPDATE', payloadBefore: { bidCents: 30, suppressedFromBidCents: 50 }, payloadAfter: { bidCents: 50, suppressedFromBidCents: 50 } })).toMatchObject({ excluded: 'stop' })
  })

  it('who made it: engines, a rule at AUTO and a Claude request run by rule are judged; a person, a person-approved request, an applied suggestion and a brake never', () => {
    const at = new Date('2026-09-04T12:00:00Z')
    const facts: OriginFacts = {
      approvals: new Map([['ap-rule', { decisionVia: 'auto' }], ['ap-person', { decisionVia: 'nexus' }], ['ap-code', { decisionVia: 'claude-confirm' }]]),
      rules: new Map([['crule1', 'Trim bids on weak ACoS']]),
      ruleRanLive: (ruleId, when) => ruleId === 'crule1' && when.getTime() === at.getTime(),
    }
    expect(originOf({ userId: 'automation:auto-bid', executionId: null, createdAt: at }, facts)).toEqual({ origin: 'engine', label: 'Bid optimiser', approvalId: null })
    expect(originOf({ userId: 'automation:rank-defend-s1', executionId: null, createdAt: at }, facts)).toMatchObject({ origin: 'engine' })
    expect(originOf({ userId: 'automation:crule1', executionId: null, createdAt: at }, facts)).toEqual({ origin: 'rule', label: 'rule "Trim bids on weak ACoS"', approvalId: null })
    // The same rule's actor, with no live run of it at that moment: a suggestion a person applied.
    expect(originOf({ userId: 'automation:crule1', executionId: null, createdAt: new Date(at.getTime() + HOUR) }, facts)).toMatchObject({ leftAlone: 'person-approved' })
    expect(originOf({ userId: 'user:u1', executionId: 'ap-rule', createdAt: at }, facts)).toEqual({ origin: 'claude-rule', label: 'a Claude request the business\'s rule ran', approvalId: 'ap-rule' })
    expect(originOf({ userId: 'user:u1', executionId: 'ap-person', createdAt: at }, facts)).toMatchObject({ leftAlone: 'person-approved' })
    expect(originOf({ userId: 'user:u1', executionId: 'ap-code', createdAt: at }, facts)).toMatchObject({ leftAlone: 'person-approved' })
    expect(originOf({ userId: 'user:u1', executionId: null, createdAt: at }, facts)).toMatchObject({ leftAlone: 'person' })
    expect(originOf({ userId: 'automation:budget-manager-cron', executionId: null, createdAt: at }, facts)).toMatchObject({ leftAlone: 'brake' })
    expect(originOf({ userId: 'automation:dayparting-s1', executionId: null, createdAt: at }, facts)).toMatchObject({ leftAlone: 'schedule' })
    expect(originOf({ userId: 'automation:auto-undo', executionId: null, createdAt: at }, facts)).toMatchObject({ leftAlone: 'own' })
    expect(originOf({ userId: 'automation:auto-bid', executionId: null, createdAt: at, queuedForce: true }, facts)).toMatchObject({ leftAlone: 'stop' })
    expect(originOf({ userId: 'automation:cnotarule000000000000', executionId: null, createdAt: at }, facts)).toMatchObject({ leftAlone: 'unknown' })
  })
})

describe('auto-undo — the verdict (pure)', () => {
  const peers = { before: period(1500, 6000, 30), after: period(1500, 6000, 30) }

  it('settled days: a day counts once it ended 72 hours ago; a window that is not settled is not complete', () => {
    expect(settledThroughOf(new Date('2026-09-10T08:00:00Z'), 72)).toBe('2026-09-06')
    expect(settledThroughOf(new Date('2026-09-10T00:00:00Z'), 72)).toBe('2026-09-06')
    const [w] = settledWindows([win(3, period(1, 1, 1), period(1, 1, 1))], '2026-09-06')
    expect(w.complete).toBe(false) // its days after run to 09-07
    expect(settledWindows([win(3, period(1, 1, 1), period(1, 1, 1))], '2026-09-07')[0].complete).toBe(true)
  })

  it('clearly worse by ACoS: the shared outcome is worse, ACoS up more than the bar, sales not up', () => {
    const w = win(3, period(1200, 6000, 30), period(1350, 3000, 30), true, peers)
    expect(judgeChange('cut', [w], 'worse', T)).toMatchObject({ verdict: 'worse', case: 'acos' })
    // Worse than the peers, but only a few points: not clearly.
    expect(judgeChange('cut', [win(3, period(1200, 6000, 30), period(1320, 6000, 30), true, peers)], 'worse', T)).toMatchObject({ verdict: 'not_worse' })
    // ACoS up, but sales up too.
    expect(judgeChange('raise', [win(3, period(1200, 6000, 30), period(4000, 8000, 30), true, peers)], 'worse', T)).toMatchObject({ verdict: 'not_worse' })
  })

  it('a raise that sold nothing: spend up past the bar and no sales after — only for a raise', () => {
    const w = win(3, period(1500, 6000, 30), period(3600, 0, 60))
    expect(judgeChange('raise', [w], 'no_sales', T)).toMatchObject({ verdict: 'worse', case: 'no_sales' })
    expect(judgeChange('cut', [w], 'no_sales', T)).toMatchObject({ verdict: 'not_worse' })
    expect(judgeChange('raise', [win(3, period(3000, 6000, 30), period(3600, 0, 60))], 'no_sales', T)).toMatchObject({ verdict: 'not_worse' })
  })

  it('no data is never worse; nothing settled waits', () => {
    expect(judgeChange('raise', [win(3, period(1500, 6000, 30), period(300, 0, 6))], 'no_sales', T)).toMatchObject({ verdict: 'not_enough_data' })
    expect(judgeChange('raise', [{ ...win(3, period(0, 0, 0), period(0, 0, 0)), entity: null }], 'no_data', T)).toMatchObject({ verdict: 'not_enough_data' })
    expect(judgeChange('raise', [win(3, period(1500, 6000, 30), period(3600, 0, 60), false)], 'not_yet', T)).toBeNull()
  })

  it('the thresholds live in one place, per market over the defaults', () => {
    expect(autoUndoThresholds('it')).toEqual(T)
    expect(autoUndoThresholds('IT', { IT: { maxUndosPerDay: 2 } })).toEqual({ ...T, maxUndosPerDay: 2 })
    expect(autoUndoThresholds('DE', { IT: { maxUndosPerDay: 2 } })).toEqual(T)
  })
})

describe('auto-undo — what may be done (pure)', () => {
  const none = { maxChangePct: null, maxBidCents: null, maxBudgetCents: null }
  const base = { verdict: 'worse' as const, level: 'AUTO' as const, capLeft: 5, cap: 5, market: 'IT', raise: null, case: 'acos' as const }

  it('undoing a raise is a cut: always inside; undoing a cut is a raise: inside maxRaisePct and the strategy only', () => {
    expect(raiseRefusal(bid('raise', 50, 90), T, none)).toBeNull()
    expect(raiseRefusal(bid('cut', 100, 85), T, none)).toBeNull() // +17.6 %
    expect(raiseRefusal(bid('cut', 100, 50), T, none)).toContain('more than 25 %')
    expect(raiseRefusal(bid('cut', 100, 85), T, { ...none, maxChangePct: 10 })).toContain("the ads strategy's largest change")
    expect(raiseRefusal(bid('cut', 100, 85), T, { ...none, maxBidCents: 90 })).toContain('highest bid')
    expect(raiseRefusal({ lever: 'dailyBudget', direction: 'cut', from: 2400, to: 2000 }, T, { ...none, maxBudgetCents: 2200 })).toContain("campaign's own bound")
    expect(raiseRefusal({ lever: 'placement:PLACEMENT_TOP', direction: 'cut', from: 50, to: 20 }, T, none)).toContain('30 points')
  })

  it('a cut is put back only when it made its ACoS worse; the cap and the level decide the rest', () => {
    expect(decideAction({ ...base, change: bid('cut', 100, 85), case: 'no_sales' })).toMatchObject({ action: 'held', reason: expect.stringContaining('only when the cut made its ACoS worse') })
    expect(decideAction({ ...base, change: bid('cut', 100, 50), raise: 'too far' })).toEqual({ action: 'held', reason: 'too far' })
    expect(decideAction({ ...base, change: bid('raise', 50, 70), capLeft: 0 })).toMatchObject({ action: 'held', reason: expect.stringContaining('daily cap of 5 undos in IT') })
    expect(decideAction({ ...base, change: bid('raise', 50, 70), level: 'OBSERVE' })).toMatchObject({ action: 'would_undo' })
    expect(decideAction({ ...base, change: bid('raise', 50, 70), level: 'PROPOSE' })).toMatchObject({ action: 'proposed' })
    expect(decideAction({ ...base, change: bid('raise', 50, 70) })).toMatchObject({ action: 'undone' })
    expect(decideAction({ ...base, change: { lever: 'placement:PLACEMENT_TOP', direction: 'raise', from: 20, to: 60 } })).toMatchObject({ action: 'held', reason: expect.stringContaining('no 5-minute window') })
    expect(decideAction({ ...base, verdict: 'not_worse', change: bid('raise', 50, 70) })).toMatchObject({ action: 'none' })
    expect(decideAction({ ...base, verdict: 'not_enough_data', change: bid('raise', 50, 70) })).toMatchObject({ action: 'none' })
  })
})

// ── Whole runs ────────────────────────────────────────────────────────────────────────────────────

const A = LEGACY_WORKSPACE_ID
const business = { workspaceId: A, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const db = () => database.client as any
const EVERYTHING = new Set<string>([...Object.values(FEATURES), ...Object.values(FIELDS)])
const people = { approver: '', asker: '' }
const principal = (userId: string): UserPrincipal => ({ kind: 'user', userId, label: `Person ${userId.slice(0, 6)}`, via: 'app', workspace: business, permissions: { isOwner: false, permissions: EVERYTHING } })

/** Today 08:00 UTC: the newest settled day is 4 days back. D7: both windows settled; D3: only the 3 days after. */
const NOW = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate(), 8))
const TODAY = Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), NOW.getUTCDate())
const D7 = TODAY - 12 * DAY
const D3 = TODAY - 8 * DAY
const at = (dayStart: number) => new Date(dayStart + 12 * HOUR)

const CAMPAIGN = 'au-c'
const GROUP = 'au-g'
const PEERS = ['au-p1', 'au-p2', 'au-p3']
type Figures = (offsetFromChange: number) => { spend: number; sales: number; clicks: number }
const steady: Figures = () => ({ spend: 500, sales: 2000, clicks: 10 })
const soldNothingAfter: Figures = (o) => (o > 0 ? { spend: 1200, sales: 0, clicks: 20 } : steady(o))

async function target(id: string, bidCents: number) {
  await db().adTarget.create({ data: { id, adGroupId: GROUP, kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: `term ${id}`, bidCents, externalTargetId: `EXT-${id}` } })
}
/** Daily figures for 20 days back to yesterday, as `figures(offset from the change day)` says. */
async function figures(id: string, changeDay: number, f: Figures) {
  const rows = []
  for (let d = TODAY - 20 * DAY; d < TODAY; d += DAY) {
    const v = f(Math.round((d - changeDay) / DAY))
    rows.push({
      profileId: 'P-IT-AU', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: new Date(d), entityType: 'AD_TARGET', entityId: `EXT-${id}`, localEntityId: id,
      clicks: v.clicks, costMicros: BigInt(v.spend * 10_000), currencyCode: 'EUR', sales7dCents: v.sales, orders7d: v.sales ? 2 : 0, reportRunId: 'test-run', reportedAt: new Date(),
    })
  }
  await db().amazonAdsDailyPerformance.createMany({ data: rows })
}
const log = (data: { id: string; entityType?: string; entityId: string; actionType?: string; userId: string; before: object; after: object; createdAt: Date; executionId?: string }) =>
  db().advertisingActionLog.create({
    data: {
      id: data.id, entityType: data.entityType ?? 'AD_TARGET', entityId: data.entityId, actionType: data.actionType ?? 'AD_BID_UPDATE', userId: data.userId,
      payloadBefore: data.before, payloadAfter: data.after, createdAt: data.createdAt, executionId: data.executionId ?? null, amazonResponseStatus: 'SUCCESS',
    },
  })
const judgements = () => inside(() => db().adsAutoUndoJudgement.findMany({ orderBy: { entityId: 'asc' } })) as Promise<Array<Record<string, any>>>
const judgementOf = async (entityId: string) => (await judgements()).find((j) => j.entityId === entityId)
const bidOf = async (id: string) => (await inside(() => db().adTarget.findUniqueOrThrow({ where: { id } }))).bidCents as number
const run = (dryRun = false) => inside(() => runAutoUndo({ now: NOW, dryRun }))
const reset = async () => inside(async () => {
  await db().adsAutoUndoJudgement.deleteMany({})
  await db().agentApproval.deleteMany({ where: { toolName: 'undo-worse-ad-change', status: { in: ['pending', 'scheduled'] } } })
})

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_ENABLE_AMAZON_ADS_CRON', '1')
  vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
  vi.stubEnv('NEXUS_ADS_AUTOMATION_KILL', '')
  vi.stubEnv('NEXUS_AI_KILL_SWITCH', '')
  const c = db()
  people.approver = (await c.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: 'Test Approver' } })).id
  people.asker = (await c.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: 'Test Asker' } })).id
  const role = await c.role.create({ data: { key: `AU_${randomUUID().slice(0, 8)}`, name: 'Auto-undo approver', description: 'test', isSystem: false, permissions: [...EVERYTHING] } })
  for (const userId of [people.approver, people.asker]) {
    await c.userRole.create({ data: { userId, roleId: role.id } })
    const membership = await c.workspaceMembership.create({ data: { workspaceId: A, userId, status: 'active' } })
    await c.workspaceMemberRole.create({ data: { membershipId: membership.id, roleId: role.id } })
  }
  await inside(async () => {
    await c.adsAutomationState.upsert({ where: { id: 'singleton' }, create: { id: 'singleton', autonomy: 'AUTO' }, update: { autonomy: 'AUTO', halted: false } })
    await c.amazonAdsConnection.create({ data: { profileId: 'P-IT-AU', marketplace: 'IT', region: 'EU', mode: 'production', writesEnabledAt: new Date(), isActive: true } })
    await c.campaign.create({
      data: { id: CAMPAIGN, name: 'Auto-undo test', type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: `EXT-${CAMPAIGN}`, dailyBudget: '20.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true },
    })
    await c.adGroup.create({ data: { id: GROUP, campaignId: CAMPAIGN, name: 'auto-undo group', externalAdGroupId: `EXT-${GROUP}` } })
    for (const p of PEERS) { await target(p, 50); await figures(p, D3, steady) }

    // An engine's raise that then sold nothing: clearly worse, its undo is a cut.
    await target('au-raise', 70); await figures('au-raise', D3, soldNothingAfter)
    await log({ id: 'log-raise', entityId: 'au-raise', userId: 'automation:auto-bid', before: { bidCents: 50, status: 'ENABLED' }, after: { bidCents: 70, status: 'ENABLED' }, createdAt: at(D3) })
    // A rule at AUTO cut a bid and its ACoS went up while its sales fell (7 days settled): its undo is a raise of 17.6 %.
    await c.automationRule.create({ data: { id: 'aurulecut000000000000000', name: 'Trim weak bids', domain: 'advertising', trigger: 'schedule', enabled: true, dryRun: false, autonomyLevel: 'AUTO' } })
    await c.automationRuleExecution.create({ data: { ruleId: 'aurulecut000000000000000', triggerData: {}, actionResults: [], dryRun: false, status: 'SUCCESS', startedAt: new Date(at(D7).getTime() + 30_000), finishedAt: new Date(at(D7).getTime() + 30_000), durationMs: 60_000 } })
    await target('au-cut', 85); await figures('au-cut', D7, (o) => (o > 0 ? { spend: 450, sales: 1000, clicks: 10 } : { spend: 400, sales: 2000, clicks: 10 }))
    await log({ id: 'log-cut', entityId: 'au-cut', userId: 'automation:aurulecut000000000000000', before: { bidCents: 100 }, after: { bidCents: 85 }, createdAt: at(D7) })
    // An engine's raise that went as its peers did: not worse.
    await target('au-flat', 66); await figures('au-flat', D3, steady)
    await log({ id: 'log-flat', entityId: 'au-flat', userId: 'automation:auto-bid', before: { bidCents: 60 }, after: { bidCents: 66 }, createdAt: at(D3) })
    // Too little traffic after it: never worse.
    await target('au-thin', 48); await figures('au-thin', D3, (o) => (o > 0 ? { spend: 100, sales: 0, clicks: 2 } : steady(o)))
    await log({ id: 'log-thin', entityId: 'au-thin', userId: 'automation:auto-bid', before: { bidCents: 40 }, after: { bidCents: 48 }, createdAt: at(D3) })
    // A Claude request the business's rule ran, and one a person approved: the same bad raise.
    const agentRun = await c.agentRun.create({ data: { agentKey: 'mcp', trigger: 'manual', status: 'done', via: 'claude', userId: people.asker } })
    await c.agentApproval.create({ data: { id: 'ap-byrule', agentRunId: agentRun.id, toolName: 'set-target-bid', riskTier: 'high', args: {}, status: 'executed', decisionVia: 'auto' } })
    await c.agentApproval.create({ data: { id: 'ap-person', agentRunId: agentRun.id, toolName: 'set-target-bid', riskTier: 'high', args: {}, status: 'executed', decisionVia: 'nexus' } })
    await target('au-byrule', 70); await figures('au-byrule', D3, soldNothingAfter)
    await log({ id: 'log-byrule', entityId: 'au-byrule', userId: `user:${people.asker}`, executionId: 'ap-byrule', before: { bidCents: 50 }, after: { bidCents: 70 }, createdAt: at(D3) })
    await target('au-approved', 70); await figures('au-approved', D3, soldNothingAfter)
    await log({ id: 'log-approved', entityId: 'au-approved', userId: `user:${people.approver}`, executionId: 'ap-person', before: { bidCents: 50 }, after: { bidCents: 70 }, createdAt: at(D3) })
    // A person's own change, an engine raise a person changed again later (superseded), an hourly plan's floor (a stop).
    await target('au-person', 35); await figures('au-person', D3, soldNothingAfter)
    await log({ id: 'log-person', entityId: 'au-person', userId: `user:${people.approver}`, before: { bidCents: 30 }, after: { bidCents: 35 }, createdAt: at(D3) })
    await target('au-super', 45); await figures('au-super', D3, soldNothingAfter)
    await log({ id: 'log-super', entityId: 'au-super', userId: 'automation:auto-bid', before: { bidCents: 40 }, after: { bidCents: 50 }, createdAt: at(D3) })
    await log({ id: 'log-super-later', entityId: 'au-super', userId: `user:${people.approver}`, before: { bidCents: 50 }, after: { bidCents: 45 }, createdAt: at(D3 + DAY) })
    await target('au-stop', 2); await figures('au-stop', D3, steady)
    await log({ id: 'log-stop', entityId: 'au-stop', userId: 'automation:rank-defend-s1', before: { bidCents: 50 }, after: { bidCents: 2 }, createdAt: at(D3) })
  })
}, 240_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

describe('auto-undo — a whole run', { timeout: TIMEOUT }, () => {
  it('a dry run (preview-automation) judges and writes nothing', async () => {
    const out = await run(true)
    expect(out).toMatchObject({ level: 'OBSERVE', dryRun: true })
    expect(out.counts).toMatchObject({ judged: 5, worse: 3, wouldUndo: 3, notWorse: 1, notEnoughData: 1, superseded: 1 })
    expect(await judgements()).toEqual([])
  })

  it('a failed brain levers\' pass never loses the bid pass: its answer and line stand, the failure said (batch 2 review fix)', async () => {
    vi.doMock('./brain/undo-run.js', () => ({ runBrainLeverUndo: async () => { throw new Error('test: the enrollment read failed') } }))
    try {
      const out = await run(true)
      expect(out).toMatchObject({ level: 'OBSERVE', dryRun: true, brainError: 'test: the enrollment read failed' })
      expect(out.counts).toMatchObject({ judged: 5, worse: 3, wouldUndo: 3, notWorse: 1, notEnoughData: 1, superseded: 1 })
      expect(out.items.length).toBeGreaterThan(0)
      expect(out.notes).toEqual(expect.arrayContaining([expect.stringMatching(/^The brain levers' pass failed \(test: the enrollment read failed\): the changes above were judged/)]))
      expect('brain' in out).toBe(false)
      expect(autoUndoSummaryLine(out)).toMatch(/^level=OBSERVE read=\d+ judged=5 .* · brain: failed \(test: the enrollment read failed\)$/)
      expect(await judgements()).toEqual([])
    } finally { vi.doUnmock('./brain/undo-run.js') }
  })

  it('born OBSERVE: each judgement is recorded with its numbers; it would undo the clearly worse ones and changes nothing at Amazon', async () => {
    const out = await run()
    expect(out.level).toBe('OBSERVE')
    expect(out.levelWhy).toContain('born OBSERVE')
    expect(out.counts).toMatchObject({ judged: 5, worse: 3, wouldUndo: 3, proposed: 0, undone: 0, superseded: 1 })
    // Never read or judged: a person's change, a request a person approved, a stop.
    expect(out.leftAlone).toMatchObject({ 'person-approved': 1, stop: 1 })
    const all = await judgements()
    expect(all.map((j) => j.entityId)).toEqual(['au-byrule', 'au-cut', 'au-flat', 'au-raise', 'au-thin'])
    expect(await judgementOf('au-raise')).toMatchObject({ origin: 'engine', originLabel: 'Bid optimiser', verdict: 'worse', outcome: 'no_sales', action: 'would_undo', direction: 'raise', fromValue: 50, toValue: 70, level: 'OBSERVE', final: false, marketplace: 'IT' })
    expect(await judgementOf('au-cut')).toMatchObject({ origin: 'rule', verdict: 'worse', outcome: 'worse', action: 'would_undo', final: true })
    expect((await judgementOf('au-cut'))!.evidence).toMatchObject({ case: 'acos', window: { days: 7 }, thresholds: { acosPointsUp: 10 } })
    expect(await judgementOf('au-byrule')).toMatchObject({ origin: 'claude-rule', approvalId: 'ap-byrule', verdict: 'worse', action: 'would_undo' })
    expect(await judgementOf('au-flat')).toMatchObject({ verdict: 'not_worse', action: 'none' })
    expect(await judgementOf('au-thin')).toMatchObject({ verdict: 'not_enough_data', action: 'none' })
    expect([await bidOf('au-raise'), await bidOf('au-cut'), await bidOf('au-byrule')]).toEqual([70, 85, 70])
    expect(autoUndoSummaryLine(out)).toContain('level=OBSERVE')
    // A second run the same day changes nothing new and counts no undo twice: the cut's judgement is final (both windows
    // settled) and not read again; the others are looked at again and stay as they were.
    const again = await run()
    expect(again.counts).toMatchObject({ judged: 4, wouldUndo: 2 })
    expect((await judgements()).length).toBe(5)
    expect(await judgementOf('au-cut')).toMatchObject({ action: 'would_undo', final: true })
  })

  it('at most N undos a market a day: past the cap a clearly worse change is held, to look again tomorrow', async () => {
    await reset()
    await inside(async () => {
      for (let i = 0; i < T.maxUndosPerDay; i++) {
        await db().adsAutoUndoJudgement.create({
          data: { actionLogId: `cap-${i}`, actor: 'automation:auto-bid', origin: 'engine', entityType: 'AD_TARGET', entityId: `cap-${i}`, marketplace: 'IT', lever: 'bid', direction: 'raise', changedAt: NOW, verdict: 'worse', action: 'would_undo', actionAt: NOW, level: 'OBSERVE', final: true },
        })
      }
    })
    const out = await run()
    expect(out.counts).toMatchObject({ worse: 3, wouldUndo: 0, held: 3 })
    expect((await judgementOf('au-raise'))!.actionReason).toContain('daily cap of 5 undos in IT')
    await reset()
  })

  it('PROPOSE: a person decides each undo in the Approvals page; approved, the value goes back as his request', async () => {
    await inside(() => setEngineSwitch('auto-undo', 'PROPOSE', `user:${people.approver}`))
    const out = await run()
    expect(out.level).toBe('PROPOSE')
    expect(out.counts).toMatchObject({ worse: 3, proposed: 3, undone: 0 })
    const raise = (await judgementOf('au-raise'))!
    expect(raise).toMatchObject({ action: 'proposed', final: true })
    const request = await inside(() => db().agentApproval.findUniqueOrThrow({ where: { id: raise.undoApprovalId } }))
    expect(request).toMatchObject({ toolName: 'undo-worse-ad-change', status: 'pending', args: { judgementId: raise.id } })
    expect(request.preview).toMatchObject({ restore: { entityId: 'au-raise', lever: 'bid', fromValue: 70, toValue: 50 }, reach: { reach: 'live' }, raises: [] })
    // The cut's undo raises: listed.
    const cutApproval = (await judgementOf('au-cut'))!.undoApprovalId
    const cutRequest = await inside(() => db().agentApproval.findUniqueOrThrow({ where: { id: cutApproval } }))
    expect((cutRequest.preview as { raises: string[] }).raises).toEqual([expect.stringContaining('raises the bid back')])
    // Nothing changed before a person decides; asking again for the same judgement is refused.
    expect(await bidOf('au-raise')).toBe(70)
    const twice = await inside(() => callTool(principal(people.asker), 'undo-worse-ad-change', { judgementId: raise.id }))
    expect(twice.raw).toMatchObject({ ok: false, error: expect.stringContaining('already asked for') })

    const approved = await inside(() => decideFleetApproval({ id: raise.undoApprovalId, decision: 'approve', actor: principal(people.approver) })) as Record<string, any>
    expect(approved.ok).toBe(true)
    await inside(() => db().agentApproval.update({ where: { id: raise.undoApprovalId }, data: { executeAfter: new Date(Date.now() - 1000) } }))
    const done = await inside(() => commitScheduledApproval(raise.undoApprovalId)) as Record<string, any>
    expect(done).toMatchObject({ ok: true, status: 'executed' })
    expect(await bidOf('au-raise')).toBe(50)
    expect(await judgementOf('au-raise')).toMatchObject({ action: 'undone', undoApprovalId: raise.undoApprovalId })
    const original = await inside(() => db().advertisingActionLog.findUniqueOrThrow({ where: { id: 'log-raise' } }))
    expect(original.rolledBackAt).toBeInstanceOf(Date)
    const reversal = await inside(() => db().advertisingActionLog.findFirstOrThrow({ where: { entityId: 'au-raise', executionId: raise.undoApprovalId } }))
    expect(reversal).toMatchObject({ userId: `user:${people.approver}`, payloadBefore: { bidCents: 70 }, payloadAfter: { bidCents: 50 } })
  })

  it('AUTO: it puts the clearly worse ones back itself, through the Undo, held 5 minutes for a person to cancel; a second run does nothing new', async () => {
    await reset()
    await inside(() => setEngineSwitch('auto-undo', 'AUTO', `user:${people.approver}`))
    const out = await run()
    expect(out.level).toBe('AUTO')
    // The raise was put back by a person's approved request: its own write is that person's, never judged; the original is undone.
    expect(out.counts).toMatchObject({ worse: 2, undone: 2 })
    expect(await bidOf('au-cut')).toBe(100) // a cut that made its ACoS worse: raised back, inside the limits
    expect(await bidOf('au-byrule')).toBe(50)
    const cut = (await judgementOf('au-cut'))!
    expect(cut).toMatchObject({ action: 'undone', final: true, level: 'AUTO' })
    const reversal = await inside(() => db().advertisingActionLog.findUniqueOrThrow({ where: { id: cut.undoActionLogId } }))
    expect(reversal).toMatchObject({ userId: 'automation:auto-undo', entityId: 'au-cut', payloadAfter: { bidCents: 100 } })
    const queued = await inside(() => db().outboundSyncQueue.findUniqueOrThrow({ where: { id: reversal.outboundQueueId } }))
    expect(queued.holdUntil.getTime()).toBeGreaterThan(Date.now() + 4 * 60_000)
    const again = await run()
    expect(again.counts).toMatchObject({ undone: 0, proposed: 0 })
    // The superseded engine raise and the person's changes were never touched.
    expect([await bidOf('au-super'), await bidOf('au-person'), await bidOf('au-approved')]).toEqual([45, 35, 70])
  })

  it('the Undo itself refuses a superseded write (compare-and-set) and writes nothing', async () => {
    const out = await inside(() => reverseJudgedWrite({ actionLogId: 'log-super', actor: 'automation:auto-undo', reason: 'test' }))
    expect(out).toMatchObject({ ok: false, superseded: true, reason: expect.stringContaining('superseded') })
    expect(await bidOf('au-super')).toBe(45)
  })

  it('undo-worse-ad-change refuses a change not judged clearly worse, and an unknown judgement', async () => {
    const flat = (await judgementOf('au-flat'))!
    const notWorse = await inside(() => callTool(principal(people.asker), 'undo-worse-ad-change', { judgementId: flat.id }))
    expect(notWorse.raw).toMatchObject({ ok: false, error: expect.stringContaining('only a change judged clearly worse') })
    const unknown = await inside(() => callTool(principal(people.asker), 'undo-worse-ad-change', { judgementId: 'nope' }))
    expect(unknown.raw).toMatchObject({ ok: false, error: expect.stringContaining('not found') })
  })

  it('OFF runs nothing', async () => {
    await inside(() => setEngineSwitch('auto-undo', 'OFF', `user:${people.approver}`))
    const out = await run()
    expect(out).toMatchObject({ level: 'OFF', counts: { read: 0, judged: 0 } })
    expect(autoUndoSummaryLine(out)).toMatch(/^skipped:/)
  })
})
