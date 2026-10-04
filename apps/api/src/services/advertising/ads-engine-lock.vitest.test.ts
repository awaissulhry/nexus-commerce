/**
 * Group 1 (1e) — Run now honours the business switch, the env arm flag and the overlap lock (review 2.4).
 *
 * The lock is the lease of lib/cron/workspace-lease.ts, run here against an in-memory stand-in that answers its three
 * scripts the way Redis does (claim only if free, renew and release only by the holder's token) — no real Redis, as
 * the workspace-lease tests do. The switch is engine-switch.service's `engineMode`, stood in; the scheduler's flags
 * come through the real runtime-status readers from a stand-in heartbeat.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StatusRedis } from '../../lib/runtime-status/process-snapshot.js'

const h = vi.hoisted(() => ({
  switches: {} as Record<string, { mode: string; setBy: string } | undefined>,
  switchError: null as Error | null,
}))
vi.mock('../../db.js', () => ({ default: {} }))
vi.mock('../automation/engine-switch.service.js', () => ({
  engineMode: vi.fn(async (key: string, envMode: string) => {
    if (h.switchError) throw h.switchError
    const row = h.switches[key]
    if (!row) return { mode: envMode, switched: null, note: null }
    return { mode: row.mode, switched: { mode: row.mode, reason: null, setBy: row.setBy, setAt: '2026-10-04T00:00:00.000Z' }, note: `switched to ${row.mode} for this business by ${row.setBy}` }
  }),
}))

const { setStatusRedisForTests } = await import('../../lib/runtime-status/process-snapshot.js')
const lock = await import('./ads-engine-lock.js')
const { engineMode } = await import('../automation/engine-switch.service.js')

/** Redis as the lease scripts see it: one string per key, a token, an expiry. */
function memoryStore() {
  const keys = new Map<string, { value: string; expiresAt: number }>()
  const live = (key: string) => {
    const k = keys.get(key)
    if (k && k.expiresAt <= Date.now()) keys.delete(key)
    return keys.get(key)
  }
  const store = {
    status: 'ready',
    keys,
    eval: vi.fn(async (script: string, _n: number, key: string, token: string, ttl?: number) => {
      if (script.includes("'NX'")) {
        if (live(key)) return 0
        keys.set(key, { value: token, expiresAt: Date.now() + Number(ttl) })
        return 1
      }
      const held = live(key)
      if (!held || held.value !== token) return 0
      if (script.includes('pexpire')) { held.expiresAt = Date.now() + 90_000; return 1 }
      if (script.includes("'del'")) { keys.delete(key); return 1 }
      throw new Error(`unexpected script: ${script}`)
    }),
  }
  return store
}

/** A heartbeat the scheduler would publish, with the flags it sees. */
function schedulerPublishes(flags: Record<string, string> | null) {
  const snapshot = flags === null ? null : JSON.stringify({ v: 1, role: 'scheduler', instanceId: 'sched-1', pid: 1, startedAt: new Date().toISOString(), publishedAt: new Date().toISOString(), ready: true, sections: { flags } })
  const client: StatusRedis = {
    status: 'ready',
    set: async () => 'OK', sadd: async () => 1, srem: async () => 1, del: async () => 1, incr: async () => 1,
    smembers: async () => (snapshot ? ['scheduler:sched-1:1'] : []),
    mget: async (...members: string[]) => members.map(() => snapshot),
  }
  setStatusRedisForTests(client)
}

const ARMED = { NEXUS_ENABLE_AMAZON_ADS_CRON: 'true', NEXUS_ENABLE_RANK_DEFEND: '1', NEXUS_ENABLE_TOS_DEFENSE_CRON: '1' }
let store: ReturnType<typeof memoryStore>
const savedRole = process.env.NEXUS_PROCESS_ROLE

beforeEach(() => {
  h.switches = {}
  h.switchError = null
  store = memoryStore()
  lock.setEngineLockStoreForTests(store)
  schedulerPublishes(ARMED)
  delete process.env.NEXUS_PROCESS_ROLE
})
afterEach(() => {
  lock.setEngineLockStoreForTests(undefined)
  setStatusRedisForTests(undefined)
  vi.useRealTimers()
  if (savedRole === undefined) delete process.env.NEXUS_PROCESS_ROLE; else process.env.NEXUS_PROCESS_ROLE = savedRole
})

describe('withEngineLock — one run per business and engine at a time', () => {
  it('a second run while the first holds the lock answers "a run is already in progress" and does not run', async () => {
    let release!: () => void
    const first = vi.fn(() => new Promise<string>((resolve) => { release = () => resolve('evaluated=3 applied=2') }))
    const second = vi.fn(async () => 'should not run')
    const tick = lock.withEngineLock('ws-a', 'rank-defend', first)
    await vi.waitFor(() => expect(first).toHaveBeenCalled())
    expect(await lock.withEngineLock('ws-a', 'rank-defend', second)).toEqual({ ran: false, reason: 'a run is already in progress' })
    expect(second).not.toHaveBeenCalled()
    release()
    expect(await tick).toEqual({ ran: true, value: 'evaluated=3 applied=2' })
    // Released: the next run goes ahead.
    expect(store.keys.size).toBe(0)
    expect(await lock.withEngineLock('ws-a', 'rank-defend', second)).toEqual({ ran: true, value: 'should not run' })
  })

  it('another business, or another engine, is not held up', async () => {
    let release!: () => void
    const tick = lock.withEngineLock('ws-a', 'rank-defend', () => new Promise<void>((resolve) => { release = resolve }))
    await vi.waitFor(() => expect(store.keys.size).toBe(1))
    expect(await lock.withEngineLock('ws-b', 'rank-defend', async () => 'b')).toEqual({ ran: true, value: 'b' })
    expect(await lock.withEngineLock('ws-a', 'auto-bid', async () => 'auto-bid')).toEqual({ ran: true, value: 'auto-bid' })
    release()
    await tick
  })

  it('a run that throws still releases the lock; the error reaches the caller', async () => {
    await expect(lock.withEngineLock('ws-a', 'tos-defense', async () => { throw new Error('Amazon timed out') })).rejects.toThrow('Amazon timed out')
    expect(store.keys.size).toBe(0)
    expect((await lock.withEngineLock('ws-a', 'tos-defense', async () => 'next')).ran).toBe(true)
  })

  it('no Redis, or Redis not answering: nothing runs, and the reason says so', async () => {
    const work = vi.fn(async () => 'ran')
    lock.setEngineLockStoreForTests(null)
    expect(await lock.withEngineLock('ws-a', 'budget-enforce', work)).toMatchObject({ ran: false, reason: expect.stringMatching(/could not be taken \(Redis is not connected\)/) })
    lock.setEngineLockStoreForTests({ status: 'reconnecting', eval: vi.fn() })
    expect((await lock.withEngineLock('ws-a', 'budget-enforce', work)).ran).toBe(false)
    lock.setEngineLockStoreForTests({ status: 'ready', eval: vi.fn().mockRejectedValue(new Error('connection lost')) })
    expect(await lock.withEngineLock('ws-a', 'budget-enforce', work)).toMatchObject({ ran: false, reason: expect.stringContaining('connection lost') })
    expect(work).not.toHaveBeenCalled()
  })

  it('a long run keeps the lease: it is renewed every 20 s while the run is alive, so no second run slips in', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    let release!: () => void
    const tick = lock.withEngineLock('ws-a', 'rank-defend', () => new Promise<void>((resolve) => { release = resolve }))
    await vi.waitFor(() => expect(store.keys.size).toBe(1))
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(20_000) // 200 s: well past one 90 s lease
    expect(store.eval.mock.calls.filter(([script]) => String(script).includes('pexpire')).length).toBeGreaterThanOrEqual(9)
    expect(await lock.withEngineLock('ws-a', 'rank-defend', async () => 'second')).toEqual({ ran: false, reason: 'a run is already in progress' })
    release()
    await tick
    expect(store.keys.size).toBe(0)
  })
})

describe('guardLiveRun — the switch and the arm flags as the scheduler sees them, then the lock', () => {
  it('runs when the switch is on and the scheduler has the engine armed', async () => {
    expect(await lock.guardLiveRun('rank-defend', async () => 'evaluated=1 applied=1')).toEqual({ ran: true, value: 'evaluated=1 applied=1' })
  })

  it('switched OFF for this business: refused in plain words, before the lock is even asked for', async () => {
    h.switches['rank-defend'] = { mode: 'OFF', setBy: 'user:u-1e' }
    const work = vi.fn(async () => 'ran')
    expect(await lock.guardLiveRun('rank-defend', work)).toEqual({ ran: false, reason: 'Rank & Dayparting is switched off for this business (by user:u-1e)' })
    expect(work).not.toHaveBeenCalled()
    expect(store.eval).not.toHaveBeenCalled()
  })

  it('the arm flag off ON THE SCHEDULER refuses, whatever the API process itself has set', async () => {
    process.env.NEXUS_ENABLE_TOS_DEFENSE_CRON = '1' // the API's own env: not what decides
    schedulerPublishes({ NEXUS_ENABLE_AMAZON_ADS_CRON: 'true' })
    const work = vi.fn(async () => 'ran')
    expect(await lock.guardLiveRun('tos-defense', work)).toEqual({ ran: false, reason: "Top-of-Search defense is switched off on the server (the scheduler's NEXUS_ENABLE_TOS_DEFENSE_CRON is not on)" })
    delete process.env.NEXUS_ENABLE_TOS_DEFENSE_CRON
    // Rank-defend arms only with exactly '1', as the scheduler parses it.
    schedulerPublishes({ ...ARMED, NEXUS_ENABLE_RANK_DEFEND: 'true' })
    expect((await lock.guardLiveRun('rank-defend', work)).ran).toBe(false)
    // The master ads flag is part of every ads engine's arm.
    schedulerPublishes({ NEXUS_ENABLE_AMAZON_ADS_CRON: '0', NEXUS_ENABLE_RANK_DEFEND: '1' })
    expect(await lock.guardLiveRun('auto-bid', work)).toEqual({ ran: false, reason: "Bid optimiser is switched off on the server (the scheduler's NEXUS_ENABLE_AMAZON_ADS_CRON is not on)" })
    expect(work).not.toHaveBeenCalled()
  })

  it('unknown is not on: no scheduler heartbeat (or no Redis) refuses, and says why', async () => {
    schedulerPublishes(null)
    const work = vi.fn(async () => 'ran')
    expect(await lock.guardLiveRun('rank-defend', work)).toMatchObject({ ran: false, reason: expect.stringMatching(/^whether Rank & Dayparting is switched on cannot be read from the scheduler \(no live heartbeat from the scheduler process/) })
    setStatusRedisForTests(null)
    expect((await lock.guardLiveRun('rank-defend', work)).ran).toBe(false)
    expect(work).not.toHaveBeenCalled()
  })

  it('inside the scheduler the flags are its own env (no heartbeat needed)', async () => {
    process.env.NEXUS_PROCESS_ROLE = 'scheduler'
    setStatusRedisForTests(null)
    const saved = { ...process.env }
    try {
      Object.assign(process.env, ARMED)
      expect((await lock.guardLiveRun('rank-defend', async () => 'ok')).ran).toBe(true)
      process.env.NEXUS_ENABLE_RANK_DEFEND = '0'
      expect((await lock.guardLiveRun('rank-defend', async () => 'ok')).ran).toBe(false)
    } finally {
      for (const k of Object.keys(ARMED)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
    }
  })

  it('a switch that cannot be read fails the run (it never runs an engine this business may have switched off)', async () => {
    h.switchError = new Error('database unavailable')
    await expect(lock.guardLiveRun('auto-bid', async () => 'ran')).rejects.toThrow('database unavailable')
  })

  it('runs in the business of the caller: the lock key carries it', async () => {
    const { withWorkspace } = await import('../../lib/workspace-context.js')
    await withWorkspace({ workspaceId: 'ws-xavia', actorUserId: null, membershipId: null, roleKeys: [] }, () => lock.guardLiveRun('auto-bid', async () => {
      expect([...store.keys.keys()]).toEqual(['nexus:ads:engine-lock:ws-xavia:auto-bid'])
    }))
  })
})

describe('runNowRefusal — the drawer asks the same question', () => {
  it('answers for the guarded engines and stays out of the others', async () => {
    h.switches['auto-bid'] = { mode: 'OFF', setBy: 'user:u-1e' }
    expect(await lock.runNowRefusal('auto-bid')).toBe('Bid optimiser is switched off for this business (by user:u-1e)')
    expect(await lock.runNowRefusal('rank-defend')).toBeNull()
    vi.mocked(engineMode).mockClear()
    expect(await lock.runNowRefusal('anomaly-guard')).toBeNull()
    expect(engineMode).not.toHaveBeenCalled()
  })

  it('budget enforcement needs only its switch (its tick reads its own apply flag)', async () => {
    schedulerPublishes(null)
    expect(await lock.runNowRefusal('budget-enforce')).toBeNull()
    h.switches['budget-enforce'] = { mode: 'OBSERVE', setBy: 'user:u-1e' }
    expect(await lock.runNowRefusal('budget-enforce')).toBeNull()
    h.switches['budget-enforce'] = { mode: 'OFF', setBy: 'user:u-1e' }
    expect(await lock.runNowRefusal('budget-enforce')).toBe('Budget enforcement is switched off for this business (by user:u-1e)')
  })
})
