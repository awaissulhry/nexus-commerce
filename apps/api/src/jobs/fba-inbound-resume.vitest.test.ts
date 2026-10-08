/**
 * Step 4 Send to FBA — the resume job and the dispatch (plan §2c).
 *
 *   resume     queues every Step 4 plan the job must move on: a job state that is due or never claimed, a held plan
 *              whose wait is over, tracking due on a shipped plan. Never: a lease still running, a person's state, a
 *              finished plan, an older wizard plan. One plan that cannot be queued does not stop the others.
 *   cron       through lib/cron/clustered (hard rule 7), every minute; NEXUS_FBA_INBOUND_RESUME=0 turns it off.
 *   dispatch   with queue workers: the fba-inbound queue, job id fba-plan-<id>; without: the plan runs in this process.
 *
 * Real SQL (PGlite with the production schema and row-level security); the queue and the cron wrapper are spies.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../db.js', async () => {
  const { contextualDatabase } = await import('../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_target, property) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), property) }) }
})
const q = vi.hoisted(() => ({ added: [] as Array<{ name: string; data: unknown; options: unknown }> }))
vi.mock('../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    publicationBatchQueue: queue, agentPlanQueue: queue,
    fbaInboundQueue: { add: vi.fn(async (name: string, data: unknown, options: unknown) => { q.added.push({ name, data, options }); return {} }) },
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: false, status: 'disabled' }),
    resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: { connection: null },
  }
})
const cronSpy = vi.hoisted(() => ({ scheduled: [] as string[] }))
vi.mock('../lib/cron/clustered.js', () => ({
  default: {
    validate: () => true,
    schedule: vi.fn((expression: string) => { cronSpy.scheduled.push(expression); return { stop: vi.fn() } }),
  },
}))
vi.mock('../services/fba-inbound/runner.js', () => ({ runFbaPlan: vi.fn(async () => ({ claimed: true, status: 'WAITING_FOR_CHOICE', step: 'CONFIRM', nextCheckAt: null })) }))

import { runFbaInboundResumeTick, startFbaInboundResumeCron, stopFbaInboundResumeCron } from './fba-inbound-resume.job.js'
import { dispatchFbaPlan } from '../services/fba-inbound/dispatch.js'
import { runFbaPlan } from '../services/fba-inbound/runner.js'

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const NOW = new Date('2026-10-08T07:00:00.000Z')
const past = new Date(NOW.getTime() - 1_000)
const future = new Date(NOW.getTime() + 60_000)
const plans: Record<string, string> = {}

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    const make = async (key: string, data: Record<string, unknown>) => {
      plans[key] = (await database.client.fbaInboundPlanV2.create({ data: { source: 'matrix', currentStep: 'CREATE', ...data } as never })).id
    }
    await make('queuedNeverClaimed', { status: 'QUEUED', nextCheckAt: null, createdAt: new Date(NOW.getTime() - 5_000) })
    await make('placingDue', { status: 'PLACING', currentStep: 'PLACE', nextCheckAt: past })
    await make('placingLeased', { status: 'PLACING', currentStep: 'PLACE', nextCheckAt: future })
    await make('heldDue', { status: 'HELD', currentStep: 'BOXES', nextCheckAt: past })
    await make('heldWaiting', { status: 'HELD', currentStep: 'BOXES', nextCheckAt: future })
    await make('cancelling', { status: 'CANCELLING', currentStep: 'CANCEL', nextCheckAt: null, createdAt: new Date(NOW.getTime() - 4_000) })
    await make('waitingForChoice', { status: 'WAITING_FOR_CHOICE', currentStep: 'CONFIRM', nextCheckAt: null })
    await make('failed', { status: 'FAILED', currentStep: 'PACK', nextCheckAt: null })
    await make('readyNoTracking', { status: 'READY_TO_SHIP', currentStep: 'TRACKING', nextCheckAt: null })
    await make('readyTrackingDue', { status: 'READY_TO_SHIP', currentStep: 'TRACKING', nextCheckAt: past })
    await make('shippedTrackingDue', { status: 'SHIPPED', currentStep: 'TRACKING', nextCheckAt: new Date(NOW.getTime() - 2_000) })
    await make('closed', { status: 'CLOSED', currentStep: 'TRACKING', nextCheckAt: null })
    await make('wizard', { source: null, status: 'CREATING', nextCheckAt: null })
  })
})
afterAll(async () => { await database?.close() })
afterEach(() => {
  delete process.env.NEXUS_FBA_INBOUND_RESUME
  delete process.env.ENABLE_QUEUE_WORKERS
  stopFbaInboundResumeCron()
  cronSpy.scheduled = []
  q.added = []
  vi.mocked(runFbaPlan).mockClear()
})

describe('runFbaInboundResumeTick', () => {
  it('queues the plans the job must move on, never-claimed first, and nothing else', async () => {
    const dispatched: string[] = []
    const tick = await inside(() => runFbaInboundResumeTick(NOW, async id => { dispatched.push(id) }))
    const name = (id: string) => Object.entries(plans).find(([, v]) => v === id)![0]
    // Never claimed first (oldest first), then the most overdue.
    expect(dispatched.map(name)).toEqual(['queuedNeverClaimed', 'cancelling', 'shippedTrackingDue', 'placingDue', 'heldDue', 'readyTrackingDue'])
    expect(tick).toEqual({ due: 6, queued: 6 })
  })

  it('one plan that cannot be queued does not stop the others', async () => {
    const dispatched: string[] = []
    const tick = await inside(() => runFbaInboundResumeTick(NOW, async id => {
      if (id === plans.placingDue) throw new Error('redis down')
      dispatched.push(id)
    }))
    expect(tick).toEqual({ due: 6, queued: 5 })
    expect(dispatched).not.toContain(plans.placingDue)
  })
})

describe('the cron', () => {
  it('is scheduled every minute through the clustered wrapper', () => {
    startFbaInboundResumeCron()
    expect(cronSpy.scheduled).toEqual(['* * * * *'])
  })
  it('NEXUS_FBA_INBOUND_RESUME=0 turns it off', () => {
    process.env.NEXUS_FBA_INBOUND_RESUME = '0'
    startFbaInboundResumeCron()
    expect(cronSpy.scheduled).toEqual([])
  })
})

describe('dispatchFbaPlan', () => {
  it('with queue workers: the fba-inbound queue, job id fba-plan-<id>', async () => {
    process.env.ENABLE_QUEUE_WORKERS = '1'
    expect(await dispatchFbaPlan('plan-1')).toBe('queued')
    expect(q.added).toEqual([{ name: 'run', data: { planRowId: 'plan-1' }, options: { jobId: 'fba-plan-plan-1' } }])
    expect(runFbaPlan).not.toHaveBeenCalled()
  })
  it('without them: the plan runs in this process', async () => {
    expect(await dispatchFbaPlan('plan-2')).toBe('inline')
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))
    expect(runFbaPlan).toHaveBeenCalledWith('plan-2')
    expect(q.added).toEqual([])
  })
})
