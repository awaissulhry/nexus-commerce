/**
 * The fleet's clocks, per business — the scheduler's boot error "custom clock resync failed — Select a business
 * profile." On a real PostgreSQL (PGlite), with business profiles ON (as in production) and OFF.
 *
 * Proven:
 *   - the boot resync (no business selected) reads each business's workflows inside that business and arms that
 *     business's own clocks there: its stored sweep/council trigger (a stored `manual` arms nothing) and one clock per
 *     enabled custom routine with a stored schedule — as the system, never as a person; no error is logged;
 *   - one business that cannot be read never stops the next one's clocks;
 *   - a clock armed for one business ticks in that business only;
 *   - a custom routine's tick reaches NO model while any off switch is set: every worker off (production today), the
 *     worker paused, the fleet stopped, NEXUS_AI_KILL_SWITCH, this business's "Analyst fleet" switch at OFF, the
 *     routine switched off. The control (everything on) does reach the model, so a call would be seen.
 *
 * The clustered wrapper (lib/cron/clustered.ts) is the real one; node-cron only records what was armed, and the Redis
 * lease (proven in workspace-lease.vitest.test.ts) always grants the tick. The model is a stub: no AI spend.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace, workspaceContext } from '../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
/** A business whose workflow tables cannot be read (the failure-isolation case). */
let unreadable: string | null = null
vi.mock('../db.js', () => ({
  default: new Proxy({}, {
    get: (_target, property) => {
      const broken = unreadable !== null && (workspaceContext()?.workspaceId ?? LEGACY_WORKSPACE_ID) === unreadable
      if (broken && (property === 'agentWorkflow' || property === 'agentWorkflowRevision')) {
        const refuse = async () => { throw new Error('stored layer unreadable (test)') }
        return { findMany: refuse, findFirst: refuse, findUnique: refuse }
      }
      return Reflect.get(database.client, property)
    },
  }),
}))
vi.mock('../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: true, status: 'ready' }),
    resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: { connection: { status: 'ready', set: async () => 'OK' } },
  }
})
vi.mock('../lib/cron/workspace-lease.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runWorkspaceTick: async (_store: unknown, _jobId: string, _at: number, work: () => Promise<void>) => { await work(); return true },
}))
/** What node-cron was asked to arm, and in which business the arming ran. */
const clocks = vi.hoisted(() => ({
  armed: [] as Array<{ expression: string; tick: () => Promise<void>; workspaceId: string | null; actorUserId: string | null; stopped: boolean }>,
}))
vi.mock('node-cron', async (importOriginal) => {
  const real = await importOriginal<{ default: { validate: (e: string) => boolean } }>()
  const { workspaceContext: current } = await import('../lib/workspace-context.js')
  return {
    default: {
      validate: real.default.validate,
      schedule: (expression: string, tick: () => Promise<void>) => {
        const scope = current()
        const entry = { expression, tick, workspaceId: scope?.workspaceId ?? null, actorUserId: scope?.actorUserId ?? null, stopped: false }
        clocks.armed.push(entry)
        return { stop: () => { entry.stopped = true }, start: () => {} }
      },
    },
  }
})
// The model: a stub that records the call and fails it. Reaching it at all is what the off switches must prevent.
const model = vi.hoisted(() => ({ generate: vi.fn(async () => { throw new Error('stub model: no AI call in tests') }) }))
vi.mock('../services/ai/model-resolver.service.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getProviderForFeature: async () => ({ name: 'stub', generate: model.generate }),
  resolveModelForFeature: async () => 'stub-model',
}))

const { resyncFleetSchedules } = await import('./fleet-sweep.job.js')
const { seedCharters, bustCharterCache } = await import('../services/agent-fleet/charter-registry.js')
const { haltFleet, resumeFleet } = await import('../services/agent-fleet/fleet-state.service.js')
const { logger } = await import('../utils/logger.js')

const A = LEGACY_WORKSPACE_ID
const B = 'ws_fleet_clock_b'
/** A person in A whose click (publish / revert / switch) re-arms A's clocks. */
const CLICKER = 'user-fleet-clock-clicker'
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(work: () => Promise<T>, workspaceId = A) => withWorkspace(business(workspaceId), work)

const ENV = ['NEXUS_WORKSPACES_ENABLED', 'NEXUS_ENABLE_FLEET_SWEEP_CRON', 'NEXUS_AI_KILL_SWITCH', 'NEXUS_FLEET_SWEEP_SCHEDULE', 'NEXUS_FLEET_COUNCIL_SCHEDULE', 'NEXUS_REQUIRE_CRON_LEASE'] as const
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]))

const routine = (cron: string | null) => ({
  v: 1,
  trigger: cron ? { type: 'schedule', cron } : { type: 'manual' },
  steps: cron ? [{ charterKey: 'fleet-selftest', gate: 'inherit' }] : [],
  edges: [],
})

async function storeWorkflow(key: string, kind: 'custom' | 'builtin', enabled: boolean, cron: string | null) {
  await database.client.agentWorkflow.create({ data: { key, name: key, kind, enabled } })
  await database.client.agentWorkflowRevision.create({
    data: { workflowKey: key, revision: 1, definition: routine(cron), note: 'test', activatedAt: new Date() },
  })
}

beforeAll(async () => {
  database = await formulaDatabase()
  await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING`, [B])
  await database.db.query(`INSERT INTO "UserProfile" (id,email,status,"updatedAt") VALUES ($1,$2,'active',CURRENT_TIMESTAMP)`, [CLICKER, `${CLICKER}@example.test`])
  await database.db.query(`INSERT INTO "WorkspaceMembership" (id,"workspaceId","userId",status,"updatedAt") VALUES ($1,$2,$3,'active',CURRENT_TIMESTAMP)`, ['m-fleet-clock-clicker', A, CLICKER])
  // A: a routine on a nightly clock, and one switched off (never armed). Every worker as production has them: off.
  await inside(async () => {
    await seedCharters()
    await storeWorkflow('night-check', 'custom', true, '0 3 * * *')
    await storeWorkflow('parked-check', 'custom', false, '0 1 * * *')
  })
  // B: its own routine, and the built-in sweep stored as manual — B's sweep clock must not be armed.
  await inside(async () => {
    await seedCharters()
    await storeWorkflow('b-routine', 'custom', true, '30 2 * * *')
    await storeWorkflow('fleet-sweep', 'builtin', true, null)
  }, B)
}, 180_000)

afterAll(async () => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  await database?.close()
}, 30_000)

beforeEach(() => {
  for (const k of ENV) delete process.env[k]
  process.env.NEXUS_ENABLE_FLEET_SWEEP_CRON = '1'
  clocks.armed.length = 0
  unreadable = null
  model.generate.mockClear()
})
afterEach(() => vi.restoreAllMocks())

/** Live clocks as `business|cron` (business `-` = one legacy-mode clock), sorted. */
const live = () => clocks.armed.filter((c) => !c.stopped).map((c) => `${c.workspaceId ?? '-'}|${c.expression}`).sort()
const clockFor = (expression: string, workspaceId: string | null) => {
  const found = clocks.armed.find((c) => !c.stopped && c.expression === expression && c.workspaceId === workspaceId)
  if (!found) throw new Error(`no live clock ${expression} for ${workspaceId}`)
  return found
}

describe.each([
  ['ON', '1', A, B],
  ['OFF', undefined, null, null],
] as const)('business profiles %s', (_label, flag, armedInA, armedInB) => {
  beforeEach(() => {
    if (flag) process.env.NEXUS_WORKSPACES_ENABLED = flag
  })

  it('the boot resync arms each business its own clocks, inside that business, and logs no error', async () => {
    const errors = vi.spyOn(logger, 'error')
    await resyncFleetSchedules()

    const expected = [`${armedInA ?? '-'}|45 4 * * *`, `${armedInA ?? '-'}|15 5 * * 1`, `${armedInA ?? '-'}|0 3 * * *`]
    // With profiles off there is one business (the legacy one); B exists only as a profile.
    if (flag) expected.push(`${armedInB}|15 5 * * 1`, `${armedInB}|30 2 * * *`)
    expect(live()).toEqual(expected.sort())
    expect(clocks.armed.every((c) => c.actorUserId === null)).toBe(true)
    expect(errors).not.toHaveBeenCalled()

    // A second resync replaces every clock; nothing is left armed twice.
    await resyncFleetSchedules()
    expect(live()).toEqual(expected.sort())
  })

  it('a resync from a request re-arms only that business, as the system', async () => {
    await resyncFleetSchedules()
    await withWorkspace({ workspaceId: A, actorUserId: CLICKER, membershipId: 'm-fleet-clock-clicker', roleKeys: ['owner'] }, () => resyncFleetSchedules())
    // A's clocks are replaced (re-armed inside A — in legacy mode that is the one business), never doubled.
    const expected = [`${A}|45 4 * * *`, `${A}|15 5 * * 1`, `${A}|0 3 * * *`]
    if (flag) expected.push(`${armedInB}|15 5 * * 1`, `${armedInB}|30 2 * * *`)
    expect(live()).toEqual(expected.sort())
    expect(clocks.armed.filter((c) => !c.stopped).every((c) => c.actorUserId === null)).toBe(true)
    // B's clocks were not touched (armed once, never stopped).
    if (flag) expect(clocks.armed.filter((c) => c.workspaceId === B).every((c) => !c.stopped)).toBe(true)
  })

  it('one business that cannot be read never stops the next one', async () => {
    unreadable = A
    const errors = vi.spyOn(logger, 'error')
    await resyncFleetSchedules()
    // A falls back to the env clocks and arms no routine (said in the log, with the business); B is whole.
    const expected = [`${armedInA ?? '-'}|45 4 * * *`, `${armedInA ?? '-'}|15 5 * * 1`]
    if (flag) expected.push(`${armedInB}|15 5 * * 1`, `${armedInB}|30 2 * * *`)
    expect(live()).toEqual(expected.sort())
    expect(errors).toHaveBeenCalledWith('[fleet-workflow] custom clock resync failed', expect.objectContaining({ workspaceId: A }))
  })

  describe("a routine's clock and every off switch", () => {
    const tick = async () => {
      await inside(() => database.client.cronRun.deleteMany({ where: { jobName: 'workflow:night-check' } }))
      await clockFor('0 3 * * *', armedInA).tick()
      const runs = await inside(() => database.client.cronRun.findMany({ where: { jobName: 'workflow:night-check' }, select: { outputSummary: true } }))
      expect(runs).toHaveLength(1)
      return runs[0]!.outputSummary ?? ''
    }
    const setWorker = async (data: { enabled?: boolean; autonomyLevel?: string; pausedUntil?: Date | null }) => {
      await inside(() => database.client.agentCharter.updateMany({ where: { key: 'fleet-selftest' }, data }))
      bustCharterCache() // outside any business: every business's cached charters (a legacy-mode tick reads its own)
    }

    beforeEach(async () => {
      await resyncFleetSchedules()
    })
    afterEach(async () => {
      await setWorker({ enabled: false, autonomyLevel: 'OFF', pausedUntil: null })
      await inside(async () => {
        await resumeFleet('test')
        await database.client.automationSwitch.deleteMany({ where: { key: 'fleet-analysts' } })
        await database.client.agentWorkflow.updateMany({ where: { key: 'night-check' }, data: { enabled: true } })
      })
    })

    it('ticks in its own business only', async () => {
      await tick()
      if (flag) {
        const inB = await inside(() => database.client.cronRun.count({ where: { jobName: 'workflow:night-check' } }), B)
        expect(inB).toBe(0)
      }
    })

    it('every worker off (production today): the tick skips them all and reaches no model', async () => {
      const runsBefore = await inside(() => database.client.agentRun.count({ where: { agentKey: 'fleet-selftest' } }))
      expect(await tick()).toBe('started=1 ok=0 failed=0 skipped=1')
      expect(model.generate).not.toHaveBeenCalled()
      // A worker that is off is a silent no-op: not even a run row.
      expect(await inside(() => database.client.agentRun.count({ where: { agentKey: 'fleet-selftest' } }))).toBe(runsBefore)
    })

    it('control: the worker on and nothing switched off — the tick does reach the model', async () => {
      await setWorker({ enabled: true, autonomyLevel: 'OBSERVE' })
      await tick()
      expect(model.generate).toHaveBeenCalled()
    })

    it('the worker on but paused: no model', async () => {
      await setWorker({ enabled: true, autonomyLevel: 'OBSERVE', pausedUntil: new Date(Date.now() + 3_600_000) })
      expect(await tick()).toBe('started=1 ok=0 failed=0 skipped=1')
      expect(model.generate).not.toHaveBeenCalled()
    })

    it('the worker on, NEXUS_AI_KILL_SWITCH set: no model', async () => {
      await setWorker({ enabled: true, autonomyLevel: 'OBSERVE' })
      process.env.NEXUS_AI_KILL_SWITCH = '1'
      expect(await tick()).toContain('halted=kill_switch')
      expect(model.generate).not.toHaveBeenCalled()
    })

    it("the worker on, this business's fleet stopped: no model", async () => {
      await setWorker({ enabled: true, autonomyLevel: 'OBSERVE' })
      await inside(() => haltFleet('stopped by a person (test)', 'test'))
      expect(await tick()).toContain('halted=fleet_halted')
      expect(model.generate).not.toHaveBeenCalled()
    })

    it('the worker on, this business\'s "Analyst fleet" switch at OFF: no model', async () => {
      await setWorker({ enabled: true, autonomyLevel: 'OBSERVE' })
      await inside(() => database.client.automationSwitch.create({ data: { key: 'fleet-analysts', mode: 'OFF', setBy: 'user:test' } }))
      expect(await tick()).toMatch(/^skipped: switched to OFF/)
      expect(model.generate).not.toHaveBeenCalled()
    })

    it('the worker on, the routine switched off: no clock after the resync, and a stale tick runs nothing', async () => {
      await setWorker({ enabled: true, autonomyLevel: 'OBSERVE' })
      const stale = clockFor('0 3 * * *', armedInA)
      await inside(() => database.client.agentWorkflow.updateMany({ where: { key: 'night-check' }, data: { enabled: false } }))
      await resyncFleetSchedules()
      expect(live()).not.toContain(`${armedInA ?? '-'}|0 3 * * *`)
      await inside(() => database.client.cronRun.deleteMany({ where: { jobName: 'workflow:night-check' } }))
      await stale.tick()
      const runs = await inside(() => database.client.cronRun.findMany({ where: { jobName: 'workflow:night-check' }, select: { outputSummary: true } }))
      expect(runs[0]?.outputSummary).toContain('halted=workflow_disabled')
      expect(model.generate).not.toHaveBeenCalled()
    })
  })
})
