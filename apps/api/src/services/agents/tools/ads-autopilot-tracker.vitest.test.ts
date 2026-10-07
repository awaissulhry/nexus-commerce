/**
 * ADS AUTONOMY W4-9 — autopilot plans' decisions and Keyword Tracker proposals, read and decided by Claude. Through
 * Claude's own door (runToolForClaude → the gate → one change plan → the Approvals page's approve → the plan runner) on
 * PGlite with the production schema and business policies, business profiles ON. The write gate and the change tools are
 * real (sandbox: nothing leaves the process); the job queue is a stub; the bid optimizer's per-target answer is a
 * stand-in whose output the test sets (its own data path is not under test). Values are made up (public repo).
 *
 *   read        ad-recommendations lists the waiting decisions (autopilot:) and proposals (kt:), each with the tool it is
 *               carried out with; a decision of a plan that is off is flagged stale
 *   mapping     a BID decision → the optimizer run now at the plan's target, its bids frozen into the one bid step; a
 *               BUDGET decision → set-campaign-budget; a PLACEMENT decision → set-placement-multipliers (top of search
 *               nudged from the adjustment now); a proposal → its bid on each of its targets in the same bid step —
 *               never approveDecision / applyProposal
 *   frozen      what the person approved is what lands: the optimizer moving afterwards changes nothing
 *   settle      the step's source settles the row once it ran: the decision APPLIED (recreated under its own id when the
 *               plan's 15-minute tick replaced it), the proposal APPLIED with its commitment; the source on every audit
 *               row; an undo gives the proposal's commitment back and says so on the decision
 *   stale       refused before anything waits: not found, a stale plan, a proposal whose targets moved, an id already
 *               carried out, two ids on the same target; a decision dismissed after it was asked is not carried out
 *   sources     a source must match the change it rides on (its campaign, its module, its value)
 *   dismiss     mute-ad-recommendations dismisses and restores a rule's suggestion, a decision (its re-proposal when the
 *               tick replaced it) and a proposal; undo is the opposite op
 *   override    a rule's suggestion with a value of its own: the step carries it and its limits judge it
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { seedAdsFixture } from '../../../test-support/ads-fixtures.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
// As db.ts wraps it: inside a transaction, `prisma.x` is that transaction's client.
vi.mock('../../../db.js', async () => {
  const { contextualDatabase } = await import('../../../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_t, p) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), p) }) }
})
vi.mock('../../../lib/queue.js', () => {
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
// On PGlite's single connection the queue row's account lookup cannot run beside the open enqueue transaction.
vi.mock('../../outbound-destination.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveDestinations: async (_db: unknown, rows: unknown[]) => rows.map(() => ({ connectionId: null, reason: 'NO_ACCOUNT' })),
}))
// The engines' feed, as the test sets it (one bid recommendation, for the overlap check).
const feed = vi.hoisted(() => ({ current: [] as Array<Record<string, any>> }))
vi.mock('../../advertising/ads-recommendations.service.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  buildRecommendations: async (opts: { windowDays?: number } = {}) => ({ generatedAt: new Date().toISOString(), windowDays: opts.windowDays ?? 30, counts: {}, potentialMonthlyImpactCents: 0, recommendations: feed.current, mutedCount: 0 }),
}))
// The per-target bid optimizer's answer for a campaign, as the test sets it; every call is kept (the plan's target).
const optimizer = vi.hoisted(() => ({ proposals: {} as Record<string, Array<{ targetId: string; currentBidCents: number; proposedBidCents: number }>>, calls: [] as Array<Record<string, unknown>> }))
vi.mock('../../advertising/ads-bid-optimizer.service.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  previewBidOptimization: async (opts: Record<string, unknown>) => {
    optimizer.calls.push(opts)
    const target = Number(opts.targetAcos ?? opts.fallbackTargetAcos ?? 0.3)
    const proposals = (optimizer.proposals[String(opts.campaignId)] ?? []).map((p) => ({
      ...p, expression: p.targetId, matchType: 'EXACT', deltaCents: p.proposedBidCents - p.currentBidCents, acos: null, spendCents: 0, salesCents: 0, clicks: 0,
      reason: 'test', targetAcosUsed: target, targetBasis: 'flat', targetSource: 'flat', sources: {}, limits: null,
    }))
    return { targetAcos: target, profitMode: false, bayesian: true, proposals, held: [] }
  },
}))

import { commitScheduledApproval, decideFleetApproval } from '../../agent-fleet/approval-inbox.service.js'
import type { McpPrincipal } from '../../mcp/mcp-auth.js'
import { runToolForClaude } from '../../mcp/mcp-tool-call.js'
import { callTool, executeTool, type UserPrincipal } from '../call-tool.js'
import { runPlan } from '../change-plan.service.js'
import { getTool } from '../tool-registry.js'
import { committedToday } from '../../advertising/kt6-proposal.service.js'

const A = LEGACY_WORKSPACE_ID
const TIMEOUT = 60_000
const business = { workspaceId: A, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const db = () => database.client
const EVERYTHING = new Set<string>([...Object.values(F), ...Object.values(FIELDS)])
const ids: Record<string, string> = {}
let nameA = ''

function claude(): McpPrincipal {
  return {
    kind: 'user', userId: ids.person, label: 'Ada Pilot', permissions: { isOwner: false, permissions: EVERYTHING },
    workspace: business, business: { id: A, name: nameA }, via: 'claude', oauthGrantId: 'grant-w49', scopes: ['nexus.read', 'nexus.write', 'nexus.run'],
  } as McpPrincipal
}
const person = (): UserPrincipal => ({ kind: 'user', userId: ids.person, label: 'Ada Pilot', permissions: { isOwner: false, permissions: EVERYTHING }, workspace: business, via: 'app' })
type Answer = Record<string, any>
async function call(tool: string, args: Record<string, unknown>): Promise<{ isError: boolean; answer: Answer }> {
  const result = await inside(() => runToolForClaude(claude(), getTool(tool)!, { ...args, business: nameA }))
  return { isError: !!result.isError, answer: JSON.parse((result.content as Array<{ text: string }>).map((b) => b.text).join('')) }
}
const dry = async (tool: string, args: Record<string, unknown>) => (await inside(() => callTool(person(), tool, args))).raw
const stepsOf = (approvalId: string) => inside(() => db().agentPlanStep.findMany({ where: { approvalId }, orderBy: { position: 'asc' } }))
/** A person approves it on the Approvals page, the window closes, and the sweep's commit runs it (a plan: the runner too). */
async function approveAndRun(approvalId: string) {
  const parked = await inside(() => decideFleetApproval({ id: approvalId, decision: 'approve', actor: person() }))
  expect(parked, parked.error).toMatchObject({ ok: true, status: 'scheduled' })
  await inside(() => db().agentApproval.update({ where: { id: approvalId }, data: { executeAfter: new Date(Date.now() - 1000) } }))
  const committed = await inside(() => commitScheduledApproval(approvalId))
  if (committed.status === 'executing') return inside(() => runPlan(approvalId))
  expect(committed, committed.error).toMatchObject({ ok: true })
  return null
}
const bidOf = async (id: string) => (await inside(() => db().adTarget.findUniqueOrThrow({ where: { id }, select: { bidCents: true } }))).bidCents
const budgetOf = async (id: string) => Number((await inside(() => db().campaign.findUniqueOrThrow({ where: { id }, select: { dailyBudget: true } }))).dailyBudget)
const topOfSearchOf = async (id: string) => {
  const c = await inside(() => db().campaign.findUniqueOrThrow({ where: { id }, select: { dynamicBidding: true } }))
  return ((c.dynamicBidding as { placementBidding?: Array<{ placement: string; percentage: number }> } | null)?.placementBidding ?? []).find((p) => p.placement === 'PLACEMENT_TOP')?.percentage ?? 0
}
const decision = (id: string) => inside(() => db().autopilotDecision.findUnique({ where: { id } }))
const proposal = (id: string) => inside(() => db().keywordBidProposal.findUniqueOrThrow({ where: { id } }))

/** One autopilot decision, as the conductor's SUGGEST branch records it. */
const decide = (planId: string, module: string, campaignId: string, action: string, before: object, after: object, extra: Record<string, unknown> = {}) =>
  inside(async () => (await db().autopilotDecision.create({ data: { planId, cycle: 'fast', module, campaignId, action, before, after, reason: `test ${module} ${action}`, status: 'PROPOSED', source: 'autopilot', ...extra } })).id)
/** One Keyword Tracker proposal, as proposeBidChange records it. */
const propose = (term: string, requestedBidCents: number, targetIds: string[], extra: Record<string, unknown> = {}) =>
  inside(async () => (await db().keywordBidProposal.create({
    data: {
      marketplace: 'IT', term, requestedBidCents, matchedTargets: targetIds.length, matchedCampaigns: 1, actionableTargets: targetIds.length, actionableCampaigns: 1,
      excludedByReason: {}, targetIds, commitmentCents: targetIds.length * requestedBidCents, ceilingVerdict: 'NO_CEILING', ceilingMessage: 'No ceiling applies.',
      confirmationText: `test proposal for ${term}`, status: 'PROPOSED', ...extra,
    },
  })).id)

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  vi.stubEnv('NEXUS_OAUTH_ISSUER', 'https://web.example.test')
  vi.stubEnv('NEXUS_AI_KILL_SWITCH', '')
  vi.stubEnv('ENABLE_QUEUE_WORKERS', '')
  const client = database.client
  const role = await client.role.create({
    data: { key: `W49_${randomUUID().slice(0, 8)}`, name: 'Autopilot tester', description: 'test', isSystem: false, permissions: [...EVERYTHING] },
  })
  const p = await client.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: 'Ada Pilot' } })
  ids.person = p.id
  await client.userRole.create({ data: { userId: p.id, roleId: role.id } })
  const membership = await client.workspaceMembership.create({ data: { workspaceId: A, userId: p.id, status: 'active' } })
  await client.workspaceMemberRole.create({ data: { membershipId: membership.id, roleId: role.id } })
  nameA = (await client.workspace.findUniqueOrThrow({ where: { id: A } })).name
  await inside(async () => {
    await seedAdsFixture(client)
    for (const [id, text, bidCents] of [['t-aa', 'touring jacket', 50], ['t-bb', 'rain jacket', 60]] as const) {
      await client.adTarget.create({ data: { id, adGroupId: 'g-c-it', kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: text, bidCents, externalTargetId: `EXT-${id}` } })
    }
    await client.autopilotPlan.create({ data: { id: 'plan-on', name: 'TEST plan', marketplace: 'IT', campaignIds: ['c-it', 'c-uk', 'c-pin', 'c-off'], goal: 'BALANCED', autonomy: 'SUGGEST', enabled: true } })
    await client.autopilotPlan.create({ data: { id: 'plan-off', name: 'TEST plan off', marketplace: 'IT', campaignIds: ['c-off'], goal: 'BALANCED', autonomy: 'SUGGEST', enabled: false } })
    await client.automationRule.create({ data: { id: 'tst-w49-rule', domain: 'advertising', name: 'TEST rule', trigger: 'SCHEDULE', enabled: true, dryRun: true, autonomyLevel: 'PROPOSE', actions: [], conditions: [] } })
  })
  ids.bid = await decide('plan-on', 'bid', 'c-it', 'BID_RAISE', { cents: 50 }, { cents: 55 })
  ids.budget = await decide('plan-on', 'budget', 'c-it', 'BUDGET_UP', { cents: 2000 }, { cents: 2400 })
  ids.place = await decide('plan-on', 'placement', 'c-uk', 'PLACEMENT', { tosISPct: 10 }, { raiseTosPct: 10 })
  ids.stale = await decide('plan-off', 'budget', 'c-off', 'BUDGET_DOWN', { cents: 2000 }, { cents: 1600 })
  ids.safety = await decide('plan-on', 'safety', 'c-pin', 'SUPPRESS', {}, {})
  ids.kt = await propose('race jacket', 55, ['t-it'])
  // Raised when the term had another target: it resolves to one now.
  ids.ktMoved = await propose('race jacket', 50, ['t-it', 't-gone'])
  optimizer.proposals['c-it'] = [{ targetId: 't-aa', currentBidCents: 50, proposedBidCents: 46 }, { targetId: 't-bb', currentBidCents: 60, proposedBidCents: 66 }]
  feed.current = [{ id: 'bid:t-aa', category: 'bid', severity: 'medium', title: 'Lower bid on “t-aa”', detail: 'test', estImpactCents: 100, impactKind: 'estimate', apply: { kind: 'bid', payload: { changes: [{ targetId: 't-aa', proposedBidCents: 47 }] } } }]
}, 180_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

describe('W4-9 — ad-recommendations reads the autopilot plans\' decisions and the Keyword Tracker\'s proposals', { timeout: TIMEOUT }, () => {
  it('lists each waiting decision and proposal with the tool it is carried out with; a plan that is off is stale', async () => {
    const autopilot = await call('ad-recommendations', { category: 'autopilot' })
    expect(autopilot.isError, JSON.stringify(autopilot.answer)).toBe(false)
    const byId = new Map(autopilot.answer.items.map((i: Answer) => [i.recommendationId, i]))
    expect(byId.get(`autopilot:${ids.budget}`)).toMatchObject({
      from: 'autopilot', category: 'autopilot', module: 'budget', action: 'BUDGET_UP', campaignId: 'c-it', plan: { id: 'plan-on', on: true },
      suggestedTool: 'set-campaign-budget', proposedChange: { before: { cents: 2000 }, after: { cents: 2400 } }, carriedOut: expect.stringContaining('every 15 minutes'),
    })
    expect(byId.get(`autopilot:${ids.bid}`)).toMatchObject({ suggestedTool: 'bulk-ad-bid-change', carriedOut: expect.stringContaining('per-target bid optimizer') })
    expect(byId.get(`autopilot:${ids.place}`)).toMatchObject({ suggestedTool: 'set-placement-multipliers', campaignId: 'c-uk' })
    expect(byId.get(`autopilot:${ids.stale}`)).toMatchObject({ plan: { on: false }, suggestedTool: null, stale: expect.stringContaining('dismiss it') })
    expect(byId.get(`autopilot:${ids.safety}`)).toMatchObject({ suggestedTool: null, noApply: expect.stringContaining('safety module') })
    expect(autopilot.answer.counts).toMatchObject({ autopilot: 5, bid: 0, rule: 0 })

    const tracker = await call('ad-recommendations', { category: 'tracker', campaignId: 'c-it' })
    expect(tracker.answer.items.map((i: Answer) => i.recommendationId).sort()).toEqual([`kt:${ids.kt}`, `kt:${ids.ktMoved}`].sort())
    expect(tracker.answer.items.find((i: Answer) => i.recommendationId === `kt:${ids.kt}`)).toMatchObject({
      from: 'tracker', query: 'race jacket', market: 'IT', proposedBidCents: 55, targets: 1, targetIds: ['t-it'], suggestedTool: 'set-target-bid',
    })
    expect((await call('ad-recommendations', { category: 'tracker', market: 'UK' })).answer.items).toEqual([])
  })
})

describe('W4-9 — apply-ad-recommendations carries a decision or a proposal out, its values frozen', { timeout: TIMEOUT }, () => {
  it('refused as a whole before anything waits, each id with its reason', async () => {
    const before = await inside(() => db().agentApproval.count())
    const { isError, answer } = await call('apply-ad-recommendations', {
      recommendationIds: ['autopilot:nope', `autopilot:${ids.stale}`, `autopilot:${ids.safety}`, `kt:${ids.ktMoved}`, 'kt:nope', `autopilot:${ids.budget}`],
      overrides: [{ id: `autopilot:${ids.budget}`, proposedBudgetCents: 3000 }],
      why: 'test refusals',
    })
    expect(isError).toBe(true)
    expect(answer.error).toMatch(/^Nothing was queued — /)
    expect(answer.error).toContain('autopilot:nope: not found in this business — an autopilot plan replaces its waiting decisions every 15 minutes')
    expect(answer.error).toContain(`autopilot:${ids.stale}: its plan "TEST plan off" is off, so its proposals are stale — dismiss it`)
    expect(answer.error).toContain(`autopilot:${ids.safety}: the safety module has no way to be carried out`)
    expect(answer.error).toContain(`kt:${ids.ktMoved}: it names 2 targets, and "race jacket" in IT now resolves to 1 — bids or the allowlist moved`)
    expect(answer.error).toContain('kt:nope: not found in this business')
    expect(answer.error).toContain(`autopilot:${ids.budget}: this kind of recommendation takes no value of its own`)
    expect(await inside(() => db().agentApproval.count())).toBe(before)
  })

  it('two ids that change the same bid are refused, both named', async () => {
    const { isError, answer } = await call('apply-ad-recommendations', { recommendationIds: ['bid:t-aa', `autopilot:${ids.bid}`], why: 'overlap' })
    expect(isError).toBe(true)
    expect(answer.error).toContain(`bid:t-aa and autopilot:${ids.bid} both change the same target`)
  })

  it('a source must match the change it rides on: campaign, module and value', async () => {
    const autopilot = (id: string) => ({ kind: 'autopilot', id: `autopilot:${id}` })
    const tracker = { kind: 'tracker', id: `kt:${ids.kt}` }
    expect((await dry('set-target-bid', { targetId: 't-it', proposedBidCents: 60, source: tracker })).error)
      .toBe(`Not queued: kt:${ids.kt}: it asks for a bid of 0.55 on its targets, not 0.60.`)
    expect((await dry('set-target-bid', { targetId: 't-aa', proposedBidCents: 55, source: tracker })).error).toContain(`kt:${ids.kt}: it does not name target t-aa`)
    expect((await dry('set-target-bid', { targetId: 't-it', proposedBidCents: 55, source: { kind: 'tracker', id: ids.kt } })).error).toContain('a source of kind tracker names its id as kt:<id>')
    expect((await dry('set-campaign-budget', { campaignId: 'c-it', dailyBudgetCents: 2500, source: autopilot(ids.budget) })).error).toContain('it decides a daily budget of 24.00, not 25.00')
    expect((await dry('set-campaign-budget', { campaignId: 'c-uk', dailyBudgetCents: 2400, source: autopilot(ids.budget) })).error).toContain('it decides campaign c-it, not c-uk')
    expect((await dry('set-placement-multipliers', { campaignId: 'c-uk', topOfSearchPct: 10, source: autopilot(ids.budget) })).error).toContain('a budget decision, but this change sets a placement adjustment')
    expect((await dry('set-placement-multipliers', { campaignId: 'c-uk', topOfSearchPct: 20, source: autopilot(ids.place) })).error).toContain('it moves top of search only, from 0 % to 10 %')
    expect((await dry('set-placement-multipliers', { campaignId: 'c-uk', topOfSearchPct: 10, source: { kind: 'recommendation', id: 'bid:t-uk' } })).error).toContain('no engine recommendation sets placement adjustments')
    expect((await dry('create-negative-keyword', { externalCampaignId: 'EXT-c-it', externalAdGroupId: 'EXT-g-c-it', keywordText: 'free gloves', matchType: 'NEGATIVE_EXACT', source: autopilot(ids.bid) })).error)
      .toContain('an autopilot decision or a Keyword Tracker proposal is carried out with set-target-bid, bulk-ad-bid-change, set-campaign-budget or set-placement-multipliers')
    // The right value on the right change passes, and the preview freezes what it carries out.
    const ok = await dry('set-campaign-budget', { campaignId: 'c-it', dailyBudgetCents: 2400, source: autopilot(ids.budget) })
    expect(ok, ok.error).toMatchObject({ ok: true, preview: { sourceFacts: [{ kind: 'autopilot', id: `autopilot:${ids.budget}`, decision: { planId: 'plan-on', module: 'budget', action: 'BUDGET_UP' } }], sourceNote: expect.stringContaining('marked applied on the A.I. Bids tab') } })
  })

  it('each kind becomes its change tool — never approveDecision — the values frozen in ONE plan through Claude\'s door', async () => {
    optimizer.calls.length = 0
    const { isError, answer } = await call('apply-ad-recommendations', {
      recommendationIds: [`autopilot:${ids.bid}`, `autopilot:${ids.budget}`, `autopilot:${ids.place}`, `kt:${ids.kt}`],
      why: 'test the plans',
    })
    expect(isError, JSON.stringify(answer)).toBe(false)
    expect(answer).toMatchObject({ status: 'waiting_for_approval', approvalId: expect.any(String), plan: { steps: 3 } })
    ids.plan = answer.approvalId
    const approval = await inside(() => db().agentApproval.findUniqueOrThrow({ where: { id: ids.plan } }))
    expect(approval).toMatchObject({ toolName: 'submit-change-plan', status: 'pending', args: { title: 'Apply 4 ad recommendations (3 autopilot, 1 tracker)' } })
    // The optimizer ran once, for the bid decision's campaign, at the plan's goal target as a fallback (the plan stores none).
    expect(optimizer.calls).toEqual([expect.objectContaining({ campaignId: 'c-it', fallbackTargetAcos: expect.any(Number) })])
    expect(optimizer.calls[0]).not.toHaveProperty('targetAcos')

    const [bulk, budget, placement] = await stepsOf(ids.plan) as Array<{ toolName: string; args: Answer; preview: Answer }>
    expect([bulk.toolName, budget.toolName, placement.toolName]).toEqual(['bulk-ad-bid-change', 'set-campaign-budget', 'set-placement-multipliers'])
    expect(bulk.args).toEqual({
      bids: [
        { targetId: 't-aa', bidCents: 46, source: { kind: 'autopilot', id: `autopilot:${ids.bid}` } },
        { targetId: 't-bb', bidCents: 66, source: { kind: 'autopilot', id: `autopilot:${ids.bid}` } },
        { targetId: 't-it', bidCents: 55, source: { kind: 'tracker', id: `kt:${ids.kt}` } },
      ],
      why: 'test the plans',
    })
    expect(bulk.preview).toMatchObject({ totals: { changing: 3 }, sources: { autopilot: 2, tracker: 1 } })
    expect(bulk.preview.sourceFacts.map((f: Answer) => f.id).sort()).toEqual([`autopilot:${ids.bid}`, `kt:${ids.kt}`].sort())
    expect(bulk.preview.sourceNote).toContain('per-target bid optimizer at the plan\'s target')
    expect(budget.args).toEqual({ campaignId: 'c-it', dailyBudgetCents: 2400, why: 'test the plans', source: { kind: 'autopilot', id: `autopilot:${ids.budget}` } })
    expect(budget.preview).toMatchObject({ currentBudgetCents: 2000, proposedBudgetCents: 2400 })
    expect(placement.args).toEqual({ campaignId: 'c-uk', topOfSearchPct: 10, why: 'test the plans', source: { kind: 'autopilot', id: `autopilot:${ids.place}` } })
    expect(placement.preview).toMatchObject({ current: { topOfSearchPct: null }, proposed: { topOfSearchPct: 10 }, source: { id: `autopilot:${ids.place}` } })
    // The plan's card: one change of each kind, all of them reaching Amazon.
    expect((approval.preview as Answer).kinds.map((k: Answer) => [k.tool, k.count])).toEqual([['bulk-ad-bid-change', 1], ['set-campaign-budget', 1], ['set-placement-multipliers', 1]])
    // Nothing changed: it waits for a person, and every row still waits.
    expect([await bidOf('t-aa'), await bidOf('t-it'), await budgetOf('c-it')]).toEqual([50, 45, 20])
    expect((await decision(ids.bid))?.status).toBe('PROPOSED')
    expect((await proposal(ids.kt)).status).toBe('PROPOSED')
  })

  it('a decision or a proposal a waiting request already carries out is not asked for twice', async () => {
    const { isError, answer } = await call('apply-ad-recommendations', { recommendationIds: [`kt:${ids.kt}`, `autopilot:${ids.place}`], why: 'again' })
    expect(isError).toBe(true)
    expect(answer.error).toContain(`kt:${ids.kt}: already asked for — request ${ids.plan} carries it out`)
    expect(answer.error).toContain(`autopilot:${ids.place}: already asked for — request ${ids.plan}`)
  })

  it('once approved it lands the frozen values — even after the plan\'s tick replaced the decision — and settles each row', async () => {
    // The 15-minute tick: the plan's waiting rows are replaced, and the optimizer would now answer differently.
    await inside(() => db().autopilotDecision.delete({ where: { id: ids.bid } }))
    ids.reproposed = await decide('plan-on', 'bid', 'c-it', 'BID_RAISE', { cents: 50 }, { cents: 57 })
    optimizer.proposals['c-it'] = [{ targetId: 't-aa', currentBidCents: 50, proposedBidCents: 40 }]

    const ran = await approveAndRun(ids.plan)
    const steps = await stepsOf(ids.plan)
    expect(ran, JSON.stringify(steps.map((s) => [s.toolName, s.status, s.reason]))).toMatchObject({ finished: true, counts: { done: 3 } })
    // What the person approved is what landed.
    expect([await bidOf('t-aa'), await bidOf('t-bb'), await bidOf('t-it'), await budgetOf('c-it'), await topOfSearchOf('c-uk')]).toEqual([46, 66, 55, 24, 10])

    // Settled: the replaced decision is recreated under its own id, decided, naming the request.
    expect(await decision(ids.bid)).toMatchObject({ status: 'APPLIED', planId: 'plan-on', module: 'bid', campaignId: 'c-it', action: 'BID_RAISE', executionId: ids.plan, after: { targets: 2 } })
    expect((await decision(ids.bid))!.reason).toContain(`carried out by request ${ids.plan}`)
    expect(await decision(ids.budget)).toMatchObject({ status: 'APPLIED', executionId: ids.plan, after: { cents: 2400 } })
    expect(await decision(ids.place)).toMatchObject({ status: 'APPLIED', executionId: ids.plan })
    // The tick's re-proposal is left for the plan's next run to decide afresh.
    expect((await decision(ids.reproposed))?.status).toBe('PROPOSED')
    // The proposal: applied by the approver, under the request, its commitment what was written (1 target × its bid).
    expect(await proposal(ids.kt)).toMatchObject({ status: 'APPLIED', executionId: ids.plan, decidedBy: `user:${ids.person}`, commitmentCents: 55 })
    expect((await inside(() => committedToday('IT'))).committedCents).toBe(55)

    // Provenance: every write carries the request as its change set and what it carried out.
    const logs = await inside(() => db().advertisingActionLog.findMany({ where: { executionId: ids.plan }, select: { entityId: true, actionType: true, evidence: true } }))
    const sourceOf = (entityId: string, type?: string) => (logs.find((l) => l.entityId === entityId && (!type || l.actionType === type))?.evidence as { source?: unknown } | null)?.source
    expect(sourceOf('t-aa')).toEqual({ kind: 'autopilot', id: `autopilot:${ids.bid}` })
    expect(sourceOf('t-it')).toEqual({ kind: 'tracker', id: `kt:${ids.kt}` })
    expect(sourceOf('c-uk', 'update_placement_bidding')).toEqual({ kind: 'autopilot', id: `autopilot:${ids.place}` })

    // Carried out: no longer offered, and asked for again it is refused by its state.
    const listed = (await call('ad-recommendations', { category: 'autopilot' })).answer.items.map((i: Answer) => i.recommendationId)
    expect(listed).toContain(`autopilot:${ids.reproposed}`)
    expect(listed).not.toContain(`autopilot:${ids.budget}`)
    const again = await call('apply-ad-recommendations', { recommendationIds: [`autopilot:${ids.budget}`, `kt:${ids.kt}`], why: 'again' })
    expect(again.answer.error).toContain(`autopilot:${ids.budget}: no longer waiting (it is applied)`)
    expect(again.answer.error).toContain(`kt:${ids.kt}: no longer waiting (it is applied)`)
  })

  it('undo of the bid step puts its bids back, gives the proposal\'s commitment back and says so on the decision', async () => {
    const bulk = (await stepsOf(ids.plan)).find((s) => s.toolName === 'bulk-ad-bid-change')!.changeId!
    const { isError, answer } = await call('undo-change', { changeId: bulk })
    expect(isError, JSON.stringify(answer)).toBe(false)
    await approveAndRun(answer.approvalId)
    expect([await bidOf('t-aa'), await bidOf('t-bb'), await bidOf('t-it')]).toEqual([50, 60, 45])
    // The other steps stand.
    expect([await budgetOf('c-it'), await topOfSearchOf('c-uk')]).toEqual([24, 10])
    expect(await proposal(ids.kt)).toMatchObject({ status: 'APPLIED', commitmentCents: 0 })
    expect((await inside(() => committedToday('IT'))).committedCents).toBe(0)
    expect((await decision(ids.bid))!.reason).toMatch(/put back by an undo$/)
    expect((await decision(ids.budget))!.reason).not.toMatch(/put back by an undo$/)
  })

  it('a decision dismissed after it was asked for is not carried out', async () => {
    ids.later = await decide('plan-on', 'budget', 'c-pin', 'BUDGET_UP', { cents: 2000 }, { cents: 2600 })
    const { isError, answer } = await call('apply-ad-recommendations', { recommendationIds: [`autopilot:${ids.later}`], why: 'later' })
    expect(isError, JSON.stringify(answer)).toBe(false)
    // A person dismisses it on the A.I. Bids tab meanwhile.
    const { dismissDecision } = await import('../../advertising/autopilot/decisions.js')
    expect(await inside(() => dismissDecision(ids.later))).toMatchObject({ ok: true })
    // Approving parks it (a plan's steps are re-checked when they run); the run re-checks the step and skips it.
    const ran = await approveAndRun(answer.approvalId)
    expect(ran).toMatchObject({ finished: true, counts: { skipped: 1 } })
    const [step] = await stepsOf(answer.approvalId)
    expect(step).toMatchObject({ status: 'skipped' })
    expect(step.reason).toContain(`autopilot:${ids.later}: no longer waiting — it was dismissed`)
    expect(await budgetOf('c-pin')).toBe(20)
    expect((await decision(ids.later))?.status).toBe('DISMISSED')
  })
})

describe('W4-9 — mute-ad-recommendations dismisses and restores', { timeout: TIMEOUT }, () => {
  const run = (args: Record<string, unknown>, approvalId: string, approvedPreview: unknown) =>
    inside(() => executeTool(person(), 'mute-ad-recommendations', { days: 30, ...args }, { via: 'claude', approvalId, approvedPreview }))
  const asked = async (args: Record<string, unknown>) => {
    const { isError, answer } = await call('mute-ad-recommendations', { why: 'test', ...args })
    expect(isError, JSON.stringify(answer)).toBe(false)
    return { answer, preview: (await inside(() => db().agentApproval.findUniqueOrThrow({ where: { id: answer.approvalId } }))).preview }
  }

  it('an autopilot decision the tick replaced is dismissed as its re-proposal; undo restores that row', async () => {
    ids.toDismiss = await decide('plan-on', 'budget', 'c-off', 'BUDGET_DOWN', { cents: 2000 }, { cents: 1500 })
    const { answer, preview } = await asked({ recommendationIds: [`autopilot:${ids.toDismiss}`], op: 'dismiss' })
    expect(answer.preview).toMatchObject({ op: 'dismiss', totals: { dismissing: 1 }, items: [{ category: 'autopilot', from: 'waiting', to: 'dismissed', identity: { planId: 'plan-on', module: 'budget', campaignId: 'c-off', action: 'BUDGET_DOWN' } }] })
    expect(answer.preview.summary).toContain('its plan does not propose it again for 7 days')
    // The tick replaces it before a person approves.
    await inside(() => db().autopilotDecision.delete({ where: { id: ids.toDismiss } }))
    const replacement = await decide('plan-on', 'budget', 'c-off', 'BUDGET_DOWN', { cents: 2000 }, { cents: 1450 })
    const out = (await run({ recommendationIds: [`autopilot:${ids.toDismiss}`], op: 'dismiss', why: 'test' }, answer.approvalId, preview)).raw
    expect(out, out.error).toMatchObject({ ok: true, change: { after: { op: 'dismiss', items: [{ id: `autopilot:${replacement}`, state: 'dismissed' }] } } })
    expect((await decision(replacement))?.status).toBe('DISMISSED')

    const tool = getTool('mute-ad-recommendations')!
    expect(await inside(() => tool.undo!.current(out.change!))).toEqual(out.change!.after)
    const back = tool.undo!.request(out.change!) as { tool: string; args: Record<string, unknown> }
    expect(back).toEqual({ tool: 'mute-ad-recommendations', args: { recommendationIds: [`autopilot:${replacement}`], op: 'restore', why: 'undo of an earlier dismiss' } })
    const undoPreview = (await inside(() => callTool(person(), back.tool, back.args))).raw.preview
    expect((await run(back.args, 'ap-undo-w49', undoPreview)).raw).toMatchObject({ ok: true })
    expect((await decision(replacement))?.status).toBe('PROPOSED')
  })

  it('a Keyword Tracker proposal and a rule\'s suggestion: dismissed, then restored', async () => {
    ids.ktDismiss = await propose('winter jacket', 40, ['t-off'])
    ids.suggestion = (await inside(() => db().adsRuleSuggestion.create({
      data: { ruleId: 'tst-w49-rule', ruleName: 'TEST rule', marketplace: 'IT', entityType: 'CAMPAIGN', entityId: 'c-off', entityName: 'TEST campaign', proposedAction: { type: 'budget_apply', op: 'incPct', value: 10 }, proposedKey: 'k-w49-dismiss' },
    }))).id
    const both = [`kt:${ids.ktDismiss}`, `rule:${ids.suggestion}`]
    const dismissed = await asked({ recommendationIds: both, op: 'dismiss' })
    const out = (await run({ recommendationIds: both, op: 'dismiss', why: 'test' }, dismissed.answer.approvalId, dismissed.preview)).raw
    expect(out, out.error).toMatchObject({ ok: true, data: { decided: 2 } })
    expect(await proposal(ids.ktDismiss)).toMatchObject({ status: 'DISMISSED', decidedBy: `user:${ids.person}` })
    expect(await inside(() => db().adsRuleSuggestion.findUniqueOrThrow({ where: { id: ids.suggestion } }))).toMatchObject({ status: 'dismissed', decidedBy: `user:${ids.person}` })

    const restored = await asked({ recommendationIds: both, op: 'restore' })
    expect((await run({ recommendationIds: both, op: 'restore', why: 'test' }, restored.answer.approvalId, restored.preview)).raw).toMatchObject({ ok: true })
    expect((await proposal(ids.ktDismiss)).status).toBe('PROPOSED')
    expect((await inside(() => db().adsRuleSuggestion.findUniqueOrThrow({ where: { id: ids.suggestion } }))).status).toBe('pending')
  })

  it('refused before anything waits: an op that does not fit the id, a row not in the state the op needs', async () => {
    const refusal = async (args: Record<string, unknown>) => (await call('mute-ad-recommendations', { why: 'test', ...args })).answer.error as string
    expect(await refusal({ recommendationIds: [`autopilot:${ids.reproposed}`], op: 'mute' })).toContain('an autopilot decision is dismissed (op dismiss) and restored (op restore), not muted')
    expect(await refusal({ recommendationIds: ['bid:t-aa'], op: 'dismiss' })).toContain('bid:t-aa: an engine\'s recommendation is muted (op mute), not dismissed')
    expect(await refusal({ recommendationIds: [`kt:${ids.ktDismiss}`], op: 'restore' })).toContain('it is proposed — only a dismissed proposal is restored')
    expect(await refusal({ recommendationIds: [`autopilot:${ids.budget}`], op: 'dismiss' })).toContain('it was decided — only a waiting decision is dismissed')
    expect(await refusal({ recommendationIds: ['autopilot:nope'], op: 'dismiss' })).toContain('autopilot:nope: not found in this business')
  })
})

describe('W4-9 — a rule\'s suggestion with a value of its own', { timeout: TIMEOUT }, () => {
  it('the step carries the edited value, and its limits judge it', async () => {
    ids.ruleBid = (await inside(() => db().adsRuleSuggestion.create({
      data: { ruleId: 'tst-w49-rule', ruleName: 'TEST rule', marketplace: 'IT', entityType: 'AD_TARGET', entityId: 't-bb', entityName: 'rain jacket', proposedAction: { type: 'bid_down', percent: 10 }, proposedKey: 'k-w49-bid' },
    }))).id
    const { isError, answer } = await call('apply-ad-recommendations', { recommendationIds: [`rule:${ids.ruleBid}`], overrides: [{ id: `rule:${ids.ruleBid}`, proposedBidCents: 70 }], why: 'my own bid' })
    expect(isError, JSON.stringify(answer)).toBe(false)
    const [step] = await stepsOf(answer.approvalId) as Array<{ toolName: string; args: Answer; preview: Answer }>
    expect(step.args).toEqual({ kind: 'amazon-ads', decisions: [{ suggestionId: ids.ruleBid, decide: 'apply', override: { bidCents: 70 } }] })
    // The rule proposed a cut (60 → 54); the value of its own is a raise to 70, and that is what is judged.
    expect(step.preview.items[0]).toMatchObject({ current: 60, projected: 70, override: { resultBidCents: 70 } })
    expect(step.preview.suggestions.bids).toMatchObject({ raises: 1, largestCutPct: 0 })
    await inside(() => db().agentApproval.update({ where: { id: answer.approvalId }, data: { status: 'rejected' } }))
  })

  it('a value of its own must fit the suggestion', async () => {
    const two = await call('apply-ad-recommendations', { recommendationIds: [`rule:${ids.ruleBid}`], overrides: [{ id: `rule:${ids.ruleBid}`, proposedBidCents: 70, proposedBudgetCents: 900 }], why: 'two' })
    expect(two.answer.error).toContain('a rule\'s suggestion takes one value of its own')
    const wrong = await dry('decide-automation-suggestions', { kind: 'amazon-ads', decisions: [{ suggestionId: ids.suggestion, decide: 'apply', override: { bidCents: 70 } }] })
    expect(wrong.error).toContain('a bid of its own fits a bid suggestion on one target, and this is a budget suggestion')
    const dismiss = await dry('decide-automation-suggestions', { kind: 'amazon-ads', decisions: [{ suggestionId: ids.ruleBid, decide: 'dismiss', override: { bidCents: 70 } }] })
    expect(dismiss.error).toContain('only an apply takes a value of its own')
  })
})
