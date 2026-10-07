/**
 * ADS AUTONOMY W4-5 — add-ad-targets, add-negative-targets, retire-negatives, harvest-search-term and
 * set-harvest-destination, run for real through the door and the approval gate (PGlite, production schema; the job queue
 * a stub; the ads write gate the real one, sandbox). Made-up names, ids and amounts only.
 *
 * Proven: each previews what it does where it lands, and what Nexus or Amazon would refuse is refused and not queued;
 * approved, every row and write carries the approval as its change set and runs as the approver; undo asks for exactly
 * the inverse. The Owner's rule 2 — a negative never blocks a search term that converts where it lands (but the proven
 * handover), a harvest never negates a converting term in its source — and rule 3 — another product's place that buys
 * the term needs allowOtherProducts, a person's word, never a rule (the limits refuse it; a run the rule decided is
 * refused in execute too). What adds spend needs the approver's code (a plain approve does not run it; the code does);
 * the plan path carries it. By default nothing runs by rule.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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
import { actionOfTool, actionsOfTool, __claudeStrategyTest } from '../../advertising/ads-strategy/claude.js'
import { commitScheduledApproval, decideFleetApproval } from '../../agent-fleet/approval-inbox.service.js'
import { queuePlan, runPlan } from '../change-plan.service.js'
import { adDeliveryOf } from './approval.tools.js'
import { STEP_UP_NEEDS } from '../step-up-approval.js'
import { __stepUpTest } from '../../../lib/auth/step-up.js'
import { generateSecret, generateSync } from 'otplib'

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const person = (userId: string, via: 'claude' | 'app'): UserPrincipal => ({
  kind: 'user', userId, label: `Person ${userId}`, via, workspace: business,
  permissions: { isOwner: false, permissions: new Set([...Object.values(FEATURES), ...Object.values(FIELDS)]) },
})
const claude = person('u-asker', 'claude')
const approver = person('u-approver', 'app')

type Row = Record<string, any>
const preview = async (tool: string, args: Record<string, unknown>) => (await inside(() => callTool(claude, tool, args))).raw as Row
async function ask(tool: string, args: Record<string, unknown>) {
  return inside(async () => {
    const run = await database.client.agentRun.create({ data: { agentKey: 'mcp', trigger: 'manual', status: 'done', via: 'claude', userId: claude.userId } })
    return runOrQueueTool(tool, args, claude, run.id, { forceAsk: true })
  })
}
const approve = (approvalId: string) => inside(() => decideApproval(approvalId, 'approve', approver)) as Promise<Row>
/** As the Approvals page records a decision taken with the approver's authenticator code. */
const withCode = (approvalId: string) => inside(() => database.client.agentApproval.update({ where: { id: approvalId }, data: { decisionVia: 'nexus-step-up' } }))
/** A request approved by the business's standing rule, not a person (decisionVia auto). */
const approveByRule = async (approvalId: string) => {
  await inside(() => database.client.agentApproval.update({ where: { id: approvalId }, data: { decisionVia: 'auto' } }))
  return approve(approvalId)
}
const sql = <T = Row>(text: string, params: unknown[] = []) => inside(async () => (await database.client.$queryRawUnsafe(text, ...params)) as T[])
const target = (id: string) => inside(() => database.client.adTarget.findUnique({ where: { id } })) as Promise<Row | null>
const judge = (tool: string, p: unknown, limits: Record<string, unknown> = {}) => getTool(tool)!.withinLimits!(p, getTool(tool)!.limits!.parse(limits) as Record<string, unknown>)
/** The audit rows a request wrote (its change set). */
const writesOf = (approvalId: string) => sql<{ entityId: string; actionType: string; userId: string }>(`SELECT "entityId", "actionType", "userId" FROM "AdvertisingActionLog" WHERE "executionId" = $1 ORDER BY "createdAt"`, [approvalId])

/** Real people (a row, a role, a membership, an authenticator), for the real approve and commit paths. */
const EVERYTHING = new Set<string>([...Object.values(FEATURES), ...Object.values(FIELDS)])
type RealPerson = { id: string; secret: string; principal: UserPrincipal }
async function realPerson(label: string): Promise<RealPerson> {
  const client = database.client
  const secret = generateSecret()
  const role = await client.role.create({ data: { key: `W45_${randomUUID().slice(0, 8)}`, name: label, description: 'test', isSystem: false, permissions: [...EVERYTHING] } })
  const user = await client.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: label, twoFactorEnabledAt: new Date(), twoFactorSecret: secret } })
  await client.userRole.create({ data: { userId: user.id, roleId: role.id } })
  const membership = await client.workspaceMembership.create({ data: { workspaceId: LEGACY_WORKSPACE_ID, userId: user.id, status: 'active' } })
  await client.workspaceMemberRole.create({ data: { membershipId: membership.id, roleId: role.id } })
  return { id: user.id, secret, principal: { kind: 'user', userId: user.id, label, via: 'app', workspace: business, permissions: { isOwner: false, permissions: EVERYTHING } } }
}
const codeOf = (p: RealPerson) => { __stepUpTest.reset(); return generateSync({ secret: p.secret }) }
const commitNow = async (approvalId: string) => {
  await inside(() => database.client.agentApproval.update({ where: { id: approvalId }, data: { executeAfter: new Date(Date.now() - 1000) } }))
  return inside(() => commitScheduledApproval(approvalId))
}

const YESTERDAY = new Date(Date.now() - 86_400_000)
/** One row of the search-term report: what ran in an ad group (by Amazon's ids), with its orders. */
const term = (campaign: string, group: string, query: string, m: { impressions: number; clicks: number; costCents: number; orders: number }) =>
  database.client.amazonAdsSearchTerm.create({
    data: {
      profileId: 'P-IT-TEST', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: YESTERDAY, campaignId: `EXT-${campaign}`, adGroupId: `EXT-${group}`, query,
      impressions: m.impressions, clicks: m.clicks, costMicros: BigInt(m.costCents) * 10_000n, currencyCode: 'EUR', orders7d: m.orders, sales7dCents: m.orders * 2_000,
    },
  })

/**
 * Two products in IT. Product one is advertised in four ad groups (g-a1, g-a2, g-a3 of the manual campaign c-a; g-auto of
 * the automatic c-auto); product two in g-b1 (c-b) and in g-a1 too? No — g-a1 stays product one's own. A floored
 * campaign c-fl holds g-fl. Search terms: in g-a1 "red jacket" (clicks, no order), "blue jacket" (3 orders: converting),
 * "green jacket" (2 orders) whose live exact home in g-a2 wins (3 orders there); in g-b1 product two bought "red jacket".
 */
beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    const db = database.client
    await seedAdsFixture(db)
    const one = await db.product.create({ data: { sku: 'TEST-W45-ONE', name: 'Test product one', basePrice: '10.00', amazonAsin: 'B0TESTONE1' } })
    const two = await db.product.create({ data: { sku: 'TEST-W45-TWO', name: 'Test product two', basePrice: '10.00', amazonAsin: 'B0TESTTWO1' } })
    const campaign = (id: string, extra: Record<string, unknown> = {}) => db.campaign.create({
      data: { id, name: `Test ${id}`, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: `EXT-${id}`, dailyBudget: '12.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true, targetingType: 'MANUAL', ...extra },
    })
    const group = async (id: string, campaignId: string, productId: string, extra: Record<string, unknown> = {}) => {
      await db.adGroup.create({ data: { id, campaignId, name: `group ${id}`, externalAdGroupId: `EXT-${id}`, defaultBidCents: 30, ...extra } })
      await db.adProductAd.create({ data: { id: `pa-${id}`, adGroupId: id, productId, sku: productId === one.id ? 'TEST-W45-ONE' : 'TEST-W45-TWO', asin: productId === one.id ? 'B0TESTONE1' : 'B0TESTTWO1', externalAdId: `EXT-pa-${id}` } })
    }
    await campaign('c-a')
    await campaign('c-b')
    await campaign('c-auto', { targetingType: 'AUTO' })
    await campaign('c-fl', { bidsSuppressedAt: new Date(), bidsSuppressedBy: 'user:u-person' })
    await group('g-a1', 'c-a', one.id)
    await group('g-a2', 'c-a', one.id)
    await group('g-a3', 'c-a', one.id)
    await group('g-b1', 'c-b', two.id)
    await group('g-auto', 'c-auto', one.id)
    await group('g-fl', 'c-fl', one.id)
    // The live exact home of "green jacket" (product one), and a keyword product two buys.
    await db.adTarget.create({ data: { id: 'k-green', adGroupId: 'g-a2', kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'green jacket', bidCents: 40, externalTargetId: 'EXT-k-green' } })
    await db.adTarget.create({ data: { id: 'k-red-boots', adGroupId: 'g-b1', kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'red boots', bidCents: 40, externalTargetId: 'EXT-k-red-boots' } })
    // Standing negatives: one at Amazon, one only in Nexus.
    await db.adTarget.create({ data: { id: 'n-old', adGroupId: 'g-a1', kind: 'KEYWORD', expressionType: 'NEGATIVE_EXACT', expressionValue: 'old term', bidCents: 0, isNegative: true, negativeLevel: 'AD_GROUP', externalTargetId: 'EXT-n-old' } })
    await db.adTarget.create({ data: { id: 'n-local', adGroupId: 'g-a1', kind: 'KEYWORD', expressionType: 'NEGATIVE_PHRASE', expressionValue: 'local term', bidCents: 0, isNegative: true, negativeLevel: 'AD_GROUP' } })
    await term('c-a', 'g-a1', 'red jacket', { impressions: 300, clicks: 10, costCents: 1_200, orders: 0 })
    await term('c-a', 'g-a1', 'blue jacket', { impressions: 400, clicks: 12, costCents: 900, orders: 3 })
    await term('c-a', 'g-a1', 'green jacket', { impressions: 200, clicks: 8, costCents: 500, orders: 2 })
    await term('c-a', 'g-a2', 'green jacket', { impressions: 500, clicks: 15, costCents: 700, orders: 3 })
    await term('c-a', 'g-a1', 'cheap jacket', { impressions: 90, clicks: 4, costCents: 160, orders: 0 })
    await term('c-a', 'g-a1', 'warm jacket', { impressions: 80, clicks: 5, costCents: 250, orders: 0 })
    await term('c-a', 'g-a1', 'wool jacket', { impressions: 300, clicks: 10, costCents: 1_200, orders: 0 })
    await term('c-b', 'g-b1', 'red jacket', { impressions: 50, clicks: 2, costCents: 80, orders: 0 })
    await db.adKeywordProtection.create({ data: { mode: 'WHITELIST', term: 'brandname', matchType: 'EXACT', reason: 'test brand' } })
  })
}, 180_000)
afterAll(async () => { vi.unstubAllEnvs(); await database?.close() }, 30_000)
beforeEach(() => { vi.unstubAllEnvs() })

const TOOLS = ['add-ad-targets', 'add-negative-targets', 'retire-negatives', 'harvest-search-term', 'set-harvest-destination'] as const

describe('the five tools as the contract holds them', () => {
  it('strategy-bound, alwaysAsk, ceiling auto, at ask by default; the default limits run nothing alone', () => {
    for (const name of TOOLS) {
      const tool = getTool(name)!
      expect(tool, name).toMatchObject({ alwaysAsk: true, strategyBound: 'amazon-ads', maxClaudeTrust: 'auto' })
      expect(ruleFrom(tool, null).level, name).toBe('ask')
      expect(tool.limits!.parse({}), name).toMatchObject({ maxItems: 0, markets: [] })
      expect(typeof judge(name, { action: name }), name).toBe('string')
    }
    expect(getTool('set-harvest-destination')!.openWorld).toBe(false)
    expect(Object.fromEntries(TOOLS.map((name) => [name, getTool(name)!.reversibility]))).toEqual({
      'add-ad-targets': 'partial', 'add-negative-targets': 'full', 'retire-negatives': 'partial', 'harvest-search-term': 'partial', 'set-harvest-destination': 'full',
    })
    // The single-term tools name their list forms.
    expect(getTool('create-negative-keyword')!.description).toMatch(/add-negative-targets/)
    expect(getTool('graduate-keyword')!.description).toMatch(/harvest-search-term.*add-ad-targets/)
  })

  it('the kinds of ad action the strategy narrows: a harvest is a negative too, unless it negates nothing; its undo a retire', () => {
    expect(TOOLS.map((name) => actionOfTool(name))).toEqual(['targeting', 'negative', 'retire', 'harvest', 'harvest'])
    expect(actionsOfTool('harvest-search-term', {})).toEqual(['harvest', 'negative'])
    expect(actionsOfTool('harvest-search-term', { negateSource: false })).toEqual(['harvest'])
    expect(actionsOfTool('harvest-search-term', { op: 'undo' })).toEqual(['harvest', 'retire'])
  })
})

describe('add-negative-targets', () => {
  it('one set of terms into many ad groups: each negative with what it blocks of what ran there; it raises nothing', async () => {
    const r = await preview('add-negative-targets', { adGroupIds: ['g-a1', 'g-a2'], keywords: [{ text: 'red jacket' }, { text: 'warm', matchType: 'NEGATIVE_PHRASE' }] })
    expect(r.ok, r.error).toBe(true)
    expect(r.preview).toMatchObject({
      action: 'add-negative-targets', market: 'IT', totals: { negatives: 4, keywords: 4, asins: 0, places: 2, campaigns: 1 }, raises: [], otherProducts: [], handovers: [],
      productFor: 'TEST-W45-ONE', reach: { reach: 'sandbox' }, limitFacts: { action: 'negative', this: { items: 4, cuts: 4, raises: 0 } },
      effect: expect.stringMatching(/^Adds 4 negative keywords at Amazon in 2 places: .*only lowers spend/),
    })
    expect(r.preview.changes[0]).toMatchObject({ label: 'negative exact "red jacket" · ad group "group g-a1" (campaign "Test c-a")', blocked: { searchTerms: 1, clicks: 10, orders: 0, spendCents: 1_200, currency: 'EUR' } })
    expect(r.preview.changes[1]).toMatchObject({ label: 'negative phrase "warm" · ad group "group g-a1" (campaign "Test c-a")', blocked: { searchTerms: 1, clicks: 5 } })
    expect(r.preview).not.toHaveProperty('stepUp')
  })

  it('refuses, and does not queue, what the write service would refuse', async () => {
    const refused = async (args: Record<string, unknown>) => (await preview('add-negative-targets', args)).error
    expect(await refused({ adGroupIds: ['g-a1'], keywords: [{ text: 'old term' }] })).toMatch(/negative exact "old term" is already negated in ad group "group g-a1"/)
    expect(await refused({ adGroupIds: ['g-a1'], keywords: [{ text: 'Red Jacket' }, { text: 'red  jacket' }] })).toMatch(/asked for twice in the same place/)
    expect(await refused({ adGroupIds: ['g-a2'], keywords: [{ text: 'green jacket' }] })).toMatch(/would block your own exact keyword "green jacket" in ad group "group g-a2"/)
    expect(await refused({ adGroupIds: ['g-a1'], keywords: [{ text: 'brandname' }] })).toMatch(/brandname/i)
    expect(await refused({ adGroupIds: ['g-a1'], keywords: [{ text: 'B0ABCDEFGH' }] })).toMatch(/is an ASIN, a product: name it in asins/)
    expect(await refused({ scope: 'CAMPAIGN', campaignIds: ['c-a'], asins: ['B0ABCDEFGH'] })).toMatch(/a negative product target goes into an ad group, not a whole campaign/)
    expect(await refused({ adGroupIds: ['nope'], keywords: [{ text: 'x' }] })).toBe('Not queued: ad group nope was not found in this business.')
    expect(await refused({ adGroupIds: ['g-c-sb'], keywords: [{ text: 'x' }] })).toMatch(/not a Sponsored Products campaign/)
    expect(await refused({})).toMatch(/^Name the negatives/)
  })

  it("rule 2 — never a term that converts where it lands (named, with its orders), exact or phrase", async () => {
    const exact = await preview('add-negative-targets', { adGroupIds: ['g-a1'], keywords: [{ text: 'blue jacket' }] })
    expect(exact.error).toMatch(/^Not queued: a negative there would block a search term that converts — "blue jacket" in ad group "group g-a1" \(campaign "Test c-a"\): 3 orders over the last 60 days\. Winners stay where they win \(the Owner's rule 2\)/)
    const phrase = await preview('add-negative-targets', { adGroupIds: ['g-a1'], keywords: [{ text: 'jacket', matchType: 'NEGATIVE_PHRASE' }] })
    expect(phrase.error).toMatch(/"blue jacket" in ad group "group g-a1" .*: 3 orders/)
  })

  it('rule 2 — the proven handover: a converting term whose live exact home of the same product wins elsewhere may be closed, by a person only', async () => {
    const r = await preview('add-negative-targets', { adGroupIds: ['g-a1'], keywords: [{ text: 'green jacket' }] })
    expect(r.ok, r.error).toBe(true)
    expect(r.preview.handovers).toEqual([{ key: expect.any(String), term: 'green jacket', place: 'ad group "group g-a1" (campaign "Test c-a")', home: 'ad group "group g-a2" (campaign "Test c-a")' }])
    expect(r.preview.effect).toMatch(/closed in an old place because its own exact keyword wins elsewhere \(the proven handover\)/)
    expect(judge('add-negative-targets', r.preview, { maxItems: 5, markets: ['IT'] })).toMatch(/closes a converting term's old place/)
  })

  it("rule 3 — another product's place that buys the term: listed and refused; allowed only by a person's word, never by rule", async () => {
    // Two products, none named: both places buy "red jacket" — each is another's.
    expect((await preview('add-negative-targets', { adGroupIds: ['g-a1', 'g-b1'], keywords: [{ text: 'red jacket' }] })).error)
      .toMatch(/^Not queued: isolation is per product \(the Owner's rule 3\) — ad group "group g-a1" .*TEST-W45-ONE.*; ad group "group g-b1" \(campaign "Test c-b"\), which advertises TEST-W45-TWO and bought "red jacket" \(2 clicks\)/)
    // Product one named: only product two's place is listed.
    const named = await preview('add-negative-targets', { adGroupIds: ['g-a1', 'g-b1'], keywords: [{ text: 'red jacket' }], product: 'TEST-W45-ONE' })
    expect(named.error).toMatch(/— ad group "group g-b1" \(campaign "Test c-b"\), which advertises TEST-W45-TWO and bought "red jacket" \(2 clicks\): the negative would stop that product/)
    expect(named.error).not.toMatch(/group g-a1/)
    // A place of another product that never ran the term is not in the way.
    expect((await preview('add-negative-targets', { adGroupIds: ['g-a1', 'g-b1'], keywords: [{ text: 'warm jacket' }], product: 'TEST-W45-ONE' })).ok).toBe(true)
    const args = { adGroupIds: ['g-a1', 'g-b1'], keywords: [{ text: 'red jacket' }], product: 'TEST-W45-ONE', allowOtherProducts: true }
    const allowed = await preview('add-negative-targets', args)
    expect(allowed.ok, allowed.error).toBe(true)
    expect(allowed.preview.otherProducts).toEqual([expect.objectContaining({ place: 'ad group "group g-b1" (campaign "Test c-b")', products: ['TEST-W45-TWO'] })])
    expect(allowed.preview.effect).toMatch(/As asked \(allowOtherProducts\), 1 place of another product is blocked too/)
    expect(judge('add-negative-targets', allowed.preview, { maxItems: 5, markets: ['IT'] })).toMatch(/another product's ad group \(allowOtherProducts\): isolation is per product, a person's word, never a rule/)
    // The last door: a run the business's rule decided is refused in execute; a person's approval runs it.
    const byRule = await ask('add-negative-targets', args)
    expect(await approveByRule(byRule.approvalId!)).toMatchObject({ ok: false, error: expect.stringMatching(/^Not run: it blocks a term in another product's ad group, which a person decides, never a rule/) })
    // Handed back to a person (a refused run by rule no longer counts as one): his approval runs it.
    await inside(() => database.client.agentApproval.update({ where: { id: byRule.approvalId! }, data: { decisionVia: null } }))
    expect(await approve(byRule.approvalId!)).toMatchObject({ ok: true, status: 'executed', result: { added: 2 } })
    expect((await sql(`SELECT id FROM "AdTarget" WHERE "adGroupId" = 'g-b1' AND "isNegative" AND "expressionValue" = 'red jacket'`)).length).toBe(1)
  })

  it('approved: created as the approver, every row on the change set; approval-status counts them; undo retires exactly them', async () => {
    const asked = await ask('add-negative-targets', { negatives: [{ adGroupId: 'g-a3', text: 'cheap socks' }, { adGroupId: 'g-a3', asin: 'B0OTHERAA1' }, { campaignId: 'c-b', text: 'free socks' }], why: 'wasted spend' })
    expect(asked).toMatchObject({ ok: true, mode: 'queued' })
    const done = await approve(asked.approvalId!)
    expect(done).toMatchObject({ ok: true, status: 'executed', result: { added: 3, changeSetId: asked.approvalId } })
    const rows = await sql<{ id: string; kind: string; negativeLevel: string; expressionValue: string }>(`SELECT id, kind::text, "negativeLevel", "expressionValue" FROM "AdTarget" WHERE "isNegative" AND "expressionValue" IN ('cheap socks', 'B0OTHERAA1', 'free socks') ORDER BY "expressionValue"`)
    expect(rows.map((r) => [r.expressionValue, r.kind, r.negativeLevel])).toEqual([['B0OTHERAA1', 'PRODUCT', 'AD_GROUP'], ['cheap socks', 'KEYWORD', 'AD_GROUP'], ['free socks', 'KEYWORD', 'CAMPAIGN']])
    const writes = await writesOf(asked.approvalId!)
    expect(writes.map((w) => w.entityId).sort()).toEqual(rows.map((r) => r.id).sort())
    expect(new Set(writes.map((w) => w.userId))).toEqual(new Set(['user:u-approver']))
    expect(await inside(() => adDeliveryOf(asked.approvalId!, 'add-negative-targets', { reach: { reach: 'sandbox' } }))).toMatchObject({ created: { total: 3, atAmazon: 0 } })
    const undo = await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))
    expect(undo).toMatchObject({ request: { tool: 'undo-ad-change', args: { changeSetId: asked.approvalId, changeId: expect.any(String) } } })
    const undoAsked = await ask(undo.request!.tool, undo.request!.args)
    expect(await approve(undoAsked.approvalId!)).toMatchObject({ ok: true, status: 'executed' })
    // Sandbox: Amazon never had them, so the retire removes Nexus's rows (live, they would be archived at Amazon).
    for (const r of rows) expect(await target(r.id), r.expressionValue).toBeNull()
  })

  it('by rule only inside its limits and the ads strategy: exact, a market named, the negate group met; never a campaign negative or an ASIN by default', async () => {
    const strategy = await inside(() => database.client.adsStrategy.create({ data: {
      market: 'IT', level: 'MARKET', scopeId: '*', label: 'Test market (IT)', updatedBy: 'user:test', claudeAutonomy: { negative: 'auto' },
      claudeMaxChangesPerDay: 50, claudeMaxRaisesPerDay: 10, claudeMaxBudgetIncreasePerDayCents: 0,
      negateMinClicks: 5, negateMinSpendCents: 200, negateMaxOrders: 0, negateWindowDays: 30,
    } }))
    __claudeStrategyTest.reset()
    try {
      const limits = { maxItems: 5, markets: ['IT'] }
      const wasteful = (await preview('add-negative-targets', { adGroupIds: ['g-a1'], keywords: [{ text: 'warm jacket' }] })).preview
      expect(wasteful.ruleRecords).toEqual({ 'searchTerm:EXT-c-a:EXT-g-a1:warm jacket': { windowDays: 30, clicks: 5, spendCents: 250, orders: 0 } })
      expect(judge('add-negative-targets', wasteful, limits)).toBeNull()
      expect(judge('add-negative-targets', wasteful)).toMatch(/names no market/)
      expect(judge('add-negative-targets', wasteful, { markets: ['IT'] })).toMatch(/more than the 0 this tool's limits allow/)
      expect(judge('add-negative-targets', wasteful, { ...limits, minWastedSpendCents: 5_000 })).toMatch(/less than the EUR 50\.00 this tool's limits ask/)
      const short = (await preview('add-negative-targets', { adGroupIds: ['g-a1'], keywords: [{ text: 'cheap jacket' }] })).preview
      expect(judge('add-negative-targets', short, limits)).toMatch(/fewer than 5 clicks, less than EUR 2\.00 spent over 30 days, so it does not meet "Negate a search term when"/)
      const phrase = (await preview('add-negative-targets', { adGroupIds: ['g-a1'], keywords: [{ text: 'warm jacket', matchType: 'NEGATIVE_PHRASE' }] })).preview
      expect(judge('add-negative-targets', phrase, limits)).toMatch(/phrase negative, which this tool's limits do not let run by rule \(matchTypes\)/)
      const asin = (await preview('add-negative-targets', { adGroupIds: ['g-a1'], asins: ['B0OTHERBB1'] })).preview
      expect(judge('add-negative-targets', asin, limits)).toMatch(/allowAsinNegatives is off/)
      const whole = (await preview('add-negative-targets', { scope: 'CAMPAIGN', campaignIds: ['c-a'], keywords: [{ text: 'warm jacket' }] })).preview
      expect(judge('add-negative-targets', whole, limits)).toMatch(/allowCampaignScope is off/)
    } finally {
      await inside(() => database.client.adsStrategy.delete({ where: { id: strategy.id } }))
      __claudeStrategyTest.reset()
    }
  })
})

describe('retire-negatives', () => {
  it('any negative, by id or by its place and text: who added it, at Amazon or only in Nexus; lifting one needs the code', async () => {
    const r = await preview('retire-negatives', { negativeIds: ['n-old'], negatives: [{ adGroupId: 'g-a1', text: 'local term' }] })
    expect(r.ok, r.error).toBe(true)
    expect(r.preview).toMatchObject({
      action: 'retire-negatives', market: 'IT', totals: { retiring: 2, atAmazon: 1, nexusOnly: 1 },
      raises: ['negative exact "old term" · ad group "group g-a1" (campaign "Test c-a")'],
      stepUp: { what: 'lifts 1 negative at Amazon (the searches it blocks can show the ads again)', raises: ['Spend'], needs: STEP_UP_NEEDS, how: expect.stringMatching(/authenticator code.*allowRetire/) },
      limitFacts: { action: 'retire', this: { items: 2, raises: 2 } },
    })
    expect(r.preview.changes.map((c: Row) => [c.label, c.toLabel, c.madeBy])).toEqual([
      ['negative exact "old term" · ad group "group g-a1" (campaign "Test c-a")', 'Retired: archived at Amazon', expect.stringMatching(/^no record in Nexus of who added it/)],
      ['negative phrase "local term" · ad group "group g-a1" (campaign "Test c-a")', 'Removed from Nexus (Amazon never had it)', expect.stringMatching(/^no record in Nexus/)],
    ])
    expect(judge('retire-negatives', r.preview, { maxItems: 5, markets: ['IT'] })).toMatch(/allowRetire is off/)
  })

  it('refuses what is not a standing negative of this business', async () => {
    expect((await preview('retire-negatives', { negativeIds: ['k-green'] })).error).toMatch(/is a keyword or target, not a negative: pause-ads or archive-ads/)
    expect((await preview('retire-negatives', { negativeIds: ['nope'] })).error).toMatch(/negative nope was not found in this business/)
    expect((await preview('retire-negatives', { negatives: [{ adGroupId: 'g-a1', text: 'never there' }] })).error).toMatch(/no standing negative "never there" in ad group g-a1/)
    expect((await preview('retire-negatives', {})).error).toMatch(/^Name the negatives to retire/)
  })

  it('a plain approve does not run it; with the code it retires as the approver on the change set; undo adds them again', async () => {
    const asked = await ask('retire-negatives', { negativeIds: ['n-old', 'n-local'], why: 'they block a good term' })
    const plain = await approve(asked.approvalId!)
    expect(plain).toMatchObject({ ok: false, status: 'pending', error: expect.stringMatching(/^Not run: it lifts 1 negative at Amazon, and that runs only when a person with settings\.security\.manage approved it with their authenticator code/) })
    expect((await target('n-old'))?.status).toBe('ENABLED')
    await withCode(asked.approvalId!)
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed', result: { retired: 1, removedFromNexus: 1 } })
    expect((await target('n-old'))?.status).toBe('ARCHIVED')
    expect(await target('n-local')).toBeNull()
    expect((await writesOf(asked.approvalId!)).map((w) => [w.entityId, w.actionType])).toEqual(expect.arrayContaining([['n-old', 'retire_negative'], ['n-local', 'retire_negative']]))
    const undo = await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))
    expect(undo).toMatchObject({ request: { tool: 'add-negative-targets', args: { negatives: [{ adGroupId: 'g-a1', text: 'old term', matchType: 'NEGATIVE_EXACT' }], allowOtherProducts: true } } })
  })

  it('the Approvals page: approving without the code is refused (mfa_required); with it, it runs at commit', async () => {
    await inside(() => database.client.adTarget.create({ data: { id: 'n-page', adGroupId: 'g-a3', kind: 'KEYWORD', expressionType: 'NEGATIVE_EXACT', expressionValue: 'page term', bidCents: 0, isNegative: true, negativeLevel: 'AD_GROUP', externalTargetId: 'EXT-n-page' } }))
    const boss = await inside(() => realPerson('Test Approver'))
    const asked = await ask('retire-negatives', { negativeIds: ['n-page'] })
    const decide = (code?: string) => inside(() => decideFleetApproval({ id: asked.approvalId!, decision: 'approve', actor: boss.principal, ...(code ? { code } : {}) }))
    expect(await decide()).toMatchObject({ ok: false, code: 'mfa_required' })
    expect(await decide(codeOf(boss))).toMatchObject({ ok: true, status: 'scheduled' })
    expect(await commitNow(asked.approvalId!)).toMatchObject({ ok: true })
    expect((await target('n-page'))?.status).toBe('ARCHIVED')
  })
})

describe('add-ad-targets', () => {
  it('at its bid: each target listed in raises, approving needs the code; at the floor: no code, the planned bid kept', async () => {
    const r = await preview('add-ad-targets', { adGroupId: 'g-a1', keywords: [{ text: 'new boots', matchType: 'EXACT', bidCents: 40 }], productTargets: [{ asin: 'B0OTHERCC1' }], categoryTargets: [{ categoryId: '123456' }], bidCents: 25 })
    expect(r.ok, r.error).toBe(true)
    expect(r.preview).toMatchObject({
      action: 'add-ad-targets', currency: 'EUR', highestBidCents: 40, totals: { targets: 3, keywords: 1, productTargets: 1, categoryTargets: 1, atBid: 3, atFloor: 0 },
      raises: ['exact keyword "new boots" at EUR 0.40', 'product target B0OTHERCC1 at EUR 0.25', 'category target 123456 at EUR 0.25'],
      stepUp: { what: 'adds 3 targets that start spending at their bids', raises: ['Bids', 'Spend'], needs: STEP_UP_NEEDS },
      sameProductClashes: [], reach: { reach: 'sandbox' }, limitFacts: { action: 'targeting', this: { items: 3, raises: 3 } },
    })
    const floor = await preview('add-ad-targets', { adGroupId: 'g-a1', keywords: [{ text: 'new boots', matchType: 'EXACT', bidCents: 40 }], startAtFloor: true })
    expect(floor.preview).toMatchObject({ raises: [], highestBidCents: 5, startsAtFloor: { floorCents: 5 }, changes: [{ toLabel: 'at the 5-cent floor (planned EUR 0.40)', bidCents: 5, plannedBidCents: 40 }] })
    expect(floor.preview).not.toHaveProperty('stepUp')
  })

  it('refuses an auto campaign, a target already there, a floored campaign at a bid, an ASIN typed as a keyword', async () => {
    const refused = async (args: Record<string, unknown>) => (await preview('add-ad-targets', args)).error
    expect(await refused({ adGroupId: 'g-auto', keywords: [{ text: 'x', matchType: 'EXACT' }] })).toMatch(/its campaign is an automatic one/)
    expect(await refused({ adGroupId: 'g-a2', keywords: [{ text: 'Green Jacket', matchType: 'EXACT' }] })).toMatch(/exact keyword "Green Jacket" is already in this ad group, enabled/)
    expect(await refused({ adGroupId: 'g-fl', keywords: [{ text: 'x', matchType: 'EXACT' }] })).toMatch(/are at the floor \(a temporary stop, by user:u-person\).*startAtFloor: true/)
    expect((await preview('add-ad-targets', { adGroupId: 'g-fl', keywords: [{ text: 'x', matchType: 'EXACT' }], startAtFloor: true })).ok).toBe(true)
    expect(await refused({ adGroupId: 'g-a1', keywords: [{ text: 'B0ABCDEFGH', matchType: 'EXACT' }] })).toMatch(/is an ASIN, a product: name it in productTargets/)
    expect(await refused({ adGroupId: 'g-a1', keywords: [{ text: 'a b c d e f g h i j k', matchType: 'BROAD' }] })).toMatch(/more than 10 words/)
    expect(await refused({ adGroupId: 'nope', keywords: [{ text: 'x', matchType: 'EXACT' }] })).toBe('Not queued: ad group nope was not found in this business.')
  })

  it("rules 2 and 3 — what this product buys elsewhere waits for skip or accept (never by rule); another product's keyword is allowed", async () => {
    const args = { adGroupId: 'g-a1', keywords: [{ text: 'green jacket', matchType: 'PHRASE' }, { text: 'red boots', matchType: 'EXACT' }], bidCents: 30 }
    expect((await preview('add-ad-targets', args)).error).toMatch(/^Not queued: this product already buys phrase keyword "green jacket" in ad group "group g-a2" \(campaign "Test c-a"\)/)
    const skip = await preview('add-ad-targets', { ...args, sameProductTerms: 'skip' })
    expect(skip.preview).toMatchObject({ totals: { targets: 1, leftOut: 1 }, sameProductClashes: [], leftOut: [{ target: 'phrase keyword "green jacket"', keepsRunningIn: ['ad group "group g-a2" (campaign "Test c-a")'] }] })
    const accept = await preview('add-ad-targets', { ...args, sameProductTerms: 'accept' })
    expect(accept.preview.sameProductClashes).toHaveLength(1)
    expect(judge('add-ad-targets', accept.preview, { maxItems: 5, maxBidCents: 100, markets: ['IT'], matchTypes: ['EXACT', 'PHRASE'] })).toMatch(/already buys in another ad group \(accepted\)/)
    const accepted = await ask('add-ad-targets', { ...args, sameProductTerms: 'accept' })
    expect(await approveByRule(accepted.approvalId!)).toMatchObject({ ok: false, error: expect.stringMatching(/^Not run: it adds what this product already buys elsewhere \(accepted\), which a person decides, never a rule/) })
  })

  it('approved with the code: created at Amazon as the approver on the change set; undo lowers them to the stop bid', async () => {
    const asked = await ask('add-ad-targets', { adGroupId: 'g-a3', keywords: [{ text: 'rain boots', matchType: 'EXACT', bidCents: 35 }], productTargets: [{ asin: 'B0OTHERDD1', bidCents: 20 }] })
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: false, status: 'pending', error: expect.stringMatching(/^Not run: it adds 2 targets that start spending, and that runs only when a person/) })
    await withCode(asked.approvalId!)
    const done = await approve(asked.approvalId!)
    expect(done).toMatchObject({ ok: true, status: 'executed', result: { added: 2, reachedAmazon: 2 } })
    const made = await sql<{ id: string; bidCents: number; externalTargetId: string | null }>(`SELECT id, "bidCents", "externalTargetId" FROM "AdTarget" WHERE "adGroupId" = 'g-a3' AND NOT "isNegative" AND "expressionValue" IN ('rain boots', 'B0OTHERDD1') ORDER BY "bidCents" DESC`)
    expect(made.map((t) => t.bidCents)).toEqual([35, 20])
    expect(made.every((t) => !!t.externalTargetId)).toBe(true)
    expect((await writesOf(asked.approvalId!)).map((w) => w.entityId).sort()).toEqual(made.map((t) => t.id).sort())
    expect(await inside(() => adDeliveryOf(asked.approvalId!, 'add-ad-targets', { reach: { reach: 'sandbox' } }))).toMatchObject({ created: { total: 2 } })
    const undo = await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))
    expect(undo).toMatchObject({ request: { tool: 'bulk-ad-bid-change', args: { bids: expect.arrayContaining(made.map((t) => ({ targetId: t.id, stop: true }))) } } })
  })

  it('born at the floor: a plain approve runs it (nothing adds spend); its undo has nothing to lower', async () => {
    const asked = await ask('add-ad-targets', { adGroupId: 'g-a3', keywords: [{ text: 'snow boots', matchType: 'EXACT', bidCents: 60 }], startAtFloor: true })
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed', result: { added: 1, targets: [{ bidCents: 5, plannedBidCents: 60 }] } })
    expect(await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))).toMatchObject({ error: expect.stringMatching(/sits at the 5-cent floor already: there is nothing to lower/) })
  })
})

describe('harvest-search-term', () => {
  it('rule 2 — a term that converts in its source is never negated there (harvested away); without the negative it is harvested', async () => {
    const converting = await preview('harvest-search-term', { query: 'blue jacket', sourceAdGroupId: 'g-a1', destAdGroupId: 'g-a3' })
    expect(converting.error).toMatch(/^Not queued: "blue jacket" converts where it runs — "blue jacket" in ad group "group g-a1" .*: 3 orders over the last 60 days — so negating it there would harvest a winner away/)
    const kept = await preview('harvest-search-term', { query: 'blue jacket', sourceAdGroupId: 'g-a1', destAdGroupId: 'g-a3', negateSource: false })
    expect(kept.ok, kept.error).toBe(true)
    expect(kept.preview).toMatchObject({ negateSource: 'none', bidCents: 75, changes: [{ label: 'exact keyword "blue jacket" · ad group "group g-a3" (campaign "Test c-a")' }] })
  })

  it('refuses a term that did not run there, one at home already for the same product, a destination that is its own source', async () => {
    expect((await preview('harvest-search-term', { query: 'never ran', sourceAdGroupId: 'g-a1', destAdGroupId: 'g-a3' })).error).toMatch(/did not run in ad group "group g-a1" .*To add a keyword of your own, ask add-ad-targets/)
    expect((await preview('harvest-search-term', { query: 'green jacket', sourceAdGroupId: 'g-a1', destAdGroupId: 'g-a3', negateSource: false })).error).toMatch(/already lives in Test c-a › group g-a2, which advertises the same product.*a winner stays where it is/)
    expect((await preview('harvest-search-term', { query: 'red jacket', sourceAdGroupId: 'g-a1', destAdGroupId: 'g-a1' })).error).toMatch(/lands in ad group "group g-a1" .*the ad group the term ran in: a negative there would block it/)
  })

  it('one step: the keyword, then the source negative, both on the change set; like graduate-keyword it needs no code; undo puts both back', async () => {
    const r = await preview('harvest-search-term', { query: 'wool jacket', sourceAdGroupId: 'g-a1', destAdGroupId: 'g-a3' })
    expect(r.preview).toMatchObject({ negateSource: 'add', bidCents: 120, raises: ['exact keyword "wool jacket" at EUR 1.20'], limitFacts: { action: 'harvest', this: { items: 2, raises: 1, cuts: 1 } } })
    expect(r.preview).not.toHaveProperty('stepUp')
    const asked = await ask('harvest-search-term', { query: 'wool jacket', sourceAdGroupId: 'g-a1', destAdGroupId: 'g-a3' })
    const done = await approve(asked.approvalId!)
    expect(done).toMatchObject({ ok: true, status: 'executed', result: { keyword: { bidCents: 120, reachedAmazon: true }, sourceNegative: { targetId: expect.any(String) } } })
    const keywordId = done.result.keyword.targetId as string
    const negativeId = done.result.sourceNegative.targetId as string
    expect(await target(keywordId)).toMatchObject({ adGroupId: 'g-a3', expressionValue: 'wool jacket', expressionType: 'EXACT', bidCents: 120, isNegative: false })
    expect(await target(negativeId)).toMatchObject({ adGroupId: 'g-a1', expressionValue: 'wool jacket', isNegative: true })
    expect((await writesOf(asked.approvalId!)).map((w) => w.entityId)).toEqual([keywordId, negativeId])
    const undo = await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))
    expect(undo).toMatchObject({ request: { tool: 'harvest-search-term', args: { op: 'undo', changeSetId: asked.approvalId, keywordId, negativeId } } })
    const undoPreview = await preview('harvest-search-term', undo.request!.args)
    expect(undoPreview.preview).toMatchObject({ op: 'undo', raises: [], effect: expect.stringMatching(/from EUR 1\.20 to the stop bid.*the negative "wool jacket" .* retired, so the term runs there again/) })
    expect(judge('harvest-search-term', undoPreview.preview, { maxItems: 5, markets: ['IT'], maxStartBidCents: 500 })).toMatch(/an undo of a harvest lifts the negative it made/)
    const undoAsked = await ask('harvest-search-term', undo.request!.args)
    expect(await approve(undoAsked.approvalId!)).toMatchObject({ ok: true, status: 'executed', result: { lowered: true, retired: true } })
    expect((await target(keywordId))?.bidCents).toBe(5)
    // Sandbox: Amazon never had the negative, so its retire removes Nexus's row (live, it would be archived at Amazon).
    expect(await target(negativeId)).toBeNull()
  })
})

describe('set-harvest-destination', () => {
  it('Nexus only: from → to, stored as the approver; a harvest then lands there with its own choice of the source negative; undo removes it', async () => {
    const r = await preview('set-harvest-destination', { scope: 'adGroup', scopeId: 'g-a1', adGroupId: 'g-a2', negateAtSource: false })
    expect(r.ok, r.error).toBe(true)
    expect(r.preview).toMatchObject({
      action: 'set-harvest-destination', market: 'IT', from: null, to: { adGroupId: 'g-a2', negateAtSource: false }, raises: [],
      reachNote: 'Nexus only: nothing is sent to Amazon by this change.', effect: expect.stringMatching(/^Sets where a harvested exact keyword lands for source ad group "group g-a1" .*Nexus only/),
    })
    expect(r.preview).not.toHaveProperty('reach')
    const asked = await ask('set-harvest-destination', { scope: 'adGroup', scopeId: 'g-a1', adGroupId: 'g-a2', negateAtSource: false })
    expect(await approve(asked.approvalId!)).toMatchObject({ ok: true, status: 'executed', result: { set: true } })
    const stored = await sql<{ adGroupId: string; negateAtSource: boolean; updatedBy: string }>(`SELECT "adGroupId", "negateAtSource", "updatedBy" FROM "AdsHarvestDestination" WHERE "scopeGrain" = 'adGroup' AND "scopeId" = 'g-a1'`)
    expect(stored).toEqual([{ adGroupId: 'g-a2', negateAtSource: false, updatedBy: 'user:u-approver' }])
    // A harvest from that source with no destination named lands there, and keeps the source as the destination says.
    const h = await preview('harvest-search-term', { query: 'warm jacket', sourceAdGroupId: 'g-a1' })
    expect(h.preview).toMatchObject({ destinationAdGroup: { id: 'g-a2', why: 'the harvest destination stored for this source' }, negateSource: 'none' })
    expect((await preview('set-harvest-destination', { scope: 'adGroup', scopeId: 'g-a1', adGroupId: 'g-a2', negateAtSource: false })).error).toMatch(/^Nothing would change/)
    const undo = await inside(() => undoRequestFor({ approvalId: asked.approvalId! }))
    expect(undo).toMatchObject({ request: { tool: 'set-harvest-destination', args: { scope: 'adGroup', scopeId: 'g-a1', matchType: 'EXACT', remove: true } } })
  })

  it('refuses a destination outside a manual campaign, and a removal of nothing', async () => {
    expect((await preview('set-harvest-destination', { scope: 'campaign', scopeId: 'c-a', adGroupId: 'g-auto' })).error).toMatch(/is not in a manual campaign \(Amazon reports it as AUTO\)/)
    expect((await preview('set-harvest-destination', { scope: 'campaign', scopeId: 'c-b', remove: true })).error).toMatch(/^Nothing would change: no exact harvest destination is stored/)
    expect((await preview('set-harvest-destination', { scope: 'campaign', scopeId: 'nope', adGroupId: 'g-a2' })).error).toBe('Not queued: campaign nope was not found in this business.')
  })
})

describe('the plan path', () => {
  it('submit-change-plan: a step that adds spend carries its code onto the plan; approved with it, every step runs', async () => {
    const boss = await inside(() => realPerson('Test Plan Approver'))
    const queued = await inside(async () => {
      const run = await database.client.agentRun.create({ data: { agentKey: 'mcp', trigger: 'manual', status: 'done', via: 'claude', userId: claude.userId } })
      return queuePlan({
        title: 'Test targeting plan',
        steps: [
          { tool: 'add-negative-targets', args: { adGroupIds: ['g-a3'], keywords: [{ text: 'plan socks' }] } },
          { tool: 'add-ad-targets', args: { adGroupId: 'g-a3', keywords: [{ text: 'plan boots', matchType: 'EXACT', bidCents: 33 }] } },
        ],
      }, claude, run.id)
    })
    expect(queued).toMatchObject({ ok: true, mode: 'queued', preview: { stepUp: { what: 'adds 1 target that starts spending at its bid', raises: ['Bids', 'Spend'], steps: [2] } } })
    const planId = queued.approvalId!
    const decide = (code?: string) => inside(() => decideFleetApproval({ id: planId, decision: 'approve', actor: boss.principal, ...(code ? { code } : {}) }))
    expect(await decide()).toMatchObject({ ok: false, code: 'mfa_required' })
    expect(await decide(codeOf(boss))).toMatchObject({ ok: true, status: 'scheduled' })
    expect(await commitNow(planId)).toMatchObject({ ok: true, status: 'executing' })
    expect(await inside(() => runPlan(planId))).toMatchObject({ finished: true, counts: { done: 2 } })
    expect((await sql(`SELECT id FROM "AdTarget" WHERE "adGroupId" = 'g-a3' AND "expressionValue" IN ('plan socks', 'plan boots')`)).length).toBe(2)
  })
})
