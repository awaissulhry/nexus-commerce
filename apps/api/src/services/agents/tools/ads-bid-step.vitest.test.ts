/**
 * ADS AUTONOMY W4-4 — the largest bid change per action, and handing a bid back to auto-bid. Through Claude's own door
 * (runToolForClaude → the gate → a person's approval, or the sweep's commit of a run by rule) on PGlite with the
 * production schema and business policies, business profiles ON. The ads write gate is the real one (sandbox unless a
 * test goes live); the job queue is a stub, so nothing leaves the process. Values are made up (public repo).
 *
 *   person     a bid request past the largest change shows the bid asked for, warns on the card (where #401 warns about
 *              a budget past the daily move) and a person's approval sends it as asked — set-target-bid and bulk
 *   by rule    the same request run by the business's rule writes the stepped bid, exactly as before
 *   engines    the mutation layer steps an engine's, a rule's and any write without a person's mark, as before
 *   stale      a largest change moved after the approval: not run; a request stepped before W4-4 reads honestly
 *   own limits by rule, a request whose asked bid passes another of his own limits waits for a person; an asked bid
 *              Amazon's own limits refuse is refused as a whole
 *   plans      a change plan (submit-change-plan, apply-ad-recommendations) carries its steps' warnings on the card,
 *              ad-spend viewers only, and a person's approval sends the bids as asked
 *   afterwards "hold" (default) keeps the bid a person's for 60 days; "auto-bid" hands it back: personBidTargetIds does
 *              not count it, a person's later edit holds it again; never by rule; a stop row is never handed back; a
 *              mark counts only on a request a person decided
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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

// The engines' output for apply-ad-recommendations, as a test sets it.
const feed = vi.hoisted(() => ({ current: [] as Array<Record<string, any>> }))
vi.mock('../../advertising/ads-recommendations.service.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  buildRecommendations: async (opts: { windowDays?: number } = {}) => ({
    generatedAt: new Date().toISOString(), windowDays: opts.windowDays ?? 30, counts: {}, potentialMonthlyImpactCents: 0, recommendations: feed.current, mutedCount: 0,
  }),
}))

import { commitScheduledApproval, decideFleetApproval, previewStaleness } from '../../agent-fleet/approval-inbox.service.js'
import { resolveRequest } from '../../agent-fleet/approval-target.js'
import { __claudeStrategyTest } from '../../advertising/ads-strategy/claude.js'
import { updateAdTargetWithSync } from '../../advertising/ads-mutation.service.js'
import { personBidTargetIds } from '../../advertising/bid-grid.service.js'
import { NO_LIMITS } from '../../advertising/ads-strategy/bids.js'
import type { McpPrincipal } from '../../mcp/mcp-auth.js'
import { runToolForClaude } from '../../mcp/mcp-tool-call.js'
import { decideApproval } from '../approval-gate.service.js'
import { callTool, storedOutputOf, type UserPrincipal } from '../call-tool.js'
import { runPlan } from '../change-plan.service.js'
import { getTool } from '../tool-registry.js'
import { PLAN_TOOL } from '../tool-types.js'
import { afterwardsNote, approvedReachOf, bidStepOf, handBackEvidence, handBackRefusal } from './ads-change-kit.js'

const A = LEGACY_WORKSPACE_ID
const TIMEOUT = 30_000
const business = { workspaceId: A, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const db = () => database.client
const EVERYTHING = new Set<string>([...Object.values(F), ...Object.values(FIELDS)])
const ids = { person: '', approver: '' }
let nameA = ''
const BIDS: Record<string, number> = { 't-it': 45, 't-off': 30, 't-aa': 50, 't-bb': 60, 't-cc': 40 }
const STEP_WORDS = 'more than the largest bid change 20 % (ads strategy: Test market (IT), market)'

function claude(): McpPrincipal {
  return {
    kind: 'user', userId: ids.person, label: 'Sam Step', permissions: { isOwner: false, permissions: EVERYTHING },
    workspace: business, business: { id: A, name: nameA }, via: 'claude', oauthGrantId: 'grant-step', scopes: ['nexus.read', 'nexus.write', 'nexus.run'],
  } as McpPrincipal
}
const approver = (): UserPrincipal => ({
  kind: 'user', userId: ids.approver, label: 'Ada Approver', via: 'app', permissions: { isOwner: false, permissions: EVERYTHING }, workspace: business,
})
type Answer = Record<string, any>
async function call(tool: string, args: Record<string, unknown>): Promise<Answer> {
  const who = claude()
  const result = await inside(() => runToolForClaude(who, getTool(tool)!, { ...args, business: nameA }))
  return JSON.parse((result.content as Array<{ text: string }>).map((b) => b.text).join(''))
}
/** A person approves it in Nexus: it runs now, as him. */
const approve = (approvalId: string) => inside(() => decideApproval(approvalId, 'approve', approver()))
/** The business lets Claude run this tool by its rule (the level a person raises with a code), with these limits. */
const atAuto = (tool: string, claudeLimits?: Record<string, unknown>) =>
  inside(() => db().agentTool.create({ data: { name: tool, riskTier: 'high', requiresApproval: true, claudeTrust: 'auto', ...(claudeLimits ? { claudeLimits } : {}) } }))
/** The undo window closes now: the sweep's commit may take it. */
const windowClosed = (approvalId: string) =>
  inside(() => db().agentApproval.update({ where: { id: approvalId }, data: { executeAfter: new Date(Date.now() - 1000) } }))
const approvalOf = (id: string) => inside(() => db().agentApproval.findUniqueOrThrow({ where: { id } }))
const bidOf = async (id: string) => (await inside(() => db().adTarget.findUniqueOrThrow({ where: { id }, select: { bidCents: true } }))).bidCents
const lastLog = async (entityId: string) => (await inside(() => db().advertisingActionLog.findMany({ where: { entityId }, orderBy: { createdAt: 'desc' }, take: 1 })))[0]
const held = () => inside(() => personBidTargetIds())
/** A person approves it on the Approvals page, the window closes, and the sweep's commit runs it (a plan: the runner too). */
async function approveAndRun(approvalId: string) {
  const parked = await inside(() => decideFleetApproval({ id: approvalId, decision: 'approve', actor: approver() }))
  expect(parked, parked.error).toMatchObject({ ok: true, status: 'scheduled' })
  await inside(() => db().agentApproval.update({ where: { id: approvalId }, data: { executeAfter: new Date(Date.now() - 1000) } }))
  const committed = await inside(() => commitScheduledApproval(approvalId))
  if (committed.status === 'executing') return inside(() => runPlan(approvalId))
  expect(committed, committed.error).toMatchObject({ ok: true })
  return null
}
/** What a viewer who may act but not see ad spend is shown of a stored preview. */
const withoutAdSpend = (toolName: string, preview: unknown) => {
  const permissions = new Set([...EVERYTHING].filter((p) => p !== FIELDS.financialsView && p !== FIELDS.financialsAdspendView))
  return storedOutputOf({ ...approver(), permissions: { isOwner: false, permissions } })(toolName, preview)
}

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  vi.stubEnv('NEXUS_OAUTH_ISSUER', 'https://web.example.test')
  vi.stubEnv('NEXUS_AI_KILL_SWITCH', '')
  const client = database.client
  const role = await client.role.create({
    data: { key: `W44_${randomUUID().slice(0, 8)}`, name: 'Step tester', description: 'test', isSystem: false, permissions: [...EVERYTHING] },
  })
  for (const key of ['person', 'approver'] as const) {
    const user = await client.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: key === 'person' ? 'Sam Step' : 'Ada Approver' } })
    ids[key] = user.id
    await client.userRole.create({ data: { userId: user.id, roleId: role.id } })
    const membership = await client.workspaceMembership.create({ data: { workspaceId: A, userId: user.id, status: 'active' } })
    await client.workspaceMemberRole.create({ data: { membershipId: membership.id, roleId: role.id } })
  }
  nameA = (await client.workspace.findUniqueOrThrow({ where: { id: A } })).name
  await inside(async () => {
    await seedAdsFixture(client)
    // Three more keywords in c-it's ad group, for a bulk change and for the hand-back.
    for (const [id, text] of [['t-aa', 'touring jacket'], ['t-bb', 'rain jacket'], ['t-cc', 'mesh jacket']] as const) {
      await client.adTarget.create({ data: { id, adGroupId: 'g-c-it', kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: text, bidCents: BIDS[id], externalTargetId: `EXT-${id}` } })
    }
  })
}, 180_000)

beforeEach(async () => {
  vi.unstubAllEnvs()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  vi.stubEnv('NEXUS_OAUTH_ISSUER', 'https://web.example.test')
  vi.stubEnv('NEXUS_AI_KILL_SWITCH', '')
  __claudeStrategyTest.reset()
  await inside(async () => {
    await db().adsStrategy.deleteMany({})
    await db().agentTool.deleteMany({})
    await db().agentAutonomy.deleteMany({})
    await db().agentApproval.updateMany({ where: { status: { in: ['pending', 'scheduled'] } }, data: { status: 'rejected', decisionVia: null } })
    await db().agentApproval.updateMany({ where: { decisionVia: 'auto' }, data: { decidedAt: new Date(Date.now() - 48 * 3600_000) } })
    for (const [id, bidCents] of Object.entries(BIDS)) await db().adTarget.update({ where: { id }, data: { bidCents } })
    // IT: the largest bid change per action 20 %; the band 0.10–2.00; Claude may change bids alone, inside its limits.
    await db().adsStrategy.create({
      data: {
        market: 'IT', level: 'MARKET', label: 'Test market (IT)', minBidCents: 10, maxBidCents: 200, maxChangePct: 20, claudeAutonomy: { bid: 'auto' },
        claudeMaxChangesPerDay: 10, claudeMaxRaisesPerDay: 5, version: 1, updatedBy: 'user:test',
      },
    })
  })
})
afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

describe('W4-4 — the kit: what a person\'s approval sends, what a run by rule writes', () => {
  const strategy = (pct: number) => ({ ...NO_LIMITS, maxChangePct: { value: pct, source: { level: 'market', scopeId: '*', label: 'Test market (IT)', version: 1, strategyId: 's1' } as never } })

  it('inside the largest change nothing is stepped and nothing warned; past it, the asked bid and the stepped one, with whose limit', () => {
    expect(bidStepOf({ currentCents: 45, wantedCents: 50, dynamicBidding: null, strategy: strategy(20), label: '"race jacket"', currency: 'EUR' }))
      .toMatchObject({ personCents: 50, ruleCents: 50, past: null })
    expect(bidStepOf({ currentCents: 5, wantedCents: 30, dynamicBidding: null, strategy: strategy(25), label: '"race jacket"', currency: 'EUR' })).toMatchObject({
      personCents: 30, ruleCents: 6,
      // No strategy version in the words: a save that keeps the number does not make a waiting request stale.
      past: { limit: 'bid_step', reason: '"race jacket" moves 500 % (EUR 0.05 → EUR 0.30), more than the largest bid change 25 % (ads strategy: Test market (IT), market); run by the business\'s rule instead it moves only to EUR 0.06' },
    })
    // The campaign's own guardrail, when it is the lower one.
    expect(bidStepOf({ currentCents: 45, wantedCents: 200, dynamicBidding: { maxBidChangePct: 10 }, strategy: strategy(20), label: '"race jacket"', currency: 'EUR' }).past?.reason)
      .toBe('"race jacket" moves 344.44 % (EUR 0.45 → EUR 2.00), more than the largest bid change 10 % (the campaign\'s own max-change guardrail); run by the business\'s rule instead it moves only to EUR 0.50')
    // A step that ends on the band's edge anyway writes the bid asked for: nothing to warn about.
    const band = { ...strategy(30), maxBidCents: { value: 50, source: { level: 'market', label: 'Test market (IT)', version: 1 } as never } }
    expect(bidStepOf({ currentCents: 80, wantedCents: 50, dynamicBidding: null, strategy: band, label: '"x"', currency: 'EUR' })).toMatchObject({ personCents: 50, ruleCents: 50, past: null })
  })

  it('the approved reach keeps the warning in sandbox too; afterwards words; the hand-back mark only when asked', () => {
    expect(approvedReachOf({ reach: { reach: 'sandbox', pastOwnLimits: [{ limit: 'bid_step', reason: 'r' }] } })).toEqual({ reach: 'sandbox', pastOwnLimits: [{ limit: 'bid_step', reason: 'r' }] })
    expect(approvedReachOf({ reach: { reach: 'sandbox' } })).toEqual({ reach: 'sandbox' })
    expect(afterwardsNote('hold')).toBe('Afterwards auto-bid leaves this bid alone for 60 days: a bid an approved request writes counts as a person\'s. Ask with afterwards "auto-bid" to hand it back to auto-bid instead.')
    expect(afterwardsNote('auto-bid', true)).toMatch(/^Afterwards these bids are handed back to auto-bid: it may move them from its next run/)
    expect(handBackEvidence(null, 'hold')).toBeNull()
    expect(handBackEvidence({ source: { kind: 'recommendation', id: 'bid:t1' } }, 'auto-bid')).toEqual({ source: { kind: 'recommendation', id: 'bid:t1' }, handBack: 'auto-bid' })
    // A hand-back never runs by rule; a preview that does not say is a person's too.
    expect(handBackRefusal({ afterwards: 'hold' })).toBeNull()
    expect(handBackRefusal({ afterwards: 'auto-bid' })).toMatch(/never by rule; a person decides$/)
    expect(handBackRefusal({})).toMatch(/does not say what auto-bid does with the bid afterwards; a person decides$/)
  })
})

describe('W4-4 — set-target-bid past the largest change', { timeout: TIMEOUT }, () => {
  it('a person: the preview shows the bid asked for and the stepped one, the card warns, approving sends it as asked', async () => {
    const asked = await call('set-target-bid', { targetId: 't-it', proposedBidCents: 90, why: 'test: a larger raise' })
    expect(asked).toMatchObject({ status: 'waiting_for_approval' })
    const { preview } = await approvalOf(asked.approvalId)
    const warning = `"race jacket" moves 100 % (EUR 0.45 → EUR 0.90), ${STEP_WORDS}; run by the business's rule instead it moves only to EUR 0.54`
    expect(preview).toMatchObject({
      currentBidCents: 45, proposedBidCents: 90, deltaCents: 45, byRuleBidCents: 54, byRuleSteppedBy: 'the largest bid change 20 % (ads strategy: Test market (IT), market, v1)',
      reach: { reach: 'sandbox', pastOwnLimits: [{ limit: 'bid_step', reason: warning }] },
      reachNote: expect.stringContaining(`Warning — this goes past your own limits: ${warning}. Approving it sends it anyway.`),
      effect: 'Moves "race jacket" from EUR 0.45 to EUR 0.90 in Italy exact; run by the business\'s rule instead, only to EUR 0.54 (the largest bid change 20 % (ads strategy: Test market (IT), market, v1)).',
      afterwards: 'hold', effectiveBidCents: 90,
    })
    // The approval card: the warning first (as for a budget past the daily move), the bid asked for and what a rule writes.
    const card = resolveRequest('set-target-bid', { targetId: 't-it' }, preview, { masterCurrency: 'EUR' } as never)
    expect(card.summary).toMatch(/^Warning — this goes past your own limits: "race jacket" moves 100 %.*Approving it sends it anyway\. Moves "race jacket"/)
    expect(card.changes).toEqual([expect.objectContaining({ label: 'Bid', from: expect.stringContaining('0.45'), to: expect.stringMatching(/0\.90 \(by rule: .*0\.54\)$/) })])

    expect(await approve(asked.approvalId)).toMatchObject({ ok: true, status: 'executed', result: expect.objectContaining({ bidCents: 90, afterwards: 'hold' }) })
    expect(await bidOf('t-it')).toBe(90)
    expect(await lastLog('t-it')).toMatchObject({
      userId: `user:${ids.approver}`, executionId: asked.approvalId,
      evidence: { strategyWarning: expect.stringMatching(/more than the largest bid change 20 % \(ads strategy: Test market \(IT\), market, v1\); sent, because a person made or approved it$/) },
    })
  })

  it('live: the warning sits beside the gate\'s answer on the card; approving sends the bid asked for to the queue', async () => {
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
    const asked = await call('set-target-bid', { targetId: 't-it', proposedBidCents: 20 })
    const { preview } = await approvalOf(asked.approvalId)
    expect(preview).toMatchObject({ byRuleBidCents: 36, reach: { reach: 'live', profileId: 'P-IT-TEST', pastOwnLimits: [{ limit: 'bid_step', reason: expect.stringContaining('moves 55.56 % (EUR 0.45 → EUR 0.20)') }] } })
    expect(await approve(asked.approvalId)).toMatchObject({ ok: true, status: 'executed' })
    expect(await bidOf('t-it')).toBe(20)
    const [history] = await inside(() => db().campaignBidHistory.findMany({ where: { entityId: 't-it' }, orderBy: { changedAt: 'desc' }, take: 1 }))
    expect(history).toMatchObject({ oldValue: '45', newValue: '20', changedBy: `user:${ids.approver}` })
  })

  it('by rule: the same cut writes the stepped bid, as before — its limits judged on that bid', async () => {
    await atAuto('set-target-bid')
    const asked = await call('set-target-bid', { targetId: 't-it', proposedBidCents: 20, why: 'test: a deep cut' })
    expect(asked).toMatchObject({ status: 'runs_by_rule' })
    expect((await approvalOf(asked.approvalId)).preview).toMatchObject({
      proposedBidCents: 20, byRuleBidCents: 36, ruleGate: null,
      limitFacts: { this: { items: 1, cuts: 1, raises: 0, largestCutPct: 20, rowsOutsideStrategy: 0 } },
    })
    await windowClosed(asked.approvalId)
    expect(await inside(() => commitScheduledApproval(asked.approvalId))).toMatchObject({ ok: true, status: 'executed' })
    expect(await bidOf('t-it')).toBe(36)
    const [history] = await inside(() => db().campaignBidHistory.findMany({ where: { entityId: 't-it' }, orderBy: { changedAt: 'desc' }, take: 1 }))
    expect(history).toMatchObject({ reason: `Claude request ${asked.approvalId} (run by rule): test: a deep cut`, oldValue: '45', newValue: '36' })
  })

  it('a largest change that moved after the request was made: not run, nothing written', async () => {
    const asked = await call('set-target-bid', { targetId: 't-it', proposedBidCents: 90 })
    await inside(() => db().adsStrategy.updateMany({ data: { maxChangePct: 10, version: 2 } }))
    expect(await approve(asked.approvalId)).toMatchObject({ ok: false })
    expect(await bidOf('t-it')).toBe(45)
  })

  it('a save of the strategy that keeps the largest change does not make a waiting request stale', async () => {
    const asked = await call('set-target-bid', { targetId: 't-it', proposedBidCents: 90 })
    await inside(() => db().adsStrategy.updateMany({ data: { goalNote: 'test: a note', version: 2 } }))
    expect(await approve(asked.approvalId)).toMatchObject({ ok: true, status: 'executed' })
    expect(await bidOf('t-it')).toBe(90)
  })

  it('a request stepped before W4-4 is stale, and says so in plain amounts (never "undefined")', async () => {
    const before = { action: 'set-target-bid', currentBidCents: 45, proposedBidCents: 90, effectiveBidCents: 54, clampedBy: 'the largest bid change', deltaCents: 9, reach: { reach: 'sandbox' } }
    const verdict = await inside(() => previewStaleness('set-target-bid', { targetId: 't-it', proposedBidCents: 90 }, before, 'ap-before-w44'))
    expect(verdict).toMatchObject({ stale: true, why: expect.stringContaining('effectiveBidCents changed from €0.54 to €0.90') })
    expect(verdict.why).not.toContain('undefined')
  })
})

describe('W4-4 — his other own limits, and Amazon\'s (live)', { timeout: TIMEOUT }, () => {
  it('by rule: a request whose asked bid passes another of his own limits waits for a person, though its stepped bid would not', async () => {
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
    await atAuto('set-target-bid')
    await inside(() => db().campaign.update({ where: { id: 'c-it' }, data: { minBidCents: 25 } }))
    try {
      const asked = await call('set-target-bid', { targetId: 't-it', proposedBidCents: 20 })
      expect(asked).toMatchObject({ status: 'waiting_for_approval', trust: { level: 'auto', why: expect.stringMatching(/^campaign "Italy exact": Amazon's write gate refuses it as a run by rule/) } })
      // The card warns about both; a person's approval would send 20.
      expect((await approvalOf(asked.approvalId)).preview).toMatchObject({
        byRuleBidCents: 36,
        reach: { reach: 'live', pastOwnLimits: expect.arrayContaining([expect.objectContaining({ limit: 'entity_bounds' }), expect.objectContaining({ limit: 'bid_step' })]) },
      })
      // Inside his bounds, the same cut runs by rule (stepped).
      expect(await call('set-target-bid', { targetId: 't-it', proposedBidCents: 30 })).toMatchObject({ status: 'runs_by_rule' })
    } finally {
      await inside(() => db().campaign.update({ where: { id: 'c-it' }, data: { minBidCents: null } }))
    }
  })

  it('an asked bid Amazon\'s own limits refuse is refused as a whole — not queued as a stepped one', async () => {
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
    const before = await inside(() => db().agentApproval.count())
    const refused = (await inside(() => callTool(approver(), 'set-target-bid', { targetId: 't-it', proposedBidCents: 150_000 }))).raw
    expect(refused).toEqual({ ok: false, error: expect.stringMatching(/^Not queued: Amazon's write gate refuses it — /) })
    const asked = await call('set-target-bid', { targetId: 't-it', proposedBidCents: 150_000 })
    expect(asked).not.toHaveProperty('approvalId')
    expect(await inside(() => db().agentApproval.count())).toBe(before)
  })
})

describe('W4-4 — bulk-ad-bid-change past the largest change', { timeout: TIMEOUT }, () => {
  it('a person: each line shows the bid asked for and, past the step, the stepped one; one warning on the card; approving sends them as asked', async () => {
    const asked = await call('bulk-ad-bid-change', { bids: [{ targetId: 't-it', bidCents: 90 }, { targetId: 't-aa', bidCents: 55 }], why: 'test: two raises' })
    expect(asked).toMatchObject({ status: 'waiting_for_approval' })
    const { preview } = await approvalOf(asked.approvalId) as { preview: Answer }
    expect(preview.changes).toEqual([
      expect.objectContaining({ targetId: 't-aa', fromCents: 50, toCents: 55 }),
      expect.objectContaining({ targetId: 't-it', fromCents: 45, toCents: 90, byRuleCents: 54 }),
    ])
    expect(preview.changes[0]).not.toHaveProperty('byRuleCents')
    expect(preview).toMatchObject({
      reach: { reach: 'sandbox', pastOwnLimits: [{ limit: 'bid_step', reason: `1 bid moves more than the largest bid change per action — "race jacket" moves 100 % (EUR 0.45 → EUR 0.90), ${STEP_WORDS}; run by the business's rule instead it moves only to EUR 0.54` }] },
      stepNote: expect.stringMatching(/^1 of these bid moves more than the largest bid change per action: a person's approval sends it as asked/),
      byCurrency: { EUR: { targets: 2, deltaCents: 50 } },
      afterwards: 'hold', afterwardsNote: expect.stringContaining('leaves these bids alone for 60 days'),
    })
    const card = resolveRequest('bulk-ad-bid-change', {}, preview, { masterCurrency: 'EUR' } as never)
    expect(card.summary).toMatch(/^Warning — this goes past your own limits: 1 bid moves more than the largest bid change per action/)
    expect(card.changes.map((c) => c.to)).toEqual([expect.not.stringContaining('by rule'), expect.stringMatching(/0\.90 \(by rule: .*0\.54\)$/)])
    expect(await approve(asked.approvalId)).toMatchObject({ ok: true, status: 'executed', result: expect.objectContaining({ applied: 2, failed: 0 }) })
    expect([await bidOf('t-it'), await bidOf('t-aa')]).toEqual([90, 55])
  })

  it('by rule: the same rows write the stepped bids, as before', async () => {
    await atAuto('bulk-ad-bid-change')
    const asked = await call('bulk-ad-bid-change', { bids: [{ targetId: 't-it', bidCents: 20 }, { targetId: 't-aa', bidCents: 45 }], why: 'test: two cuts' })
    expect(asked).toMatchObject({ status: 'runs_by_rule' })
    expect((await approvalOf(asked.approvalId)).preview).toMatchObject({ ruleGate: null, limitFacts: { this: { items: 2, cuts: 2, largestCutPct: 20, rowsOutsideStrategy: 0 } } })
    await windowClosed(asked.approvalId)
    expect(await inside(() => commitScheduledApproval(asked.approvalId))).toMatchObject({ ok: true, status: 'executed' })
    expect([await bidOf('t-it'), await bidOf('t-aa')]).toEqual([36, 45])
  })
})

describe('W4-4 — the engines are stepped as before', { timeout: TIMEOUT }, () => {
  it('an engine, a rule\'s write and any write without a person\'s mark are stepped; a person\'s own edit is not', async () => {
    const write = (actor: string, manual?: boolean) => inside(() => updateAdTargetWithSync({ adTargetId: 't-cc', patch: { bidCents: 80 }, actor, reason: 'test', ...(manual ? { manual } : {}) }))
    const reset = () => inside(() => db().adTarget.update({ where: { id: 't-cc' }, data: { bidCents: 40 } }))
    for (const actor of ['automation:auto-bid', 'automation:rule-test', 'automation:rank-defend-test', `user:${ids.approver}`]) {
      expect(await write(actor)).toMatchObject({ ok: true })
      expect(await bidOf('t-cc')).toBe(48)
      await reset()
    }
    expect(await write(`user:${ids.approver}`, true)).toMatchObject({ ok: true, warnings: [expect.stringContaining('more than the largest bid change 20 %')] })
    expect(await bidOf('t-cc')).toBe(80)
  })
})

describe('W4-4 — afterwards: hold the bid, or hand it back to auto-bid', { timeout: TIMEOUT }, () => {
  it('hold (default) keeps it a person\'s bid; auto-bid hands it back, and the preview says which', async () => {
    const hold = await call('set-target-bid', { targetId: 't-bb', proposedBidCents: 62 })
    expect((await approvalOf(hold.approvalId)).preview).toMatchObject({ afterwards: 'hold', afterwardsNote: expect.stringContaining('auto-bid leaves this bid alone for 60 days') })
    await approve(hold.approvalId)
    expect((await held()).has('t-bb')).toBe(true)

    const back = await call('set-target-bid', { targetId: 't-bb', proposedBidCents: 60, afterwards: 'auto-bid', why: 'test: reset, back to auto-bid' })
    expect((await approvalOf(back.approvalId)).preview).toMatchObject({ afterwards: 'auto-bid', afterwardsNote: expect.stringMatching(/^Afterwards this bid is handed back to auto-bid: it may move it from its next run/) })
    expect(await approve(back.approvalId)).toMatchObject({ ok: true, status: 'executed', result: expect.objectContaining({ afterwards: 'auto-bid' }) })
    expect(await lastLog('t-bb')).toMatchObject({ executionId: back.approvalId, evidence: { handBack: 'auto-bid' } })
    // The hand-back is the newest write a person approved: the earlier hold no longer counts.
    expect((await held()).has('t-bb')).toBe(false)
  })

  it('bulk: auto-bid hands every row back', async () => {
    const asked = await call('bulk-ad-bid-change', { bids: [{ targetId: 't-aa', bidCents: 52 }], afterwards: 'auto-bid' })
    expect((await approvalOf(asked.approvalId)).preview).toMatchObject({ afterwards: 'auto-bid' })
    await approve(asked.approvalId)
    expect(await lastLog('t-aa')).toMatchObject({ evidence: { handBack: 'auto-bid' } })
    expect((await held()).has('t-aa')).toBe(false)
  })

  it('a hand-back never runs by rule: it waits for a person whatever the level; the same change held runs by rule', async () => {
    await atAuto('set-target-bid')
    await atAuto('bulk-ad-bid-change')
    const never = /^it hands the bid back to auto-bid \(afterwards "auto-bid"\), which may release a bid a person set: never by rule; a person /
    expect(await call('set-target-bid', { targetId: 't-it', proposedBidCents: 40, afterwards: 'auto-bid' })).toMatchObject({ status: 'waiting_for_approval', trust: { level: 'auto', why: expect.stringMatching(never) } })
    expect(await call('bulk-ad-bid-change', { bids: [{ targetId: 't-it', bidCents: 40 }], afterwards: 'auto-bid' })).toMatchObject({ status: 'waiting_for_approval', trust: { level: 'auto', why: expect.stringMatching(never) } })
    expect(await call('set-target-bid', { targetId: 't-it', proposedBidCents: 40, afterwards: 'hold' })).toMatchObject({ status: 'runs_by_rule' })
  })

  it('a stop row is never handed back: the preview says so, and it stays a person\'s bid while the bid row is handed back', async () => {
    await inside(() => db().adsStrategy.updateMany({ data: { stopMethod: 'LOW_BIDS', stopBidCents: 15 } }))
    const asked = await call('bulk-ad-bid-change', { bids: [{ targetId: 't-cc', stop: true }, { targetId: 't-bb', bidCents: 58 }], afterwards: 'auto-bid' })
    expect((await approvalOf(asked.approvalId)).preview).toMatchObject({
      afterwards: 'auto-bid',
      afterwardsNote: expect.stringMatching(/^Afterwards this bid is handed back to auto-bid: .* The 1 stop row is not handed back \(auto-bid could raise it\): it stays held as a person's bid for 60 days\.$/),
    })
    expect(await approve(asked.approvalId)).toMatchObject({ ok: true, status: 'executed' })
    expect([await bidOf('t-cc'), await bidOf('t-bb')]).toEqual([15, 58])
    expect((await lastLog('t-cc')).evidence).toBeNull()
    expect(await lastLog('t-bb')).toMatchObject({ evidence: { handBack: 'auto-bid' } })
    const now = await held()
    expect([now.has('t-cc'), now.has('t-bb')]).toEqual([true, false])
  })

  it('the newest write decides; the mark counts only on a request a person decided; engines are no one\'s', async () => {
    const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000)
    const log = (entityId: string, userId: string, minutesAgo: number, extra: Record<string, unknown> = {}) => inside(() => db().advertisingActionLog.create({
      data: { userId, actionType: 'AD_BID_UPDATE', entityType: 'AD_TARGET', entityId, payloadBefore: { bidCents: 40 }, payloadAfter: { bidCents: 41 }, createdAt: at(minutesAgo), ...extra },
    }))
    const request = (decisionVia: string | null, decided = true) => inside(async () => {
      const run = await db().agentRun.create({ data: { agentKey: 'mcp', trigger: 'manual', status: 'done', via: 'claude', userId: ids.person } })
      return (await db().agentApproval.create({
        data: { agentRunId: run.id, toolName: 'set-target-bid', riskTier: 'high', args: {}, preview: {}, status: decided ? 'executed' : 'pending', decisionVia, ...(decided ? { decidedAt: new Date() } : {}) },
      })).id
    })
    const [byPerson, byCode, byRule, undecided] = [await request('nexus'), await request('claude-confirm'), await request('auto'), await request(null, false)]
    const mark = (executionId: string | null) => ({ ...(executionId ? { executionId } : {}), evidence: { handBack: 'auto-bid' } })
    // A hand-back, then a person's own edit: held again.
    await log('k-later', `user:${ids.approver}`, 30, mark(byPerson))
    await log('k-later', `user:${ids.approver}`, 10)
    // A person's edit, then a hand-back a person approved (in Nexus, or with his code in Claude): released.
    await log('k-back', `user:${ids.approver}`, 30)
    await log('k-back', `user:${ids.approver}`, 10, mark(byPerson))
    await log('k-code', `user:${ids.approver}`, 30)
    await log('k-code', `user:${ids.approver}`, 10, mark(byCode))
    // The mark on a write the business's rule ran, on an undecided request, or with no request at all: still held.
    await log('k-rule', `user:${ids.approver}`, 30)
    await log('k-rule', `user:${ids.approver}`, 10, mark(byRule))
    await log('k-undecided', `user:${ids.approver}`, 10, mark(undecided))
    await log('k-forged', `user:${ids.approver}`, 10, mark(null))
    // An engine's write is no one's hold, marked or not.
    await log('k-engine', 'automation:auto-bid', 10, mark(byPerson))
    const now = await held()
    expect(['k-later', 'k-back', 'k-code', 'k-rule', 'k-undecided', 'k-forged', 'k-engine'].map((id) => now.has(id))).toEqual([true, false, false, true, true, true, false])
  })
})

describe('W4-4 — a change plan warns on its card too, and a person\'s approval sends the bids as asked', { timeout: 60_000 }, () => {
  it('submit-change-plan: the steps\' warnings on the plan, named by step, ad-spend viewers only', async () => {
    const asked = await call(PLAN_TOOL, { title: 'Test bids', steps: [
      { tool: 'set-target-bid', args: { targetId: 't-bb', proposedBidCents: 62 } },
      { tool: 'set-target-bid', args: { targetId: 't-it', proposedBidCents: 90 } },
    ] })
    expect(asked).toMatchObject({ status: 'waiting_for_approval', approvalId: expect.any(String) })
    const { preview } = await approvalOf(asked.approvalId)
    expect(preview).toMatchObject({ pastOwnLimits: [{ limit: 'bid_step', step: 2, reason: `step 2: "race jacket" moves 100 % (EUR 0.45 → EUR 0.90), ${STEP_WORDS}; run by the business's rule instead it moves only to EUR 0.54` }] })
    const card = resolveRequest(PLAN_TOOL, { title: 'Test bids', steps: 2 }, preview, { masterCurrency: 'EUR' } as never)
    expect(card.summary).toMatch(/^Warning — this goes past your own limits: step 2: "race jacket" moves 100 %.*Approving it sends it anyway\. Test bids — /)
    // A viewer who may not see ad spend sees the plan without the amounts.
    const hidden = withoutAdSpend(PLAN_TOOL, preview) as Answer
    expect(hidden).not.toHaveProperty('pastOwnLimits')
    expect(resolveRequest(PLAN_TOOL, {}, hidden, { masterCurrency: 'EUR' } as never).summary).not.toMatch(/^Warning/)
    await approveAndRun(asked.approvalId)
    expect([await bidOf('t-bb'), await bidOf('t-it')]).toEqual([62, 90])
  })

  it('apply-ad-recommendations: its one bulk step\'s warning is on the plan; a person\'s approval sends the bids as asked', async () => {
    const bid = (targetId: string, proposedBidCents: number) => ({ severity: 'medium', detail: 'test', estImpactCents: 100, impactKind: 'estimate', id: `bid:${targetId}`, category: 'bid', title: `Bid on ${targetId}`, apply: { kind: 'bid', payload: { changes: [{ targetId, proposedBidCents }] } } })
    feed.current = [bid('t-it', 90), bid('t-aa', 55)]
    const asked = await call('apply-ad-recommendations', { recommendationIds: ['bid:t-it', 'bid:t-aa'], why: 'test: the engines' })
    expect(asked).toMatchObject({ status: 'waiting_for_approval', approvalId: expect.any(String) })
    const { preview } = await approvalOf(asked.approvalId)
    expect(preview).toMatchObject({ pastOwnLimits: [{ limit: 'bid_step', step: 1, reason: expect.stringMatching(/^step 1: 1 bid moves more than the largest bid change per action — "race jacket" moves 100 %/) }] })
    expect(resolveRequest(PLAN_TOOL, {}, preview, { masterCurrency: 'EUR' } as never).summary).toMatch(/^Warning — this goes past your own limits: step 1: 1 bid moves/)
    await approveAndRun(asked.approvalId)
    expect([await bidOf('t-it'), await bidOf('t-aa')]).toEqual([90, 55])
    feed.current = []
  })
})
