/**
 * MCP full control R18 — save-ops-rule, through the one door, on a real PostgreSQL (PGlite).
 *
 * Proven: each domain's own triggers, actions and permission; never a pause; conditions and a daily run cap required
 * (and a value cap for replenishment); a new rule is born OBSERVE (a review rule OFF: its actions call the AI even dry);
 * an AUTO rule's edit drops it to PROPOSE; undo saves the rule as it was or retires a created one to OFF; a rule of
 * another domain or another business is not found.
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
import { guardOpsRule } from '../../automation/ops-rule-save.service.js'

const A = LEGACY_WORKSPACE_ID
const OTHER = 'ws_r18_other'
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(work: () => Promise<T>, workspaceId = A) => withWorkspace(business(workspaceId), work)
const all = new Set<string>([...Object.values(FEATURES), ...Object.values(FIELDS)])
const personWith = (permissions: Set<string>): UserPrincipal => ({ kind: 'user', userId: 'u-r18', label: 'R18 test', permissions: { isOwner: false, permissions }, workspace: business(A), via: 'claude' })
const person = personWith(all)
type Out = { ok: boolean; error?: string; preview?: Record<string, any>; data?: Record<string, any>; change?: { before: any; after: any } }
const dry = async (args: Record<string, unknown>, who = person) => (await callTool(who, 'save-ops-rule', args)).raw as Out
const run = async (args: Record<string, unknown>) => (await executeTool(person, 'save-ops-rule', args, { via: 'claude' })).raw as Out
const tool = () => getTool('save-ops-rule')!
const ids: Record<string, string> = {}
const sku = [{ field: 'product.sku', op: 'eq', value: 'TEST-SKU-1' }]
const restock = { domain: 'replenishment', name: 'TEST restock', trigger: 'recommendation_generated', conditions: sku, actions: [{ type: 'auto_approve_recommendation' }], maxExecutionsPerDay: 10, maxValueCentsEur: 50_000 }

beforeAll(async () => {
  database = await formulaDatabase()
  await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING`, [OTHER])
  await inside(async () => {
    const db = database.client
    ids.auto = (await db.automationRule.create({ data: { domain: 'listings', name: 'TEST live listing rule', trigger: 'inventory_low', enabled: true, dryRun: false, autonomyLevel: 'AUTO', conditions: sku, actions: [{ type: 'sync_inventory_to_marketplaces' }], maxExecutionsPerDay: 5 } })).id
    ids.ads = (await db.automationRule.create({ data: { domain: 'advertising', name: 'TEST ads rule', trigger: 'SCHEDULE', actions: [{ type: 'notify' }] } })).id
  })
  await inside(async () => { ids.other = (await database.client.automationRule.create({ data: { domain: 'replenishment', name: 'TEST other business rule', trigger: 'cron_tick', actions: [{ type: 'notify' }] } })).id }, OTHER)
}, 180_000)
afterAll(async () => {
  await database?.close()
}, 30_000)

describe('R18 — the operations rule guard', () => {
  const draft = (patch: Record<string, unknown>) => ({ domain: 'replenishment' as const, opsRuleId: null, name: 'x', description: null, trigger: 'cron_tick', conditions: sku, actions: [{ type: 'notify' }], maxExecutionsPerDay: 5, maxValueCentsEur: 100, ...patch })
  it('refuses a pause, a foreign trigger or action, no conditions, no caps', () => {
    expect(guardOpsRule('bulk-operations', { ...draft({ trigger: 'bulk_cron_tick', actions: [{ type: 'pause_schedules_matching' }] }), domain: 'bulk-operations' }))
      .toEqual(['pause_schedules_matching: refused — Claude never pauses (Owner rule); a person sets that in Nexus'])
    expect(guardOpsRule('replenishment', draft({ trigger: 'inventory_low' })).join(' ')).toContain('trigger: one of recommendation_generated')
    expect(guardOpsRule('replenishment', draft({ actions: [{ type: 'sync_price_to_marketplaces' }] })).join(' ')).toContain('sync_price_to_marketplaces: not an action a replenishment rule may carry')
    expect(guardOpsRule('replenishment', draft({ conditions: [] }))).toEqual(['conditions: at least one — an empty list matches everything'])
    expect(guardOpsRule('replenishment', draft({ maxExecutionsPerDay: null, maxValueCentsEur: 0 })).join(' ')).toMatch(/maxExecutionsPerDay: required.*maxValueCentsEur: required/)
    expect(guardOpsRule('listings', { ...draft({ trigger: 'inventory_low', maxValueCentsEur: null }), domain: 'listings' })).toEqual([])
  })
})

describe('R18 — save-ops-rule', () => {
  it('each domain needs its own permission', async () => {
    const noRestock = personWith(new Set([...all].filter((p) => p !== FEATURES.replenishmentRun)))
    expect((await dry(restock, noRestock)).error).toBe('Saving a replenishment rule needs the replenishment.run permission.')
    expect((await dry({ domain: 'listings', name: 'x', trigger: 'inventory_low', conditions: sku, actions: [{ type: 'notify' }], maxExecutionsPerDay: 3 }, noRestock)).ok).toBe(true)
  })

  it('a new rule is born OBSERVE (a review rule OFF); undo retires it to OFF', async () => {
    const preview = await dry(restock)
    expect(preview.preview).toMatchObject({ action: 'save-ops-rule', domain: 'replenishment', automation: 'N6', rule: { id: null, name: 'TEST restock' }, level: { from: null, to: 'OBSERVE' } })
    const made = await run(restock)
    expect(made.ok).toBe(true)
    expect(await inside(() => database.client.automationRule.findUniqueOrThrow({ where: { id: made.data!.opsRuleId } }))).toMatchObject({ domain: 'replenishment', enabled: true, dryRun: true, autonomyLevel: 'OBSERVE', createdBy: 'user:u-r18' })
    const back = tool().undo!.request(made.change!) as { tool: string; args: Record<string, unknown> }
    expect(back).toEqual({ tool: 'turn-down-automation', args: { automation: 'N6', rowId: made.data!.opsRuleId, level: 'OFF' } })
    expect(getTool('turn-down-automation')!.input.safeParse(back.args).success).toBe(true)

    const review = await run({ domain: 'reviews', name: 'TEST review ideas', trigger: 'REVIEW_SPIKE_DETECTED', conditions: [{ field: 'spike.count', op: 'gte', value: 3 }], actions: [{ type: 'create_aplus_module_from_review' }], maxExecutionsPerDay: 2 })
    expect(review.ok).toBe(true)
    expect(await inside(() => database.client.automationRule.findUniqueOrThrow({ where: { id: review.data!.opsRuleId } }))).toMatchObject({ enabled: false, autonomyLevel: 'OFF' })
    expect((tool().undo!.request(review.change!) as { refusal: string }).refusal).toContain('was created switched off')
  })

  it("an AUTO rule's edit drops it to PROPOSE; undo saves it as it was (its level stays a person's)", async () => {
    const edited = await run({ domain: 'listings', opsRuleId: ids.auto, maxExecutionsPerDay: 3 })
    expect(edited).toMatchObject({ ok: true, data: { level: { from: 'AUTO', to: 'PROPOSE' }, changes: { maxExecutionsPerDay: { from: 5, to: 3 } } } })
    expect(await inside(() => database.client.automationRule.findUniqueOrThrow({ where: { id: ids.auto } }))).toMatchObject({ autonomyLevel: 'PROPOSE', dryRun: true, enabled: true, maxExecutionsPerDay: 3 })
    expect(await inside(() => tool().undo!.current(edited.change!))).toEqual(edited.change!.after)
    const back = tool().undo!.request(edited.change!) as { tool: string; args: Record<string, unknown> }
    expect(back.tool).toBe('save-ops-rule')
    expect(back.args).toMatchObject({ domain: 'listings', opsRuleId: ids.auto, maxExecutionsPerDay: 5 })
    expect(tool().input.safeParse(back.args).success).toBe(true)
    expect((await run(back.args)).ok).toBe(true)
  })

  it('a rule of another domain or another business is not found', async () => {
    expect((await dry({ domain: 'replenishment', opsRuleId: ids.ads, description: 'x' })).error).toBe(`There is no replenishment rule ${ids.ads} in this business (not found).`)
    expect((await dry({ domain: 'replenishment', opsRuleId: ids.other, description: 'x' })).error).toBe(`There is no replenishment rule ${ids.other} in this business (not found).`)
  })
})
