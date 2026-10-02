/**
 * MCP full control R12 — stop-automation / resume-automation, through the one door, on a real PostgreSQL (PGlite).
 *
 * Proven: each area stops and resumes through its own switch, with its audit; a stop is inside its limits, a resume is
 * never (it is `ask` at most); a stop's undo is a resume of exactly what it stopped (rules: the ids it switched off);
 * another business's rules are not found; a second stop says it is already stopped.
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
vi.mock('../../advertising/ads-automation-notify.service.js', () => ({ notifyAutomation: vi.fn(async () => 0), notifyAutomationDetailed: vi.fn(async () => ({ created: 0, deduped: false, wouldHaveReached: 0 })) }))

import { callTool, executeTool, type UserPrincipal } from '../call-tool.js'
import { getTool } from '../tool-registry.js'

const A = LEGACY_WORKSPACE_ID
const OTHER = 'ws_r12_other'
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(work: () => Promise<T>, workspaceId = A) => withWorkspace(business(workspaceId), work)
const person: UserPrincipal = { kind: 'user', userId: 'u-r12', label: 'R12 test', permissions: { isOwner: false, permissions: new Set([...Object.values(FEATURES), ...Object.values(FIELDS)]) }, workspace: business(A), via: 'claude' }
type Out = { ok: boolean; error?: string; preview?: Record<string, any>; data?: Record<string, any>; change?: { before: any; after: any } }
const dry = async (tool: string, args: Record<string, unknown>) => (await callTool(person, tool, args)).raw as Out
const run = async (tool: string, args: Record<string, unknown>) => (await executeTool(person, tool, args, { via: 'claude' })).raw as Out
const ids: Record<string, string> = {}

beforeAll(async () => {
  database = await formulaDatabase()
  await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING`, [OTHER])
  await inside(async () => {
    const rule = (name: string, enabled: boolean) => database.client.automationRule.create({ data: { domain: 'replenishment', name, trigger: 'recommendation_generated', enabled, autonomyLevel: 'PROPOSE' } })
    ids.r1 = (await rule('TEST restock one', true)).id
    ids.r2 = (await rule('TEST restock two', true)).id
    ids.r3 = (await rule('TEST restock off', false)).id
  })
  await inside(() => database.client.automationRule.create({ data: { id: 'tst-r12-other', domain: 'replenishment', name: 'TEST other', trigger: 'x', enabled: true } }), OTHER)
}, 180_000)
afterAll(async () => {
  await database?.close()
}, 30_000)

describe('R12 — stop-automation / resume-automation', () => {
  it('Amazon ads: halt with its audit; already stopped is said; the undo is a resume, which a person always approves', async () => {
    const preview = await dry('stop-automation', { area: 'amazon-ads', reason: 'TEST spend spike' })
    expect(preview.preview).toMatchObject({ action: 'stop-automation', area: 'amazon-ads', changes: { halted: { from: false, to: true } } })
    const stop = getTool('stop-automation')!
    expect(stop.withinLimits!(preview.preview, stop.limits!.parse({}))).toBeNull()
    const out = await run('stop-automation', { area: 'amazon-ads', reason: 'TEST spend spike' })
    expect(out).toMatchObject({ ok: true, change: { before: { area: 'amazon-ads', halted: false }, after: { area: 'amazon-ads', halted: true } } })
    expect(await inside(() => database.client.adsAutomationState.findUniqueOrThrow({ where: { id: 'singleton' } }))).toMatchObject({ halted: true, haltReason: 'TEST spend spike', haltedBy: 'user:u-r12' })
    expect((await inside(() => database.client.advertisingActionLog.findMany({ where: { entityId: 'amazon-ads' } }))).map((r) => r.actionType)).toEqual(['halt_automation'])
    expect((await dry('stop-automation', { area: 'amazon-ads', reason: 'again' })).error).toBe('Amazon ads automation is already stopped (TEST spend spike).')
    expect(await inside(() => stop.undo!.current(out.change!))).toEqual(out.change!.after)
    expect(stop.undo!.request(out.change!)).toEqual({ tool: 'resume-automation', args: { area: 'amazon-ads' } })
    const resume = getTool('resume-automation')!
    expect(resume).toMatchObject({ maxClaudeTrust: 'ask' })
    expect(resume.limits).toBeUndefined()
    expect(await run('resume-automation', { area: 'amazon-ads' })).toMatchObject({ ok: true })
    expect(await inside(() => database.client.adsAutomationState.findUniqueOrThrow({ where: { id: 'singleton' } }))).toMatchObject({ halted: false })
  })

  it('eBay ads, the fleet and the review mailer stop and resume through their own switches', async () => {
    for (const area of ['ebay-ads', 'agent-fleet', 'review-mailer']) {
      expect(await run('stop-automation', { area, reason: 'TEST stop' }), area).toMatchObject({ ok: true })
      expect((await dry('stop-automation', { area, reason: 'TEST stop' })).error, area).toContain('already stopped')
      expect(await run('resume-automation', { area }), area).toMatchObject({ ok: true })
    }
    expect(await inside(() => database.client.marketingAutomationState.findFirstOrThrow({ where: { channel: 'EBAY' } }))).toMatchObject({ halted: false })
    expect(await inside(() => database.client.reviewMailerState.findFirstOrThrow())).toMatchObject({ isPaused: false })
  })

  it('rules: every switched-on rule of a domain goes off, the ids are recorded, and the undo switches exactly those back on', async () => {
    const out = await run('stop-automation', { area: 'rules', domain: 'replenishment', reason: 'TEST misbehaving' })
    expect(out.change!.after).toMatchObject({ area: 'rules', domain: 'replenishment', halted: true })
    expect([...out.change!.after.ruleIds].sort()).toEqual([ids.r1, ids.r2].sort())
    const enabled = await inside(() => database.client.automationRule.findMany({ where: { domain: 'replenishment', enabled: true } }))
    expect(enabled).toEqual([])
    const request = getTool('stop-automation')!.undo!.request(out.change!) as { tool: string; args: Record<string, unknown> }
    expect(request.tool).toBe('resume-automation')
    expect(await run('resume-automation', request.args)).toMatchObject({ ok: true })
    // The rule that was off before the stop stays off.
    expect((await inside(() => database.client.automationRule.findMany({ where: { domain: 'replenishment', enabled: true }, orderBy: { name: 'asc' } }))).map((r) => r.name)).toEqual(['TEST restock one', 'TEST restock two'])
  })

  it("another business's rules are not found; rule ids belong to area rules", async () => {
    expect((await dry('stop-automation', { area: 'rules', ruleIds: ['tst-r12-other'], reason: 'x x x' })).error).toBe('Rules not found in this business: tst-r12-other (not found).')
    expect((await dry('stop-automation', { area: 'amazon-ads', ruleIds: [ids.r1], reason: 'x x x' })).error).toBe('ruleIds (TEST restock one) name rules: they apply to area rules only.')
  })
})
