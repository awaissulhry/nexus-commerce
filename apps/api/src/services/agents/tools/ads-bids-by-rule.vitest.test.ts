/**
 * ADS AUTONOMY AA-W2-6 — set-target-bid and bulk-ad-bid-change may run by the business's rule, only inside their Claude
 * limits and the ads strategy where each bid lands. Through Claude's own door (runToolForClaude → the gate → the sweep's
 * commit) on PGlite with the production schema and business policies, business profiles ON. The ads write gate is the
 * real one (sandbox unless a test goes live); the job queue is a stub, so nothing leaves the process. Values are made up
 * (public repo).
 *
 *   inside      a cut inside the strategy runs by rule: the preview carries the limit facts (each limit with its row),
 *               the note and the gate's answer as a run by rule; the write names the approval as its change set and
 *               says the rule decided it; the change can be put back
 *   defaults    a raise waits for a person until the business sets a raise step; with one, it runs by rule
 *   strategy    a market without a strategy, and a bulk row outside its ad group's bid band, wait for a person
 *   gate        live, a campaign off the live-write allowlist (or pinned) is fine for a person's approval, but never
 *               runs by rule: the gate would refuse the machine's write
 *   bulk        every row is checked (not only the lines shown); the request is ONE run of the business's daily cap, and
 *               its rows count against the strategy's daily limit of changes per market
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

import { commitScheduledApproval } from '../../agent-fleet/approval-inbox.service.js'
import { __claudeStrategyTest } from '../../advertising/ads-strategy/claude.js'
import type { McpPrincipal } from '../../mcp/mcp-auth.js'
import { runToolForClaude } from '../../mcp/mcp-tool-call.js'
import { undoRequestFor } from '../change-record.service.js'
import { autoRunsInLastDay } from '../claude-trust.service.js'
import { getTool } from '../tool-registry.js'
import { ruleRunLedger } from './ads-autonomy-kit.js'

const A = LEGACY_WORKSPACE_ID
const TIMEOUT = 30_000
const business = { workspaceId: A, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const db = () => database.client
const EVERYTHING = new Set<string>([...Object.values(F), ...Object.values(FIELDS)])
const ids = { person: '', p1: '', p2: '' }
let nameA = ''
const BIDS: Record<string, number> = { 't-it': 45, 't-off': 30, 't-pin': 40, 't-uk': 60, 't-aa': 50, 't-bb': 60 }

function claude(): McpPrincipal {
  return {
    kind: 'user', userId: ids.person, label: 'Bea Bids', permissions: { isOwner: false, permissions: EVERYTHING },
    workspace: business, business: { id: A, name: nameA }, via: 'claude', oauthGrantId: 'grant-bids', scopes: ['nexus.read', 'nexus.write', 'nexus.run'],
  } as McpPrincipal
}
type Answer = Record<string, any>
async function call(tool: string, args: Record<string, unknown>): Promise<Answer> {
  const who = claude()
  const result = await inside(() => runToolForClaude(who, getTool(tool)!, { ...args, business: nameA }))
  return JSON.parse((result.content as Array<{ text: string }>).map((b) => b.text).join(''))
}
/** The business lets Claude run this tool by its rule (the level a person raises with a code), with these limits. */
const atAuto = (tool: string, claudeLimits?: Record<string, unknown>) =>
  inside(() => db().agentTool.create({ data: { name: tool, riskTier: 'high', requiresApproval: true, claudeTrust: 'auto', ...(claudeLimits ? { claudeLimits } : {}) } }))
/** The undo window closes now: the sweep's commit may take it. */
const windowClosed = (approvalId: string) =>
  inside(() => db().agentApproval.update({ where: { id: approvalId }, data: { executeAfter: new Date(Date.now() - 1000) } }))
const approvalOf = (id: string) => inside(() => db().agentApproval.findUniqueOrThrow({ where: { id } }))
const bidOf = async (id: string) => (await inside(() => db().adTarget.findUniqueOrThrow({ where: { id }, select: { bidCents: true } }))).bidCents

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  vi.stubEnv('NEXUS_OAUTH_ISSUER', 'https://web.example.test')
  vi.stubEnv('NEXUS_AI_KILL_SWITCH', '')
  const client = database.client
  const role = await client.role.create({
    data: { key: `W26_${randomUUID().slice(0, 8)}`, name: 'Bids tester', description: 'test', isSystem: false, permissions: [...EVERYTHING] },
  })
  const person = await client.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: 'Bea Bids' } })
  ids.person = person.id
  await client.userRole.create({ data: { userId: person.id, roleId: role.id } })
  const membership = await client.workspaceMembership.create({ data: { workspaceId: A, userId: person.id, status: 'active' } })
  await client.workspaceMemberRole.create({ data: { membershipId: membership.id, roleId: role.id } })
  nameA = (await client.workspace.findUniqueOrThrow({ where: { id: A } })).name
  await inside(async () => {
    await seedAdsFixture(client)
    // Two more keywords in c-it's ad group, for a bulk change.
    for (const [id, text] of [['t-aa', 'touring jacket'], ['t-bb', 'rain jacket']] as const) {
      await client.adTarget.create({ data: { id, adGroupId: 'g-c-it', kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: text, bidCents: BIDS[id], externalTargetId: `EXT-${id}` } })
    }
    ids.p1 = (await client.product.create({ data: { sku: 'TEST-W26-P1', name: 'Test helmet', basePrice: '10.00' } })).id
    ids.p2 = (await client.product.create({ data: { sku: 'TEST-W26-P2', name: 'Test gloves', basePrice: '10.00' } })).id
    await client.adProductAd.create({ data: { adGroupId: 'g-c-it', productId: ids.p1, asin: 'B0TESTW261' } })
    await client.adProductAd.create({ data: { adGroupId: 'g-c-off', productId: ids.p2, asin: 'B0TESTW262' } })
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
    // What ran by rule in an earlier test leaves today's window (the daily limits and the per-entity limit).
    await db().agentApproval.updateMany({ where: { decisionVia: 'auto' }, data: { decidedAt: new Date(Date.now() - 48 * 3600_000) } })
    for (const [id, bidCents] of Object.entries(BIDS)) await db().adTarget.update({ where: { id }, data: { bidCents } })
    // IT: Claude may change bids alone; the band 0.20–1.00; at most 10 changes and 5 raises by rule a day.
    await db().adsStrategy.create({
      data: {
        market: 'IT', level: 'MARKET', label: 'Test market (IT)', minBidCents: 20, maxBidCents: 100, claudeAutonomy: { bid: 'auto' },
        claudeMaxChangesPerDay: 10, claudeMaxRaisesPerDay: 5, version: 1, updatedBy: 'user:test',
      },
    })
  })
})
afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

describe('AA-W2-6 — set-target-bid runs by rule inside the strategy', { timeout: TIMEOUT }, () => {
  it('a cut inside runs by rule: the facts are in the preview, the write names its change set and says the rule decided it', async () => {
    await atAuto('set-target-bid')
    const asked = await call('set-target-bid', { targetId: 't-it', proposedBidCents: 40, why: 'a test cut' })
    expect(asked).toMatchObject({ status: 'runs_by_rule' })
    const stored = await approvalOf(asked.approvalId)
    expect(stored.preview).toMatchObject({
      currentBidCents: 45, proposedBidCents: 40, reach: { reach: 'sandbox' }, ruleGate: null,
      limitFacts: {
        tool: 'set-target-bid', action: 'bid', markets: { IT: { strategy: { version: expect.any(String) }, maxChangesPerDay: 10 } },
        this: { markets: ['IT'], items: 1, writes: 1, raises: 0, cuts: 1, largestCutPct: 11.11, rowsOutsideStrategy: 0, entities: ['target:t-it'] },
      },
      limitsNote: expect.arrayContaining([expect.stringContaining('Test market (IT)'), expect.stringMatching(/^Items: 1 \(at most 1, Claude's limits for this tool\)/)]),
    })

    await windowClosed(asked.approvalId)
    expect(await inside(() => commitScheduledApproval(asked.approvalId))).toMatchObject({ ok: true, status: 'executed' })
    expect(await bidOf('t-it')).toBe(40)
    const [history] = await inside(() => db().campaignBidHistory.findMany({ where: { entityId: 't-it' }, orderBy: { changedAt: 'desc' }, take: 1 }))
    expect(history).toMatchObject({ changedBy: `user:${ids.person}`, reason: `Claude request ${asked.approvalId} (run by rule): a test cut`, oldValue: '45', newValue: '40' })
    const [log] = await inside(() => db().advertisingActionLog.findMany({ where: { entityId: 't-it' }, orderBy: { createdAt: 'desc' }, take: 1 }))
    expect(log).toMatchObject({ executionId: asked.approvalId, actionType: 'AD_BID_UPDATE' })
    // It counts as one run by rule today, and as a change of t-it.
    expect(await inside(() => ruleRunLedger())).toMatchObject({ runs: 1, byMarket: { IT: { changes: 1, raises: 0 } }, byEntity: { 'target:t-it': 1 } })
    // Undo asks set-target-bid for the old bid (a raise: it is judged as one).
    expect(await inside(() => undoRequestFor({ approvalId: asked.approvalId }))).toMatchObject({ request: { tool: 'set-target-bid', args: { targetId: 't-it', proposedBidCents: 45 } } })
  })

  it('a raise waits for a person by default; with a raise step set, it runs by rule', async () => {
    await atAuto('set-target-bid')
    const raise = await call('set-target-bid', { targetId: 't-it', proposedBidCents: 50 })
    expect(raise).toMatchObject({ status: 'waiting_for_approval', trust: { level: 'auto', why: expect.stringMatching(/its largest raise is 11\.11 %, more than the 0 % this tool's limits let run without a person/) } })
    await inside(() => db().agentTool.updateMany({ where: { name: 'set-target-bid' }, data: { claudeLimits: { maxRaisePct: 15 } } }))
    expect(await call('set-target-bid', { targetId: 't-it', proposedBidCents: 50 })).toMatchObject({ status: 'runs_by_rule' })
  })

  it('a market without a strategy waits for a person, and so does a cut the step brings outside the band', async () => {
    await atAuto('set-target-bid')
    expect(await call('set-target-bid', { targetId: 't-uk', proposedBidCents: 55 })).toMatchObject({
      status: 'waiting_for_approval', trust: { why: expect.stringContaining('there is no ads strategy for UK') },
    })
    expect(await call('set-target-bid', { targetId: 't-off', proposedBidCents: 15 })).toMatchObject({
      status: 'waiting_for_approval', trust: { why: expect.stringMatching(/1 of 1 item is outside the ads strategy — target "winter jacket": the new bid EUR 0\.15 is below the lowest bid EUR 0\.20/) },
    })
  })

  it('live: off the live-write allowlist a person may approve it, but it never runs by rule (the gate refuses the machine\'s write)', async () => {
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
    await atAuto('set-target-bid')
    const off = await call('set-target-bid', { targetId: 't-off', proposedBidCents: 27 })
    expect(off).toMatchObject({ status: 'waiting_for_approval', trust: { level: 'auto', why: expect.stringMatching(/^campaign "Italy not allowlisted": Amazon's write gate refuses it as a run by rule — campaign c-off is not on the live-write allowlist/) } })
    expect((await approvalOf(off.approvalId)).preview).toMatchObject({ reach: { reach: 'live', profileId: 'P-IT-TEST' }, ruleGate: expect.stringContaining('live-write allowlist') })
    const pinned = await call('set-target-bid', { targetId: 't-pin', proposedBidCents: 36 })
    expect(pinned).toMatchObject({ status: 'waiting_for_approval', trust: { why: expect.stringMatching(/^campaign "Italy pinned": Amazon's write gate refuses it as a run by rule/) } })
    // On the allowlist and not pinned, live: it runs by rule.
    expect(await call('set-target-bid', { targetId: 't-it', proposedBidCents: 40 })).toMatchObject({ status: 'runs_by_rule' })
  })
})

describe('AA-W2-6 — bulk-ad-bid-change: every row checked, one run', { timeout: TIMEOUT }, () => {
  it('cuts inside the strategy run by rule as ONE run of the daily cap; each row counts as a change in its market', async () => {
    await atAuto('bulk-ad-bid-change')
    const asked = await call('bulk-ad-bid-change', { bids: [{ targetId: 't-it', bidCents: 40 }, { targetId: 't-off', bidCents: 27 }, { targetId: 't-aa', bidCents: 45 }], why: 'a test cut' })
    expect(asked).toMatchObject({ status: 'runs_by_rule' })
    expect((await approvalOf(asked.approvalId)).preview).toMatchObject({
      totals: { changing: 3 }, ruleGate: null,
      limitFacts: { tool: 'bulk-ad-bid-change', this: { items: 3, cuts: 3, raises: 0, byMarket: { IT: { changes: 3 } }, rowsOutsideStrategy: 0 } },
    })
    await windowClosed(asked.approvalId)
    expect(await inside(() => commitScheduledApproval(asked.approvalId))).toMatchObject({ ok: true, status: 'executed' })
    expect([await bidOf('t-it'), await bidOf('t-off'), await bidOf('t-aa')]).toEqual([40, 27, 45])
    const logs = await inside(() => db().advertisingActionLog.findMany({ where: { executionId: asked.approvalId } }))
    expect(logs).toHaveLength(3)
    const reasons = await inside(() => db().campaignBidHistory.findMany({ where: { entityId: { in: ['t-it', 't-off', 't-aa'] }, reason: { startsWith: `Claude request ${asked.approvalId} (run by rule): ` } } }))
    expect(reasons).toHaveLength(3)
    expect(await inside(() => autoRunsInLastDay())).toBe(1)
    expect(await inside(() => ruleRunLedger())).toMatchObject({ runs: 1, byMarket: { IT: { changes: 3 } } })
  })

  it('a row outside its ad group\'s band holds the whole request, though the preview shows it among others', async () => {
    await atAuto('bulk-ad-bid-change')
    const asked = await call('bulk-ad-bid-change', { bids: [{ targetId: 't-it', bidCents: 40 }, { targetId: 't-off', bidCents: 15 }] })
    expect(asked).toMatchObject({ status: 'waiting_for_approval', trust: { why: expect.stringMatching(/^1 of 2 items is outside the ads strategy — target "winter jacket": the new bid EUR 0\.15 is below the lowest bid EUR 0\.20/) } })
  })

  it('more rows than the strategy\'s daily changes, or than the tool\'s items per request, wait for a person', async () => {
    await atAuto('bulk-ad-bid-change')
    await inside(() => db().adsStrategy.updateMany({ data: { claudeMaxChangesPerDay: 2, version: 2 } }))
    const cuts = [{ targetId: 't-it', bidCents: 40 }, { targetId: 't-aa', bidCents: 45 }, { targetId: 't-bb', bidCents: 55 }]
    expect(await call('bulk-ad-bid-change', { bids: cuts })).toMatchObject({
      status: 'waiting_for_approval', trust: { why: expect.stringMatching(/^IT: 0 changes ran by rule in the last 24 hours and this adds 3 changes, more than the 2 a day the ads strategy allows/) },
    })
    await inside(() => db().adsStrategy.updateMany({ data: { claudeMaxChangesPerDay: 10, version: 3 } }))
    await inside(() => db().agentTool.updateMany({ where: { name: 'bulk-ad-bid-change' }, data: { claudeLimits: { maxItems: 2 } } }))
    expect(await call('bulk-ad-bid-change', { bids: cuts })).toMatchObject({
      status: 'waiting_for_approval', trust: { why: expect.stringMatching(/^it changes 3 items, more than the 2 this tool's limits allow in one request run by rule/) },
    })
  })

  it('live: a pinned campaign among the rows holds the whole request for a person', async () => {
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
    await atAuto('bulk-ad-bid-change')
    const asked = await call('bulk-ad-bid-change', { bids: [{ targetId: 't-it', bidCents: 40 }, { targetId: 't-pin', bidCents: 36 }] })
    expect(asked).toMatchObject({ status: 'waiting_for_approval', trust: { why: expect.stringMatching(/^campaign "Italy pinned": Amazon's write gate refuses it as a run by rule/) } })
    expect((await approvalOf(asked.approvalId)).preview).toMatchObject({ totals: { changing: 2 }, reach: { reach: 'live' } })
  })
})
