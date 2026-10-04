/**
 * MCP full control R6 — `list-automations` and `automation-detail`, through the one door (call-tool.ts), on a real
 * PostgreSQL (PGlite, production schema). No mocked query.
 *
 * Proven here: a person sees exactly the automations of the areas they may view (the rest are counted, never named,
 * and detail refuses them); money in caps and ceilings reaches only a person with financials.adspend.view; a rule
 * opens in full with its conditions in words and its graduation gate; another business's row is not found.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))
// No Redis in this test: nothing here queues, and a connection attempt would only add noise.
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

import { callTool, type UserPrincipal } from '../call-tool.js'
import { getTool } from '../tool-registry.js'

const A = LEGACY_WORKSPACE_ID
const OTHER = 'ws_r6_other'
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(workspaceId: string, work: () => Promise<T>) => withWorkspace(business(workspaceId), work)

function principal(permissions: string[], workspaceId = A): UserPrincipal {
  return { kind: 'user', userId: 'u-r6', label: 'R6 test', permissions: { isOwner: false, permissions: new Set(permissions) }, workspace: business(workspaceId), via: 'claude' }
}
const everything = (workspaceId = A) => principal([...Object.values(FEATURES), ...Object.values(FIELDS)], workspaceId)
/** Ads only, and no money. */
const adsOnly = principal([FEATURES.aiRun, FEATURES.aiView, FEATURES.adsView])

type Row = Record<string, any>
async function call(tool: string, args: Record<string, unknown>, who: UserPrincipal = everything()): Promise<{ ok: boolean; error?: string; data?: Row }> {
  return (await callTool(who, tool, args)).visible as { ok: boolean; error?: string; data?: Row }
}

const ids: Record<string, string> = {}

beforeAll(async () => {
  database = await formulaDatabase()
  const db = database.client
  await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING`, [OTHER])
  await inside(A, async () => {
    ids.rule = (await db.automationRule.create({ data: {
      domain: 'advertising', name: 'TEST budget guard', trigger: 'SCHEDULE', enabled: true, autonomyLevel: 'OBSERVE',
      conditions: [{ field: 'campaign.acos', op: 'gt', value: 0.4 }], actions: [{ type: 'adjust_ad_budget', percent: -10 }],
      maxExecutionsPerDay: 7, maxValueCentsEur: 900,
    } })).id
    ids.pool = (await db.budgetPool.create({ data: { name: 'TEST pool', totalDailyBudgetCents: 5000, enabled: true, dryRun: true } })).id
    await db.adsAutomationState.create({ data: { id: 'singleton', autonomy: 'SUGGEST', maxHourlySpendCentsEur: 12_345 } })
  })
  await inside(OTHER, async () => {
    ids.otherRule = (await db.automationRule.create({ data: { domain: 'advertising', name: 'TEST other business rule', trigger: 'SCHEDULE' } })).id
  })
}, 180_000)

afterAll(async () => {
  await database?.close()
}, 30_000)

describe('R6 — list-automations', () => {
  it('a person who may see everything sees all 39, at their levels, and nothing hidden', async () => {
    const out = await call('list-automations', {})
    expect(out.ok).toBe(true)
    expect(out.data!.items).toHaveLength(39)
    expect(out.data!.hidden).toBe(0)
    const a1 = out.data!.items.find((e: Row) => e.id === 'A1')
    expect(a1).toMatchObject({ key: 'ads-rules', name: 'Amazon ads rules', business: { level: 'OBSERVE' } })
    expect(a1.sample).toEqual([{ id: ids.rule, name: 'TEST budget guard', level: 'OBSERVE' }])
    // The area and level filters narrow the list.
    const pricing = await call('list-automations', { area: 'pricing' })
    expect(pricing.data!.items.map((e: Row) => e.id)).toEqual(['N1', 'N2', 'N3'])
  })

  it('rows filter: a person with ads.view only sees the ads automations; the rest are counted, never named', async () => {
    const out = await call('list-automations', {}, adsOnly)
    const shown = out.data!.items.map((e: Row) => e.id)
    // ai.view (which the tool itself needs) also shows the agent fleet and the autonomous agents.
    expect(shown).toEqual(['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'A10', 'A11', 'A12', 'A13', 'A14', 'A15', 'A16', 'A17', 'A18', 'E1', 'F1', 'F2'])
    expect(out.data!.hidden).toBe(18)
    const text = JSON.stringify(out)
    expect(text).not.toContain('Repricing rules')
    expect(text).not.toContain('Replenishment rules')
    // Detail refuses an automation of another area, naming the permission it needs.
    const refused = await call('automation-detail', { automation: 'N1' }, adsOnly)
    expect(refused).toEqual({ ok: false, error: 'Repricing rules needs the repricing.view permission.' })
  })

  it('money filter: caps and spend limits reach only a person with financials.adspend.view', async () => {
    const withMoney = await call('list-automations', { area: 'amazon-ads' })
    const noMoney = await call('list-automations', { area: 'amazon-ads' }, adsOnly)
    const a3 = (out: { data?: Row }) => out.data!.items.find((e: Row) => e.id === 'A3')
    // 1b — the per-engine hourly breaker limits are counts, not money: both readers see them.
    const engineChangesPerHour = expect.objectContaining({ 'rank-defend': 1200, unknown: 300 })
    expect(a3(withMoney).caps).toEqual({ maxActionsPerHour: 250, maxHourlySpendCentsEur: 12_345, defaultTargetAcosPct: null, engineChangesPerHour })
    expect(a3(noMoney).caps).toEqual({ maxActionsPerHour: 250, engineChangesPerHour })

    const poolWith = await call('automation-detail', { automation: 'A9' })
    const poolWithout = await call('automation-detail', { automation: 'A9' }, adsOnly)
    expect(poolWith.data!.rows[0].caps).toMatchObject({ totalDailyBudgetCents: 5000, maxShiftPerRebalancePct: 20 })
    expect(poolWithout.data!.rows[0].caps).not.toHaveProperty('totalDailyBudgetCents')
    expect(poolWithout.data!.rows[0].caps).toHaveProperty('maxShiftPerRebalancePct')

    const ruleWith = await call('automation-detail', { automation: 'A1', rowId: ids.rule })
    const ruleWithout = await call('automation-detail', { automation: 'A1', rowId: ids.rule }, adsOnly)
    expect(ruleWith.data!.row.caps).toMatchObject({ perExecutionCents: 900 })
    expect(JSON.stringify(ruleWithout)).not.toMatch(/perExecutionCents|maxValueCentsEur/)
    expect(ruleWithout.data!.row.caps).toMatchObject({ perDay: 7 })
  })
})

describe('R6 — automation-detail', () => {
  it('an automation with its rows, and one rule in full: conditions in words, window, caps, reach and the graduation gate', async () => {
    const out = await call('automation-detail', { automation: 'ads-rules' })
    expect(out.data!.automation).toMatchObject({ id: 'A1', business: { level: 'OBSERVE' } })
    expect(out.data!.rows.map((r: Row) => r.name)).toEqual(['TEST budget guard'])

    const rule = await call('automation-detail', { automation: 'A1', rowId: ids.rule })
    expect(rule.ok).toBe(true)
    expect(rule.data!.row).toMatchObject({
      id: ids.rule, name: 'TEST budget guard', level: 'OBSERVE', trigger: 'SCHEDULE',
      conditions: [{ field: 'campaign.acos', op: 'gt', value: 0.4 }], actions: [{ type: 'adjust_ad_budget', percent: -10 }],
      graduationGate: { gateOpen: false, observationDaysRequired: 14 },
    })
    expect(typeof rule.data!.row.conditionsText).toBe('string')
    expect(rule.data!.row.conditionsText.length).toBeGreaterThan(0)
  })

  it("a row of another business, or none at all, is not found; an automation with no rows says how it is set", async () => {
    expect(await call('automation-detail', { automation: 'A1', rowId: ids.otherRule })).toEqual({ ok: false, error: `Amazon ads rules has no row ${ids.otherRule} in this business (not found).` })
    expect((await call('automation-detail', { automation: 'A1', rowId: 'nope' })).ok).toBe(false)
    // The same id inside its own business is found (control).
    expect((await call('automation-detail', { automation: 'A1', rowId: ids.otherRule }, everything(OTHER))).data!.row.name).toBe('TEST other business rule')
    const tos = await call('automation-detail', { automation: 'A11' })
    expect(tos.data).toMatchObject({ rows: null, rowsNote: expect.stringContaining('no rows of its own') })
  })

  it('an unknown automation is refused by the schema, and both tools are read-only, Nexus-only reads', async () => {
    await expect(callTool(everything(), 'automation-detail', { automation: 'Z9' })).rejects.toMatchObject({ code: 'invalid_arguments' })
    for (const name of ['list-automations', 'automation-detail']) {
      const tool = getTool(name)!
      expect(tool).toMatchObject({ readOnly: true, openWorld: false, requires: [FEATURES.aiView] })
      expect(tool.execute).toBeUndefined()
    }
  })
})
