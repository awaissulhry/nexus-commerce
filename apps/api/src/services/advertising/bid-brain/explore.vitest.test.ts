/**
 * BID BRAIN BB-20 — exploration and revive (explore.ts), pure.
 *
 *   switch     off · shadow (default) · on; the budget: the strategy's market row, else 200¢ IT / 100¢ DE / none
 *   seeded     the same key gives the same draw and the same bid; another data day another draw; the Beta sampler's mean
 *   explore    a thin keyword only; its bid inside [0.85 × goal, min(1.35 × goal, band top, break-even)], one step of the
 *              largest change from the anchor, the limits; never under an override, a raise cap, a rule, short cover
 *   budget     the picks never add up past the budget (random spreads); revives first, then sd × traffic; 0 = nothing
 *   revive     a silent seller and a keyword floored long ago; step 1, step 2 three days later, silent three days after,
 *              at rest until 28 days after the first step, then a new re-test
 *   flags      off and shadow return the decisions untouched (a seeded market through buildFacts → decide → plan); on
 *              changes only the picks, and checks each again on the run's own facts
 *
 * Made-up numbers only (the repository is public).
 */
import { describe, expect, it } from 'vitest'
import { decide, type TargetFacts } from './decide.js'
import type { Evidence } from './estimator.js'
import { buildFacts, type AdGroupRow, type CampaignRow, type MarketRows, type RunRows, type TargetRow } from './facts.js'
import { bidForAcos } from './recipe.js'
import { goalContext } from './response.js'
import {
  DEFAULT_EXPLORE_BUDGET_CENTS, EXPLORE_HIGH_SHARE, EXPLORE_LOW_SHARE, REVIVE_REST_DAYS, applyExplore, betaDraw, exploreBudgetOf,
  exploreMode, exploreOption, exploreSummaryWords, exploreWords, extraSpend, mulberry32, planExplore, reviveStage, seedOf,
  summarizeExplore, thompsonCr, type ExploreOption, type ExploreSkip, type TargetActivity,
} from './explore.js'

const ev = (clicks: number, orders = 0, salesCents = 0, costCents = 0): Evidence => ({ clicks, orders, salesCents, costCents })
const isOption = (x: ExploreOption | ExploreSkip): x is ExploreOption => 'kind' in x

/** A thin keyword (1 click of its own) under a product with a made-up 1 % rate. */
const thin = (current: number, extra: Partial<TargetFacts> = {}): TargetFacts => ({
  targetId: `kw-${current}`, currentCents: current, dataDay: '2026-09-29',
  chain: [{ level: 'target', evidence: ev(1, 0, 0, 30) }, { level: 'product', evidence: ev(2000, 20, 160_000, 60_000) }, { level: 'market', evidence: ev(9000, 90, 720_000, 270_000) }],
  listPriceCents: 9000, parentCpcRatio: 0.88,
  goal: { target: { kind: 'ACOS', pct: 20 }, band: { loPct: 18, hiPct: 28 }, phase: 'PROFIT', breakEvenAcos: 0.35 },
  limits: { maxBidCents: 80, maxChangePct: 25 },
  ...extra,
})
const busy: TargetActivity = { impressions14: 1400, impressions90: 9000, clicks14: 28, orders90: 2 }

describe('the switch and the budget', () => {
  it('off · shadow (default) · on', () => {
    expect(exploreMode(undefined)).toBe('shadow')
    expect(exploreMode('live')).toBe('shadow')
    expect(exploreMode('off')).toBe('off')
    expect(exploreMode(' ON ')).toBe('on')
  })

  it('the Owner\'s pick until the market row sets one; 0 switches it off', () => {
    expect(DEFAULT_EXPLORE_BUDGET_CENTS).toEqual({ IT: 200, DE: 100 })
    expect(exploreBudgetOf('IT', null)).toEqual({ cents: 200, from: 'default' })
    expect(exploreBudgetOf('DE', undefined)).toEqual({ cents: 100, from: 'default' })
    expect(exploreBudgetOf('FR', null)).toEqual({ cents: 0, from: 'default' })
    expect(exploreBudgetOf('IT', 0)).toEqual({ cents: 0, from: 'strategy' })
    expect(exploreBudgetOf('FR', 350)).toEqual({ cents: 350, from: 'strategy' })
  })
})

describe('the seeded draw', () => {
  it('the same key gives the same draw; another key almost always another', () => {
    const node = { cr: 0.01, k: 200, clicks: 1 }
    expect(thompsonCr(node, 'kw|2026-09-29')).toBe(thompsonCr(node, 'kw|2026-09-29'))
    const draws = new Set(Array.from({ length: 30 }, (_, i) => thompsonCr(node, `kw|2026-09-${String(i + 1).padStart(2, '0')}`)))
    expect(draws.size).toBe(30)
    expect(seedOf('kw|2026-09-29')).toBe(seedOf('kw|2026-09-29'))
  })

  it('the Beta sampler has the posterior\'s mean and spread', () => {
    const r = mulberry32(42)
    const n = 20_000
    let sum = 0
    let sq = 0
    for (let i = 0; i < n; i++) { const x = betaDraw(2, 198, r); sum += x; sq += x * x }
    const mean = sum / n
    expect(mean).toBeCloseTo(0.01, 3)
    const sd = Math.sqrt(sq / n - mean * mean)
    expect(sd).toBeCloseTo(Math.sqrt((2 * 198) / (200 * 200 * 201)), 3)
    // Shapes under 1 too.
    const small = Array.from({ length: 5000 }, () => betaDraw(0.4, 0.6, r))
    expect(small.every((x) => x >= 0 && x <= 1)).toBe(true)
    expect(small.reduce((a, b) => a + b, 0) / small.length).toBeCloseTo(0.4, 1)
  })

  it('same facts, same bid: a rerun lands where the first run did; the next data day draws again', () => {
    const f = thin(16)
    const a = exploreOption(f, decide(f), busy) as ExploreOption
    const b = exploreOption(f, decide(f), busy) as ExploreOption
    expect(a.kind).toBe('explore')
    expect(b).toEqual(a)
    const next = thin(16, { dataDay: '2026-09-30' })
    expect((exploreOption(next, decide(next), busy) as ExploreOption).draw).not.toBe(a.draw)
  })
})

describe('explore', () => {
  it('a thin keyword\'s bid stays inside 0.85–1.35 × the goal bid, the band top, break-even, one step and the limits', () => {
    for (const current of [8, 12, 16, 20, 25, 33]) {
      for (const day of ['2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30']) {
        const f = thin(current, { dataDay: day, targetId: `kw-${current}-${day}` })
        const d = decide(f)
        const o = exploreOption(f, d, busy)
        if (!isOption(o)) { expect(o.why).toMatch(/no room|layer decides/); continue }
        const ctx = goalContext(f)!
        const g = d.goalBidCents!
        const top = Math.min(EXPLORE_HIGH_SHARE * g, bidForAcos(0.28, ctx.est.node.cr, ctx.aov, ctx.ratio), bidForAcos(0.35, ctx.est.node.cr, ctx.aov, ctx.ratio))
        expect(o.bidCents).toBeGreaterThanOrEqual(Math.min(Math.round(EXPLORE_LOW_SHARE * g), Math.round(ctx.anchor * 0.75)) - 1)
        expect(o.bidCents).toBeLessThanOrEqual(Math.round(top) + 1)
        expect(o.bidCents).toBeLessThanOrEqual(Math.round(ctx.anchor * 1.25))
        expect(o.bidCents).toBeGreaterThanOrEqual(Math.round(ctx.anchor * 0.75))
        expect(o.bidCents).toBeLessThanOrEqual(80)
        expect(o.words).toMatch(/^thin data \(\d+% its own\), CR drawn [\d.]+% \(pooled [\d.]+%\) → \d+¢ beside the goal's \d+¢$/)
      }
    }
  })

  it('a keyword with enough data of its own is not explored', () => {
    const f = thin(16, { chain: [{ level: 'target', evidence: ev(3000, 30, 240_000, 42_000) }, { level: 'product', evidence: ev(4000, 40, 320_000, 60_000) }] })
    expect(exploreOption(f, decide(f), busy)).toMatchObject({ why: expect.stringMatching(/^not thin/) })
  })

  it('never under an override, a raise cap, a rule\'s input, short stock cover, a brake or without a goal', () => {
    const cases: Array<[Partial<TargetFacts>, RegExp, TargetActivity?]> = [
      [{ overrides: { pin: { by: 'user:owner' } } }, /pin layer decides/],
      [{ overrides: { stock: { coverFactor: 0.7, by: 'low stock' } } }, /stock layer decides/],
      [{ raiseCap: 'the campaign is held by auto-undo' }, /^raises wait/],
      [{ directives: [{ kind: 'CEILING', cents: 40, source: 'rule:A' }] }, /rule's ceiling or floor/],
      [{ brakes: ['campaign paused'] }, /brake layer decides/],
      [{ goal: { target: null } }, /no-goal layer decides/],
      [{}, /stock cover 9 days/, { ...busy, coverDays: 9 }],
    ]
    for (const [extra, why, activity] of cases) {
      const f = thin(16, extra)
      expect((exploreOption(f, decide(f), activity ?? busy) as ExploreSkip).why, JSON.stringify(extra)).toMatch(why)
    }
  })

  it('the expected extra spend follows the response curve: r̂ · (clicks(b) · b − clicks(g) · g), never below 0', () => {
    expect(extraSpend({ ratio: 0.85, c0: 2, bid: 20, base: 16, today: 16, eps: 0 })).toBeCloseTo(0.85 * 2 * 4, 9)
    expect(extraSpend({ ratio: 0.85, c0: 2, bid: 20, base: 16, today: 16, eps: 1 })).toBeCloseTo(0.85 * (2 * 1.25 * 20 - 2 * 16), 9)
    expect(extraSpend({ ratio: 0.85, c0: 2, bid: 14, base: 16, today: 16, eps: 0.8 })).toBe(0)
  })
})

describe('the budget', () => {
  const option = (id: string, kind: 'explore' | 'revive', extra: number, priority = 1): ExploreOption => ({ targetId: id, kind, bidCents: 20, goalBidCents: 16, extraCents: extra, priority, anchorCents: 16, words: id })

  it('is never exceeded, whatever the spread', () => {
    const r = mulberry32(9)
    for (let round = 0; round < 500; round++) {
      const items = Array.from({ length: 1 + Math.floor(r() * 40) }, (_, i) => option(`k${i}`, r() < 0.2 ? 'revive' : 'explore', r() * 60, r()))
      const budget = Math.floor(r() * 300)
      const plan = planExplore(items, { cents: budget, from: 'default' })
      expect(plan.spentCents).toBeLessThanOrEqual(budget + 1e-9)
      expect(plan.picked.reduce((s, o) => s + o.extraCents, 0)).toBeCloseTo(plan.spentCents, 9)
      expect(plan.picked.length + plan.over.length).toBe(budget > 0 ? items.length : 0)
    }
  })

  it('revives first, then the widest posterior × traffic; one that does not fit is left out and smaller ones still go', () => {
    const plan = planExplore([option('a', 'explore', 50, 0.9), option('b', 'explore', 120, 0.95), option('r', 'revive', 40), option('c', 'explore', 10, 0.1)], { cents: 100, from: 'default' })
    expect(plan.picked.map((o) => o.targetId)).toEqual(['r', 'a', 'c'])
    expect(plan.over.map((o) => o.targetId)).toEqual(['b'])
    expect(plan.spentCents).toBe(100)
  })

  it('no budget in the market: nothing picked and nothing said', () => {
    const plan = planExplore([option('a', 'explore', 0)], { cents: 0, from: 'default' })
    expect(plan).toMatchObject({ picked: [], over: [], spentCents: 0 })
    expect(exploreWords(plan, 'shadow').notes.size).toBe(0)
  })
})

describe('revive', () => {
  it('the schedule: step 1, step 2 three days later, silent three days after, at rest until day 28, then a new re-test', () => {
    const memory = { start: '2026-09-01', fromCents: 6, step: 1, state: 'step' as const, dataDay: '2026-09-01' }
    const at = (day: string) => reviveStage(memory, day, 6)
    expect(reviveStage(null, '2026-09-01', 6)).toEqual({ state: 'step', step: 1, start: '2026-09-01', fromCents: 6 })
    expect(at('2026-09-02')).toMatchObject({ state: 'step', step: 1 })
    expect(at('2026-09-04')).toMatchObject({ state: 'step', step: 2, start: '2026-09-01', fromCents: 6 })
    expect(at('2026-09-06')).toMatchObject({ state: 'step', step: 2 })
    expect(at('2026-09-07')).toMatchObject({ state: 'silent', until: '2026-09-29' })
    expect(at('2026-09-10')).toMatchObject({ state: 'rest', until: '2026-09-29' })
    expect(at('2026-09-28')).toMatchObject({ state: 'rest' })
    expect(REVIVE_REST_DAYS).toBe(28)
    expect(at('2026-09-29')).toEqual({ state: 'step', step: 1, start: '2026-09-29', fromCents: 6 })
  })

  const silentSeller: TargetActivity = { impressions14: 10, impressions90: 9000, clicks14: 0, orders90: 2 }

  it('a keyword that sold and went silent steps up one largest change at a time toward the higher goal, three days apart', () => {
    const f = thin(10, { targetId: 'kw-silent', dataDay: '2026-09-29' })
    const o = exploreOption(f, decide(f), silentSeller) as ExploreOption
    expect(o).toMatchObject({ kind: 'revive', bidCents: 13, revive: { start: '2026-09-29', fromCents: 10, step: 1, state: 'step' } })
    expect(o.words).toMatch(/^silent 14 days \(impressions 1% of its 90-day average; 2 orders in 90 days\) — step 1 of 2 since 2026-09-29 → 13¢ \(toward \d+¢\)$/)
    // Shadow: nothing moved; three days later the second step goes one more step up.
    const later = thin(10, { targetId: 'kw-silent', dataDay: '2026-10-02' })
    const second = exploreOption(later, decide(later), { ...silentSeller, revive: o.revive }) as ExploreOption
    expect(second).toMatchObject({ kind: 'revive', bidCents: 16, revive: { start: '2026-09-29', fromCents: 10, step: 2 } })
    // Six days after the first step, still silent: no bid; the memory is kept and the why says so.
    const done = thin(10, { targetId: 'kw-silent', dataDay: '2026-10-05' })
    const rest = exploreOption(done, decide(done), { ...silentSeller, revive: second.revive }) as ExploreSkip
    expect(rest).toMatchObject({ say: true, revive: { start: '2026-09-29', state: 'silent' } })
    expect(rest.why).toBe('revive: still silent after 2 steps since 2026-09-29 — at rest until 2026-10-27')
  })

  it('a keyword cut to the floor long ago is re-tested; one written lately, or serving, is not', () => {
    const floored: TargetActivity = { impressions14: 0, impressions90: 0, clicks14: 0, orders90: 0, daysSinceWrite: null }
    const f = thin(5, { targetId: 'kw-floor' })
    const o = exploreOption(f, decide(f), floored)
    expect(o).toMatchObject({ kind: 'revive' })
    expect((o as ExploreOption).words).toMatch(/^at the floor 5¢ with no bid write for 30\+ days, and silent — step 1 of 2/)
    expect(exploreOption(f, decide(f), { ...floored, daysSinceWrite: 3 })).not.toMatchObject({ kind: 'revive' })
    expect(exploreOption(f, decide(f), { ...floored, impressions14: 900, impressions90: 6000 })).not.toMatchObject({ kind: 'revive' })
  })
})

/** One seeded market (the golden test's shape): 4 campaigns, 8 ad groups over 3 families, 6 keywords each. */
function seededMarket(seed: number): { m: MarketRows; run: RunRows } {
  const r = mulberry32(seed)
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]
  const campaign = (id: string, extra: Partial<CampaignRow> = {}): CampaignRow => ({ id, status: 'ENABLED', pinBids: false, pinnedBy: null, bidsSuppressedAt: null, bidsSuppressedFloorCents: null, bidsSuppressedBy: null, minBidCents: null, maxBidCents: null, ownTargetAcos: undefined, allowlisted: true, ...extra })
  const campaigns = new Map<string, CampaignRow>([['c1', campaign('c1')], ['c2', campaign('c2', { ownTargetAcos: 0.3 })], ['c3', campaign('c3', { minBidCents: 8, maxBidCents: 60 })], ['c4', campaign('c4', { allowlisted: false })]])
  const families = ['famA', 'famB', 'famC']
  const adGroups = new Map<string, AdGroupRow>()
  for (let g = 1; g <= 8; g++) adGroups.set(`g${g}`, { id: `g${g}`, campaignId: `c${((g - 1) % 4) + 1}`, status: 'ENABLED', bidsSuppressedAt: null, bidsSuppressedFloorCents: null, bidsSuppressedBy: null, families: [families[(g - 1) % 3]], productIds: [families[(g - 1) % 3]] })
  const words = ['race jacket', 'leather jacket', 'boots', 'gloves', 'helmet']
  const targets: TargetRow[] = []
  const evidence = new Map<string, Evidence>()
  for (const [gid] of adGroups) {
    for (let k = 0; k < 6; k++) {
      const id = `${gid}-t${k}`
      targets.push({ id, adGroupId: gid, kind: 'KEYWORD', expressionType: pick(['EXACT', 'PHRASE']), expressionValue: pick(words), bidCents: 5 + Math.floor(r() * 60), suppressedFromBidCents: null })
      const clicks = Math.floor(r() * r() * 400)
      const orders = Math.floor(clicks * r() * 0.04)
      evidence.set(id, { clicks, orders, salesCents: orders * (6000 + Math.floor(r() * 4000)), costCents: clicks * (15 + Math.floor(r() * 30)) })
    }
  }
  const m: MarketRows = { market: 'IT', dataDay: '2026-10-01', campaigns, adGroups, targets, evidence, prices: new Map([['famA', 9000], ['famB', 4500]]) }
  const run: RunRows = {
    marketBrakes: [], strategy: new Map([['g1', { target: { kind: 'ACOS', pct: 20 }, acosPct: 20, band: { loPct: 18, hiPct: 28 }, goal: 'PROFIT', minBidCents: null, maxBidCents: 90, maxChangePct: 25 }]]),
    accountDefaultPct: 25, personHeld: new Set(['g2-t1']), holds: [], enrollments: new Map([['c2', { mode: 'HELD', heldBy: 'auto-undo', heldUntil: null }]]),
    lastSteps: new Map(), breakEven: new Map([['g1', 0.35]]),
  }
  return { m, run }
}

describe('the flags: off and shadow decide exactly as before; on changes only the picks', () => {
  const activity: TargetActivity = { impressions14: 200, impressions90: 2000, clicks14: 6, orders90: 1 }

  it('off and shadow return the very decisions decide made, for every seeded market', () => {
    for (const seed of [101, 202, 303, 404, 505]) {
      const { m, run } = seededMarket(seed)
      const facts = buildFacts(m, run)
      const decisions = facts.map((f) => decide(f))
      const before = JSON.stringify(decisions)
      const options = facts.map((f, i) => exploreOption(f, decisions[i], activity))
      const plan = planExplore(options, { cents: 200, from: 'default' })
      expect(plan.picked.length, `seed ${seed}`).toBeGreaterThan(0)
      for (const mode of ['off', 'shadow'] as const) {
        const out = applyExplore(decisions, facts, plan, mode)
        expect(out).toBe(decisions)
        expect(JSON.stringify(out)).toBe(before)
      }
    }
  })

  it('on: the picks become layer explore / revive with one step from the anchor; every other decision is the same', () => {
    const { m, run } = seededMarket(303)
    const facts = buildFacts(m, run)
    const decisions = facts.map((f) => decide(f))
    const plan = planExplore(facts.map((f, i) => exploreOption(f, decisions[i], activity)), { cents: 200, from: 'default' })
    const out = applyExplore(decisions, facts, plan, 'on')
    const picked = new Map(plan.picked.map((o) => [o.targetId, o]))
    out.forEach((d, i) => {
      const o = picked.get(d.targetId)
      if (!o) { expect(d).toBe(decisions[i]); return }
      expect(d).toMatchObject({ layer: o.kind, bidCents: o.bidCents, action: o.bidCents !== d.currentCents ? 'write' : 'hold', step: { dataDay: d.dataDay, fromCents: o.anchorCents, toCents: o.bidCents } })
      expect(d.why.startsWith(`${o.kind}: `)).toBe(true)
      expect(d.why).toContain(`(goal: ${decisions[i].why})`)
    })
    // Checked again on the run's own facts: a product cycle's raise cap keeps the goal's decision.
    const capped = facts.map((f) => (picked.has(f.targetId) ? { ...f, raiseCap: 'a product cycle holds raises' } : f))
    const held = capped.map((f) => decide(f))
    expect(applyExplore(held, capped, plan, 'on').every((d, i) => d === held[i])).toBe(true)
  })

  it('the words: a pick, one the budget left out, the run line', () => {
    const { m, run } = seededMarket(202)
    const facts = buildFacts(m, run)
    const decisions = facts.map((f) => decide(f))
    const options = facts.map((f, i) => exploreOption(f, decisions[i], activity))
    const plan = planExplore(options, { cents: 3, from: 'strategy' })
    const { notes, evidence } = exploreWords(plan, 'shadow', options)
    for (const o of plan.picked) {
      expect(notes.get(o.targetId)).toMatch(new RegExp(`^${o.kind} \\(shadow\\): would bid ${o.bidCents}¢ — .*, expected \\+[\\d.]+¢ of today's 3¢ \\(the strategy\\)$`))
      expect(evidence.get(o.targetId)).toMatchObject({ explore: { kind: o.kind, mode: 'shadow', picked: true, bidCents: o.bidCents, budgetCents: 3 } })
    }
    for (const o of plan.over) expect(notes.get(o.targetId)).toMatch(/left out — today's 3¢ \(the strategy\) is taken \(it needs \+[\d.]+¢\)$/)
    expect(exploreSummaryWords(summarizeExplore(plan, 'shadow', 0))).toMatch(/^explore \(shadow\): \d+ thin, \d+ revive(, \d+ left out)?, \+[\d.]+¢ of 3¢$/)
  })
})
