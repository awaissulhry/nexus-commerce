/**
 * Bid-page fix 10-10 — the give-back after the night floor gives back the newest bid the brain set, and says what holds it.
 *
 * The cause seen live (a goal's bid and a rule's raise both came back lower): the give-back read the newest bid right ("the
 * bid before it" named it) and then held it, without a word, to today's limits — there the hourly plan's lowest CPC ceiling
 * of the day. Two more ways it
 * gave back an OLDER bid than the newest one the brain set:
 *   money      the money brake's step down was not a decision the give-back counted: a floor after it gave back the bid
 *              from before the step
 *   unlanded   a LIVE write that did not land (refused at the gate, deferred by the caps, would-apply under SUGGEST)
 *              counted with the bid it asked for; the bid stayed where it was
 *
 *   decide     the limit that holds the bid given back is named in the why
 *   bidSetBy   the bid a kept decision left: its decided bid, or the bid that stayed when its write did not land
 *   loaded     the money step is the bid before; an unlanded write leaves the bid it found (PGlite, the production schema)
 *
 * Values are made up (public repo).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { withWorkspace } from '../../../lib/workspace-context.js'
import { decide, type TargetFacts } from './decide.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', () => ({ default: new Proxy({}, { get: (_target, key) => Reflect.get(database.client, key) }) }))
const { bidSetBy, loadLowered, previousDecisions } = await import('./load.js')

const DAY = '2026-10-01'
/** A tick with no evidence (the 15-minute one that lifts the floor). */
function lightFacts(current: number, extra: Partial<TargetFacts> = {}): TargetFacts {
  return {
    targetId: 'kw-1', currentCents: current, dataDay: DAY, chain: [], listPriceCents: 8990,
    goal: { target: { kind: 'ACOS', pct: 20 }, band: { loPct: 18, hiPct: 28 }, phase: 'PROFIT' },
    limits: { maxBidCents: 80, maxChangePct: 25 }, ...extra,
  }
}

describe('the limit that holds a bid given back is said', () => {
  it('the bid before is 20¢ and the strategy\'s highest bid 12¢: back to 12¢, and the why says the limit held it', () => {
    const d = decide(lightFacts(2, { restore: { layer: 'min_bid_hour', heldCents: 2, beforeCents: 20 }, limits: { maxBidCents: 12, maxChangePct: 25 } }))
    expect([d.action, d.layer, d.bidCents]).toEqual(['write', 'restore', 12])
    expect(d.why).toMatch(/^restore: the min-bid_hour layer no longer applies → back to 12¢ from the 2¢ it held \(the bid before it: 20¢; 20¢ held to the strategy highest bid; /)
  })

  it('Owner decision A — this hour\'s plan ceiling 12¢: back to 12¢, held by the plan at its hours, the brain\'s own 20¢ kept', () => {
    const lanes = [{ lane: 'TOP_OF_SEARCH' as const, planPct: 50, maxCpcCents: 12, dynamic: 1 }]
    const d = decide(lightFacts(2, { restore: { layer: 'min_bid_hour', heldCents: 2, beforeCents: 20 }, lanes, hourWords: 'the plan at 08:00–10:00' }))
    expect([d.action, d.layer, d.bidCents, d.beforeHour]).toEqual(['write', 'restore', 12, 20])
    expect(d.why).toMatch(/^restore: the min-bid_hour layer no longer applies → back to 12¢ from the 2¢ it held \(the bid before it: 20¢; .*held to 12¢ by the plan at 08:00–10:00/)
  })

  it('a bid before inside every limit comes back as it was, with no limit named', () => {
    const d = decide(lightFacts(2, { restore: { layer: 'min_bid_hour', heldCents: 2, beforeCents: 16 }, limits: { maxBidCents: 80, maxChangePct: 25, planCeilingCents: 40 } }))
    expect(d.bidCents).toBe(16)
    expect(d.why).not.toMatch(/held to/)
  })
})

describe('bidSetBy — the bid a kept decision left', () => {
  const live = (sent: string | null, layer = 'goal') => ({ decidedCents: 24, currentCents: 20, layer, action: 'write', mode: 'LIVE', sent })
  it('a write that landed or is on its way: the bid it decided', () => {
    expect(bidSetBy(live('queued'))).toBe(24)
    expect(bidSetBy(live('unchanged'))).toBe(24)
  })
  it('a LIVE write that did not land set no bid (review fix 3: never its current bid, which may be a floor)', () => {
    for (const sent of ['refused', 'deferred', 'would-apply']) expect(bidSetBy(live(sent))).toBeNull()
  })
  it('a hold, a shadow decision and a refused give-back (the bid to give back again) keep their decided bid', () => {
    expect(bidSetBy({ ...live(null), action: 'hold', decidedCents: 20 })).toBe(20)
    expect(bidSetBy({ ...live('refused'), mode: 'SHADOW' })).toBe(24)
    expect(bidSetBy(live('refused', 'restore'))).toBe(24)
  })
})

// ── Loaded from the decisions (PGlite, the production schema, business profiles ON) ─────────────────────────────────

const W = 'bidpage_restore_latest'
const inside = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: W, actorUserId: null, membershipId: null, roleKeys: [] }, work)

describe('the bid before a floor, as the give-back reads it', () => {
  beforeAll(async () => {
    database = await formulaDatabase()
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP)`, [W])
  }, 120_000)
  afterAll(async () => { vi.unstubAllEnvs(); await database?.close() }, 30_000)

  const row = (targetId: string, at: string, layer: string, action: string, currentCents: number, decidedCents: number, sent?: string) => ({
    runId: `run-${at}`, mode: 'LIVE', kind: 'change', marketplace: 'IT', campaignId: 'c-1', adGroupId: 'g-1', targetId, action, layer,
    currentCents, decidedCents, dataDay: new Date(`${DAY}T00:00:00Z`), why: layer, evidence: (sent ? { sent: { sent } } : {}) as never, createdAt: new Date(at),
  })
  const read = (ids: string[]) => inside(async () => loadLowered(await previousDecisions(ids, new Date('2026-10-10T06:05:00Z'))))

  it('the money brake stepped the bid down before the floor: the bid before is the step (22¢), not the goal\'s 24¢', async () => {
    await inside(() => database.client.bidBrainDecision.createMany({
      data: [
        row('kw-money', '2026-10-09T06:45:00Z', 'goal', 'write', 20, 24, 'queued'),
        row('kw-money', '2026-10-09T12:45:00Z', 'money', 'write', 24, 22, 'queued'),
        row('kw-money', '2026-10-09T22:00:00Z', 'min_bid_hour', 'write', 22, 2, 'queued'),
      ],
    }))
    const lowered = (await read(['kw-money'])).get('kw-money')!
    expect(lowered).toMatchObject({ layer: 'min_bid_hour', heldCents: 2, beforeCents: 22, foundCents: 22 })
    const d = decide(lightFacts(2, { restore: lowered }))
    expect([d.layer, d.bidCents]).toEqual(['restore', 22])
  })

  it('the goal\'s raise was refused at the gate: given back to the 20¢ that stayed, never the 24¢ it asked for', async () => {
    await inside(() => database.client.bidBrainDecision.createMany({
      data: [
        row('kw-refused', '2026-10-09T06:45:00Z', 'goal', 'write', 20, 24, 'refused'),
        row('kw-refused', '2026-10-09T22:00:00Z', 'min_bid_hour', 'write', 20, 2, 'queued'),
      ],
    }))
    const lowered = (await read(['kw-refused'])).get('kw-refused')!
    // The refused write is skipped (no bid before from it); the floor found 20¢, and that is given back.
    expect(lowered).toMatchObject({ beforeCents: null, foundCents: 20 })
    expect(decide(lightFacts(2, { restore: lowered })).bidCents).toBe(20)
  })
})
