/**
 * MCP full control part 06, fix (lead review of R5) — the Control Room reads the two engine switches exactly as the
 * jobs do. Budget enforcement applies only with NEXUS_BUDGET_ENFORCE_APPLY === '1' (jobs/ad-budget-enforce.job.ts) and
 * rank-defend runs only with NEXUS_ENABLE_RANK_DEFEND === '1' (jobs/ad-rank-defend.job.ts). The Levers view and the
 * Foresight strip read both with `envEnabled`, which also takes 'true', 'yes', 'on' …: set to 'true', they showed
 * AUTO / "armed" while the job stayed dry or off.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))
vi.mock('../../lib/queue.js', () => {
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

import { getEngineLevers } from './ads-control-room.service.js'
import { getForesight } from './ads-foresight.service.js'

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const KEYS = ['NEXUS_ENABLE_AMAZON_ADS_CRON', 'NEXUS_BUDGET_ENFORCE_APPLY', 'NEXUS_ENABLE_RANK_DEFEND'] as const
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
const set = (values: Partial<Record<(typeof KEYS)[number], string>>) => {
  for (const k of KEYS) delete process.env[k]
  Object.assign(process.env, values)
}

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(() => database.client.adsAutomationState.create({ data: { id: 'singleton', autonomy: 'AUTO' } }))
}, 180_000)
afterEach(() => set(saved as never))
afterAll(async () => {
  set(saved as never)
  await database?.close()
}, 30_000)

const lever = async (key: string) => (await inside(() => getEngineLevers())).levers.find((l) => l.key === key)!
const engine = async (key: string) => (await inside(() => getForesight())).engines.find((e) => e.key === key)!

describe('the Control Room reads the engine switches as the jobs do', () => {
  it("'true' is not '1': budget enforcement shows OBSERVE (it computes, never applies) and rank-defend OFF", async () => {
    set({ NEXUS_ENABLE_AMAZON_ADS_CRON: '1', NEXUS_BUDGET_ENFORCE_APPLY: 'true', NEXUS_ENABLE_RANK_DEFEND: 'true' })
    expect(await lever('budget-enforce')).toMatchObject({ mode: 'OBSERVE', modeReason: expect.stringContaining('NEXUS_BUDGET_ENFORCE_APPLY') })
    expect(await lever('rank-defend')).toMatchObject({ mode: 'OFF', modeReason: expect.stringContaining('NEXUS_ENABLE_RANK_DEFEND') })
    expect((await engine('budget-enforce')).blockedReason).toContain('NEXUS_BUDGET_ENFORCE_APPLY')
    expect((await engine('rank-defend')).blockedReason).toContain('NEXUS_ENABLE_RANK_DEFEND')
  })

  it('R16 — a business switch lowers a lever below its env, the lever says both, and env off still wins', async () => {
    set({ NEXUS_ENABLE_AMAZON_ADS_CRON: '1', NEXUS_BUDGET_ENFORCE_APPLY: '1', NEXUS_ENABLE_RANK_DEFEND: '1' })
    const { setEngineSwitch } = await import('../automation/engine-switch.service.js')
    await inside(() => setEngineSwitch('rank-defend', 'OFF', 'user:u-r16', 'test'))
    await inside(() => setEngineSwitch('budget-enforce', 'OBSERVE', 'user:u-r16'))
    expect(await lever('rank-defend')).toMatchObject({
      mode: 'OFF', modeReason: 'Switched to OFF for this business (user:u-r16)',
      control: { env: { mode: 'AUTO' }, switch: { mode: 'OFF', setBy: 'user:u-r16', reason: 'test' }, switchable: true, levels: ['OFF', 'AUTO'], ceiling: expect.any(String) },
    })
    expect(await lever('budget-enforce')).toMatchObject({ mode: 'OBSERVE', control: { env: { mode: 'AUTO' }, switch: { mode: 'OBSERVE' } } })
    expect(await lever('anomaly-guard')).toMatchObject({ control: { switch: null, switchable: false } })
    expect((await engine('rank-defend')).blockedReason).toBe('Switched to OFF for this business (user:u-r16)')
    expect((await engine('budget-enforce')).blockedReason).toBe('Switched to OBSERVE for this business (user:u-r16)')
    // Env off wins over the switch: rank-defend not armed reads OFF for the env's reason.
    set({ NEXUS_ENABLE_AMAZON_ADS_CRON: '1', NEXUS_BUDGET_ENFORCE_APPLY: '1' })
    expect(await lever('rank-defend')).toMatchObject({ mode: 'OFF', modeReason: expect.stringContaining('NEXUS_ENABLE_RANK_DEFEND'), control: { env: { mode: 'OFF' } } })
    await inside(() => setEngineSwitch('rank-defend', 'AUTO', 'user:u-r16'))
    await inside(() => setEngineSwitch('budget-enforce', 'AUTO', 'user:u-r16'))
    expect((await lever('budget-enforce')).control.switch).toBeNull()
  })

  it("control: exactly '1' arms both", async () => {
    set({ NEXUS_ENABLE_AMAZON_ADS_CRON: '1', NEXUS_BUDGET_ENFORCE_APPLY: '1', NEXUS_ENABLE_RANK_DEFEND: '1' })
    expect((await lever('budget-enforce')).mode).toBe('AUTO')
    expect((await lever('rank-defend')).mode).toBe('AUTO')
    expect((await engine('budget-enforce')).blockedReason).toBeNull()
    expect((await engine('rank-defend')).blockedReason).toBeNull()
  })
})
