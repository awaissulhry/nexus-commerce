/**
 * ADS AUTONOMY W3-1 — the engines' recommendations carried out by id, their provenance, and mute. Through Claude's own
 * door (runToolForClaude → the gate → one change plan → the Approvals page's approve → the plan runner) on PGlite with
 * the production schema and business policies, business profiles ON. The write gate and the change tools are real
 * (sandbox: nothing leaves the process); the job queue is a stub; the feed's engines are a stand-in whose output the
 * test sets (the feed's own mute filter is the real one). Values are made up (public repo).
 *
 *   mapping     each kind of id becomes its change tool with the engine's value frozen into the step: every bid id in
 *               ONE bulk-ad-bid-change (set-target-bid for one), negatives, graduations, budgets, retail stops
 *               (suppress-campaign: never a pause) and the rules' suggestions in ONE decide-automation-suggestions;
 *               each step names its recommendation (source) in its arguments and its preview
 *   override    a value of the caller's own is the value that lands, and the one the step's limits judge
 *   refusals    refused as a whole, each id with its reason, before anything waits: no longer recommended, share of
 *               voice, an autopilot id, an unknown id, a rule's suggestion already decided, a wrong override; a
 *               duplicate of a waiting request; a source that names another change
 *   settle      once the plan ran: the source is on each write's ads audit row, and each recommendation is settled —
 *               not offered again until the data the engines read is a day past the change
 *   mute        Nexus only, by id; undo is the opposite op; within its limits by rule
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
// On PGlite's single connection the queue row's account lookup cannot run beside the open enqueue transaction; an ads
// row names no listing account anyway (the ads worker resolves its Amazon Ads profile).
vi.mock('../../outbound-destination.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveDestinations: async (_db: unknown, rows: unknown[]) => rows.map(() => ({ connectionId: null, reason: 'NO_ACCOUNT' })),
}))
// The engines' output, as the test sets it; what hides a recommendation is the real reader (mutes and settles).
const feed = vi.hoisted(() => ({ current: [] as Array<Record<string, any>> }))
vi.mock('../../advertising/ads-recommendations.service.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  buildRecommendations: async (opts: { windowDays?: number; includeMuted?: boolean } = {}) => {
    const { recommendationMuteKeys } = await import('../../advertising/ads-recommendation-mutes.service.js')
    const { hidden, muted } = await recommendationMuteKeys()
    const key = (r: { id: string }) => `RECOMMENDATION|${r.id}`
    const recommendations = feed.current.filter((r) => (opts.includeMuted ? muted.has(key(r)) : !hidden.has(key(r))))
    return { generatedAt: new Date().toISOString(), windowDays: opts.windowDays ?? 30, counts: {}, potentialMonthlyImpactCents: 0, recommendations, mutedCount: muted.size }
  },
}))

import { commitScheduledApproval, decideFleetApproval } from '../../agent-fleet/approval-inbox.service.js'
import { familyOfRecommendationId, hidesNow, recommendationMuteKeys, recommendationMuteStates, settledDataFrom } from '../../advertising/ads-recommendation-mutes.service.js'
import type { McpPrincipal } from '../../mcp/mcp-auth.js'
import { runToolForClaude } from '../../mcp/mcp-tool-call.js'
import { callTool, executeTool, type UserPrincipal } from '../call-tool.js'
import { runPlan } from '../change-plan.service.js'
import { getTool } from '../tool-registry.js'
import { planRecommendations } from './ads-recommendations-apply.tools.js'

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
    kind: 'user', userId: ids.person, label: 'Rea Recs', permissions: { isOwner: false, permissions: EVERYTHING },
    workspace: business, business: { id: A, name: nameA }, via: 'claude', oauthGrantId: 'grant-recs', scopes: ['nexus.read', 'nexus.write', 'nexus.run'],
  } as McpPrincipal
}
const person = (): UserPrincipal => ({ kind: 'user', userId: ids.person, label: 'Rea Recs', permissions: { isOwner: false, permissions: EVERYTHING }, workspace: business, via: 'app' })
type Answer = Record<string, any>
async function call(tool: string, args: Record<string, unknown>): Promise<{ isError: boolean; answer: Answer }> {
  const who = claude()
  const result = await inside(() => runToolForClaude(who, getTool(tool)!, { ...args, business: nameA }))
  return { isError: !!result.isError, answer: JSON.parse((result.content as Array<{ text: string }>).map((b) => b.text).join('')) }
}
const stepsOf = (approvalId: string) => inside(() => db().agentPlanStep.findMany({ where: { approvalId }, orderBy: { position: 'asc' } }))
const bidOf = async (id: string) => (await inside(() => db().adTarget.findUniqueOrThrow({ where: { id }, select: { bidCents: true } }))).bidCents

// The engines' recommendations, in the feed's own shapes (ads-recommendations.service.ts).
const base = { severity: 'medium', detail: 'test detail', estImpactCents: 100, impactKind: 'estimate' }
const term = (query: string, extra: Record<string, number>) => ({ query, externalCampaignId: 'EXT-c-it', externalAdGroupId: 'EXT-g-c-it', impressions: 300, market: 'IT', ...extra })
const rec = {
  bid: (targetId: string, proposedBidCents: number) => ({ ...base, id: `bid:${targetId}`, category: 'bid', title: `Lower bid on “${targetId}” (EXACT)`, apply: { kind: 'bid', payload: { changes: [{ targetId, proposedBidCents }] } } }),
  budget: (campaignId: string, proposedBudgetCents: number) => ({ ...base, id: `budget:${campaignId}`, category: 'budget', title: `Raise budget for ${campaignId}`, apply: { kind: 'budget', payload: { changes: [{ campaignId, proposedBudgetCents }] } } }),
  negative: (query: string) => ({ ...base, id: `neg:EXT-g-c-it:${query}`, category: 'negative', title: `Negate wasteful search term “${query}”`, apply: { kind: 'harvest-negative', payload: { negatives: [term(query, { clicks: 12, costCents: 900, orders: 0, salesCents: 0 })] } } }),
  graduate: (query: string) => ({ ...base, id: `grad:EXT-g-c-it:${query}`, category: 'graduate', title: `Graduate converting term “${query}” to exact`, apply: { kind: 'harvest-graduate', payload: { graduations: [term(query, { clicks: 20, costCents: 1300, orders: 4, salesCents: 12000 })] } } }),
  retail: (campaignId: string) => ({ ...base, id: `retail:${campaignId}`, category: 'retail', severity: 'high', title: `Pause ${campaignId} — unsellable`, apply: { kind: 'retail-pause', payload: { campaignIds: [campaignId] } } }),
  sov: (query: string) => ({ ...base, id: `sov:outbid:${query}`, category: 'sov', title: `Likely outbid on “${query}”`, apply: null }),
}

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  vi.stubEnv('NEXUS_OAUTH_ISSUER', 'https://web.example.test')
  vi.stubEnv('NEXUS_AI_KILL_SWITCH', '')
  vi.stubEnv('ENABLE_QUEUE_WORKERS', '')
  const client = database.client
  const role = await client.role.create({
    data: { key: `W31_${randomUUID().slice(0, 8)}`, name: 'Recommendations tester', description: 'test', isSystem: false, permissions: [...EVERYTHING] },
  })
  const p = await client.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: 'Rea Recs' } })
  ids.person = p.id
  await client.userRole.create({ data: { userId: p.id, roleId: role.id } })
  const membership = await client.workspaceMembership.create({ data: { workspaceId: A, userId: p.id, status: 'active' } })
  await client.workspaceMemberRole.create({ data: { membershipId: membership.id, roleId: role.id } })
  nameA = (await client.workspace.findUniqueOrThrow({ where: { id: A } })).name
  const { ACTION_HANDLERS } = await import('../../automation-rule.service.js')
  ACTION_HANDLERS.tst_rec_ok = (async (action: { type: string }) => ({ type: action.type, ok: true, output: { applied: 'test' } })) as never
  await inside(async () => {
    await seedAdsFixture(client)
    for (const [id, text, bidCents] of [['t-aa', 'touring jacket', 50], ['t-bb', 'rain jacket', 60]] as const) {
      await client.adTarget.create({ data: { id, adGroupId: 'g-c-it', kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: text, bidCents, externalTargetId: `EXT-${id}` } })
    }
    await client.automationRule.create({ data: { id: 'tst-rec-rule', domain: 'advertising', name: 'TEST rule', trigger: 'SCHEDULE', enabled: true, dryRun: true, autonomyLevel: 'PROPOSE', actions: [], conditions: [] } })
    const suggestion = (key: string, entityId: string, status = 'pending') => client.adsRuleSuggestion.create({
      data: { ruleId: 'tst-rec-rule', ruleName: 'TEST rule', marketplace: 'IT', entityType: 'CAMPAIGN', entityId, entityName: `TEST ${key}`, proposedAction: { type: 'tst_rec_ok' }, proposedKey: key, status },
    })
    ids.suggestion = (await suggestion('k-rec', 'c-off')).id
    ids.decided = (await suggestion('k-rec-done', 'c-off', 'applied')).id
    // On the campaign whose budget the engine recommends changing.
    ids.sameCampaign = (await suggestion('k-rec-same', 'c-it')).id
  })
  feed.current = [
    rec.bid('t-it', 40), rec.bid('t-aa', 45), rec.bid('t-bb', 54), rec.budget('c-it', 2500), rec.negative('cheap gloves'),
    rec.graduate('race jacket xl'), rec.retail('c-uk'), rec.sov('helmet'),
  ]
}, 180_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

describe('W3-1 — apply-ad-recommendations', { timeout: TIMEOUT }, () => {
  it('each kind becomes its change tool, the value frozen in the step; bids in ONE step; one plan through Claude\'s door', async () => {
    const { isError, answer } = await call('apply-ad-recommendations', {
      recommendationIds: ['bid:t-it', 'bid:t-aa', 'neg:EXT-g-c-it:cheap gloves', 'budget:c-it', 'retail:c-uk', `rule:${ids.suggestion}`],
      why: 'test the engines',
    })
    expect(isError, JSON.stringify(answer)).toBe(false)
    expect(answer).toMatchObject({ status: 'waiting_for_approval', approvalId: expect.any(String), plan: { steps: 5 } })
    ids.plan = answer.approvalId
    const approval = await inside(() => db().agentApproval.findUniqueOrThrow({ where: { id: ids.plan } }))
    expect(approval).toMatchObject({ toolName: 'submit-change-plan', status: 'pending', args: { title: 'Apply 6 ad recommendations (2 bid, 1 negative, 1 budget, 1 retail, 1 rule)' } })
    const steps = await stepsOf(ids.plan)
    expect(steps.map((s) => s.toolName)).toEqual(['bulk-ad-bid-change', 'create-negative-keyword', 'set-campaign-budget', 'suppress-campaign', 'decide-automation-suggestions'])
    const [bulk, negative, budget, stop, rule] = steps as Array<{ args: Answer; preview: Answer }>
    expect(bulk.args).toEqual({
      bids: [
        { targetId: 't-it', bidCents: 40, source: { kind: 'recommendation', id: 'bid:t-it' } },
        { targetId: 't-aa', bidCents: 45, source: { kind: 'recommendation', id: 'bid:t-aa' } },
      ],
      why: 'test the engines',
    })
    expect(bulk.preview).toMatchObject({ totals: { changing: 2 }, sources: { recommendations: 2 }, sourceNote: expect.stringContaining('bid optimizer') })
    expect(bulk.preview.changes).toEqual(expect.arrayContaining([expect.objectContaining({ targetId: 't-it', fromCents: 45, toCents: 40, source: 'bid:t-it' })]))
    expect(negative.args).toMatchObject({ externalCampaignId: 'EXT-c-it', externalAdGroupId: 'EXT-g-c-it', keywordText: 'cheap gloves', matchType: 'NEGATIVE_EXACT', source: { id: 'neg:EXT-g-c-it:cheap gloves' } })
    expect(budget.args).toMatchObject({ campaignId: 'c-it', dailyBudgetCents: 2500, source: { id: 'budget:c-it' } })
    expect(budget.preview).toMatchObject({ currentBudgetCents: 2000, proposedBudgetCents: 2500, source: { kind: 'recommendation', id: 'budget:c-it' }, sourceNote: expect.stringContaining('budget pacing') })
    // A stock problem lowers bids (the stop bid), never a pause.
    expect(stop.args).toMatchObject({ campaignId: 'c-uk', source: { id: 'retail:c-uk' } })
    expect(stop.preview).toMatchObject({ action: 'suppress-campaign', source: { id: 'retail:c-uk' } })
    expect(rule.args).toEqual({ kind: 'amazon-ads', decisions: [{ suggestionId: ids.suggestion, decide: 'apply' }] })
    // Nothing changed: it waits for a person.
    expect(await bidOf('t-it')).toBe(45)
  })

  it('a graduation starts at the term\'s cost per click, frozen; an override is the value that lands and the one judged', async () => {
    const planned = await inside(() => planRecommendations({ recommendationIds: ['grad:EXT-g-c-it:race jacket xl'], days: 30, why: 'test graduation' }))
    expect(planned).toMatchObject({ ok: true, steps: [{ tool: 'graduate-keyword', args: { query: 'race jacket xl', sourceExternalCampaignId: 'EXT-c-it', sourceExternalAdGroupId: 'EXT-g-c-it', bidCents: 65, source: { id: 'grad:EXT-g-c-it:race jacket xl' } } }] })
    const { isError, answer } = await call('apply-ad-recommendations', { recommendationIds: ['bid:t-bb'], overrides: [{ id: 'bid:t-bb', proposedBidCents: 50 }], why: 'a bid of my own' })
    expect(isError, JSON.stringify(answer)).toBe(false)
    const [step] = await stepsOf(answer.approvalId) as Array<{ toolName: string; args: Answer; preview: Answer }>
    expect(step.toolName).toBe('set-target-bid')
    expect(step.args).toEqual({ targetId: 't-bb', proposedBidCents: 50, why: 'a bid of my own', source: { kind: 'recommendation', id: 'bid:t-bb' } })
    expect(step.preview).toMatchObject({ currentBidCents: 60, proposedBidCents: 50, source: { id: 'bid:t-bb' } })
    // The limits judge the value that lands: the kit counted this one bid, 60 → 50.
    expect(step.preview.limitFacts.this).toMatchObject({ items: 1, cuts: 1, raises: 0 })
    await inside(() => db().agentApproval.update({ where: { id: answer.approvalId }, data: { status: 'rejected' } }))
  })

  it('refused as a whole before anything waits, each id with its reason', async () => {
    const before = await inside(() => db().agentApproval.count())
    const { isError, answer } = await call('apply-ad-recommendations', {
      recommendationIds: ['bid:t-gone', 'bid:t-low', 'sov:outbid:helmet', 'autopilot:d1', 'nonsense', `rule:${ids.decided}`, 'bid:t-bb'],
      overrides: [{ id: 'bid:t-bb', proposedBudgetCents: 900 }],
      why: 'test refusals',
    })
    expect(isError).toBe(true)
    expect(answer.error).toMatch(/^Nothing was queued — /)
    expect(answer.error).toContain('bid:t-gone: its target is not found in this business')
    expect(answer.error).toContain('bid:t-low: no longer recommended — the data moved')
    expect(answer.error).toContain('sov:outbid:helmet: share of voice is information, not a change')
    expect(answer.error).toContain('autopilot:d1: an autopilot decision or a keyword-tracker proposal is not carried out from here yet')
    expect(answer.error).toContain('nonsense: not a recommendation id Nexus gives')
    expect(answer.error).toContain(`rule:${ids.decided}: no longer waiting (it is applied)`)
    expect(answer.error).toContain('bid:t-bb: it takes proposedBidCents, not proposedBudgetCents')
    expect(await inside(() => db().agentApproval.count())).toBe(before)
  })

  it('a rule\'s suggestion for the campaign an engine\'s recommendation also changes: refused, both named', async () => {
    const { isError, answer } = await call('apply-ad-recommendations', { recommendationIds: ['budget:c-it', `rule:${ids.sameCampaign}`], why: 'overlap' })
    expect(isError).toBe(true)
    expect(answer.error).toContain(`rule:${ids.sameCampaign} and budget:c-it both change the same campaign: carry out one of them`)
  })

  it('a recommendation a waiting request already carries out is not asked for twice', async () => {
    const { isError, answer } = await call('apply-ad-recommendations', { recommendationIds: ['bid:t-it', `rule:${ids.suggestion}`], why: 'again' })
    expect(isError).toBe(true)
    expect(answer.error).toContain(`bid:t-it: already asked for — request ${ids.plan} carries it out`)
    expect(answer.error).toContain(`rule:${ids.suggestion}: already asked for — request ${ids.plan}`)
  })

  it('a source must name the change it rides on; only an engine\'s recommendation is taken', async () => {
    const dry = async (tool: string, args: Record<string, unknown>) => (await inside(() => callTool(person(), tool, args))).raw
    expect(await dry('set-target-bid', { targetId: 't-bb', proposedBidCents: 50, source: { kind: 'recommendation', id: 'bid:t-aa' } }))
      .toMatchObject({ ok: false, error: 'Not queued: the source names recommendation bid:t-aa, but this change carries out bid:t-bb.' })
    expect((await dry('set-campaign-budget', { campaignId: 'c-it', dailyBudgetCents: 2100, source: { kind: 'rule', id: 'rule:x' } })).error)
      .toMatch(/a rule's suggestion is applied with decide-automation-suggestions/)
    expect((await dry('bulk-ad-bid-change', { bids: [{ targetId: 't-bb', bidCents: 50, source: { kind: 'recommendation', id: 'bid:t-it' } }] })).error)
      .toMatch(/^Not queued: target t-bb: the source names recommendation bid:t-it/)
  })

  it('once run: the source is on each write\'s audit row, and each recommendation is settled until the data moves', async () => {
    const parked = await inside(() => decideFleetApproval({ id: ids.plan, decision: 'approve', actor: person() }))
    expect(parked, parked.error).toMatchObject({ ok: true, status: 'scheduled' })
    await inside(() => db().agentApproval.update({ where: { id: ids.plan }, data: { executeAfter: new Date(Date.now() - 1000) } }))
    expect(await inside(() => commitScheduledApproval(ids.plan))).toMatchObject({ ok: true, status: 'executing' })
    const ran = await inside(() => runPlan(ids.plan))
    const steps = await stepsOf(ids.plan)
    expect(ran, JSON.stringify(steps.map((s) => [s.toolName, s.status, s.reason]))).toMatchObject({ finished: true, counts: { done: 5 } })
    expect(await bidOf('t-it')).toBe(40)

    // Provenance: every write carries the approval as its change set and the recommendation it carried out.
    const logs = await inside(() => db().advertisingActionLog.findMany({ where: { executionId: ids.plan }, select: { entityType: true, entityId: true, evidence: true } }))
    const sourceOf = (entityId: string) => (logs.find((l) => l.entityId === entityId)?.evidence as { source?: unknown } | null)?.source
    expect(sourceOf('t-it')).toEqual({ kind: 'recommendation', id: 'bid:t-it' })
    expect(sourceOf('c-it')).toEqual({ kind: 'recommendation', id: 'budget:c-it' })
    expect(sourceOf('t-uk')).toEqual({ kind: 'recommendation', id: 'retail:c-uk' })
    // The rule's suggestion is settled by its own apply.
    expect(await inside(() => db().adsRuleSuggestion.findUniqueOrThrow({ where: { id: ids.suggestion } }))).toMatchObject({ status: 'applied' })

    // Settled: not offered again — said so if asked for again.
    const carried = ['bid:t-it', 'bid:t-aa', 'neg:EXT-g-c-it:cheap gloves', 'budget:c-it', 'retail:c-uk']
    expect((await inside(() => recommendationMuteStates(carried))).map((s) => [s.id, s.state, s.by])).toEqual(carried.map((id) => [id, 'settled', `request:${ids.plan}`]))
    const read = await call('ad-recommendations', { category: 'bid' })
    expect(read.answer.items.map((i: Answer) => i.recommendationId)).toEqual(['bid:t-bb'])
    const again = await call('apply-ad-recommendations', { recommendationIds: ['bid:t-it'], why: 'again' })
    expect(again.answer.error).toContain(`bid:t-it: request ${ids.plan} already carried it out; it is offered again once the data is a day past that change`)

    // Once the newest day the engines read is a whole day past the change, the engine may recommend it again.
    await inside(() => db().adsSuggestionMute.updateMany({ where: { entityId: 'bid:t-it' }, data: { createdAt: new Date(settledDataFrom().getTime() - 1) } }))
    const keys = await inside(() => recommendationMuteKeys())
    expect(keys.hidden.has('RECOMMENDATION|bid:t-it')).toBe(false)
    expect(keys.hidden.has('RECOMMENDATION|bid:t-aa')).toBe(true)
    // A settle is not a mute: the Muted view does not list what was carried out.
    expect(keys.muted.has('RECOMMENDATION|bid:t-aa')).toBe(false)
  })
})

describe('W3-1 — mute-ad-recommendations', { timeout: TIMEOUT }, () => {
  const run = (args: Record<string, unknown>, approvalId: string, approvedPreview: unknown) =>
    inside(() => executeTool(person(), 'mute-ad-recommendations', args, { via: 'claude', approvalId, approvedPreview }))

  it('mutes by id in Nexus only; the feed stops offering it; undo unmutes it', async () => {
    const args = { recommendationIds: ['bid:t-bb'], op: 'mute', why: 'not now' }
    const { isError, answer } = await call('mute-ad-recommendations', args)
    expect(isError, JSON.stringify(answer)).toBe(false)
    expect(answer.preview).toMatchObject({ op: 'mute', changes: { 'Lower bid on “t-bb” (EXACT) (bid:t-bb)': { from: 'shown', to: 'muted' } }, totals: { muting: 1 } })
    const stored = await inside(() => db().agentApproval.findUniqueOrThrow({ where: { id: answer.approvalId } }))
    const out = (await run({ ...args, days: 30 }, answer.approvalId, stored.preview)).raw
    expect(out, out.error).toMatchObject({ ok: true, change: { after: { op: 'mute', items: [{ id: 'bid:t-bb', state: 'muted' }] } } })
    const offered = async () => (await call('ad-recommendations', { category: 'bid' })).answer.items.map((i: Answer) => i.recommendationId)
    expect(await offered()).not.toContain('bid:t-bb')
    const row = await inside(() => db().adsSuggestionMute.findFirstOrThrow({ where: { entityId: 'bid:t-bb' } }))
    expect(row).toMatchObject({ scope: 'recommendations', entityType: 'RECOMMENDATION', createdBy: `user:${ids.person}`, entityName: 'Lower bid on “t-bb” (EXACT)' })
    expect(row.reason).toContain(answer.approvalId)

    const tool = getTool('mute-ad-recommendations')!
    expect(await inside(() => tool.undo!.current(out.change!))).toEqual(out.change!.after)
    const back = tool.undo!.request(out.change!) as { tool: string; args: Record<string, unknown> }
    expect(back).toEqual({ tool: 'mute-ad-recommendations', args: { recommendationIds: ['bid:t-bb'], op: 'unmute', why: 'undo of an earlier mute' } })
    const undoPreview = (await inside(() => callTool(person(), back.tool, back.args))).raw.preview
    expect((await run({ ...back.args, days: 30 }, 'ap-undo-test', undoPreview)).raw).toMatchObject({ ok: true })
    expect(await offered()).toContain('bid:t-bb')
  })

  it('refused before anything waits: a rule\'s suggestion, an id not recommended now, one not muted; by rule within its limits', async () => {
    const refusal = async (args: Record<string, unknown>) => (await call('mute-ad-recommendations', { why: 'test', ...args })).answer.error as string
    expect(await refusal({ recommendationIds: [`rule:${ids.suggestion}`], op: 'mute' })).toContain('dismissed with decide-automation-suggestions')
    expect(await refusal({ recommendationIds: ['bid:t-gone'], op: 'mute' })).toContain('bid:t-gone: its target is not found in this business')
    expect(await refusal({ recommendationIds: ['budget:c-sb'], op: 'mute' })).toContain('budget:c-sb: not recommended now — there is nothing to mute')
    expect(await refusal({ recommendationIds: ['bid:t-bb'], op: 'unmute' })).toContain('bid:t-bb: it is not muted')
    const tool = getTool('mute-ad-recommendations')!
    const defaults = tool.limits!.parse({}) as Record<string, unknown>
    const items = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `bid:t${i}` }))
    expect(tool.withinLimits!({ action: 'mute-ad-recommendations', op: 'mute', items: items(1) }, defaults)).toBeNull()
    expect(tool.withinLimits!({ action: 'mute-ad-recommendations', op: 'mute', items: items(26) }, defaults)).toMatch(/more than the 25/)
    expect(tool.withinLimits!({ summary: 'no preview' }, defaults)).toMatch(/no preview/)
  })
})

describe('W3-1 — what hides a recommendation (pure)', () => {
  it('reads each kind of id by its prefix', () => {
    expect(['bid:t1', 'neg:g:q', 'grad:g:q:x', 'budget:c', 'sov:outbid:q', 'retail:c', 'rule:s', 'autopilot:d', 'kt:p', 'bid:', 'x:y', 'plain']
      .map(familyOfRecommendationId)).toEqual(['bid', 'negative', 'graduate', 'budget', 'sov', 'retail', 'rule', 'autopilot', 'tracker', null, null, null])
  })

  it('a mute hides until unmuted; a settle until the newest day the engines read is a whole day past it', () => {
    const now = new Date('2026-10-20T12:00:00Z')
    // Sponsored Products settle over 7 days: the newest day read on the 20th is the 13th.
    expect(settledDataFrom(now).toISOString()).toBe('2026-10-13T00:00:00.000Z')
    expect(hidesNow({ createdBy: 'user:u1', createdAt: new Date('2026-01-01T00:00:00Z') }, now)).toBe(true)
    expect(hidesNow({ createdBy: 'request:ap1', createdAt: new Date('2026-10-13T00:00:00Z') }, now)).toBe(true)
    expect(hidesNow({ createdBy: 'request:ap1', createdAt: new Date('2026-10-12T23:59:59Z') }, now)).toBe(false)
  })
})
