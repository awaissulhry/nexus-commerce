/**
 * Owner decision A (10-10) — the hourly plan's CPC ceiling binds PER HOUR (it was the day's lowest hour, all day).
 *
 *   per hour     each tick holds the keyword bid to THIS hour's ceiling: min(the brain's own bid, the ceiling); at an hour
 *                boundary it moves down when the ceiling drops and back up to the brain's own bid when it rises — on a
 *                tick with no evidence too (the brain's own bid is remembered: `beforeHour` → planHeld)
 *   plan's move  such a move (`plan_hour`) takes no goal step: the day's step and its anchor stay the brain's, so the bid
 *                never sticks low after a swing; the dead zone holds; the raise cap holds a plan raise and keeps the memory
 *   left alone   a pin (a person's own edit), a brake (a halt, the kill switch's posture), a Min-bid hour (the night floor)
 *   why          "held to 15¢ by the plan at 14:00–16:00"
 *   loaded       the brain's own bid read back from the newest decision; a floor's give-back starts from it (PGlite)
 *   written      a plan lowering is a floor write, a plan raise an exact one (no step clamp), both through the gate
 *
 * Values are made up (public repo).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { withWorkspace } from '../../../lib/workspace-context.js'
import { decide, type TargetFacts } from './decide.js'
import type { Evidence } from './estimator.js'
import type { Lane } from './recipe.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', () => ({ default: new Proxy({}, { get: (_target, key) => Reflect.get(database.client, key) }) }))
const { bidSetBy, loadLowered, planHeldOf, previousDecisions } = await import('./load.js')
const { isExactWrite, writeKind } = await import('./live-writer.js')

const ev = (clicks: number, orders = 0, salesCents = 0, costCents = 0): Evidence => ({ clicks, orders, salesCents, costCents })
/** A goal bid of about 16¢ at aim 20 %, band 18–28 % (the rates of overrides.vitest.test.ts). */
const CHAIN = [
  { level: 'target' as const, evidence: ev(1, 0, 0, 30) },
  { level: 'product' as const, evidence: ev(2300, 20, 162_300, 69_000) },
  { level: 'market' as const, evidence: ev(9000, 90, 720_000, 270_000) },
]
const DAY = '2026-10-01'
const lanes = (ceiling: number): Lane[] => [{ lane: 'TOP_OF_SEARCH', planPct: 100, maxCpcCents: ceiling, baseCeilingCents: ceiling, dynamic: 1 }]
function facts(current: number, extra: Partial<TargetFacts> = {}): TargetFacts {
  return {
    targetId: 'kw-1', currentCents: current, dataDay: DAY, chain: CHAIN, listPriceCents: 8990, parentCpcRatio: 0.88,
    goal: { target: { kind: 'ACOS', pct: 20 }, band: { loPct: 18, hiPct: 28 }, phase: 'PROFIT' },
    limits: { maxBidCents: 80, maxChangePct: 25 }, ...extra,
  }
}
/** A 15-minute tick: no evidence. */
const tick = (current: number, extra: Partial<TargetFacts> = {}) => facts(current, { chain: [], ...extra })
const AT = (words: string) => ({ hourWords: `the plan at ${words}` })

describe('the plan\'s ceiling binds per hour, on the ticks with no evidence too', () => {
  it('the ceiling drops to 15¢ at 14:00: the brain\'s 19¢ goes down to 15¢, a plan move that remembers 19¢', () => {
    const d = decide(tick(19, { lanes: lanes(15), ...AT('14:00–16:00') }))
    expect([d.action, d.layer, d.currentCents, d.bidCents, d.beforeHour]).toEqual(['write', 'plan_hour', 19, 15, 19])
    expect(d.why).toBe('plan hour: held to 15¢ by the plan at 14:00–16:00 (the brain\'s own bid 19¢) — 19¢ → 15¢')
  })

  it('the ceiling rises to 40¢ at 16:00: back up to the brain\'s own 19¢, never above it', () => {
    const d = decide(tick(15, { lanes: lanes(40), ...AT('16:00–20:00'), planHeld: { cents: 15, fromCents: 19, beforeCents: 19 } }))
    expect([d.action, d.layer, d.currentCents, d.bidCents, d.beforeHour ?? null]).toEqual(['write', 'plan_hour', 15, 19, null])
    expect(d.why).toMatch(/^plan hour: the plan at 16:00–20:00 allows 40¢ — back to the brain's own bid 19¢; 15¢ → 19¢$/)
    // A rise that still binds: up to the new ceiling, the brain's own bid still remembered.
    const part = decide(tick(15, { lanes: lanes(17), ...AT('16:00–17:00'), planHeld: { cents: 15, fromCents: 19, beforeCents: 19 } }))
    expect([part.action, part.bidCents, part.beforeHour]).toEqual(['write', 17, 19])
    // An hour with no ceiling (no plan lanes): back to the brain's own bid.
    expect(decide(tick(15, { planHeld: { cents: 15, fromCents: 19, beforeCents: 19 } })).bidCents).toBe(19)
  })

  it('the same hour again: nothing to write, the memory stays', () => {
    const d = decide(tick(15, { lanes: lanes(15), ...AT('14:00–16:00'), planHeld: { cents: 15, fromCents: 19, beforeCents: 19 } }))
    expect([d.action, d.bidCents, d.beforeHour]).toEqual(['hold', 15, 19])
  })

  it('the dead zone: a move under 2¢ or 5 % is not written', () => {
    const d = decide(tick(15, { lanes: lanes(40), planHeld: { cents: 15, fromCents: 16, beforeCents: 16 } }))
    expect([d.action, d.bidCents]).toEqual(['hold', 15])
  })

  it('a plan raise waits behind the raise cap (the money brake\'s hold) and keeps the brain\'s own bid in memory', () => {
    const d = decide(tick(15, { lanes: lanes(40), planHeld: { cents: 15, fromCents: 19, beforeCents: 19 }, raiseCap: 'the money brake: no raises' }))
    expect([d.action, d.bidCents, d.beforeHour]).toEqual(['hold', 15, 19])
    expect(d.why).toMatch(/^plan-hour: raise held — the money brake: no raises/)
  })
})

describe('the plan\'s moves use up nothing of the brain\'s own (a run with evidence)', () => {
  // The day's step was 12¢ → 15¢ (toward a goal of about 16¢); the plan held it at 10¢ last hour.
  const step = { dataDay: DAY, fromCents: 12, toCents: 15 }

  it('the ceiling rises: back to 15¢ — not a new step from 10¢ (it would stick at 12–13¢ after the first swing)', () => {
    const d = decide(facts(10, { lastStep: step, lanes: lanes(40), planHeld: { cents: 10, fromCents: 15, beforeCents: 15 } }))
    expect([d.action, d.layer, d.bidCents]).toEqual(['write', 'plan_hour', 15])
    expect(d.step ?? null).toBeNull()
  })

  it('the ceiling drops: down to 10¢, the day\'s step untouched, the brain\'s 15¢ remembered', () => {
    const d = decide(facts(15, { lastStep: step, lanes: lanes(10), ...AT('18:00–20:00') }))
    expect([d.action, d.layer, d.bidCents, d.beforeHour]).toEqual(['write', 'plan_hour', 10, 15])
    expect(d.step ?? null).toBeNull()
    expect(d.why).toMatch(/held to 10¢ by the plan at 18:00–20:00/)
  })

  it('a goal step under a binding ceiling: the step is the goal\'s own (unheld), the bid the hour\'s', () => {
    const d = decide(facts(10, { lanes: lanes(10), ...AT('18:00–20:00') }))
    expect([d.action, d.bidCents]).toEqual(['hold', 10])
    expect(d.step).toEqual({ dataDay: DAY, fromCents: 10, toCents: d.beforeHour })
    expect(d.beforeHour).toBeGreaterThan(10)
    expect(d.why).toMatch(new RegExp(`${d.beforeHour}¢ held to 10¢ by the plan at 18:00–20:00`))
  })
})

describe('left as decided', () => {
  it('a person\'s own edit (a pin) wins over the hour', () => {
    const d = decide(tick(30, { lanes: lanes(15), overrides: { pin: { by: 'a person (their bid of the last 60 days)' } } }))
    expect([d.action, d.layer, d.bidCents]).toEqual(['hold', 'pin', 30])
  })
  it('a brake (a halt, the dial off) moves nothing', () => {
    const d = decide(tick(30, { lanes: lanes(15), brakes: ['halted: test'], planHeld: { cents: 30, fromCents: 40, beforeCents: 40 } }))
    expect([d.action, d.layer, d.currentCents, d.bidCents]).toEqual(['brake', 'brake', 30, 30])
  })
  it('the night floor (a Min-bid hour) is the floor, from the bid as it is', () => {
    const d = decide(tick(15, { overrides: { minBidHour: { floorCents: 2 } }, planHeld: { cents: 15, fromCents: 19, beforeCents: 19 } }))
    expect([d.action, d.layer, d.currentCents, d.bidCents]).toEqual(['write', 'min_bid_hour', 15, 2])
  })
})

describe('the plan\'s writes', () => {
  const d = (layer: 'plan_hour', currentCents: number, bidCents: number) => ({ layer, currentCents, bidCents })
  it('down: a floor write, taken exactly; up: an exact forward write (no step clamp), counted and judged by the gate', () => {
    expect([writeKind(d('plan_hour', 19, 15)), isExactWrite(d('plan_hour', 19, 15))]).toEqual(['floor', true])
    expect([writeKind(d('plan_hour', 10, 19)), isExactWrite(d('plan_hour', 10, 19))]).toEqual(['forward', true])
  })
})

// ── Loaded from the decisions (PGlite, the production schema, business profiles ON) ─────────────────────────────────

const W = 'bidpage_plan_hour'
const inside = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: W, actorUserId: null, membershipId: null, roleKeys: [] }, work)

describe('the brain\'s own bid, read back', () => {
  beforeAll(async () => {
    database = await formulaDatabase()
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP)`, [W])
  }, 120_000)
  afterAll(async () => { vi.unstubAllEnvs(); await database?.close() }, 30_000)

  const row = (targetId: string, at: string, layer: string, action: string, currentCents: number, decidedCents: number, evidence: Record<string, unknown> = {}) => ({
    runId: `run-${at}`, mode: 'LIVE', kind: 'change', marketplace: 'IT', campaignId: 'c-1', adGroupId: 'g-1', targetId, action, layer,
    currentCents, decidedCents, dataDay: new Date(`${DAY}T00:00:00Z`), why: layer, evidence: evidence as never, createdAt: new Date(at),
  })

  it('the newest decision\'s `beforeHour` is the plan\'s hold; after the night floor the give-back starts from the brain\'s own bid', async () => {
    await inside(() => database.client.bidBrainDecision.createMany({
      data: [
        row('kw-h', '2026-10-09T12:00:00Z', 'plan_hour', 'write', 19, 15, { beforeHour: 19, sent: { sent: 'queued' } }),
        row('kw-n', '2026-10-09T12:00:00Z', 'plan_hour', 'write', 19, 15, { beforeHour: 19, sent: { sent: 'queued' } }),
        row('kw-n', '2026-10-09T22:00:00Z', 'min_bid_hour', 'write', 15, 2, { sent: { sent: 'queued' } }),
      ],
    }))
    const prev = await inside(() => previousDecisions(['kw-h', 'kw-n'], new Date('2026-10-10T06:05:00Z')))
    expect(planHeldOf(prev)).toEqual(new Map([['kw-h', { cents: 15, fromCents: 19, beforeCents: 19 }]]))
    const lowered = await inside(() => loadLowered(prev))
    expect(lowered.get('kw-n')).toMatchObject({ layer: 'min_bid_hour', beforeCents: 19 })
    expect(bidSetBy({ decidedCents: 15, currentCents: 19, layer: 'plan_hour', action: 'write', mode: 'LIVE', sent: 'queued', beforeHour: 19 })).toBe(19)
  })
})
