/**
 * MCP full control R15 — steer-fleet, through the one door, on a real PostgreSQL (PGlite). The model is never called:
 * the executor is stubbed.
 *
 * Proven: a pause, a level down and a cancel are inside the limits; a run, a resume, a level up and an assignment
 * spend AI money and need a person. A level is never above the charter's cap. Each move goes through the Fleet pages'
 * own services, with the person in the control audit; undo puts the worker back (a run cannot be taken back). An
 * assignment's targets must be this business's; another business's assignment is not found. automation-detail shows a
 * worker as steer-fleet steers it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
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
const executor = vi.hoisted(() => ({ executeCharter: vi.fn(async () => ({ ok: true, runId: 'run-r15' })) }))
vi.mock('../../agent-fleet/agent-executor.js', async (importOriginal) => ({ ...(await importOriginal<object>()), executeCharter: executor.executeCharter }))

import { callTool, executeTool, type UserPrincipal } from '../call-tool.js'
import { getTool } from '../tool-registry.js'

const A = LEGACY_WORKSPACE_ID
const OTHER = 'ws_r15_other'
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(work: () => Promise<T>, workspaceId = A) => withWorkspace(business(workspaceId), work)
const person: UserPrincipal = { kind: 'user', userId: 'u-r15', label: 'R15 test', permissions: { isOwner: false, permissions: new Set([...Object.values(FEATURES), ...Object.values(FIELDS)]) }, workspace: business(A), via: 'claude' }
const other: UserPrincipal = { ...person, workspace: business(OTHER) }
type Out = { ok: boolean; error?: string; preview?: Record<string, any>; data?: Record<string, any>; change?: { before: any; after: any } }
const dry = async (args: Record<string, unknown>, who = person) => (await callTool(who, 'steer-fleet', args)).raw as Out
const run = async (args: Record<string, unknown>) => (await executeTool(person, 'steer-fleet', args, { via: 'claude' })).raw as Out
const tool = () => getTool('steer-fleet')!
const inLimits = (preview: unknown) => tool().withinLimits!(preview, tool().limits!.parse({}))
const undo = (change: Out['change']) => tool().undo!.request(change!) as { tool?: string; args?: Record<string, unknown>; refusal?: string }
const charter = (key: string) => inside(() => database.client.agentCharter.findFirstOrThrow({ where: { key }, select: { enabled: true, autonomyLevel: true, pausedUntil: true, pausedReason: true } }))
const audit = (action: string) => inside(() => database.client.agentControlAudit.findMany({ where: { action }, select: { charterKey: true, actor: true, note: true } }))
const ids: Record<string, string> = {}
const UNTIL = '2999-01-01T00:00:00.000Z'
const savedKill = process.env.NEXUS_AI_KILL_SWITCH

beforeAll(async () => {
  database = await formulaDatabase()
  await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING`, [OTHER])
  const { seedCharters, bustCharterCache } = await import('../../agent-fleet/charter-registry.js')
  await inside(async () => {
    await seedCharters()
    const db = database.client
    // The bid tuner on, at its cap (OBSERVE); the director off (cap PROPOSE).
    await db.agentCharter.updateMany({ where: { key: 'amazon-bid-tuner' }, data: { enabled: true, autonomyLevel: 'OBSERVE' } })
    bustCharterCache()
    ids.campaign = (await db.campaign.create({ data: { name: 'TEST CAMPAIGN', type: 'SP', dailyBudget: '10.00', startDate: new Date('2026-01-01T00:00:00Z'), marketplace: 'IT', externalCampaignId: 'TEST-CMP-1', portfolioId: 'TEST-PORTFOLIO-1' } })).id
    ids.assignment = (await db.agentAssignment.create({ data: { charterKey: 'amazon-bid-tuner', title: 'TEST assignment' } })).id
    ids.ran = (await db.agentAssignment.create({ data: { charterKey: 'amazon-bid-tuner', title: 'TEST assignment that ran' } })).id
    await db.agentRun.create({ data: { agentKey: 'amazon-bid-tuner', trigger: 'manual', status: 'done', assignmentId: ids.ran } as never })
  })
  await inside(async () => {
    ids.otherCampaign = (await database.client.campaign.create({ data: { name: 'TEST OTHER', type: 'SP', dailyBudget: '5.00', startDate: new Date(), marketplace: 'IT' } })).id
    ids.otherAssignment = (await database.client.agentAssignment.create({ data: { charterKey: 'amazon-bid-tuner', title: 'TEST other business assignment' } })).id
  }, OTHER)
}, 180_000)
afterEach(() => {
  if (savedKill === undefined) delete process.env.NEXUS_AI_KILL_SWITCH
  else process.env.NEXUS_AI_KILL_SWITCH = savedKill
})
afterAll(async () => {
  await database?.close()
}, 30_000)

describe('R15 — steer-fleet', () => {
  it('a pause is inside the limits, written with the person in the control audit; undo resumes; a resume needs a person', async () => {
    const pause = await dry({ action: 'pause', charterKey: 'amazon-bid-tuner', until: UNTIL, reason: 'R15 test pause' })
    expect(pause.preview).toMatchObject({ action: 'steer-fleet', steer: 'pause', worker: { key: 'amazon-bid-tuner', cap: 'OBSERVE' }, changes: { pausedUntil: { from: null, to: UNTIL } }, aiSpend: false, needsPerson: null })
    expect(inLimits(pause.preview)).toBeNull()
    expect((await dry({ action: 'pause', charterKey: 'amazon-bid-tuner', until: '2001-01-01T00:00:00.000Z', reason: 'past' })).error).toContain('until must be a future date')

    const done = await run({ action: 'pause', charterKey: 'amazon-bid-tuner', until: UNTIL, reason: 'R15 test pause' })
    expect(done.ok).toBe(true)
    expect(await charter('amazon-bid-tuner')).toMatchObject({ pausedUntil: new Date(UNTIL), pausedReason: 'R15 test pause' })
    expect(await audit('pause')).toEqual([{ charterKey: 'amazon-bid-tuner', actor: 'user:u-r15', note: 'R15 test pause' }])
    expect(await inside(() => tool().undo!.current(done.change!))).toEqual(done.change!.after)
    const back = undo(done.change)
    expect(back).toEqual({ tool: 'steer-fleet', args: { action: 'resume', charterKey: 'amazon-bid-tuner' } })

    const resume = await dry(back.args!)
    expect(resume.preview).toMatchObject({ steer: 'resume', aiSpend: true, needsPerson: 'a resumed worker spends AI money again' })
    expect(inLimits(resume.preview)).toBe('a resumed worker spends AI money again: a person decides')
    const resumed = await run(back.args!)
    expect(resumed.ok).toBe(true)
    expect(await charter('amazon-bid-tuner')).toMatchObject({ pausedUntil: null })
    // Undo of the resume pauses it again, until the same time, for the same reason.
    expect(undo(resumed.change)).toEqual({ tool: 'steer-fleet', args: { action: 'pause', charterKey: 'amazon-bid-tuner', until: UNTIL, reason: 'R15 test pause' } })
    expect((await dry({ action: 'resume', charterKey: 'amazon-bid-tuner' })).error).toBe(`${resume.preview!.worker.name}: it is not paused.`)
  })

  it('a level down is inside; a level up needs a person and stops at the charter cap; undo sets it back', async () => {
    const down = await dry({ action: 'set-level', charterKey: 'amazon-bid-tuner', level: 'OFF' })
    expect(down.preview).toMatchObject({ changes: { level: { from: 'OBSERVE', to: 'OFF' } }, needsPerson: null })
    expect((await dry({ action: 'set-level', charterKey: 'amazon-bid-tuner', level: 'PROPOSE' })).error).toContain('PROPOSE is above its charter\'s cap (OBSERVE).')
    expect((await dry({ action: 'set-level', charterKey: 'amazon-ads-director', level: 'AUTO' })).error).toContain('AUTO is above its charter\'s cap (PROPOSE).')
    const up = await dry({ action: 'set-level', charterKey: 'amazon-ads-director', level: 'PROPOSE' })
    expect(up.preview).toMatchObject({ changes: { level: { from: 'OFF', to: 'PROPOSE' } }, aiSpend: true })
    expect(inLimits(up.preview)).toBe('a higher level lets the worker do (and spend) more: a person decides')

    const raised = await run({ action: 'set-level', charterKey: 'amazon-ads-director', level: 'PROPOSE' })
    expect(raised.ok).toBe(true)
    expect(await charter('amazon-ads-director')).toMatchObject({ enabled: true, autonomyLevel: 'PROPOSE' })
    expect(await audit('dial')).toEqual([expect.objectContaining({ charterKey: 'amazon-ads-director', actor: 'user:u-r15' })])
    expect(undo(raised.change)).toEqual({ tool: 'steer-fleet', args: { action: 'set-level', charterKey: 'amazon-ads-director', level: 'OFF' } })
    expect((await run({ action: 'set-level', charterKey: 'amazon-ads-director', level: 'OFF' })).ok).toBe(true)
    expect(await charter('amazon-ads-director')).toMatchObject({ enabled: false })
  })

  it('a run now needs a person; it runs through the operator\'s Run path (no model here) and cannot be taken back', async () => {
    const preview = await dry({ action: 'run-now', charterKey: 'amazon-bid-tuner' })
    expect(preview.preview).toMatchObject({ steer: 'run-now', aiSpend: true, needsPerson: 'a run spends AI money' })
    expect(executor.executeCharter).not.toHaveBeenCalled() // a preview never runs it
    executor.executeCharter.mockClear()
    const done = await run({ action: 'run-now', charterKey: 'amazon-bid-tuner' })
    expect(done).toMatchObject({ ok: true, data: { runId: 'run-r15' } })
    expect(executor.executeCharter).toHaveBeenCalledWith('amazon-bid-tuner', { trigger: 'manual', mode: 'ask', ignoreEnabled: true, userId: 'u-r15' })
    expect(await audit('run_now')).toEqual([{ charterKey: 'amazon-bid-tuner', actor: 'user:u-r15', note: 'run now (steer-fleet)' }])
    expect(undo(done.change).refusal).toContain('a run cannot be taken back')
    process.env.NEXUS_AI_KILL_SWITCH = 'on'
    expect((await dry({ action: 'run-now', charterKey: 'amazon-bid-tuner' })).error).toContain('AI is temporarily disabled (kill switch).')
  })

  it('an assignment: targets of this business, named; undo cancels it; one that ran cannot be cancelled; it runs by its id', async () => {
    expect((await dry({ action: 'assign', charterKey: 'amazon-bid-tuner', targetKind: 'CAMPAIGN', targetIds: [ids.otherCampaign] })).error).toContain(`there is no campaign ${ids.otherCampaign} in this business (not found)`)
    expect((await dry({ action: 'assign', charterKey: 'amazon-ads-director', targetKind: 'CAMPAIGN', targetIds: [ids.campaign] })).error).toContain('This worker writes a plan')
    const preview = await dry({ action: 'assign', charterKey: 'amazon-bid-tuner', targetKind: 'CAMPAIGN', targetIds: [ids.campaign], wantBack: 'the three worst terms' })
    expect(preview.preview).toMatchObject({ steer: 'assign', changes: { assignment: { from: null, to: { targetKind: 'CAMPAIGN', targets: ['TEST CAMPAIGN'], wantBack: 'the three worst terms' } } }, needsPerson: 'an assignment is work the worker will spend AI money on' })
    const made = await run({ action: 'assign', charterKey: 'amazon-bid-tuner', targetKind: 'CAMPAIGN', targetIds: [ids.campaign], wantBack: 'the three worst terms' })
    expect(made.ok).toBe(true)
    const id = made.data!.assignmentId as string
    expect(await inside(() => database.client.agentAssignment.findUniqueOrThrow({ where: { id } }))).toMatchObject({ charterKey: 'amazon-bid-tuner', targetKind: 'CAMPAIGN', targetIds: [ids.campaign], targetLabels: ['TEST CAMPAIGN'], createdBy: 'u-r15', state: 'not_started' })
    expect(await inside(() => tool().undo!.current(made.change!))).toEqual(made.change!.after)
    const back = undo(made.change)
    expect(back).toEqual({ tool: 'steer-fleet', args: { action: 'cancel-assignment', assignmentId: id } })
    expect(inLimits((await dry(back.args!)).preview)).toBeNull()
    expect((await run(back.args!)).ok).toBe(true)
    expect(await inside(() => database.client.agentAssignment.findUniqueOrThrow({ where: { id } }))).toMatchObject({ state: 'cancelled' })
    expect((await dry({ action: 'cancel-assignment', assignmentId: ids.ran })).error).toContain('this assignment has already run, so it cannot be cancelled')

    executor.executeCharter.mockClear()
    expect((await run({ action: 'run-now', assignmentId: ids.assignment })).ok).toBe(true)
    expect(executor.executeCharter).toHaveBeenCalledWith('amazon-bid-tuner', expect.objectContaining({ assignmentId: ids.assignment, userId: 'u-r15' }))
  })

  it("another business's assignment or an unknown worker is not found; a worker not set up here cannot be paused", async () => {
    expect((await dry({ action: 'run-now', assignmentId: ids.otherAssignment })).error).toBe(`There is no assignment ${ids.otherAssignment} in this business (not found).`)
    expect((await dry({ action: 'pause', charterKey: 'no-such-worker', until: UNTIL, reason: 'x x x' })).error).toBe('Agent fleet: there is no worker no-such-worker (not found).')
    expect((await dry({ action: 'pause', charterKey: 'amazon-bid-tuner', until: UNTIL, reason: 'other business' }, other)).error).toContain('it is not set up in this business yet')
  })

  it('automation-detail shows a worker as steer-fleet steers it: level, cap, pause, assignments and runs', async () => {
    const detail = (await callTool(person, 'automation-detail', { automation: 'F1', rowId: 'amazon-bid-tuner' })).raw as Out
    expect(detail.ok).toBe(true)
    const row = JSON.stringify(detail)
    for (const fact of ['"cap":"OBSERVE"', '"pausedUntil":null', 'TEST assignment', '"steer":"steer-fleet: run-now']) expect(row).toContain(fact)
  })
})
