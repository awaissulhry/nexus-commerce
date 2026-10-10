/**
 * Bid-page fix 10-10 — the goal layer decides again after the night floor.
 *
 * The cause: a product the product cycle runs has its keyword bids decided ONCE a data day, by the cycle's bids step (from
 * 05:55 UTC) — inside the hourly plan's night floor (Min bid to 08:00 Rome), so every decision with evidence was the
 * floor's; the full runs leave the cycle's campaigns, and the 15-minute tick that lifts the floor reads no evidence
 * ("no goal: no evidence to pool"). So the goal never decided outside the floor.
 *
 *   decide     a floor decided WITH evidence also decides its give-back (GiveBack): the goal from the bid before, one
 *              step, inside the limits and that run's raise caps; with no evidence, none
 *   restore    a run with no evidence gives back that bid (with its step, its goal bid, its why) when it was decided from
 *              the same bid before for this data day or a newer one; else the bid before, as before
 *   rowKind    a decision whose give-back is new is stored (the cycle's floor hold would otherwise repeat the night's row)
 *   loaded     the newest give-back since the last decision no override lowered (PGlite, the production schema)
 *
 * Values are made up (public repo).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { withWorkspace } from '../../../lib/workspace-context.js'
import { decide, giveBackKey, type GiveBack, type TargetFacts } from './decide.js'
import type { Evidence } from './estimator.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', () => ({ default: new Proxy({}, { get: (_target, key) => Reflect.get(database.client, key) }) }))
const { rowKind } = await import('./shadow.js')
const { loadLowered, previousDecisions } = await import('./load.js')

const ev = (clicks: number, orders = 0, salesCents = 0, costCents = 0): Evidence => ({ clicks, orders, salesCents, costCents })
/** The same rates as overrides.vitest.test.ts: a goal bid of about 16¢ at aim 20 %, band 18–28 %. */
const CHAIN = [
  { level: 'target' as const, evidence: ev(1, 0, 0, 30) },
  { level: 'product' as const, evidence: ev(2300, 20, 162_300, 69_000) },
  { level: 'market' as const, evidence: ev(9000, 90, 720_000, 270_000) },
]
const DAY = '2026-10-01'
function facts(current: number, extra: Partial<TargetFacts> = {}): TargetFacts {
  return {
    targetId: 'kw-1', currentCents: current, dataDay: DAY, chain: CHAIN, listPriceCents: 8990, parentCpcRatio: 0.88,
    goal: { target: { kind: 'ACOS', pct: 20 }, band: { loPct: 18, hiPct: 28 }, phase: 'PROFIT' },
    limits: { maxBidCents: 80, maxChangePct: 25 }, ...extra,
  }
}
const NIGHT = { minBidHour: { floorCents: 2 } }
const floored = (beforeCents: number, giveBack?: GiveBack | null) => ({ layer: 'min_bid_hour' as const, heldCents: 2, beforeCents, foundCents: beforeCents, giveBack })

describe('a floor decided with evidence decides its give-back', () => {
  it('the cycle\'s run inside the night floor: held at 2¢, and the give-back is one goal step from the bid before (33¢ → 25¢)', () => {
    const d = decide(facts(2, { overrides: NIGHT, restore: floored(33), planNote: 'hourly plan TEST: pause — every placement at 0 %' }))
    expect([d.action, d.layer, d.bidCents]).toEqual(['hold', 'min_bid_hour', 2])
    expect(d.giveBack).toMatchObject({ dataDay: DAY, fromCents: 33, cents: 25, step: { dataDay: DAY, fromCents: 33, toCents: 25 } })
    expect(d.giveBack!.why).toMatch(/^goal: aim 20%/)
    // The floor's own hour is not in the give-back's words: the hour that lifts it applies its own limits.
    expect(d.giveBack!.why).not.toMatch(/pause/)
  })

  it('entering the floor this run: decided from the bid it finds', () => {
    const d = decide(facts(33, { overrides: NIGHT }))
    expect([d.action, d.layer, d.bidCents]).toEqual(['write', 'min_bid_hour', 2])
    expect(d.giveBack).toMatchObject({ fromCents: 33, cents: 25 })
  })

  it('inside that run\'s raise caps (the cycle\'s money step): a raise it holds is no give-back raise', () => {
    const d = decide(facts(2, { overrides: NIGHT, restore: floored(10), raiseCap: 'the product cycle\'s money step: its budget steps down today' }))
    expect(d.giveBack).toMatchObject({ fromCents: 10, cents: 10 })
  })

  it('no evidence (a between-slots tick), or no goal: no give-back', () => {
    expect(decide(facts(2, { chain: [], overrides: NIGHT, restore: floored(33) })).giveBack ?? null).toBeNull()
    expect(decide(facts(2, { overrides: NIGHT, restore: floored(33), goal: { target: null } })).giveBack ?? null).toBeNull()
  })
})

describe('the tick that lifts the floor gives back the goal\'s bid', () => {
  const memo = decide(facts(2, { overrides: NIGHT, restore: floored(33) })).giveBack!

  it('no evidence this tick: the give-back decided with evidence, with its step and goal bid — not "no evidence to pool"', () => {
    const d = decide(facts(2, { chain: [], restore: floored(33, memo) }))
    expect([d.action, d.layer, d.bidCents]).toEqual(['write', 'restore', 25])
    expect(d.step).toEqual({ dataDay: DAY, fromCents: 33, toCents: 25 })
    expect(d.goalBidCents).toBe(memo.goalBidCents)
    expect(d.why).toMatch(/^restore: the min-bid_hour layer no longer applies → back to 25¢ from the 2¢ it held \(the bid before it: 33¢; the goal as the run with evidence decided it during the floor \(data day 2026-10-01\): goal: /)
    expect(d.why).not.toMatch(/no evidence to pool/)
    // A rerun at 25¢ on the same data day takes no second step.
    expect(decide(facts(25, { lastStep: d.step })).action).toBe('hold')
  })

  it('this hour\'s limits still hold it, and the step lands where the bid lands', () => {
    const d = decide(facts(2, { chain: [], restore: floored(33, memo), limits: { maxBidCents: 80, maxChangePct: 25, planCeilingCents: 20 } }))
    expect([d.layer, d.bidCents]).toEqual(['restore', 20])
    expect(d.step).toEqual({ dataDay: DAY, fromCents: 33, toCents: 20 })
  })

  it('a give-back decided from another bid before, or for an older data day, is not used: the bid before, as before', () => {
    for (const other of [{ ...memo, fromCents: 40 }, { ...memo, dataDay: '2026-09-30' }]) {
      const d = decide(facts(2, { chain: [], restore: floored(33, other) }))
      expect([d.layer, d.bidCents]).toEqual(['restore', 33])
      expect(d.why).toMatch(/no goal: no evidence to pool/)
    }
  })

  it('with evidence this run the goal decides afresh (the give-back is only for a run with none)', () => {
    const d = decide(facts(2, { restore: floored(33, { ...memo, cents: 30 }) }))
    expect([d.layer, d.bidCents]).toEqual(['restore', 25])
  })
})

describe('a decision whose give-back is new is stored', () => {
  const now = new Date('2026-10-10T05:55:00Z')
  const prev = { action: 'hold', layer: 'min_bid_hour', currentCents: 2, decidedCents: 2, createdAt: new Date('2026-10-10T00:00:00Z'), lastStep: null, giveBackKey: null }
  const d = decide(facts(2, { overrides: NIGHT, restore: floored(33) }))

  it('the same floor hold, the same UTC day: stored when it carries a give-back the last row did not', () => {
    expect(rowKind({ ...d, giveBack: null }, prev, now)).toBeNull()
    expect(rowKind(d, prev, now)).toBe('change')
    expect(rowKind(d, { ...prev, giveBackKey: giveBackKey(d.giveBack) }, now)).toBeNull()
    // A tick with no evidence carries none: it does not store a row each time.
    expect(rowKind({ ...d, giveBack: undefined }, { ...prev, giveBackKey: giveBackKey(d.giveBack) }, now)).toBeNull()
  })
})

// ── Loaded from the decisions (PGlite, the production schema, business profiles ON) ─────────────────────────────────

const W = 'bidpage_goal_after_floor'
const inside = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: W, actorUserId: null, membershipId: null, roleKeys: [] }, work)

describe('the give-back as the next run reads it', () => {
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
  const memoOf = (fromCents: number, cents: number): GiveBack => ({ dataDay: DAY, fromCents, cents, goalBidCents: 16, step: { dataDay: DAY, fromCents, toCents: cents }, why: 'goal: test' })

  it('the newest give-back since the last decision no override lowered; an older one, or one before it, is not read', async () => {
    await inside(() => database.client.bidBrainDecision.createMany({
      data: [
        row('kw-a', '2026-10-08T22:45:00Z', 'min_bid_hour', 'hold', 2, 2, { giveBack: memoOf(40, 30) }), // before the goal below: stale
        row('kw-a', '2026-10-09T06:45:00Z', 'goal', 'write', 30, 33),
        row('kw-a', '2026-10-09T22:00:00Z', 'min_bid_hour', 'write', 33, 2),
        row('kw-a', '2026-10-10T05:55:00Z', 'min_bid_hour', 'hold', 2, 2, { giveBack: memoOf(33, 25) }), // the cycle's run
        row('kw-a', '2026-10-10T06:00:00Z', 'min_bid_hour', 'hold', 2, 2), // the UTC day's snapshot, after it
        row('kw-b', '2026-10-09T06:45:00Z', 'goal', 'write', 30, 33),
        row('kw-b', '2026-10-09T22:00:00Z', 'min_bid_hour', 'write', 33, 2),
      ],
    }))
    const lowered = await inside(async () => loadLowered(await previousDecisions(['kw-a', 'kw-b'], new Date('2026-10-10T06:05:00Z'))))
    expect(lowered.get('kw-a')).toMatchObject({ layer: 'min_bid_hour', heldCents: 2, beforeCents: 33, giveBack: memoOf(33, 25) })
    expect(lowered.get('kw-b')).toMatchObject({ layer: 'min_bid_hour', beforeCents: 33, giveBack: null })
  })

  it('the newest decision\'s give-back is its identity for rowKind', async () => {
    await inside(() => database.client.bidBrainDecision.create({ data: row('kw-c', '2026-10-10T05:55:00Z', 'min_bid_hour', 'hold', 2, 2, { giveBack: memoOf(20, 18) }) }))
    const prev = await inside(() => previousDecisions(['kw-c', 'kw-b'], new Date('2026-10-10T06:05:00Z')))
    expect(prev.get('kw-c')?.giveBackKey).toBe(giveBackKey(memoOf(20, 18)))
    expect(prev.get('kw-b')?.giveBackKey ?? null).toBeNull()
  })
})
