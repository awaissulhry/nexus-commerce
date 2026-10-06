/**
 * ADS AUTONOMY AA-W2-7 — create-negative-keyword and graduate-keyword may run by the business's rule, only for a search
 * term whose record over the ads strategy's window meets its group where it lands, inside Claude's limits. Through
 * Claude's own door (runToolForClaude → the gate → the sweep's commit) on PGlite with the production schema and
 * business policies, business profiles ON. The ads write gate is the real one (sandbox); the job queue is a stub, so
 * nothing leaves the process. Values are made up (public repo).
 *
 *   negative   a term that meets "Negate a search term when" over the strategy's window (not the preview's 60 days)
 *              runs by rule as an exact negative; one that does not, a phrase negative (until allowed), a term where
 *              the strategy sets no negate group, and a term that meets the harvest group (harvest first, whatever the
 *              negate group's most orders) wait for a person; a protected product's ASIN is never negated
 *   harvest    a term that meets "Harvest a search term when" where it converted runs by rule once the business sets a
 *              starting-bid limit (0 by default: every new keyword waits); an ACoS above the group's ceiling, and a
 *              starting bid above the destination's bid band, wait for a person
 *   audit      the write names the request and says the rule decided it
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
vi.mock('../../outbound-destination.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveDestinations: async (_db: unknown, rows: unknown[]) => rows.map(() => ({ connectionId: null, reason: 'NO_ACCOUNT' })),
}))

import { commitScheduledApproval } from '../../agent-fleet/approval-inbox.service.js'
import { __claudeStrategyTest } from '../../advertising/ads-strategy/claude.js'
import type { McpPrincipal } from '../../mcp/mcp-auth.js'
import { runToolForClaude } from '../../mcp/mcp-tool-call.js'
import { getTool } from '../tool-registry.js'

const A = LEGACY_WORKSPACE_ID
const TIMEOUT = 30_000
const business = { workspaceId: A, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const db = () => database.client
const EVERYTHING = new Set<string>([...Object.values(F), ...Object.values(FIELDS)])
const ids = { person: '', p1: '', p2: '' }
let nameA = ''
const ASIN = 'B0TESTW272'

function claude(): McpPrincipal {
  return {
    kind: 'user', userId: ids.person, label: 'Tess Terms', permissions: { isOwner: false, permissions: EVERYTHING },
    workspace: business, business: { id: A, name: nameA }, via: 'claude', oauthGrantId: 'grant-terms', scopes: ['nexus.read', 'nexus.write', 'nexus.run'],
  } as McpPrincipal
}
type Answer = Record<string, any>
async function call(tool: string, args: Record<string, unknown>): Promise<Answer> {
  const who = claude()
  const result = await inside(() => runToolForClaude(who, getTool(tool)!, { ...args, business: nameA }))
  return JSON.parse((result.content as Array<{ text: string }>).map((b) => b.text).join(''))
}
const atAuto = (tool: string, claudeLimits?: Record<string, unknown>) =>
  inside(() => db().agentTool.create({ data: { name: tool, riskTier: 'high', requiresApproval: true, claudeTrust: 'auto', ...(claudeLimits ? { claudeLimits } : {}) } }))
const windowClosed = (approvalId: string) =>
  inside(() => db().agentApproval.update({ where: { id: approvalId }, data: { executeAfter: new Date(Date.now() - 1000) } }))
const approvalOf = (id: string) => inside(() => db().agentApproval.findUniqueOrThrow({ where: { id } }))
const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 3600_000)
/** One day of a search term in c-it's ad group (euros and orders made up). */
const term = (query: string, days: number, clicks: number, euros: number, orders = 0, salesEuros = 0) =>
  db().amazonAdsSearchTerm.create({
    data: {
      profileId: 'P-IT-TEST', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: daysAgo(days), campaignId: 'EXT-c-it', adGroupId: 'EXT-g-c-it',
      query, impressions: clicks * 30, clicks, costMicros: BigInt(Math.round(euros * 1_000_000)), currencyCode: 'EUR', orders7d: orders, sales7dCents: Math.round(salesEuros * 100),
    },
  })
const NEGATE = { negateMinClicks: 10, negateMinSpendCents: 2000, negateMaxOrders: 0, negateWindowDays: 30 }
const HARVEST = { harvestMinOrders: 2, harvestMinClicks: 5, harvestMaxAcosPct: 30, harvestWindowDays: 30 }

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  vi.stubEnv('NEXUS_OAUTH_ISSUER', 'https://web.example.test')
  vi.stubEnv('NEXUS_AI_KILL_SWITCH', '')
  const client = database.client
  const role = await client.role.create({
    data: { key: `W27_${randomUUID().slice(0, 8)}`, name: 'Terms tester', description: 'test', isSystem: false, permissions: [...EVERYTHING] },
  })
  const person = await client.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: 'Tess Terms' } })
  ids.person = person.id
  await client.userRole.create({ data: { userId: person.id, roleId: role.id } })
  const membership = await client.workspaceMembership.create({ data: { workspaceId: A, userId: person.id, status: 'active' } })
  await client.workspaceMemberRole.create({ data: { membershipId: membership.id, roleId: role.id } })
  nameA = (await client.workspace.findUniqueOrThrow({ where: { id: A } })).name
  await inside(async () => {
    await seedAdsFixture(client)
    ids.p1 = (await client.product.create({ data: { sku: 'TEST-W27-P1', name: 'Test helmet', basePrice: '10.00' } })).id
    ids.p2 = (await client.product.create({ data: { sku: 'TEST-W27-P2', name: 'Test gloves', basePrice: '10.00' } })).id
    await client.adProductAd.create({ data: { adGroupId: 'g-c-it', productId: ids.p1, asin: 'B0TESTW271' } })
    await client.adProductAd.create({ data: { adGroupId: 'g-c-off', productId: ids.p2, asin: ASIN } })
    // Wasteful within 30 days: 25 clicks, 42.00, no order.
    await term('giacca pelle', 3, 25, 42)
    await term('giacca cuoio', 3, 12, 25)
    // Wasteful only over 60 days: 4 clicks and 5.00 in the last 30, 30 clicks and 50.00 40 days ago.
    await term('giacca usata', 5, 4, 5)
    await term('giacca usata', 40, 30, 50)
    // Converting: 30 clicks, 15.00, 3 orders, 90.00 sales (ACoS 16.67 %); and 12 clicks, 40.00, 2 orders, 60.00 (66.67 %).
    // Spent and converted: 20 clicks, 25.00, 2 orders, 100.00 sales (ACoS 25 %); and 15 clicks, 30.00, 1 order, 20.00.
    await term('giacca nera', 3, 20, 25, 2, 100)
    await term('giacca grigia', 3, 15, 30, 1, 20)
    await term('pelle nera', 4, 30, 15, 3, 90)
    await term('pelle rossa', 4, 12, 40, 2, 60)
    await term('pelle verde', 4, 20, 10, 4, 100)
    await term(ASIN.toLowerCase(), 3, 20, 30)
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
    // IT: Claude may negate and harvest alone; the band up to 1.00; at most 10 changes and 5 raises by rule a day.
    await db().adsStrategy.create({
      data: {
        market: 'IT', level: 'MARKET', label: 'Test market (IT)', maxBidCents: 100, claudeAutonomy: { negative: 'auto', harvest: 'auto' },
        claudeMaxChangesPerDay: 10, claudeMaxRaisesPerDay: 5, ...NEGATE, ...HARVEST, version: 1, updatedBy: 'user:test',
      },
    })
    await db().adsStrategy.create({ data: { market: 'IT', level: 'PRODUCT', scopeId: ids.p2, label: 'TEST-W27-P2 (IT)', protect: true, version: 1, updatedBy: 'user:test' } })
  })
})
afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

const negative = (keywordText: string, extra: Record<string, unknown> = {}) =>
  ({ externalCampaignId: 'EXT-c-it', externalAdGroupId: 'EXT-g-c-it', keywordText, ...extra })

describe('AA-W2-7 — create-negative-keyword runs by rule for a term the strategy negates', { timeout: TIMEOUT }, () => {
  it('a term that meets the group over its window runs by rule; the audit says the rule decided it', async () => {
    await atAuto('create-negative-keyword')
    const asked = await call('create-negative-keyword', negative('giacca pelle', { why: 'a test negative' }))
    expect(asked).toMatchObject({ status: 'runs_by_rule' })
    expect((await approvalOf(asked.approvalId)).preview).toMatchObject({
      term: 'giacca pelle', ruleGate: null, ruleRecord: { windowDays: 30, clicks: 25, spendCents: 4200, orders: 0 },
      limitFacts: { tool: 'create-negative-keyword', action: 'negative', this: { items: 1, cuts: 1 }, protectedHit: [] },
      limitsNote: expect.arrayContaining([expect.stringMatching(/^Negate a search term when: at least 10 clicks and EUR 20\.00 spent, at most 0 orders, over 30 days \(ads strategy: Test market \(IT\), market, v1\); this term in its ad group: 25 clicks, EUR 42\.00 spent, 0 orders/)]),
    })
    await windowClosed(asked.approvalId)
    const done = await inside(() => commitScheduledApproval(asked.approvalId))
    expect(done).toMatchObject({ ok: true, status: 'executed' })
    const row = await inside(() => db().adTarget.findFirstOrThrow({ where: { isNegative: true, expressionValue: 'giacca pelle', adGroupId: 'g-c-it' } }))
    const [log] = await inside(() => db().advertisingActionLog.findMany({ where: { entityId: row.id, actionType: 'create_negative_keyword' } }))
    expect(JSON.stringify(log?.evidence)).toContain(`Claude request ${asked.approvalId} (run by rule): a test negative`)
    expect(await inside(() => db().agentChange.findFirst({ where: { approvalId: asked.approvalId } }))).toMatchObject({ toolName: 'create-negative-keyword', undoTool: 'undo-ad-change' })
  })

  it('judged over the strategy\'s 30 days, not the preview\'s 60: a term that spent only long ago waits for a person', async () => {
    await atAuto('create-negative-keyword')
    const asked = await call('create-negative-keyword', negative('giacca usata'))
    expect(asked).toMatchObject({
      status: 'waiting_for_approval',
      trust: { level: 'auto', why: expect.stringMatching(/^"giacca usata" has 4 clicks, EUR 5\.00 spent, 0 orders over the last 30 days in its ad group: fewer than 10 clicks, less than EUR 20\.00 spent, so it does not meet "Negate a search term when" at /) },
    })
    expect((await approvalOf(asked.approvalId)).preview).toMatchObject({ metrics: { windowDays: 60, clicks: 34 }, ruleRecord: { windowDays: 30, clicks: 4 } })
  })

  it('a phrase negative waits until the business allows phrase; then it runs by rule', async () => {
    await atAuto('create-negative-keyword')
    expect(await call('create-negative-keyword', negative('giacca cuoio', { matchType: 'NEGATIVE_PHRASE' }))).toMatchObject({
      status: 'waiting_for_approval', trust: { why: expect.stringMatching(/^a phrase negative blocks every search that contains the term; this tool's limits let only exact negatives run by rule \(allowPhrase is off\)/) },
    })
    await inside(() => db().agentTool.updateMany({ where: { name: 'create-negative-keyword' }, data: { claudeLimits: { allowPhrase: true } } }))
    expect(await call('create-negative-keyword', negative('giacca cuoio', { matchType: 'NEGATIVE_PHRASE' }))).toMatchObject({ status: 'runs_by_rule' })
  })

  it('where the strategy sets no negate group, a person decides', async () => {
    await atAuto('create-negative-keyword')
    await inside(() => db().adsStrategy.updateMany({ where: { level: 'MARKET' }, data: { negateMinClicks: null, negateMinSpendCents: null, negateMaxOrders: null, negateWindowDays: null, version: 2 } }))
    expect(await call('create-negative-keyword', negative('giacca cuoio'))).toMatchObject({
      status: 'waiting_for_approval', trust: { why: expect.stringMatching(/^the ads strategy sets no "Negate a search term when" group at the ad group of search term "giacca cuoio" \(IT\): a negative runs by rule only for a term that meets one/) },
    })
  })

  it('harvest first, whatever the negate group\'s most orders: a term that meets the harvest group (or the engine\'s defaults) waits for a person', async () => {
    await atAuto('create-negative-keyword')
    // The negate group lets a term with up to 2 orders be negated: both terms meet it.
    await inside(() => db().adsStrategy.updateMany({ where: { level: 'MARKET' }, data: { negateMaxOrders: 2, version: 2 } }))
    expect(await call('create-negative-keyword', negative('giacca nera'))).toMatchObject({
      status: 'waiting_for_approval',
      trust: { why: expect.stringMatching(/^"giacca nera" has 20 clicks, EUR 25\.00 spent, 2 orders over the last 30 days in its ad group, which meets "Harvest a search term when" \(ads strategy: Test market \(IT\), market, v2\): the engines graduate such a term rather than negate it/) },
    })
    // A term that converted less than the harvest group asks still runs by rule.
    expect(await call('create-negative-keyword', negative('giacca grigia'))).toMatchObject({ status: 'runs_by_rule' })
    // No harvest group in the strategy: the harvest engine's defaults (2 orders over 60 days) still come first.
    await inside(() => db().adsStrategy.updateMany({ where: { level: 'MARKET' }, data: { harvestMinOrders: null, harvestMinClicks: null, harvestMaxAcosPct: null, harvestWindowDays: null, version: 3 } }))
    const asked = await call('create-negative-keyword', negative('giacca nera'))
    expect(asked).toMatchObject({ status: 'waiting_for_approval', trust: { why: expect.stringContaining("which meets \"Harvest a search term when\" (the harvest engine's defaults: the ads strategy sets no harvest group here)") } })
    expect((await approvalOf(asked.approvalId)).preview).toMatchObject({ ruleHarvest: { harvestMinOrders: 2, harvestWindowDays: 60 }, ruleHarvestRecord: { windowDays: 60, orders: 2 } })
  })

  it('a protected product\'s ASIN is never negated: refused, nothing queued', async () => {
    await atAuto('create-negative-keyword')
    const before = await inside(() => db().agentApproval.count({ where: { toolName: 'create-negative-keyword' } }))
    const out = await call('create-negative-keyword', negative(ASIN.toLowerCase()))
    expect(out.error).toBe(`"${ASIN.toLowerCase()}" cannot be negated: it is the ASIN of TEST-W27-P2, a product the ads strategy protects in IT (TEST-W27-P2 (IT), version 1).`)
    expect(await inside(() => db().agentApproval.count({ where: { toolName: 'create-negative-keyword' } }))).toBe(before)
  })
})

const graduate = (query: string, extra: Record<string, unknown> = {}) =>
  ({ query, sourceExternalCampaignId: 'EXT-c-it', sourceExternalAdGroupId: 'EXT-g-c-it', destExternalAdGroupId: 'EXT-g-c-it', ...extra })

describe('AA-W2-7 — graduate-keyword runs by rule for a term the strategy harvests', { timeout: TIMEOUT }, () => {
  it('waits by default (no starting bid runs alone); with a starting-bid limit it runs by rule, and the audit says so', async () => {
    await atAuto('graduate-keyword')
    expect(await call('graduate-keyword', graduate('pelle nera', { bidCents: 37 }))).toMatchObject({
      status: 'waiting_for_approval', trust: { why: expect.stringMatching(/^its starting bid EUR 0\.37 is above the EUR 0\.00 this tool's limits let a new keyword start at without a person \(0: every new keyword waits for a person\)/) },
    })
    await inside(() => db().agentTool.updateMany({ where: { name: 'graduate-keyword' }, data: { claudeLimits: { maxStartBidCents: 60 } } }))
    const asked = await call('graduate-keyword', graduate('pelle nera', { bidCents: 37, why: 'a test graduation' }))
    expect(asked).toMatchObject({ status: 'runs_by_rule' })
    expect((await approvalOf(asked.approvalId)).preview).toMatchObject({
      suggestedBidCents: 37, ruleGate: null,
      ruleHarvest: { harvestMinOrders: 2, harvestMinClicks: 5, harvestMaxAcosPct: 30, harvestWindowDays: 30, at: 'ad group "group c-it"' },
      ruleRecord: { windowDays: 30, clicks: 30, orders: 3, spendCents: 1500, salesCents: 9000 },
      limitFacts: { tool: 'graduate-keyword', action: 'harvest', this: { items: 1, raises: 1, highestNewBidCents: 37 } },
    })
    await windowClosed(asked.approvalId)
    expect(await inside(() => commitScheduledApproval(asked.approvalId))).toMatchObject({ ok: true, status: 'executed' })
    const made = await inside(() => db().adTarget.findFirstOrThrow({ where: { isNegative: false, expressionType: 'EXACT', expressionValue: 'pelle nera', adGroupId: 'g-c-it' } }))
    expect(made.bidCents).toBe(37)
    const [log] = await inside(() => db().advertisingActionLog.findMany({ where: { entityId: made.id, actionType: 'create_keyword' } }))
    expect(JSON.stringify(log?.evidence)).toContain(`Claude request ${asked.approvalId} (run by rule): a test graduation`)
  })

  it('an ACoS above the group\'s ceiling, and a starting bid above the band, wait for a person', async () => {
    await atAuto('graduate-keyword', { maxStartBidCents: 200 })
    expect(await call('graduate-keyword', graduate('pelle rossa', { bidCents: 40 }))).toMatchObject({
      status: 'waiting_for_approval', trust: { why: expect.stringMatching(/^"pelle rossa" has 12 clicks, EUR 40\.00 spent, 2 orders over the last 30 days in its ad group "group c-it": an ACoS of 66\.67 %, above 30 %, so it does not meet "Harvest a search term when"/) },
    })
    expect(await call('graduate-keyword', graduate('pelle verde', { bidCents: 150 }))).toMatchObject({
      status: 'waiting_for_approval', trust: { why: expect.stringMatching(/^1 of 1 item is outside the ads strategy — search term "pelle verde": the new bid EUR 1\.50 is above the highest bid EUR 1\.00/) },
    })
  })
})
