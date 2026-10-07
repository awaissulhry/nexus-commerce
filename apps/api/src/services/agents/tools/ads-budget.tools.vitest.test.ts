/**
 * ADS AUTONOMY W4-7 — Claude's budget tools, run for real through the door and the approval gate (PGlite, production
 * schema; the job queue a stub; the ads write gate the real one, sandbox). Made-up ids, names and amounts.
 *
 * Proven: set-campaign-budget's list form (many budgets, one request, the same rules, undone as one); restore-budget-
 * baselines (the screen's own restore, as the approver, every write in the approval's change set, undone through
 * set-campaign-budget); set-monthly-ad-budget (the Budget Manager's plan and campaign limits; a raise through the plan
 * needs the approver's code — a plain approve does not run it, the Approvals page asks for the code, with it it runs; a
 * campaign's limits loosened need none, as set-ad-guardrail); set-budget-schedule (create, windows, campaigns, pause and
 * delete with the screen's give-back, the one-schedule rule, the code for a raise through a new lever and none for a
 * window edit or a pause); set-budget-pool (create born off, allocate, a live rebalance in the change set, the code for
 * campaigns joining a live pool); ad-budgets reads them; a change plan carries a step's code; by default nothing runs by
 * rule, and the limits judge the op, the market and a raise.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
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
    readinessQueue: queue, agentPlanQueue: null, queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
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
import { ruleFrom } from '../claude-trust.service.js'
import { commitScheduledApproval, decideFleetApproval } from '../../agent-fleet/approval-inbox.service.js'
import { queuePlan, runPlan } from '../change-plan.service.js'
import { budgetRuleRefusal } from './ads-budget-kit.js'
import { STEP_UP_NEEDS } from '../step-up-approval.js'
import { __stepUpTest } from '../../../lib/auth/step-up.js'
import { generateSecret, generateSync } from 'otplib'

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const EVERYTHING = new Set<string>([...Object.values(FEATURES), ...Object.values(FIELDS)])
const person = (userId: string, via: 'claude' | 'app'): UserPrincipal => ({
  kind: 'user', userId, label: `Person ${userId}`, via, workspace: business, permissions: { isOwner: false, permissions: EVERYTHING },
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
/** A person's plain approve (no authenticator code). */
const approve = (approvalId: string) => inside(() => decideApproval(approvalId, 'approve', approver)) as Promise<Row>
/** As the Approvals page records a decision taken with the approver's authenticator code. */
const withCode = (approvalId: string) => inside(() => database.client.agentApproval.update({ where: { id: approvalId }, data: { decisionVia: 'nexus-step-up' } }))
const approvalRow = (id: string) => inside(() => database.client.agentApproval.findUniqueOrThrow({ where: { id } }))
const sql = <T = Row>(text: string, params: unknown[] = []) => inside(async () => (await database.client.$queryRawUnsafe(text, ...params)) as T[])
const budgetOf = async (id: string) => Math.round(Number((await sql<{ b: string }>('SELECT "dailyBudget"::text AS b FROM "Campaign" WHERE id = $1', [id]))[0]?.b) * 100)
const setBudget = (id: string, cents: number, extra: Record<string, unknown> = {}) => inside(() => database.client.campaign.update({ where: { id }, data: { dailyBudget: (cents / 100).toFixed(2), ...extra } }))
const nextMonth = () => { const d = new Date(); const n = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)); return `${n.getUTCFullYear()}-${String(n.getUTCMonth() + 1).padStart(2, '0')}` }
const commitNow = async (approvalId: string) => {
  await inside(() => database.client.agentApproval.update({ where: { id: approvalId }, data: { executeAfter: new Date(Date.now() - 1000) } }))
  return inside(() => commitScheduledApproval(approvalId))
}

/** A real person (a row, a role, a membership, an authenticator), for the Approvals page's real approve path. */
type RealPerson = { id: string; secret: string; principal: UserPrincipal }
async function realPerson(label: string): Promise<RealPerson> {
  const client = database.client
  const secret = generateSecret()
  const role = await client.role.create({ data: { key: `W47_${randomUUID().slice(0, 8)}`, name: label, description: 'test', isSystem: false, permissions: [...EVERYTHING] } })
  const user = await client.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: label, twoFactorEnabledAt: new Date(), twoFactorSecret: secret } })
  await client.userRole.create({ data: { userId: user.id, roleId: role.id } })
  const membership = await client.workspaceMembership.create({ data: { workspaceId: LEGACY_WORKSPACE_ID, userId: user.id, status: 'active' } })
  await client.workspaceMemberRole.create({ data: { membershipId: membership.id, roleId: role.id } })
  return { id: user.id, secret, principal: { kind: 'user', userId: user.id, label, via: 'app', workspace: business, permissions: { isOwner: false, permissions: EVERYTHING } } }
}
const codeOf = (p: RealPerson) => { __stepUpTest.reset(); return generateSync({ secret: p.secret }) }

/** One more SP campaign in IT, with a budget of 20.00. */
const campaign = (id: string, extra: Record<string, unknown> = {}) => database.client.campaign.create({
  data: { id, name: `Test ${id}`, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: `EXT-${id}`, dailyBudget: '20.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true, ...extra },
})

let people: { approver: RealPerson }
beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    await seedAdsFixture(database.client)
    for (const [code, currency] of [['IT', 'EUR'], ['UK', 'GBP']]) {
      await database.client.marketplace.create({ data: { channel: 'AMAZON', code, name: `Amazon ${code}`, region: 'EU', currency, language: 'en' } })
    }
    for (const id of ['c-b1', 'c-b2', 'c-b3', 'c-s1', 'c-s2', 'c-s3', 'c-s4', 'c-s5', 'c-p1', 'c-p2', 'c-p3', 'c-p4', 'c-l1', 'c-l2']) await campaign(id)
  })
  people = { approver: await inside(() => realPerson('Test Approver')) }
}, 180_000)
afterAll(async () => { await database?.close() }, 30_000)

describe('the tools as the contract holds them', () => {
  it('strategy-bound, alwaysAsk, ceiling auto, the budget kind, at ask by default; nothing runs by rule by default', () => {
    for (const name of ['set-monthly-ad-budget', 'set-budget-schedule', 'set-budget-pool', 'restore-budget-baselines']) {
      const tool = getTool(name)!
      expect(tool, name).toMatchObject({ alwaysAsk: true, strategyBound: 'amazon-ads', maxClaudeTrust: 'auto', openWorld: true, requires: ['ads.budgets.edit', 'financials.adspend.view'] })
      expect(ruleFrom(tool, null).level, name).toBe('ask')
      expect(tool.limits!.parse({}), name).toMatchObject({ maxItems: 0, allowEngineOwned: false })
      expect(typeof tool.withinLimits!({ summary: 'no facts' }, tool.limits!.parse({}) as Row), name).toBe('string')
    }
    for (const name of ['set-monthly-ad-budget', 'set-budget-schedule', 'set-budget-pool']) {
      expect(getTool(name)!.limits!.parse({}), name).toMatchObject({ ops: [], markets: [], allowRaise: false })
    }
    expect(getTool('restore-budget-baselines')!.limits!.parse({})).toMatchObject({ maxRaisePct: 0 })
    expect(getTool('set-budget-schedule')!.reversibility).toBe('partial')
    expect(getTool('set-budget-pool')!.reversibility).toBe('partial')
    expect(getTool('set-monthly-ad-budget')!.reversibility).toBe('full')
    expect(getTool('ad-budgets')).toMatchObject({ readOnly: true, requires: ['ads.view', 'financials.adspend.view'] })
  })

  it('the limits judge the op, the market and a raise after the kit\'s checks (pure)', () => {
    // A preview inside the strategy (the kit's facts let it through), so only the tool's own checks speak.
    const facts = {
      v: 1, tool: 'set-budget-schedule', action: 'budget',
      markets: { IT: { strategy: { version: 'test-v1' }, currency: 'EUR', maxActionsPerRun: null, maxChangesPerDay: 10, maxRaisesPerDay: 10, maxBudgetIncreasePerDayCents: 10_000, sources: {} } },
      scopes: { 'IT|campaign:c1': { market: 'IT', label: 'campaign "Test" (IT)', limits: {}, sources: {} } },
      entityScopes: { 'campaign:c1': 'IT|campaign:c1' }, labels: { 'campaign:c1': 'campaign "Test"' },
      this: { markets: ['IT'], items: 1, writes: 0, raises: 1, cuts: 0, largestRaisePct: 0, largestCutPct: 0, largestRaisePoints: 0, largestCutPoints: 0, highestNewBidCents: null, budgetIncreaseCents: 0, byMarket: { IT: { changes: 1, writes: 0, raises: 1, budgetIncreaseCents: 0, addedDailyCents: 0 } }, entities: ['campaign:c1'], rowsOutsideStrategy: 0, firstOutside: null },
      today: { IT: { changes: 0, writes: 0, raises: 0, budgetIncreaseCents: 0 } }, perEntityToday: { maxChangesByRule: 0, entity: null }, unplaced: [], engineOwned: [], protectedHit: [],
    }
    const p = { op: 'create', markets: ['IT'], raises: ['window Mon 08:00–12:00 incPct 20 can raise a budget'], ruleGate: null, limitFacts: facts }
    const limits = getTool('set-budget-schedule')!.limits!.parse({}) as Row
    expect(budgetRuleRefusal(p, limits)).toMatch(/more than the 0 this tool's limits allow in one request run by rule/)
    expect(budgetRuleRefusal(p, { ...limits, maxItems: 5 })).toMatch(/^op create does not run by rule here \(this tool's limits list no op\)/)
    expect(budgetRuleRefusal(p, { ...limits, maxItems: 5, ops: ['create'] })).toMatch(/^it acts in IT, where this tool's limits let nothing run by rule \(markets: none\)/)
    expect(budgetRuleRefusal(p, { ...limits, maxItems: 5, ops: ['create'], markets: ['IT'] })).toMatch(/^it can raise spend \(window Mon .*\); this tool's limits let no raise run by rule \(allowRaise is off\)/)
    expect(budgetRuleRefusal(p, { ...limits, maxItems: 5, ops: ['create'], markets: ['IT'], allowRaise: true })).toBeNull()
    expect(budgetRuleRefusal({ ...p, ruleGate: 'campaign "Test": refused' }, { ...limits, maxItems: 5, ops: ['create'], markets: ['IT'], allowRaise: true })).toMatch(/refused; a person decides$/)
  })
})

describe('by the business\'s rule', () => {
  it('a real preview of each tool is refused by its default limits; loosened, the ads strategy still holds it (no strategy for IT)', async () => {
    const previews: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
      ['set-monthly-ad-budget', { market: 'IT', month: nextMonth(), monthlyBudgetCents: 30_000, stopOverSpend: true }, { ops: ['set'], markets: ['IT'], allowRaise: true, maxMonthlyRaisePct: 100 }],
      ['set-budget-schedule', { op: 'create', name: 'Test rule', campaignIds: ['c-s5'], windows: [{ day: 4, adj: 'decPct', value: 10 }] }, { ops: ['create'], markets: ['IT'], allowRaise: true }],
      ['set-budget-pool', { op: 'create', name: 'Test rule pool', totalDailyBudgetCents: 3000, add: [{ campaignId: 'c-p4' }] }, { ops: ['create'], markets: ['IT'], allowRaise: true, maxPoolDailyCents: 1_000_000 }],
      ['restore-budget-baselines', { campaignIds: ['c-l1'] }, { maxRaisePct: 100 }],
      ['set-campaign-budget', { campaigns: [{ campaignId: 'c-b3', dailyBudgetCents: 1900 }, { campaignId: 'c-b2', dailyBudgetCents: 1900 }] }, { maxRaisePct: 100 }],
    ]
    await setBudget('c-l1', 1500)
    let judged = 0
    for (const [name, args, own] of previews) {
      const r = await preview(name, args)
      if (!r.ok) continue // a campaign an earlier test put in a pool: the limits are what is judged here
      judged++
      const tool = getTool(name)!
      expect(tool.withinLimits!(r.preview, tool.limits!.parse({}) as Row), name).toMatch(/a person decides/)
      const loose = tool.limits!.parse({ maxItems: 50, ...own }) as Row
      expect(tool.withinLimits!(r.preview, loose), name).toMatch(/there is no ads strategy for IT/)
    }
    expect(judged).toBeGreaterThanOrEqual(4)
  })
})

describe('set-campaign-budget — the list form', () => {
  it('many budgets in one request, on the same rules; one already as asked is left as it is', async () => {
    const r = await preview('set-campaign-budget', { campaigns: [{ campaignId: 'c-b1', dailyBudgetCents: 2500 }, { campaignId: 'c-b2', dailyBudgetCents: 1500 }, { campaignId: 'c-b3', dailyBudgetCents: 2000 }] })
    expect(r.ok, r.error).toBe(true)
    expect(r.preview).toMatchObject({
      action: 'set-campaign-budget',
      totals: { changing: 2, alreadyAsAsked: 1, raising: 1, lowering: 1 },
      campaigns: [
        { campaignId: 'c-b1', currentBudgetCents: 2000, proposedBudgetCents: 2500, currency: 'EUR', deltaCents: 500 },
        { campaignId: 'c-b2', currentBudgetCents: 2000, proposedBudgetCents: 1500, deltaCents: -500 },
      ],
      reach: { reach: 'sandbox' },
      limitFacts: { tool: 'set-campaign-budget', action: 'budget', this: { items: 2, raises: 1, cuts: 1 } },
      ruleGate: null,
      basis: expect.any(String),
    })
    expect((r.preview as Row).stepUp).toBeUndefined()
    expect((await preview('set-campaign-budget', { campaigns: [{ campaignId: 'c-b1', dailyBudgetCents: 2500 }, { campaignId: 'c-b1', dailyBudgetCents: 2600 }] })).error).toBe('campaigns names a campaign twice.')
    expect((await preview('set-campaign-budget', { campaignId: 'c-b1', dailyBudgetCents: 2500, campaigns: [{ campaignId: 'c-b2', dailyBudgetCents: 1500 }] })).error).toMatch(/^Name the budgets one way/)
    expect((await preview('set-campaign-budget', { campaigns: [{ campaignId: 'c-sb', dailyBudgetCents: 1500 }] })).error).toMatch(/^Not queued: .*not a Sponsored Products/)
    expect((await preview('set-campaign-budget', { campaigns: [{ campaignId: 'c-b3', dailyBudgetCents: 2000 }] })).error).toMatch(/^Nothing would change/)
    expect((await preview('set-campaign-budget', {})).error).toMatch(/or campaigns: a list of them/)
  })

  it('approved, it writes each budget as the approver in the approval\'s change set; undo asks the list form for the old budgets', async () => {
    const asked = await ask('set-campaign-budget', { campaigns: [{ campaignId: 'c-b1', dailyBudgetCents: 2500 }, { campaignId: 'c-b2', dailyBudgetCents: 1500 }], why: 'test list' })
    expect(asked.approvalId).toBeTruthy()
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed', result: { changed: 2, failed: 0 } })
    expect(await budgetOf('c-b1')).toBe(2500)
    expect(await budgetOf('c-b2')).toBe(1500)
    const logs = await sql(`SELECT "userId", "executionId" FROM "AdvertisingActionLog" WHERE "entityId" IN ('c-b1','c-b2') ORDER BY "createdAt"`)
    expect(logs).toEqual([{ userId: 'user:u-approver', executionId: asked.approvalId }, { userId: 'user:u-approver', executionId: asked.approvalId }])
    expect(await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))).toMatchObject({ request: { tool: 'set-campaign-budget', args: { campaigns: [{ campaignId: 'c-b1', dailyBudgetCents: 2000 }, { campaignId: 'c-b2', dailyBudgetCents: 2000 }] } } })
  })
})

describe('restore-budget-baselines', () => {
  beforeAll(async () => {
    await setBudget('c-l1', 1000, { budgetBaselineCents: 3000 })
    await setBudget('c-l2', 4000, { budgetBaselineCents: 2500 })
  })

  it('each campaign from → to its baseline; no baseline or at it is left as it is; a raise is warned and needs no code', async () => {
    const r = await preview('restore-budget-baselines', { campaignIds: ['c-l1', 'c-l2', 'c-b3'] })
    expect(r.ok, r.error).toBe(true)
    expect(r.preview).toMatchObject({
      action: 'restore-budget-baselines', op: 'restore', markets: ['IT'],
      changes: [{ campaignId: 'c-l1', fromCents: 1000, toCents: 3000 }, { campaignId: 'c-l2', fromCents: 4000, toCents: 2500 }],
      skipped: [{ campaignId: 'c-b3', why: 'no baseline captured' }],
      totals: { restoring: 2, skipped: 1, raising: 1 },
      raises: ['campaign "Test c-l1": EUR 10.00 → EUR 30.00'],
      raisesWithoutCode: ['campaign "Test c-l1": EUR 10.00 → EUR 30.00 — no code, as with set-campaign-budget'],
      reach: { reach: 'sandbox' },
      limitFacts: { tool: 'restore-budget-baselines', action: 'budget', this: { items: 2, raises: 1, cuts: 1 } },
    })
    expect((r.preview as Row).stepUp).toBeUndefined()
    expect((await preview('restore-budget-baselines', { campaignIds: ['c-b3'] })).error).toMatch(/^Nothing would change: campaign "Test c-b3" \(no baseline captured\)/)
    expect((await preview('restore-budget-baselines', { campaignIds: ['nope'] })).error).toBe('Not queued: campaign nope was not found in this business.')
  })

  it('approved, the screen\'s own restore runs as the approver in the change set; undo asks set-campaign-budget', async () => {
    const asked = await ask('restore-budget-baselines', { campaignIds: ['c-l1', 'c-l2'] })
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed', result: { restored: 2, failed: 0 } })
    expect(await budgetOf('c-l1')).toBe(3000)
    expect(await budgetOf('c-l2')).toBe(2500)
    const logs = await sql(`SELECT "userId", "executionId" FROM "AdvertisingActionLog" WHERE "entityId" IN ('c-l1','c-l2')`)
    expect(logs).toEqual([{ userId: 'user:u-approver', executionId: asked.approvalId }, { userId: 'user:u-approver', executionId: asked.approvalId }])
    expect(await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))).toMatchObject({ request: { tool: 'set-campaign-budget', args: { campaigns: [{ campaignId: 'c-l1', dailyBudgetCents: 1000 }, { campaignId: 'c-l2', dailyBudgetCents: 4000 }] } } })
  })
})

describe('set-monthly-ad-budget', () => {
  const month = nextMonth()

  it('a new plan with a cap: a brake, no code; then a bigger budget or Stop Over Spend off needs the code', async () => {
    const created = await preview('set-monthly-ad-budget', { market: 'IT', month, monthlyBudgetCents: 50_000, stopOverSpend: true })
    expect(created.ok, created.error).toBe(true)
    expect(created.preview).toMatchObject({
      action: 'set-monthly-ad-budget', op: 'set', market: 'IT', month, currency: 'EUR',
      plan: { from: null, to: { monthlyBudgetCents: 50_000, stopOverSpend: true, autoPacing: false, calendar: [] }, planId: null },
      raises: [], reach: null, reachNote: expect.stringMatching(/^Nexus only now: nothing is sent to Amazon by this change\. The budget engine reads the plan every 30 minutes — now: Off/),
      limitFacts: { tool: 'set-monthly-ad-budget', action: 'budget' },
    })
    expect((created.preview as Row).stepUp).toBeUndefined()
    const asked = await ask('set-monthly-ad-budget', { market: 'IT', month, monthlyBudgetCents: 50_000, stopOverSpend: true })
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed' })
    const [plan] = await sql('SELECT "monthlyBudgetCents", "stopOverSpend", "autoPacing", "createdBy" FROM "AdBudgetPlan" WHERE marketplace = $1 AND month = $2', ['IT', month])
    expect(plan).toEqual({ monthlyBudgetCents: 50_000, stopOverSpend: true, autoPacing: false, createdBy: 'user:u-approver' })
    expect(await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))).toMatchObject({ request: { tool: 'set-monthly-ad-budget', args: { op: 'remove', market: 'IT', month } } })

    const raise = await preview('set-monthly-ad-budget', { market: 'IT', month, monthlyBudgetCents: 60_000 })
    expect(raise.preview).toMatchObject({
      raises: ['the monthly budget rises from EUR 500.00 to EUR 600.00: Stop Over Spend and Auto Pacing act at the higher cap'],
      stepUp: { what: `raises spend through the IT budget plan for ${month}`, raises: ['Monthly budget'], needs: STEP_UP_NEEDS, how: expect.stringMatching(/authenticator code/) },
    })
    const off = await preview('set-monthly-ad-budget', { market: 'IT', month, stopOverSpend: false })
    expect((off.preview as Row).raises).toEqual(['Stop Over Spend switched off: the engine gives back the bids it floored and floors none at the cap'])
    expect((off.preview as Row).stepUp).toBeTruthy()
    const cut = await preview('set-monthly-ad-budget', { market: 'IT', month, monthlyBudgetCents: 40_000 })
    expect((cut.preview as Row).raises).toEqual([])
  })

  it('a raise: a plain approve does not run it; the Approvals page asks for the code; with it it runs at commit', async () => {
    const asked = await ask('set-monthly-ad-budget', { market: 'IT', month, monthlyBudgetCents: 70_000 })
    expect(((await approvalRow(asked.approvalId!)).preview as Row).stepUp).toMatchObject({ raises: ['Monthly budget'] })
    const plain = await approve(asked.approvalId!)
    expect(plain).toMatchObject({ ok: false })
    expect(plain.error).toMatch(/^Not run: it raises, and a raise runs only when a person with settings\.security\.manage approved it with their authenticator code/)
    const decide = (code?: string) => inside(() => decideFleetApproval({ id: asked.approvalId!, decision: 'approve', actor: people.approver.principal, ...(code ? { code } : {}) }))
    expect(await decide()).toMatchObject({ ok: false, code: 'mfa_required', httpStatus: 403 })
    expect(await decide(codeOf(people.approver))).toMatchObject({ ok: true, status: 'scheduled' })
    expect(await commitNow(asked.approvalId!)).toMatchObject({ ok: true })
    const [plan] = await sql('SELECT "monthlyBudgetCents" FROM "AdBudgetPlan" WHERE marketplace = $1 AND month = $2', ['IT', month])
    expect(plan.monthlyBudgetCents).toBe(70_000)
    expect(await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))).toMatchObject({ request: { tool: 'set-monthly-ad-budget', args: { op: 'set', market: 'IT', month, monthlyBudgetCents: 50_000, stopOverSpend: true } } })
  })

  it('campaign limits: loosening is listed and needs no code (as set-ad-guardrail); bounds and markets are checked', async () => {
    const r = await preview('set-monthly-ad-budget', { market: 'IT', month, campaignLimits: [{ campaignId: 'c-b3', minCents: 500, maxCents: null }] })
    expect(r.ok, r.error).toBe(true)
    expect(r.preview).toMatchObject({
      totals: { planChanges: 0, campaignLimits: 1 },
      campaignLimits: [{ campaignId: 'c-b3', from: 'lowest none, highest none', to: 'lowest EUR 5.00, highest none' }],
      raises: ['campaign "Test c-b3": its lowest daily budget none → EUR 5.00 holds its spend up'],
      raisesWithoutCode: ['campaign "Test c-b3": its lowest daily budget none → EUR 5.00 holds its spend up — no code, as with set-ad-guardrail (campaign-budget-bounds)'],
    })
    expect((r.preview as Row).stepUp).toBeUndefined()
    expect((await preview('set-monthly-ad-budget', { market: 'IT', month, campaignLimits: [{ campaignId: 'c-b3', minCents: 900, maxCents: 500 }] })).error).toMatch(/minimum daily budget .* is above the maximum/)
    expect((await preview('set-monthly-ad-budget', { market: 'IT', month, campaignLimits: [{ campaignId: 'c-uk', minCents: 500, maxCents: null }] })).error).toMatch(/is not in IT/)
    const asked = await ask('set-monthly-ad-budget', { market: 'IT', month, campaignLimits: [{ campaignId: 'c-b3', minCents: 500, maxCents: null }] })
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed' })
    expect((await sql('SELECT "minBudgetCents" FROM "Campaign" WHERE id = $1', ['c-b3']))[0].minBudgetCents).toBe(500)
    expect(await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))).toMatchObject({ request: { args: { op: 'set', campaignLimits: [{ campaignId: 'c-b3', minCents: null, maxCents: null }] } } })
  })

  it('refuses what the screen would not save: a past month, a calendar that does not add up, nothing to remove', async () => {
    expect((await preview('set-monthly-ad-budget', { market: 'IT', month: '2020-01', monthlyBudgetCents: 100 })).error).toMatch(/^2020-01 is over/)
    expect((await preview('set-monthly-ad-budget', { market: 'IT', month, calendar: [{ day: 1, pct: 50 }] })).error).toMatch(/gives every day of .* its share/)
    expect((await preview('set-monthly-ad-budget', { market: 'UK', month, op: 'remove' })).error).toMatch(/^Nothing to remove: UK has no budget plan/)
    expect((await preview('set-monthly-ad-budget', { market: 'ZZ', monthlyBudgetCents: 100 })).error).toMatch(/^Market ZZ not found in this business/)
    expect((await preview('set-monthly-ad-budget', { market: 'IT', month, monthlyBudgetCents: 70_000 })).error).toMatch(/^Nothing would change/)
  })

  it('a change plan carries a step\'s code: no code → mfa_required; with it the step runs', async () => {
    const queued = await inside(async () => {
      const run = await database.client.agentRun.create({ data: { agentKey: 'mcp', trigger: 'manual', status: 'done', via: 'claude', userId: claude.userId } })
      return queuePlan({ title: 'Test budget plan', steps: [{ tool: 'set-monthly-ad-budget', args: { market: 'IT', month, monthlyBudgetCents: 80_000 } }, { tool: 'set-campaign-budget', args: { campaigns: [{ campaignId: 'c-b3', dailyBudgetCents: 2200 }] } }] }, claude, run.id)
    })
    expect(queued).toMatchObject({ ok: true, mode: 'queued' })
    const planId = queued.approvalId!
    expect(((await approvalRow(planId)).preview as Row).stepUp).toMatchObject({ raises: ['Monthly budget'], steps: [1] })
    const decide = (code?: string) => inside(() => decideFleetApproval({ id: planId, decision: 'approve', actor: people.approver.principal, ...(code ? { code } : {}) }))
    expect(await decide()).toMatchObject({ ok: false, code: 'mfa_required' })
    expect(await decide(codeOf(people.approver))).toMatchObject({ ok: true, status: 'scheduled' })
    expect(await commitNow(planId)).toMatchObject({ ok: true, status: 'executing' })
    expect(await inside(() => runPlan(planId))).toMatchObject({ finished: true, counts: { done: 2 } })
    expect((await sql('SELECT "monthlyBudgetCents" FROM "AdBudgetPlan" WHERE marketplace = $1 AND month = $2', ['IT', month]))[0].monthlyBudgetCents).toBe(80_000)
    expect(await budgetOf('c-b3')).toBe(2200)
  })
})

describe('set-budget-schedule', () => {
  const window = { day: 1, start: '08:00', end: '12:00', adj: 'incPct', value: 20 }
  let scheduleId = ''

  it('create: a window that can raise a budget needs the code; one that only lowers does not', async () => {
    const lowering = await preview('set-budget-schedule', { op: 'create', name: 'Test lowering', campaignIds: ['c-s1'], windows: [{ ...window, adj: 'decPct' }] })
    expect(lowering.ok, lowering.error).toBe(true)
    expect(lowering.preview).toMatchObject({ op: 'create', raises: [], reach: null, markets: ['IT'], schedule: { from: null, to: { enabled: true, campaigns: 1, windows: ['Mon 08:00–12:00 decPct 20'] } } })
    expect((lowering.preview as Row).stepUp).toBeUndefined()
    const raising = await preview('set-budget-schedule', { op: 'create', name: 'Test raising', campaignIds: ['c-s1', 'c-s2'], windows: [window] })
    expect(raising.preview).toMatchObject({
      raises: ['window Mon 08:00–12:00 incPct 20 can raise a budget'],
      stepUp: { what: 'creates the budget schedule "Test raising", which can raise budgets', raises: ['Budgets'] },
      limitFacts: { tool: 'set-budget-schedule', action: 'budget', this: { items: 2, raises: 2 } },
    })
    expect((await preview('set-budget-schedule', { op: 'create', name: 'x', campaignIds: ['c-s1'], windows: [{ day: 1, start: '08:00', adj: 'incPct', value: 20 }] })).error).toMatch(/needs both start and end/)
    expect((await preview('set-budget-schedule', { op: 'create', name: 'x', campaignIds: ['c-s1'], windows: [{ day: 1, adj: 'set', value: 0.5 }] })).error).toMatch(/^Not queued: .*Set budget to/)
    expect((await preview('set-budget-schedule', { op: 'create', name: 'x', campaignIds: ['c-sb'], windows: [window] })).error).toMatch(/not a Sponsored Products/)
  })

  it('approved with the code, the screen\'s create runs; a second schedule on the same campaign is refused, naming the first', async () => {
    const asked = await ask('set-budget-schedule', { op: 'create', name: 'Test raising', campaignIds: ['c-s1', 'c-s2'], windows: [window] })
    expect((await approve(asked.approvalId!)).error).toMatch(/^Not run: it raises/)
    await withCode(asked.approvalId!)
    const ran = await approve(asked.approvalId!)
    expect(ran).toMatchObject({ ok: true, status: 'executed', result: { op: 'create', enabled: true, campaigns: 2, windows: 1 } })
    scheduleId = ran.result.scheduleId
    const [row] = await sql('SELECT name, type, enabled, campaigns, windows FROM "BudgetSchedule" WHERE id = $1', [scheduleId])
    expect(row).toMatchObject({ name: 'Test raising', type: 'campaign-budget', enabled: true, windows: [window] })
    expect(row.campaigns.map((c: Row) => c.id)).toEqual(['c-s1', 'c-s2'])
    expect((await preview('set-budget-schedule', { op: 'create', name: 'Test overlap', campaignIds: ['c-s2'], windows: [window] })).error).toMatch(/^Not queued: The campaign “Test c-s2” is already in the budget schedule “Test raising”/)
    expect(await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))).toMatchObject({ request: { tool: 'set-budget-schedule', args: { op: 'delete', scheduleId } } })
  })

  it('update: a window edit is tune-ad-engine\'s lever (listed, no code); campaigns added to a raising schedule need it', async () => {
    const windows = await preview('set-budget-schedule', { op: 'update', scheduleId, windows: [window, { ...window, day: 2 }] })
    expect(windows.preview).toMatchObject({ raises: ['window Tue 08:00–12:00 incPct 20 can raise a budget'], raisesWithoutCode: ['window Tue 08:00–12:00 incPct 20 can raise a budget — no code, as with tune-ad-engine (budget-schedule)'] })
    expect((windows.preview as Row).stepUp).toBeUndefined()
    const added = await preview('set-budget-schedule', { op: 'update', scheduleId, campaignIds: ['c-s1', 'c-s2', 'c-s3'] })
    expect(added.preview).toMatchObject({ raises: ['campaign "Test c-s3" joins a schedule whose windows can raise its budget'], stepUp: { raises: ['Budgets'] }, campaigns: { added: ['campaign "Test c-s3"'], takenOut: [] } })
    expect((await preview('set-budget-schedule', { op: 'update', scheduleId, type: 'budget-multiplier' })).error).toMatch(/A schedule keeps its type/)
    expect((await preview('set-budget-schedule', { op: 'update', scheduleId, name: 'Test raising' })).error).toMatch(/^Nothing would change/)
  })

  it('a pause gives back as the screen (no code); a delete giving a held-down budget back needs the code; the give-back is in the change set', async () => {
    // The schedule holds c-s1 lowered: it set 10.00 from a base of 20.00 (its memo), and the campaign sits at it.
    await setBudget('c-s1', 1000)
    await inside(() => database.client.budgetSchedule.update({ where: { id: scheduleId }, data: { lastApplied: { 'c-s1': { budget: 10, ownCents: 1000, baseCents: 2000, at: new Date().toISOString(), state: 'applied' } } } }))
    const pause = await preview('set-budget-schedule', { op: 'update', scheduleId, enabled: false })
    expect(pause.preview).toMatchObject({
      giveBacks: [{ campaignId: 'c-s1', fromCents: 1000, toCents: 2000 }],
      raises: ['campaign "Test c-s1": its budget comes back up from EUR 10.00 to EUR 20.00 (the schedule held it lower)'],
      raisesWithoutCode: [expect.stringMatching(/\(the schedule held it lower\) — no code, as with turn-up \/ turn-down-automation$/)],
      reach: { reach: 'sandbox' },
      totals: { givesBack: 1 },
    })
    expect((pause.preview as Row).stepUp).toBeUndefined()
    const del = await preview('set-budget-schedule', { op: 'delete', scheduleId })
    expect(del.preview).toMatchObject({ stepUp: { what: 'deletes the budget schedule "Test raising" and gives budgets back up' } })
    const asked = await ask('set-budget-schedule', { op: 'update', scheduleId, enabled: false })
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed', result: { op: 'update', enabled: false, gaveBack: { restored: 1, kept: 0, refused: 0 } } })
    expect(await budgetOf('c-s1')).toBe(2000)
    const [log] = await sql(`SELECT "userId", "executionId" FROM "AdvertisingActionLog" WHERE "entityId" = 'c-s1' AND "actionType" <> 'budget_schedule_update' ORDER BY "createdAt" DESC LIMIT 1`)
    expect(log).toEqual({ userId: `automation:budget-schedule-${scheduleId}`, executionId: asked.approvalId })
    expect(await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))).toMatchObject({ request: { tool: 'set-budget-schedule', args: { op: 'update', scheduleId, enabled: true } } })
  })

  it('dates and time zone of a schedule whose windows raise budgets: a longer run, an earlier start, blackout days removed or a time-zone change is a raise and needs the code', async () => {
    const dated = await inside(() => database.client.budgetSchedule.create({ data: {
      name: 'Test dated', kind: 'BUDGET', type: 'campaign-budget', enabled: true, timezone: 'Europe/Rome',
      campaigns: [{ id: 'c-s5', name: 'Test c-s5', dailyBudget: 20 }], windows: [window],
      startDate: new Date('2026-10-01T00:00:00Z'), endDate: new Date('2027-01-31T00:00:00Z'), neverExpire: false,
      excludeDates: [{ start: '2026-12-24', end: '2026-12-26' }],
    } }))
    const raiseOf = async (args: Record<string, unknown>) => (await preview('set-budget-schedule', { op: 'update', scheduleId: dated.id, ...args })).preview as Row
    const later = await raiseOf({ endDate: '2027-03-31' })
    expect(later).toMatchObject({ raises: ['it runs longer: its last day 2027-01-31 → 2027-03-31'], stepUp: { raises: ['Budgets'] }, limitFacts: { this: { raises: 1 } } })
    expect((await raiseOf({ endDate: null })).raises).toEqual(['its last day 2027-01-31 goes: it never ends'])
    expect((await raiseOf({ startDate: '2026-09-01' })).raises).toEqual(['it starts earlier: its first day 2026-10-01 → 2026-09-01'])
    expect((await raiseOf({ excludeDates: [] })).raises).toEqual(['the days it did not run, 2026-12-24 to 2026-12-26, are no longer left out: its windows run on them'])
    expect((await raiseOf({ timezone: 'Europe/London' })).raises).toEqual(['its windows move from Europe/Rome to Europe/London time: the hours that raise budgets fall at other times'])
    for (const args of [{ endDate: '2027-03-31' }, { timezone: 'Europe/London' }]) expect((await raiseOf(args)).stepUp, JSON.stringify(args)).toBeTruthy()
    // A shorter run lowers nothing it could raise: no raise, no code.
    const shorter = await raiseOf({ endDate: '2026-12-31' })
    expect(shorter.raises).toEqual([])
    expect(shorter.stepUp).toBeUndefined()
    // Its windows only lower: a longer run raises nothing.
    await inside(() => database.client.budgetSchedule.update({ where: { id: dated.id }, data: { windows: [{ ...window, adj: 'decPct' }] } }))
    expect((await raiseOf({ endDate: null })).raises).toEqual([])
    await inside(() => database.client.budgetSchedule.delete({ where: { id: dated.id } }))
  })

  it('a schedule asked switched off is made off in one write; its raising windows are still listed and need the code', async () => {
    const args = { op: 'create', name: 'Test made off', campaignIds: ['c-s5'], windows: [window], enabled: false }
    const r = await preview('set-budget-schedule', args)
    expect(r.preview).toMatchObject({
      raises: ['window Mon 08:00–12:00 incPct 20 can raise a budget (once the schedule is switched on)'],
      stepUp: { raises: ['Budgets'] },
      schedule: { to: { enabled: false } },
      reachNote: expect.stringMatching(/Switched off, it writes nothing until it is switched on/),
    })
    const asked = await ask('set-budget-schedule', args)
    await withCode(asked.approvalId!)
    const ran = await approve(asked.approvalId!)
    expect(ran).toMatchObject({ ok: true, status: 'executed', result: { op: 'create', enabled: false } })
    expect((await sql('SELECT enabled FROM "BudgetSchedule" WHERE id = $1', [ran.result.scheduleId]))[0].enabled).toBe(false)
    const logs = await sql(`SELECT "actionType", "payloadAfter" FROM "AdvertisingActionLog" WHERE "entityId" = $1`, [ran.result.scheduleId])
    expect(logs).toEqual([{ actionType: 'budget_schedule_create', payloadAfter: { name: 'Test made off', type: 'campaign-budget', enabled: false } }])
    // Its cron's mode is named, never assumed: the ads crons are not scheduled in this test.
    const on = await preview('set-budget-schedule', { op: 'update', scheduleId: ran.result.scheduleId, enabled: true })
    expect(on.preview).toMatchObject({ engine: { label: 'Off' }, reachNote: expect.stringMatching(/now: Off: the Amazon ads crons are not scheduled on this server/) })
    await inside(() => database.client.budgetSchedule.delete({ where: { id: ran.result.scheduleId } }))
  })

  it('delete, then undo creates it again as it was (a new schedule)', async () => {
    const asked = await ask('set-budget-schedule', { op: 'delete', scheduleId })
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed', result: { op: 'delete' } })
    expect(await sql('SELECT id FROM "BudgetSchedule" WHERE id = $1', [scheduleId])).toEqual([])
    expect(await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))).toMatchObject({
      request: { tool: 'set-budget-schedule', args: { op: 'create', name: 'Test raising', type: 'campaign-budget', campaignIds: ['c-s1', 'c-s2'], windows: [window], enabled: false } },
    })
  })
})

describe('set-budget-pool', () => {
  let poolId = ''

  it('create: born off and in dry run; a campaign joining is a raise (once the pool is live) and needs the code; undo deletes it', async () => {
    const args = { op: 'create', name: 'Test pool', totalDailyBudgetCents: 6000, add: [{ campaignId: 'c-p1', targetSharePct: 50 }, { campaignId: 'c-p2', targetSharePct: 50 }] }
    const r = await preview('set-budget-pool', args)
    expect(r.ok, r.error).toBe(true)
    expect(r.preview).toMatchObject({
      op: 'create', reach: null, markets: ['IT'], pool: { from: null, to: { enabled: false, dryRun: true, totalDailyBudgetCents: 6000 } },
      raises: [
        'campaign "Test c-p1" joins the pool: once the pool is live, its rebalances may raise its budget from EUR 20.00 (no highest budget is set)',
        'campaign "Test c-p2" joins the pool: once the pool is live, its rebalances may raise its budget from EUR 20.00 (no highest budget is set)',
      ],
      stepUp: { what: 'changes which campaigns the budget pool "Test pool" holds, which can raise spend', raises: ['Budgets'] },
      engine: { label: 'Off' },
      reachNote: expect.stringMatching(/It writes nothing at Amazon while it is switched off/),
    })
    expect((await preview('set-budget-pool', { op: 'create', name: 'Test pool UK', totalDailyBudgetCents: 6000, add: [{ campaignId: 'c-uk' }] })).error)
      .toMatch(/^Not queued: campaign "UK exact" budgets in GBP, and the pool in EUR: a rebalance writes the pool's amounts into each campaign, never converted/)
    const asked = await ask('set-budget-pool', args)
    expect((await approve(asked.approvalId!)).error).toMatch(/^Not run: it raises/)
    await withCode(asked.approvalId!)
    const ran = await approve(asked.approvalId!)
    expect(ran).toMatchObject({ ok: true, status: 'executed', result: { op: 'create', campaigns: 2 } })
    poolId = ran.result.poolId
    expect((await sql('SELECT "createdBy", enabled, "dryRun" FROM "BudgetPool" WHERE id = $1', [poolId]))[0]).toEqual({ createdBy: 'user:u-approver', enabled: false, dryRun: true })
    expect(await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))).toMatchObject({ request: { tool: 'set-budget-pool', args: { op: 'delete', poolId } } })
    expect((await preview('set-budget-pool', { op: 'allocate', poolId: poolId, add: [{ campaignId: 'c-p1' }] })).error).toMatch(/is in this pool already/)
  })

  it('a dry-run rebalance is Nexus only; a live pool\'s rebalance raising a budget, and campaigns joining it, need the code', async () => {
    await inside(() => database.client.budgetPool.update({ where: { id: poolId }, data: { enabled: true, dryRun: true } }))
    await setBudget('c-p1', 1000)
    await setBudget('c-p2', 5000)
    const dry = await preview('set-budget-pool', { op: 'rebalance-now', poolId })
    expect(dry.ok, dry.error).toBe(true)
    expect(dry.preview).toMatchObject({ raises: [], reach: null, totals: { writes: 0 } })
    await inside(() => database.client.budgetPool.update({ where: { id: poolId }, data: { dryRun: false } }))
    const live = await preview('set-budget-pool', { op: 'rebalance-now', poolId })
    expect(live.preview).toMatchObject({
      reach: { reach: 'sandbox' }, totals: { writes: 2 }, stepUp: { raises: ['Budgets'] },
      raises: [expect.stringMatching(/^campaign "Test c-p1": EUR 10\.00 → EUR /)],
    })
    const join = await preview('set-budget-pool', { op: 'allocate', poolId, add: [{ campaignId: 'c-p3', maxDailyBudgetCents: 3000 }] })
    expect(join.preview).toMatchObject({ stepUp: { raises: ['Budgets'] }, raises: ['campaign "Test c-p3" joins a live pool: its next rebalance may raise its budget from EUR 20.00 up to EUR 30.00'] })
    const values = await preview('set-budget-pool', { op: 'update', poolId, totalDailyBudgetCents: 8000 })
    expect(values.preview).toMatchObject({ raises: ['the pool\'s daily budget rises from EUR 60.00 to EUR 80.00'], raisesWithoutCode: ['the pool\'s daily budget rises from EUR 60.00 to EUR 80.00 — no code, as with tune-ad-engine (budget-pool)'] })
    expect((values.preview as Row).stepUp).toBeUndefined()
  })

  it('a live rebalance approved with the code writes each budget in the change set; undo asks set-campaign-budget', async () => {
    const asked = await ask('set-budget-pool', { op: 'rebalance-now', poolId })
    await withCode(asked.approvalId!)
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed', result: { op: 'rebalance-now' } })
    const logs = await sql(`SELECT "entityId", "userId", "executionId" FROM "AdvertisingActionLog" WHERE "executionId" = $1 ORDER BY "entityId"`, [asked.approvalId])
    expect(logs).toEqual([{ entityId: 'c-p1', userId: 'user:u-approver', executionId: asked.approvalId }, { entityId: 'c-p2', userId: 'user:u-approver', executionId: asked.approvalId }])
    expect(await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))).toMatchObject({ request: { tool: 'set-campaign-budget', args: { campaigns: [{ campaignId: 'c-p1', dailyBudgetCents: 1000 }, { campaignId: 'c-p2', dailyBudgetCents: 5000 }] } } })
  })

  it('allocate: a campaign in another pool is refused, naming it; leaving a live pool is a raise with its amount and needs the code; undo reverses it', async () => {
    const other = await inside(() => database.client.budgetPool.create({ data: { name: 'Test other pool', totalDailyBudgetCents: 1000 } }))
    await inside(() => database.client.budgetPoolAllocation.create({ data: { budgetPoolId: other.id, marketplace: 'IT', campaignId: 'c-p4' } }))
    expect((await preview('set-budget-pool', { op: 'allocate', poolId, add: [{ campaignId: 'c-p4' }] })).error).toMatch(/campaign "Test c-p4" is in the pool "Test other pool"/)
    const before = await budgetOf('c-p2')
    const leave = await preview('set-budget-pool', { op: 'allocate', poolId, remove: ['c-p2'] })
    expect(leave.preview).toMatchObject({
      raises: [`campaign "Test c-p2" leaves the pool and keeps its budget of EUR ${(before / 100).toFixed(2)}, while the pool's next rebalance spreads the whole pool over the campaigns left: up to EUR ${(before / 100).toFixed(2)} a day more in all`],
      stepUp: { raises: ['Budgets'] },
      limitFacts: { this: { raises: 1 } },
    })
    const asked = await ask('set-budget-pool', { op: 'allocate', poolId, remove: ['c-p2'] })
    expect((await approve(asked.approvalId!)).error).toMatch(/^Not run: it raises/)
    await withCode(asked.approvalId!)
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed', result: { campaigns: 1 } })
    expect(await budgetOf('c-p2')).toBe(before)
    expect(await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))).toMatchObject({ request: { tool: 'set-budget-pool', args: { op: 'allocate', poolId, add: [{ campaignId: 'c-p2', targetSharePct: 50, minDailyBudgetCents: 100 }] } } })
  })

  it('a campaign in a pool and a switched-on budget schedule: both name the other (alsoChangedBy) and warn', async () => {
    const schedule = await preview('set-budget-schedule', { op: 'create', name: 'Test overlap pool', campaignIds: ['c-p1'], windows: [{ day: 5, adj: 'decPct', value: 10 }] })
    expect(schedule.ok, schedule.error).toBe(true)
    expect(schedule.preview).toMatchObject({
      warnings: ['campaign "Test c-p1" is also in the budget pool "Test pool" (live): its rebalances and this schedule\'s windows both set its budget, and the last write wins.'],
      alsoChangedBy: [{ campaignId: 'c-p1', by: ['budget pool "Test pool" (live)'] }],
    })
    await ask('set-budget-schedule', { op: 'create', name: 'Test overlap pool', campaignIds: ['c-p3'], windows: [{ day: 5, adj: 'decPct', value: 10 }] }).then((x) => approve(x.approvalId!))
    const join = await preview('set-budget-pool', { op: 'allocate', poolId, add: [{ campaignId: 'c-p3' }] })
    expect(join.preview).toMatchObject({
      warnings: [expect.stringMatching(/^campaign "Test c-p3" is also in the switched-on budget schedule "Test overlap pool": its windows and this pool's rebalances both set its budget/)],
      alsoChangedBy: expect.arrayContaining([{ campaignId: 'c-p3', label: 'campaign "Test c-p3"', by: ['budget schedule "Test overlap pool"'] }]),
    })
  })
})

describe('ad-budgets', () => {
  it('reads the plans, schedules, pools and baselines of a market', async () => {
    await ask('set-budget-schedule', { op: 'create', name: 'Test read', campaignIds: ['c-s4'], windows: [{ day: 3, adj: 'decPct', value: 10 }] }).then((a) => approve(a.approvalId!))
    const r = await inside(() => callTool(claude, 'ad-budgets', { market: 'IT' }))
    expect(r.raw.ok, r.raw.error).toBe(true)
    const d = r.raw.data as Row
    expect(d.plans.markets).toEqual(expect.arrayContaining([expect.objectContaining({ market: 'IT', currency: 'EUR' })]))
    expect(d.schedules).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Test read', enabled: true, windows: ['Wed all day decPct 10'], markets: ['IT'], campaigns: [expect.objectContaining({ campaignId: 'c-s4', dailyBudgetCents: 2000 })] })]))
    expect(d.pools).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Test pool', level: 'live' })]))
    expect(d.baselines).toMatchObject({ captured: 2 })
  })
})
