/**
 * BID BRAIN BB-15 — the golden proof that the nowcast changes nothing while it is not switched on.
 *
 * The snapshot `__golden__/flag-off.json` was written by this file on origin/main BEFORE BB-15 touched the brain
 * (401d4752d): `weigh` over a fixed set of days, and `buildFacts` → `decide` over a seeded spread of markets (every layer:
 * goal writes and holds, the band, limits, thin keywords held at the parent, overrides, give-backs, rule inputs, TACoS).
 * With the nowcast off (and in shadow, which only adds words to the stored why, never to a decision), the same inputs
 * must give the same bytes: any drift fails here.
 *
 * Made-up numbers only (the repository is public).
 */
import { describe, expect, it } from 'vitest'
import { decide, type TargetFacts } from './decide.js'
import { weigh, type DayEvidence, type Evidence } from './estimator.js'
import { buildFacts, type AdGroupRow, type CampaignRow, type MarketRows, type RunRows, type StrategyRead, type TargetRow } from './facts.js'

/** A small deterministic generator (mulberry32): the same seed, the same spread, on every machine. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

const campaign = (id: string, extra: Partial<CampaignRow> = {}): CampaignRow => ({
  id, status: 'ENABLED', pinBids: false, pinnedBy: null, bidsSuppressedAt: null, bidsSuppressedFloorCents: null, bidsSuppressedBy: null,
  minBidCents: null, maxBidCents: null, ownTargetAcos: undefined, allowlisted: true, ...extra,
})
const group = (id: string, campaignId: string, families: string[], extra: Partial<AdGroupRow> = {}): AdGroupRow => ({
  id, campaignId, status: 'ENABLED', bidsSuppressedAt: null, bidsSuppressedFloorCents: null, bidsSuppressedBy: null, families, productIds: families, ...extra,
})
const strategy = (pct: number, extra: Partial<StrategyRead> = {}): StrategyRead => ({
  target: { kind: 'ACOS', pct }, acosPct: pct, band: null, goal: 'PROFIT', minBidCents: null, maxBidCents: 90, maxChangePct: 25, ...extra,
})

/** One seeded market: 4 campaigns (one not allowlisted), 8 ad groups over 3 families, 6 keywords each. */
function seededMarket(seed: number): { m: MarketRows; run: RunRows } {
  const r = rng(seed)
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]
  const campaigns = new Map<string, CampaignRow>([
    ['c1', campaign('c1')],
    ['c2', campaign('c2', { ownTargetAcos: 0.3 })],
    ['c3', campaign('c3', { minBidCents: 8, maxBidCents: 60 })],
    ['c4', campaign('c4', { allowlisted: false })],
  ])
  const families = ['famA', 'famB', 'famC']
  const adGroups = new Map<string, AdGroupRow>()
  for (let g = 1; g <= 8; g++) adGroups.set(`g${g}`, group(`g${g}`, `c${((g - 1) % 4) + 1}`, [families[(g - 1) % 3]]))
  const words = ['race jacket', 'leather jacket', 'boots', 'gloves', 'helmet', 'back protector', 'rain suit', 'knee slider']
  const targets: TargetRow[] = []
  const evidence = new Map<string, Evidence>()
  for (const [gid] of adGroups) {
    for (let k = 0; k < 6; k++) {
      const id = `${gid}-t${k}`
      targets.push({ id, adGroupId: gid, kind: 'KEYWORD', expressionType: pick(['EXACT', 'PHRASE', 'BROAD']), expressionValue: pick(words), bidCents: 5 + Math.floor(r() * 60), suppressedFromBidCents: r() < 0.05 ? 40 : null })
      const clicks = Math.floor(r() * r() * 400)
      const orders = Math.floor(clicks * r() * 0.04)
      evidence.set(id, { clicks: clicks * (0.6 + r() * 0.4), orders: orders * (0.6 + r() * 0.4), salesCents: orders * (6000 + Math.floor(r() * 4000)), costCents: clicks * (15 + Math.floor(r() * 30)) })
    }
  }
  const m: MarketRows = {
    market: 'IT', dataDay: '2026-10-01', campaigns, adGroups, targets, evidence,
    adSales30: new Map(targets.map((t) => [t.id, Math.floor(r() * 20_000)])),
    prices: new Map([['famA', 9000], ['famB', 4500]]),
  }
  const run: RunRows = {
    marketBrakes: [],
    strategy: new Map([
      ['g1', strategy(20, { band: { loPct: 18, hiPct: 28 } })],
      ['g2', strategy(25)],
      ['g3', strategy(15, { goal: 'GROW', minBidCents: 10 })],
      ['g5', { ...strategy(10), target: { kind: 'TACOS', pct: 10 }, acosPct: 22, band: { loPct: 8, hiPct: 14 } }],
      ['g6', strategy(30, { maxChangePct: 50 })],
      ['g7', strategy(20, { goal: 'LAUNCH', launchDay: 3 })],
    ]),
    accountDefaultPct: 25,
    personHeld: new Set(['g2-t1']),
    holds: [{ campaignId: 'c3', targetId: 'g3-t2', kind: 'PIN', by: 'user:owner', until: new Date('2026-12-01T00:00:00Z') }],
    enrollments: new Map([['c2', { mode: 'HELD', heldBy: 'auto-undo', heldUntil: new Date('2026-10-20T00:00:00Z') }]]),
    lastSteps: new Map([['g1-t0', { dataDay: '2026-10-01', fromCents: 30, toCents: targets[0].bidCents }]]),
    familySales: new Map([['famA', 400_000], ['famB', 90_000]]),
    stock: new Map([['g6', { kind: 'lowCover', factor: 0.7, by: 'low stock: 5 days of cover against a 14-day line' }]]),
    breakEven: new Map([['g1', 0.35], ['g7', 0.3]]),
    lowered: new Map([['g5-t3', { layer: 'stop', heldCents: targets.find((t) => t.id === 'g5-t3')!.bidCents, beforeCents: 33 }]]),
    directives: new Map([['c1', [{ targetId: null, lane: null, kind: 'CEILING', valueCents: 45, valuePct: null, label: 'rule "ceiling"' }]]]),
  }
  return { m, run }
}

/** Worked-example facts in the shape of the decide test's (§7), on a made-up 1 % rate, at a spread of bids and steps. */
function workedExamples(): TargetFacts[] {
  const ev = (clicks: number, orders = 0, salesCents = 0, costCents = 0): Evidence => ({ clicks, orders, salesCents, costCents })
  const base = (current: number, extra: Partial<TargetFacts> = {}): TargetFacts => ({
    targetId: `kw-${current}`, currentCents: current, dataDay: '2026-09-29',
    chain: [{ level: 'target', evidence: ev(1, 0, 0, 30) }, { level: 'product', evidence: ev(2000, 20, 160_000, 60_000) }, { level: 'market', evidence: ev(9000, 90, 720_000, 270_000) }],
    listPriceCents: 9000, parentCpcRatio: 0.88,
    goal: { target: { kind: 'ACOS', pct: 20 }, band: { loPct: 18, hiPct: 28 }, phase: 'PROFIT' },
    limits: { maxBidCents: 80, maxChangePct: 25 },
    ...extra,
  })
  const out: TargetFacts[] = []
  for (const c of [3, 8, 14, 16, 19, 22, 25, 33, 45, 60, 90]) out.push(base(c))
  out.push(base(25, { lastStep: { dataDay: '2026-09-29', fromCents: 33, toCents: 25 } }))
  out.push(base(33, { overrides: { stop: { bidCents: 2, by: 'suppress-campaign' }, pin: { by: 'user:owner' } } }))
  out.push(base(33, { overrides: { stock: { coverFactor: 0.5, by: 'stock cover' }, minBidHour: { floorCents: 3 } } }))
  out.push(base(10, { overrides: { freeze: { by: 'auto-undo' } } }))
  out.push(base(2, { restore: { layer: 'stop', heldCents: 2, beforeCents: 30 } }))
  out.push(base(14, { lanes: [{ lane: 'TOP_OF_SEARCH', planPct: 300, maxCpcCents: 55 }, { lane: 'PRODUCT_PAGE', planPct: 50, maxCpcCents: null }] }))
  out.push(base(14, { directives: [{ kind: 'CEILING', cents: 12, source: 'rule:A' }, { kind: 'FLOOR', cents: 15, source: 'rule:B' }] }))
  out.push(base(16, { chain: [{ level: 'target', evidence: ev(120, 6, 48_000, 1680) }, { level: 'product', evidence: ev(2000, 20, 160_000, 60_000) }], limits: { maxChangePct: 100 } }))
  out.push(base(20, { raiseCap: 'the campaign is held by auto-undo' }))
  return out
}

/** Days for `weigh`: a 120-day spread, some past the window. */
function seededDays(seed: number): DayEvidence[] {
  const r = rng(seed)
  return Array.from({ length: 120 }, (_, i) => ({ daysAgo: i - 2, clicks: Math.floor(r() * 30), orders: Math.floor(r() * 2), salesCents: Math.floor(r() * 9000), costCents: Math.floor(r() * 900) }))
}

describe('BB-15 golden — the brain with the nowcast off decides exactly as before', () => {
  it('weigh, buildFacts and decide give the bytes recorded on origin/main before BB-15', async () => {
    const golden = {
      weigh: [11, 12, 13].map((s) => [weigh(seededDays(s)), weigh(seededDays(s), { windowDays: 14 }), weigh(seededDays(s), { halfLifeDays: 10 })]),
      markets: [101, 202, 303, 404, 505].map((s) => {
        const { m, run } = seededMarket(s)
        const facts = buildFacts(m, run)
        return { facts: facts.length, decisions: facts.map((f) => decide(f)) }
      }),
      worked: workedExamples().map((f) => decide(f)),
    }
    await expect(JSON.stringify(golden, null, 1)).toMatchFileSnapshot('./__golden__/flag-off.json')
  })
})
