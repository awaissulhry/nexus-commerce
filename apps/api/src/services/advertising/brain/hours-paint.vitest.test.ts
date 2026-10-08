/**
 * ONE BRAIN AB-13 — painting the hourly plan (brain/hours-paint.ts) on a hand-made research (public repo: invented,
 * round numbers; targets named rest / defend / own / allout / pause).
 *
 *   ladder     the plan's own targets by placement %, a Min-bid target apart
 *   rules      Min bid where conversion is near zero and the spend is real; down above the band; up below it; keep in
 *              it, and when the interval is too wide (a thin product); a floored block judged on its pool's CPC
 *   moves      the furthest step within hourCellMovePct (one step at least); Min bid from anywhere; 0 % moves nothing
 *   kept       locked hours never change; the Owner's plan as limits is never exceeded and his Min-bid hours stay; a
 *              target that would move a locked lane is not taken
 *   anti-flap  at most minBidEntriesPerDay entries a day, the new run with the least spend going back first
 *   windows    the painted week reads back through the engine's own rule
 *   effect     a Min-bid hour cuts spend and orders, leaving Min bid adds them, each with lo ≤ mid ≤ hi
 */
import { describe, expect, it } from 'vitest'
import {
  decideBlocks, encodeWeek, expectedEffect, gridLines, ladderOf, minBidRuns, paintPlan, stepFrom, weekOf,
  type Goal, type PaintInput,
} from './hours-paint.js'
import { blockKey, cellRef } from './hours-research.js'
import { researchWith, testTargets } from './__fixtures__/hours-facts.js'

const T = testTargets()
const GOAL: Goal = { aim: 0.25, lo: 0.2, hi: 0.3, words: 'aim 25% (band 20–30%)' }
const EVERY = [0, 1, 2, 3, 4, 5, 6]
/** Rest of search all week; own top 16–22; defend 00–06. */
const PLAN = { windows: [{ days: EVERY, startHour: 16, endHour: 22, targetKey: 'own' }, { days: EVERY, startHour: 0, endHour: 6, targetKey: 'defend' }], defaultTargetKey: 'rest' }
// Level: CR 2 %, CPC 40, order value 80 → expected ACoS 25 % (the aim).

const input = (over: Partial<PaintInput> = {}): PaintInput => ({
  research: researchWith({}), goal: GOAL, plan: PLAN, targets: T,
  locks: { cells: new Set(), lanes: new Set() }, limits: null,
  settings: { hourCellMovePct: 30, minBidEntriesPerDay: 2 },
  ...over,
})

describe('the ladder', () => {
  it('the plan\'s own serving targets by placement %, its Min-bid target apart (else the library\'s pause)', () => {
    expect(ladderOf(PLAN, T)).toEqual({ serving: ['rest', 'defend', 'own'], minBid: 'pause', missing: [] })
    expect(ladderOf({ windows: [{ days: EVERY, startHour: 0, endHour: 4, targetKey: 'gone' }], defaultTargetKey: 'own' }, T)).toEqual({ serving: ['own'], minBid: 'pause', missing: ['gone'] })
  })

  it('moves the furthest step within the cap, one step at least; Min bid from anywhere; out of it to the lowest', () => {
    const ladder = { serving: ['rest', 'defend', 'own', 'allout'], minBid: 'pause' }
    expect(stepFrom('rest', 'up', ladder, T, 0.3)).toBe('defend') // +50 % > 30 %: one step anyway
    expect(stepFrom('own', 'up', ladder, T, 0.3)).toBe('allout') // +25 %
    expect(stepFrom('allout', 'down', ladder, T, 0.3)).toBe('own') // −20 %, then −40 % stops
    expect(stepFrom('rest', 'up', ladder, T, 1)).toBe('own') // +100 % fits, +150 % does not
    expect(stepFrom('rest', 'down', ladder, T, 0.3)).toBe('rest') // the lowest serving step: down never means Min bid
    expect(stepFrom('own', 'minbid', ladder, T, 0.3)).toBe('pause')
    expect(stepFrom('pause', 'up', ladder, T, 0.3)).toBe('rest')
    expect(stepFrom('pause', 'down', ladder, T, 0.3)).toBe('pause')
    expect(stepFrom('own', 'up', ladder, T, 0)).toBe('own') // 0 % moves nothing
  })
})

describe('each block\'s rule', () => {
  const at = (cr: number, extra: Record<string, number> = {}) => researchWith({ block: (d, p) => (d === 2 && p === 4 ? { crIndex: cr, crShape: 20, ...extra } : {}) })
  const dir = (r: ReturnType<typeof researchWith>, floored = false) => decideBlocks(r, GOAL, { any: new Set(floored ? [blockKey(2, 4)] : []), all: new Set(floored ? [blockKey(2, 4)] : []) })[blockKey(2, 4)]

  it('Min bid where conversion is near zero and the spend is real; without real spend only a step down', () => {
    // CR index 0.2 → expected ACoS 125 %, above 1.5 × 30 % and its whole interval above 30 %; spent 25.00 ≥ one order (20.00).
    expect(dir(at(0.2, { spendCents: 2500, clicks: 60 }))).toMatchObject({ dir: 'minbid', why: expect.stringMatching(/90 %: .* Min bid/) })
    expect(dir(at(0.2, { spendCents: 500, clicks: 12 }))).toMatchObject({ dir: 'down' })
  })

  it('down above the band, up below it, kept inside it', () => {
    expect(dir(at(0.55)).dir).toBe('down') // 45 %
    expect(dir(at(1.7)).dir).toBe('up') // 15 %
    expect(dir(at(1)).dir).toBe('keep') // 25 %
    expect(dir(at(1)).expectedAcos).toBeCloseTo(0.25, 4)
  })

  it('a thin product\'s wide interval keeps the plan; so does a block whose day part and weekday are unsure', () => {
    const unsure = researchWith({ block: (d, p) => (d === 2 && p === 4 ? { crIndex: 0.55, crShape: 20, partShape: 4, weekdayShape: 4 } : {}) })
    expect(dir(unsure).dir).toBe('keep')
    const thin = researchWith({ levelOrders: 2, thin: true, block: (d, p) => (d === 2 && p === 4 ? { crIndex: 0.6, crShape: 3 } : {}) })
    expect(dir(thin)).toMatchObject({ dir: 'keep', why: expect.stringMatching(/too uncertain to move/) })
  })

  it('a floored block is judged on its pool\'s cost per click, and leaves Min bid only when it clears the band', () => {
    // Its own CPC index is the floor's (0.1); its pool's is 1.
    const r = researchWith({ block: (d, p) => (d === 2 && p === 4 ? { crIndex: 1, crShape: 20, cpcIndex: 0.1, pooledCpcIndex: 1 } : {}) })
    expect(dir(r, true).dir).toBe('keep')
    const cheap = researchWith({ block: (d, p) => (d === 2 && p === 4 ? { crIndex: 1.8, crShape: 20, cpcIndex: 0.1, pooledCpcIndex: 1 } : {}) })
    expect(dir(cheap, true)).toMatchObject({ dir: 'up', why: expect.stringMatching(/leaves Min bid/) })
  })
})

describe('painting', () => {
  it('a weak evening steps down, a strong morning steps up, the rest stays; windows read back exactly', () => {
    const research = researchWith({ block: (d, p) => (d === 1 && p === 4 ? { crIndex: 0.55, crShape: 20 } : d === 1 && p === 2 ? { crIndex: 1.7, crShape: 20 } : {}) })
    const out = paintPlan(input({ research }))
    expect(out.held).toBeNull()
    // Monday 16–19: own → defend (16–19 are own top in the plan; 16–20 is the block). Monday 08–11: rest → defend.
    expect(out.changes.map((c) => [c.cell, c.from, c.to])).toEqual([
      ...[8, 9, 10, 11].map((h) => [cellRef(1, h), 'rest', 'defend']),
      ...[16, 17, 18, 19].map((h) => [cellRef(1, h), 'own', 'defend']),
    ])
    expect(weekOf({ windows: out.windows, defaultTargetKey: out.defaultTargetKey })).toEqual(out.week.after)
    expect(out.defaultTargetKey).toBe('rest')
    expect(out.summary[0]).toMatch(/Paints 8 hours of the week \(4 up, 4 down\)/)
  })

  it('Min-bid hours where conversion is near zero and the spend is real', () => {
    const research = researchWith({ block: (d, p) => (p === 0 && d === 3 ? { crIndex: 0.2, crShape: 30, spendCents: 3000, clicks: 75 } : {}) })
    const out = paintPlan(input({ research }))
    expect(out.changes.map((c) => c.to)).toEqual(['pause', 'pause', 'pause', 'pause'])
    expect(out.changes.map((c) => c.cell)).toEqual([0, 1, 2, 3].map((h) => cellRef(3, h)))
    expect(out.effect!.delta.spendCents.hi).toBeLessThan(0)
    expect(out.effect!.delta.orders.hi).toBeLessThanOrEqual(0)
  })

  it('a locked hour never changes, though its block moves', () => {
    const research = researchWith({ block: (d, p) => (d === 1 && p === 4 ? { crIndex: 0.55, crShape: 20 } : {}) })
    const out = paintPlan(input({ research, locks: { cells: new Set([cellRef(1, 17)]), lanes: new Set() } }))
    expect(out.changes.map((c) => c.cell)).toEqual([16, 18, 19].map((h) => cellRef(1, h)))
    expect(out.week.after[1][17]).toBe('own')
    expect(out.locked).toEqual([cellRef(1, 17)])
    expect(out.summary.join('\n')).toMatch(/1 hour locked by the Owner kept as they are \(1 of them the brain would have moved\)/)
  })

  it('the Owner\'s plan as limits: never above his hour, his Min-bid hours stay Min bid', () => {
    // His plan: rest all week, Min bid Tuesdays 00–04; the current plan (the brain's earlier painting) holds own top 16–22.
    const limits = { windows: [{ days: [2], startHour: 0, endHour: 4, targetKey: 'pause' }], defaultTargetKey: 'rest' }
    const research = researchWith({ block: (d, p) => (d === 1 && p === 2 ? { crIndex: 1.7, crShape: 20 } : {}) }) // Monday 08–12 would go up
    const out = paintPlan(input({ research, limits }))
    const after = out.week.after
    expect(after[1][9]).toBe('rest') // held: his plan says rest there
    expect(after[3][17]).toBe('rest') // above his plan before: brought down to it
    expect([0, 1, 2, 3].map((h) => after[2][h])).toEqual(['pause', 'pause', 'pause', 'pause'])
    for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) {
      const lim = d === 2 && h < 4 ? 'pause' : 'rest'
      if (lim === 'rest') expect(['rest', 'pause']).toContain(after[d][h])
      else expect(after[d][h]).toBe('pause')
    }
    expect(out.limited.length).toBeGreaterThan(0)
  })

  it('a locked lane: a target that would move it is not taken', () => {
    const research = researchWith({ block: (d, p) => (d === 1 && p === 4 ? { crIndex: 0.55, crShape: 20 } : {}) })
    const out = paintPlan(input({ research, locks: { cells: new Set(), lanes: new Set(['TOP_OF_SEARCH']) } }))
    expect(out.changes).toEqual([]) // own (top 100 %) → defend (top 50 %) would move the locked top of search
    expect(out.summary.join('\n')).toMatch(/Lanes the Owner locked kept: TOP_OF_SEARCH .* \(4 hours stay for that\)/)
  })

  it('anti-flap: at most the day\'s Min-bid entries; the new run with the least spend goes back', () => {
    const research = researchWith({
      block: (d, p) => (d === 4 && (p === 1 || p === 3) ? { crIndex: 0.2, crShape: 30, spendCents: p === 1 ? 2600 : 4000, clicks: 70 } : {}),
    })
    const out = paintPlan(input({ research, settings: { hourCellMovePct: 30, minBidEntriesPerDay: 1 } }))
    expect(minBidRuns(out.week.after, 4, (k) => k === 'pause').filter((r) => r.entry)).toHaveLength(1)
    expect(out.week.after[4][13]).toBe('pause') // 12–16 spent more: kept
    expect(out.week.after[4][5]).toBe('defend') // 04–08 went back (00–06 is defend in the plan, 06–08 rest)
    expect(out.antiFlap).toEqual([expect.objectContaining({ d: 4, why: expect.stringMatching(/at most 1 Min-bid entry a day/) })])
  })

  it('holds and says why: no goal, no serving target, a 0 % move, no level', () => {
    expect(paintPlan(input({ goal: null })).held).toMatch(/No ACoS goal/)
    expect(paintPlan(input({ plan: { windows: [], defaultTargetKey: 'pause' } })).held).toMatch(/no serving target/)
    expect(paintPlan(input({ settings: { hourCellMovePct: 0, minBidEntriesPerDay: 2 } })).held).toMatch(/hourCellMovePct is 0/)
    const noLevel = researchWith({})
    noLevel.expected.acos = null
    expect(paintPlan(input({ research: noLevel })).held).toMatch(/No expected ACoS/)
  })

  it('the grid a person reads: Monday first, a letter per hour, changed and locked hours marked', () => {
    const research = researchWith({ block: (d, p) => (d === 1 && p === 4 ? { crIndex: 0.55, crShape: 20 } : {}) })
    const out = paintPlan(input({ research, locks: { cells: new Set([cellRef(1, 0)]), lanes: new Set() } }))
    const g = gridLines(out, T)
    expect(g.days[0]).toMatchObject({ day: 'Mon', d: 1 })
    expect(g.days[0].before).toHaveLength(24)
    expect(g.days[0].marks).toBe(`#${' '.repeat(15)}^^^^${' '.repeat(4)}`)
    expect(Object.values(g.legend).sort()).toEqual(['defend', 'own', 'rest'])
  })
})

describe('the windows the plan stores', () => {
  it('any painted week reads back exactly through the engine\'s rule', () => {
    const keys = ['rest', 'defend', 'own', 'pause']
    let seed = 7
    const next = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
    for (let n = 0; n < 50; n++) {
      // Runs of a few hours, as a painting makes them.
      const week = Array.from({ length: 7 }, () => { const day: string[] = []; while (day.length < 24) { const k = keys[Math.floor(next() * keys.length)]; const len = 1 + Math.floor(next() * 6); for (let i = 0; i < len && day.length < 24; i++) day.push(k) } return day })
      const enc = encodeWeek(week, 'rest')
      expect(weekOf(enc)).toEqual(week)
    }
    // A plan without a baseline keeps its empty hours empty.
    const holes = Array.from({ length: 7 }, (_, d) => Array.from({ length: 24 }, (_, h) => (h < 6 && d === 0 ? null : 'own')))
    expect(weekOf(encodeWeek(holes, null))).toEqual(holes)
    expect(encodeWeek(holes, null).defaultTargetKey).toBeNull()
  })
})

describe('the expected effect', () => {
  it('Min bid cuts spend and orders; leaving it adds them; every range lo ≤ mid ≤ hi', () => {
    const research = researchWith({})
    const before = weekOf(PLAN)
    const toFloor = expectedEffect(research, before, [{ cell: 'd1h17', d: 1, h: 17, from: 'own', to: 'pause', why: '' }], T)!
    expect(toFloor.delta.spendCents.hi).toBeLessThan(0)
    // A floored hour serves almost nothing: its own share of the week is nil, its pool's is not.
    const flooredResearch = researchWith({})
    flooredResearch.hours[1 * 24 + 16].clicksShare = 0
    const floored = weekOf({ windows: [{ days: [1], startHour: 16, endHour: 18, targetKey: 'pause' }, ...PLAN.windows], defaultTargetKey: 'rest' })
    const offFloor = expectedEffect(flooredResearch, floored, [{ cell: 'd1h16', d: 1, h: 16, from: 'pause', to: 'rest', why: '' }], T)!
    expect(offFloor.delta.spendCents.lo).toBeGreaterThan(0)
    const up = expectedEffect(research, before, [{ cell: 'd1h9', d: 1, h: 9, from: 'rest', to: 'defend', why: '' }], T)!
    for (const e of [toFloor, offFloor, up]) {
      for (const r of [e.delta.spendCents, e.delta.orders, e.after.spendCents, e.after.orders]) {
        expect(r.lo).toBeLessThanOrEqual(r.mid + 1e-9)
        expect(r.mid).toBeLessThanOrEqual(r.hi + 1e-9)
      }
      expect(e.after.acos!.lo).toBeLessThanOrEqual(e.after.acos!.hi)
    }
    expect(up.delta.spendCents.mid).toBeGreaterThan(0)
    expect(up.assumptions[0]).toMatch(/top of search holding 50 % of the spend \(assumed: no placement report\)/)
  })
})
