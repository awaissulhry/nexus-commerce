/**
 * Group 1 (1c) — an engine's own brakes: the dial posture (fail closed) and its write caps per run and per day.
 *
 * Pure parts run as they are; the two reads (the automation state and today's action-log count) are stand-ins, so
 * this file needs no database. The jobs' own end-to-end arms are in jobs/ad-engine-dial-caps.vitest.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ value: null as null | Record<string, unknown>, throws: false }))
vi.mock('./ads-automation-state.service.js', () => ({
  getAutomationState: async () => {
    if (state.throws) throw new Error('pooler blip')
    return state.value
  },
}))
const log = vi.hoisted(() => ({ count: vi.fn() }))
vi.mock('../../db.js', () => ({ default: { advertisingActionLog: { count: log.count } } }))
vi.mock('../../utils/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

const {
  DRY_RUN, allowChange, engineCapsText, engineGuardNote, makeEngineGuard, nothingHeld, openEngineGuard, readEnginePosture,
} = await import('./ads-engine-guard.js')
const { ENGINE_CAPS_ENV } = await import('./ads-engine-actors.js')

const view = (over: Record<string, unknown> = {}) => ({
  autonomy: 'AUTO', halted: false, haltReason: null, effectivelyStopped: false, degraded: false, ...over,
})
const savedCaps = process.env[ENGINE_CAPS_ENV]
const savedKill = process.env.NEXUS_ADS_AUTOMATION_KILL
beforeEach(() => {
  state.value = view(); state.throws = false
  log.count.mockReset(); log.count.mockResolvedValue(0)
  delete process.env[ENGINE_CAPS_ENV]; delete process.env.NEXUS_ADS_AUTOMATION_KILL
})
afterEach(() => {
  if (savedCaps === undefined) delete process.env[ENGINE_CAPS_ENV]; else process.env[ENGINE_CAPS_ENV] = savedCaps
  if (savedKill === undefined) delete process.env.NEXUS_ADS_AUTOMATION_KILL; else process.env.NEXUS_ADS_AUTOMATION_KILL = savedKill
})

describe('posture — read from the account automation state, fail closed', () => {
  it('AUTO → auto, SUGGEST → suggest', async () => {
    expect(await readEnginePosture()).toEqual({ posture: 'auto', why: 'the account ads dial is AUTO' })
    state.value = view({ autonomy: 'SUGGEST' })
    expect(await readEnginePosture()).toEqual({ posture: 'suggest', why: 'the account ads dial is SUGGEST' })
  })

  it('a halt, the dial at OFF and the kill switch are all stopped, each naming why', async () => {
    state.value = view({ halted: true, haltReason: 'rank-defend 1,300 changes in an hour' })
    expect(await readEnginePosture()).toEqual({ posture: 'stopped', why: 'halted: rank-defend 1,300 changes in an hour' })
    state.value = view({ autonomy: 'OFF' })
    expect(await readEnginePosture()).toEqual({ posture: 'stopped', why: 'the account ads dial is OFF' })
    state.value = view()
    process.env.NEXUS_ADS_AUTOMATION_KILL = '1'
    expect(await readEnginePosture()).toEqual({ posture: 'stopped', why: 'NEXUS_ADS_AUTOMATION_KILL is set' })
  })

  it('a state it cannot read is stopped, never auto (degraded row, a throw, an unknown dial value)', async () => {
    state.value = view({ degraded: true, autonomy: 'SUGGEST' })
    expect((await readEnginePosture()).posture).toBe('stopped')
    state.throws = true
    expect(await readEnginePosture()).toEqual({ posture: 'stopped', why: 'the ads automation state could not be read' })
    state.throws = false
    state.value = view({ autonomy: 'MAYBE' })
    expect((await readEnginePosture()).posture).toBe('stopped')
  })
})

describe('permits — what one campaign may write', () => {
  const caps = { perTick: 10, perDay: 100 }
  const guard = (posture: 'auto' | 'suggest' | 'stopped', todayBefore: number | null = 0) =>
    makeEngineGuard({ engine: 'rank-defend', posture, why: 'test', caps, todayBefore })

  it('auto: everything; suggest: only give-backs; stopped: only floors', () => {
    expect(guard('auto').permit()).toEqual({ forward: true, floor: true, restore: true, capped: false })
    expect(guard('suggest').permit()).toEqual({ forward: false, floor: false, restore: true, capped: false })
    expect(guard('stopped').permit()).toEqual({ forward: false, floor: true, restore: false, capped: false })
  })

  it('a campaign that starts under the run cap finishes; the next one is deferred whole, give-backs still allowed', () => {
    const g = guard('auto')
    const first = g.permit()
    expect(first.forward).toBe(true)
    g.settle(first, 14, nothingHeld()) // one campaign overshoots the cap of 10 — by at most itself
    const second = g.permit()
    expect(second).toEqual({ forward: false, floor: false, restore: true, capped: true })
    g.settle(second, 3, { forward: true, floor: false, restore: false }) // its restore ran (counted), its raise waits
    expect(g.report()).toMatchObject({ changes: 17, deferredByCap: 1, wouldApply: 0, waiting: 0 })
  })

  it('the daily cap counts what the engine already did today', () => {
    expect(guard('auto', 99).permit().forward).toBe(true)
    expect(guard('auto', 100).permit()).toMatchObject({ forward: false, restore: true, capped: true })
  })

  it("today's count unknown: no room for new changes (fail closed), give-backs still allowed", () => {
    expect(guard('auto', null).permit()).toEqual({ forward: false, floor: false, restore: true, capped: true })
  })

  it('caps bind floors while stopped too; restores never', () => {
    const g = guard('stopped', 100)
    expect(g.permit()).toEqual({ forward: false, floor: false, restore: false, capped: true })
  })

  it('what was held back is counted per posture', () => {
    const s = guard('suggest')
    s.settle(s.permit(), 2, { forward: true, floor: false, restore: false })
    s.settle(s.permit(), 0, { forward: false, floor: true, restore: false })
    s.settle(s.permit(), 3, nothingHeld()) // a give-back, nothing held
    expect(s.report()).toMatchObject({ posture: 'suggest', changes: 5, wouldApply: 2 })

    const st = guard('stopped')
    st.settle(st.permit(), 0, { forward: false, floor: false, restore: true })
    st.settle(st.permit(), 0, { forward: true, floor: false, restore: false })
    st.settle(st.permit(), 3, nothingHeld()) // a floor that landed
    expect(st.report()).toMatchObject({ posture: 'stopped', changes: 3, waiting: 2, deferredByCap: 0 })
  })

  it('allowChange: a dry run writes nothing and notes nothing; a real run notes what its permit withholds', () => {
    const held = nothingHeld()
    expect(allowChange(false, DRY_RUN, held, 'forward')).toBe(false)
    expect(held).toEqual(nothingHeld())
    const permit = { forward: false, floor: true, restore: false, capped: false }
    expect(allowChange(true, permit, held, 'floor')).toBe(true)
    expect(allowChange(true, permit, held, 'restore')).toBe(false)
    expect(held).toEqual({ forward: false, floor: false, restore: true })
  })
})

describe('openEngineGuard — one posture read and one day count per run', () => {
  it("counts this engine's action-log rows since 00:00 UTC, records of non-changes left out", async () => {
    log.count.mockResolvedValue(2_999)
    const g = await openEngineGuard('rank-defend', { now: new Date('2026-10-04T13:45:00Z') })
    expect(log.count).toHaveBeenCalledTimes(1)
    const where = log.count.mock.calls[0]![0].where
    expect(where.createdAt).toEqual({ gte: new Date('2026-10-04T00:00:00Z') })
    expect(where.OR).toEqual([{ userId: { startsWith: 'automation:rank-defend-' } }, { userId: { startsWith: 'automation:rank-plan-' } }])
    expect(where.actionType.notIn).toContain('coverage_engine_observe')
    // Default caps: 600 a run, 3,000 a day — 2,999 done, so one more campaign may start.
    expect(g.report()).toMatchObject({ posture: 'auto', caps: { perRun: 600, perDay: 3_000 }, todayBefore: 2_999 })
    expect(g.permit().forward).toBe(true)
  })

  it('a count that fails is unknown, not zero: nothing new this run', async () => {
    log.count.mockRejectedValue(new Error('timeout'))
    const g = await openEngineGuard('dayparting')
    expect(g.report().todayBefore).toBeNull()
    expect(g.permit()).toMatchObject({ forward: false, floor: false, restore: true })
  })

  it('the env override reaches the caps', async () => {
    process.env[ENGINE_CAPS_ENV] = JSON.stringify({ dayparting: { perTick: 7, perDay: 70 } })
    const g = await openEngineGuard('dayparting')
    expect(g.report().caps).toEqual({ perRun: 7, perDay: 70 })
    expect(engineCapsText('dayparting')).toBe('at most 7 changes a run and 70 a day')
  })
})

describe('the run summary line', () => {
  const base = { engine: 'rank-defend' as const, why: 'x', caps: { perRun: 600, perDay: 3_000 }, todayBefore: 1_000, changes: 21, wouldApply: 0, waiting: 0, deferredByCap: 0 }
  it('adds nothing on a normal AUTO run, so an ordinary day reads as before', () => {
    expect(engineGuardNote({ ...base, posture: 'auto' })).toBe('')
    expect(engineGuardNote(undefined)).toBe('')
  })
  it('says what the dial or the cap held back, in words', () => {
    expect(engineGuardNote({ ...base, posture: 'suggest', why: 'the account ads dial is SUGGEST', wouldApply: 12 }))
      .toBe(' would-apply=12 (the account ads dial is SUGGEST: nothing new is written; its own floors are still given back)')
    expect(engineGuardNote({ ...base, posture: 'stopped', why: 'halted: test', waiting: 9 })).toContain(' waiting=9 (stopped — halted: test: only bid floors land;')
    expect(engineGuardNote({ ...base, posture: 'auto', changes: 612, deferredByCap: 5 }))
      .toBe(' deferred-by-cap=5 (cap 600 a run, 3,000 a day; 612 this run, 1,612 today; they go next run)')
  })
})
