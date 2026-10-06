/**
 * MCP full control R9 — save-ad-rule, through the one door (call-tool.ts: the dry run a person approves, then the
 * approved run), on a real PostgreSQL (PGlite, production schema).
 *
 * Proven: a new Amazon or marketing rule is born OBSERVE and an eBay rule OFF; an edit of an AUTO rule drops it to
 * PROPOSE (Amazon and eBay); the guard refuses a pause before anything waits for a person; the preview names the rule's
 * `basis`, which moves when someone edits the rule; undo puts the previous rule back through save-ad-rule itself;
 * another business's rule is not found; every save leaves its audit row.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))
vi.mock('../../../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: true, status: 'ready' }),
    resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: { connection: null },
  }
})

import { callTool, executeTool, type UserPrincipal } from '../call-tool.js'
import { getTool } from '../tool-registry.js'

const A = LEGACY_WORKSPACE_ID
const OTHER = 'ws_r9_other'
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(work: () => Promise<T>, workspaceId = A) => withWorkspace(business(workspaceId), work)
const person: UserPrincipal = {
  kind: 'user', userId: 'u-r9', label: 'R9 test', permissions: { isOwner: false, permissions: new Set([...Object.values(FEATURES), ...Object.values(FIELDS)]) },
  workspace: business(A), via: 'claude',
}
type Out = { ok: boolean; error?: string; preview?: Record<string, any>; data?: Record<string, any>; change?: { before: any; after: any } }
const dry = async (args: Record<string, unknown>) => (await callTool(person, 'save-ad-rule', args)).raw as Out
const run = async (args: Record<string, unknown>) => (await executeTool(person, 'save-ad-rule', args, { via: 'claude' })).raw as Out

const amazonRule = {
  kind: 'amazon-ads', name: 'TEST lower bids on high ACOS', trigger: 'KEYWORD_HIGH_ACOS',
  conditions: [{ field: 'adTarget.acos', op: 'gt', value: 0.45 }], actions: [{ type: 'bid_down', percent: 10 }],
  scope: { marketplace: 'IT' }, caps: { maxExecutionsPerDay: 50, maxWritesPerDay: 20, maxValueCentsEur: 500 },
}
const ids: Record<string, string> = {}

beforeAll(async () => {
  database = await formulaDatabase()
  await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING`, [OTHER])
  await inside(async () => {
    await database.client.campaign.create({ data: { name: 'TEST CAMPAIGN', type: 'SP', dailyBudget: '10.00', startDate: new Date('2026-01-01T00:00:00Z'), marketplace: 'IT', externalCampaignId: 'TEST-CMP-1' } })
    // 4c — a rule scoped to IT needs a market an active Amazon Ads connection serves, or its save is refused.
    await database.client.amazonAdsConnection.create({ data: { profileId: 'TEST-PROFILE-IT', marketplace: 'IT', isActive: true } })
    ids.auto = (await database.client.automationRule.create({ data: {
      domain: 'advertising', name: 'TEST auto rule', trigger: 'KEYWORD_HIGH_ACOS', enabled: true, dryRun: false, autonomyLevel: 'AUTO',
      conditions: [{ field: 'adTarget.acos', op: 'gt', value: 0.6 }], actions: [{ type: 'bid_down', percent: 5 }],
      scopeMarketplace: 'IT', maxExecutionsPerDay: 10, maxWritesPerDay: 5, maxValueCentsEur: 300,
    } })).id
    ids.ebayAuto = (await database.client.ebayAdsRule.create({ data: {
      name: 'TEST eBay autopilot', enabled: true, mode: 'AUTOPILOT', marketplace: 'EBAY_IT', cooldownHours: 24,
      trigger: { scope: 'CPS_AD', all: [{ metric: 'clicks', windowDays: 14, op: 'gte', threshold: 30 }] }, action: { type: 'adjust_ad_rate', deltaPct: -10 }, guardrails: { maxActionsPerRun: 5 },
    } })).id
  })
  await inside(() => database.client.automationRule.create({ data: { id: 'tst-r9-other', domain: 'advertising', name: 'TEST other business rule', trigger: 'SCHEDULE' } }), OTHER)
}, 180_000)
afterAll(async () => {
  await database?.close()
}, 30_000)

describe('R9 — save-ad-rule', () => {
  it('a new Amazon rule: the preview says OBSERVE and its reach; the approved run saves it OBSERVE, with its audit row', async () => {
    const preview = await dry(amazonRule)
    expect(preview.ok).toBe(true)
    expect(preview.preview).toMatchObject({
      action: 'save-ad-rule', kind: 'amazon-ads', mode: 'create', ruleId: null, basis: null,
      level: { from: null, to: 'OBSERVE' }, reach: { campaigns: 1, total: 1 },
      changes: { name: { from: null, to: 'TEST lower bids on high ACOS' }, trigger: { from: null, to: 'KEYWORD_HIGH_ACOS' } },
    })
    const out = await run(amazonRule)
    expect(out).toMatchObject({ ok: true, data: { level: 'OBSERVE', created: true }, change: { before: { kind: 'amazon-ads', created: true }, after: { name: 'TEST lower bids on high ACOS' } } })
    // Its undo retires it to OFF.
    expect(getTool('save-ad-rule')!.undo!.request(out.change!)).toEqual({ tool: 'turn-down-automation', args: { automation: 'A1', rowId: out.data!.ruleId, level: 'OFF' } })
    ids.created = out.data!.ruleId
    const stored = await inside(() => database.client.automationRule.findUniqueOrThrow({ where: { id: ids.created } }))
    expect(stored).toMatchObject({ domain: 'advertising', enabled: true, dryRun: true, autonomyLevel: 'OBSERVE', scopeMarketplace: 'IT', maxWritesPerDay: 20, maxValueCentsEur: 500 })
    const audit = await inside(() => database.client.advertisingActionLog.findMany({ where: { entityId: ids.created } }))
    expect(audit.map((a) => [a.actionType, a.userId])).toEqual([['create_rule', 'user:u-r9']])
  })

  it('never pause: a pausing rule is refused before anything waits for a person, naming the substitute', async () => {
    const out = await dry({ ...amazonRule, actions: [{ type: 'pause_campaign' }] })
    expect(out.ok).toBe(false)
    expect(out.error).toContain('pause_campaign: refused — it pauses — a rule never pauses (Owner rule: a temporary stop is lower bids); use lower_bid_to_floor')
  })

  it('an edit of an AUTO rule drops it to PROPOSE; its basis moves when someone else edits it; undo puts the rule back', async () => {
    const edit = { kind: 'amazon-ads', ruleId: ids.auto, conditions: [{ field: 'adTarget.acos', op: 'gt', value: 0.5 }] }
    const first = await dry(edit)
    expect(first.preview).toMatchObject({ mode: 'edit', level: { from: 'AUTO', to: 'PROPOSE' }, changes: { conditions: { from: [{ field: 'adTarget.acos', op: 'gt', value: 0.6 }], to: [{ field: 'adTarget.acos', op: 'gt', value: 0.5 }] } } })
    // Someone edits the rule after the preview: the basis moves, so the approval would be stale (MATERIAL_PREVIEW_FIELDS).
    await new Promise((r) => setTimeout(r, 5))
    await inside(() => database.client.automationRule.update({ where: { id: ids.auto }, data: { description: 'touched by a person' } }))
    const second = await dry(edit)
    expect(second.preview!.basis).not.toBe(first.preview!.basis)

    const out = await run(edit)
    expect(out).toMatchObject({ ok: true, data: { level: 'PROPOSE' } })
    expect(await inside(() => database.client.automationRule.findUniqueOrThrow({ where: { id: ids.auto } }))).toMatchObject({ autonomyLevel: 'PROPOSE', dryRun: true, enabled: true })

    // Undo: what is stored now is what the change wrote, so the request is save-ad-rule with the rule as it was.
    const tool = getTool('save-ad-rule')!
    expect(await inside(() => tool.undo!.current(out.change!))).toEqual(out.change!.after)
    const request = tool.undo!.request(out.change!)
    expect(request).toMatchObject({ tool: 'save-ad-rule', args: { ruleId: ids.auto, conditions: [{ field: 'adTarget.acos', op: 'gt', value: 0.6 }] } })
    const undone = await run((request as { args: Record<string, unknown> }).args)
    expect(undone.ok).toBe(true)
    expect(await inside(() => database.client.automationRule.findUniqueOrThrow({ where: { id: ids.auto } }))).toMatchObject({ conditions: [{ field: 'adTarget.acos', op: 'gt', value: 0.6 }] })
    // A rule this change created is retired to OFF (turn-down-automation), never deleted.
    expect(tool.undo!.request({ before: null, after: { kind: 'amazon-ads', ruleId: 'x', name: 'New' } })).toEqual({ tool: 'turn-down-automation', args: { automation: 'A1', rowId: 'x', level: 'OFF' } })
  })

  it('a marketing rule is born OBSERVE; a new eBay rule is saved OFF; an eBay AUTOPILOT rule edited drops to PROPOSE', async () => {
    const marketing = await run({
      kind: 'marketing', name: 'TEST marketing ACOS guard', trigger: 'MKT_ACOS_BREACH', conditions: [{ field: 'campaign.acos', op: 'gt', value: 0.6 }],
      actions: [{ type: 'mkt_adjust_budget', deltaPct: -10 }], scope: { wholeAccount: true }, caps: { maxExecutionsPerDay: 5, maxWritesPerDay: 5, maxValueCentsEur: 1000 },
    })
    expect(marketing).toMatchObject({ ok: true, data: { level: 'OBSERVE' } })
    const ebay = await run({
      kind: 'ebay-ads', name: 'TEST eBay fee creep', trigger: { scope: 'CPS_AD', all: [{ metric: 'fee_pct_of_sales', windowDays: 14, op: 'gt', threshold: 20 }] },
      action: { type: 'adjust_ad_rate', deltaPct: -10, minRatePct: 2 }, guardrails: { maxActionsPerRun: 10 }, scope: { marketplace: 'EBAY_IT' }, cooldownHours: 72,
    })
    expect(ebay).toMatchObject({ ok: true, data: { level: 'OFF', created: true } })
    const edited = await run({ kind: 'ebay-ads', ruleId: ids.ebayAuto, cooldownHours: 48 })
    expect(edited).toMatchObject({ ok: true, data: { level: 'PROPOSE' } })
    expect(await inside(() => database.client.ebayAdsRule.findUniqueOrThrow({ where: { id: ids.ebayAuto } }))).toMatchObject({ mode: 'PROPOSE', enabled: true, cooldownHours: 48 })
  })

  it("another business's rule is not found; an edit that changes nothing says so", async () => {
    expect(await dry({ kind: 'amazon-ads', ruleId: 'tst-r9-other', name: 'x' })).toEqual({ ok: false, error: 'There is no Amazon ads rule tst-r9-other in this business (not found).' })
    expect((await dry({ kind: 'amazon-ads', ruleId: ids.created, name: 'TEST lower bids on high ACOS' })).error).toContain('nothing to change')
  })
})
