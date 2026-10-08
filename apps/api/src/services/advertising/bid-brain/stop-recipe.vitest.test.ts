/**
 * ONE BRAIN AB-2 — the stop recipe of a campaign the bid brain owns (pure parts, and its writers with the mutation layer
 * stood in for).
 *
 *   which stop   a stop, stock (not buyable) or the plan's Min-bid hour on every keyword that is not braked holds the whole
 *                campaign; one serving keyword (an ad group floored alone) leaves it serving
 *   60¢ case     a 3¢ stop at 900 % top of search under "up and down" may cost 60¢: the recipe zeroes the lanes and switches
 *                to down only (→ 3¢); when the stop ends the bids, the lanes and the strategy come back exactly
 *   plan hour    the hour's own lanes over the saved ones; the raise cap measures from the saved lanes, not the zeros
 *   locks        the Owner's lock of the placements (the lever, one lane) or of the strategy is not written; the why says so
 *   anti-flap    the switch down is never held; the switch back waits once a campaign switched twice today (UTC)
 *   not owned    a campaign the brain does not own gets nothing
 *   writers      the memory first, then the write (none without it); given back → the memory goes; SUGGEST lets only the
 *                give-back through
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const order = vi.hoisted(() => ({ calls: [] as string[], memoryFails: null as string | null }))
const updateCampaign = vi.fn()
const updatePlacement = vi.fn()
vi.mock('../ads-mutation.service.js', async (importOriginal) => ({ ...(await importOriginal<object>()), updateCampaignWithSync: (...a: unknown[]) => updateCampaign(...a) }))
vi.mock('../ads-create.service.js', async (importOriginal) => ({ ...(await importOriginal<object>()), updatePlacementBidding: (...a: unknown[]) => updatePlacement(...a) }))
vi.mock('./stop-memory.js', () => ({
  rememberLanes: async (id: string, lanes: unknown) => { if (order.memoryFails) throw new Error(order.memoryFails); order.calls.push(`rememberLanes ${id} ${JSON.stringify(lanes)}`) },
  forgetLanes: async (id: string) => { order.calls.push(`forgetLanes ${id}`) },
  rememberStrategy: async (id: string, s: string) => { if (order.memoryFails) throw new Error(order.memoryFails); order.calls.push(`rememberStrategy ${id} ${s}`) },
  forgetStrategy: async (id: string) => { order.calls.push(`forgetStrategy ${id}`) },
  strategySwitchesToday: async () => new Map(),
}))
vi.mock('../../../utils/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))

const { campaignStopOf, keywordStop, stackMaxCents, strategyStep, fullLanes, readSavedLanes, MAX_STRATEGY_SWITCHES_PER_DAY } = await import('./stop-recipe.js')
const { campaignStates, placementWrites, strategyWrites, recipeWords, restoreCandidates, placementLocks, strategyLock } = await import('./shadow.js')
const { placementPlan, writeOwnedPlacements, writeOwnedStrategies, strategyReportWords, placementReportWords } = await import('./live-writer.js')
const { decide } = await import('./decide.js')
const { planFacts } = await import('./plan-hour.js')
const { makeEngineGuard } = await import('../ads-engine-guard.js')
const { BRAIN_ACTOR } = await import('./live.js')
import type { TargetFacts, Decision } from './decide.js'
import type { CampaignRow } from './facts.js'
import type { PlanHour } from './plan-hour.js'
import type { RankTargetSpec } from '../rank-controller.js'
import type { LeverLocks } from '../brain/owner-brakes.js'

type P = { placement: string; percentage: number }
const TOP = 'PLACEMENT_TOP'
const PRODUCT = 'PLACEMENT_PRODUCT_PAGE'
const REST = 'PLACEMENT_REST_OF_SEARCH'
const BUDGET = 'automation:budget-manager-cron'

const facts = (over: Partial<TargetFacts> = {}): TargetFacts => ({
  targetId: 't1', currentCents: 45,
  chain: [{ level: 'target', evidence: { clicks: 400, orders: 12, salesCents: 12 * 8000, costCents: 400 * 40 } }, { level: 'market', evidence: { clicks: 4000, orders: 120, salesCents: 120 * 8000, costCents: 4000 * 40 } }],
  goal: { target: { kind: 'ACOS', pct: 35 }, band: { loPct: 30, hiPct: 40 }, phase: null },
  limits: { maxChangePct: 25 }, dataDay: '2026-10-01', ...over,
})
const stopped = (over: Partial<TargetFacts> = {}) => facts({ overrides: { stop: { bidCents: 3, by: BUDGET } }, ...over })
const campaign = (over: Partial<CampaignRow> = {}): CampaignRow => ({
  id: 'c1', status: 'ENABLED', pinBids: false, pinnedBy: null, bidsSuppressedAt: null, bidsSuppressedFloorCents: null, bidsSuppressedBy: null,
  minBidCents: null, maxBidCents: null, ownTargetAcos: null, allowlisted: true, biddingStrategy: 'AUTO_FOR_SALES', placements: [], ...over,
})
const market = (c: CampaignRow) => ({ market: 'IT', campaigns: new Map([[c.id, c]]) })
const OWNED = new Set(['c1'])
const one = () => 'c1'
const spec = (over: Partial<RankTargetSpec> = {}): RankTargetSpec => ({ key: 'all-out', placement: TOP, targetISPct: null, acosCapPct: null, maxCpcCents: 200, biasPct: 150, pause: false, allOut: false, ...over })
const hour = (s: RankTargetSpec): PlanHour => ({ scheduleId: 's1', name: 'IT GALE JACKET', key: s.key, spec: s, event: null })
const guard = (posture: 'auto' | 'suggest' = 'auto') => makeEngineGuard({ engine: 'bid-brain', posture, why: posture === 'suggest' ? 'the account ads dial is SUGGEST' : 'the account ads dial is AUTO', caps: { perTick: null, perDay: null }, todayBefore: 0, marketCaps: new Map() })
const locks = (over: Partial<LeverLocks> = {}): Map<string, LeverLocks> => new Map([['c1', { placements: null, lanes: new Map(), biddingStrategy: null, ...over }]])
const BY = 'locked by the Owner\'s campaign override (user:owner, 2026-10-08)'

/** One tick of the recipe for one campaign: the decisions, the lanes and the strategy step. */
function tick(c: CampaignRow, fs: TargetFacts[], opts: { hours?: Map<string, PlanHour>; locks?: Map<string, LeverLocks>; switches?: number; owned?: Set<string> } = {}) {
  const ds = fs.map((f) => decide(f))
  const owned = opts.owned ?? OWNED
  const states = campaignStates(fs, ds, owned, one, opts.hours)
  const lanes = placementWrites(market(c), fs, ds, owned, one, opts.hours, { states, locks: opts.locks })
  const strategy = strategyWrites(market(c), states, opts.locks ?? new Map(), new Map([['c1', opts.switches ?? 0]]))
  return { ds, states, lanes, strategy, plan: lanes[0] ? placementPlan(lanes[0]) : null, words: recipeWords(lanes, strategy).get('c1') }
}

beforeEach(() => {
  order.calls = []
  order.memoryFails = null
  updateCampaign.mockReset().mockImplementation(async () => { order.calls.push('updateCampaign'); return { ok: true, outboundQueueId: 'q1', actionLogId: 'l1', bidHistoryIds: [], error: null } })
  updatePlacement.mockReset().mockImplementation(async () => { order.calls.push('updatePlacement'); return { ok: true, mode: 'live', adjustments: [] } })
})

describe('which stop holds the whole campaign', () => {
  const d = (layer: Decision['layer'] = 'goal') => ({ layer })
  it('a stop, stock (not buyable) or the plan\'s Min-bid hour on every keyword; the kind on most keywords is named', () => {
    expect(campaignStopOf([{ f: stopped(), d: d('stop') }, { f: stopped({ targetId: 't2' }), d: d('stop') }], false)).toEqual({ kind: 'stop', words: `stop by ${BUDGET}` })
    const out = facts({ overrides: { stock: { notBuyable: true, stopBidCents: 3, by: 'out of stock (2 products)' } } })
    expect(campaignStopOf([{ f: out, d: d('stock') }], false)).toEqual({ kind: 'stock', words: 'not buyable (out of stock (2 products))' })
    const min = facts({ overrides: { minBidHour: { floorCents: 3 } } })
    expect(campaignStopOf([{ f: min, d: d('min_bid_hour') }], true)).toEqual({ kind: 'min_bid_hour', words: 'Min-bid hour' })
    // A tie: the stop is named. A Min-bid hour over a campaign with one keyword under its own stop: the Min-bid hour.
    expect(campaignStopOf([{ f: min, d: d('min_bid_hour') }, { f: stopped({ targetId: 't2' }), d: d('stop') }], true)).toMatchObject({ kind: 'stop' })
    expect(campaignStopOf([{ f: min, d: d('min_bid_hour') }, { f: { ...min, targetId: 't3' }, d: d('min_bid_hour') }, { f: stopped({ targetId: 't2' }), d: d('stop') }], true)).toMatchObject({ kind: 'min_bid_hour' })
    // Without the plan's hour, a Min-bid mark beside a real stop still makes it whole.
    expect(campaignStopOf([{ f: min, d: d('min_bid_hour') }, { f: stopped({ targetId: 't2' }), d: d('stop') }], false)).toMatchObject({ kind: 'stop' })
    // A keyword a person pinned is held by its pin, but the stock stop still holds the campaign (ads do not serve unsellable products).
    expect(keywordStop(facts({ overrides: { pin: { by: 'a person' }, stock: { notBuyable: true, stopBidCents: 3, by: 'no Buy Box' } } }), d('pin'))).toMatchObject({ kind: 'stock' })
  })

  it('one serving keyword (an ad group floored alone), low stock cover, or a Min-bid mark with no plan hour: no campaign stop', () => {
    expect(campaignStopOf([{ f: stopped(), d: d('stop') }, { f: facts({ targetId: 't2' }), d: d('band') }], false)).toBeNull()
    expect(campaignStopOf([{ f: facts({ overrides: { stock: { coverFactor: 0.6, by: 'low stock' } } }), d: d('stock') }], false)).toBeNull()
    expect(campaignStopOf([{ f: facts({ overrides: { minBidHour: { floorCents: 2 } } }), d: d('min_bid_hour') }], false)).toBeNull()
  })

  it('a braked keyword (its ad group paused) does not count; every keyword braked is no stop', () => {
    const paused = facts({ targetId: 't2', brakes: ['ad group paused'] })
    expect(campaignStopOf([{ f: stopped(), d: d('stop') }, { f: paused, d: d('brake') }], false)).toMatchObject({ kind: 'stop' })
    expect(campaignStopOf([{ f: { ...stopped(), brakes: ['campaign paused'] }, d: d('brake') }], false)).toBeNull()
  })
})

describe('the 60¢ stack case — base 3¢ × placement 900 % × up and down → 3¢ during a stop; then bids, lanes and strategy back exact', () => {
  const LIVE: P[] = [{ placement: TOP, percentage: 900 }, { placement: PRODUCT, percentage: 50 }]

  it('during the stop: every lane at 0 % and down only, so the 3¢ floor costs at most 3¢ (60¢ before)', () => {
    const c = campaign({ placements: LIVE })
    expect(stackMaxCents(3, LIVE, 'AUTO_FOR_SALES')).toBe(60)
    const t = tick(c, [stopped()])
    expect(t.ds[0]).toMatchObject({ action: 'write', layer: 'stop', bidCents: 3 })
    expect(t.lanes).toEqual([expect.objectContaining({ recipe: 'stop', current: LIVE, note: `stop by ${BUDGET} — every placement at 0 %` })])
    expect(t.plan!.adjustments).toEqual([{ placement: TOP, percentage: 0 }, { placement: REST, percentage: 0 }, { placement: PRODUCT, percentage: 0 }])
    expect(t.strategy).toEqual([expect.objectContaining({ from: 'AUTO_FOR_SALES', layer: 'stop', step: expect.objectContaining({ do: 'switch', to: 'LEGACY_FOR_SALES', kind: 'floor', remember: 'AUTO_FOR_SALES' }) })])
    const to = (t.strategy[0].step as { to: string }).to
    expect(stackMaxCents(t.ds[0].bidCents, t.plan!.adjustments, to)).toBe(3)
    // The design's 300 % case too: 3¢ × 4 × 2 = 24¢ before, 3¢ with the recipe.
    expect(stackMaxCents(3, [{ placement: TOP, percentage: 300 }], 'AUTO_FOR_SALES')).toBe(24)
    expect(t.words).toBe('stop recipe: every placement at 0 %; bidding strategy up and down → down only while the stop lasts (Amazon then never raises the floor)')
  })

  it('after it: the bid from its memory, the lanes saved and up and down — exactly what served before the stop', () => {
    // As the stop's tick left the campaign: lanes 0 %, down only, the memory saved; the stop lifted.
    const after = campaign({ biddingStrategy: 'LEGACY_FOR_SALES', placements: [{ placement: TOP, percentage: 0 }, { placement: REST, percentage: 0 }, { placement: PRODUCT, percentage: 0 }], savedPlacements: LIVE, savedStrategy: 'AUTO_FOR_SALES' })
    const t = tick(after, [facts({ currentCents: 3, chain: [], restore: { layer: 'stop', heldCents: 3, beforeCents: 45 } })], { switches: 1 })
    expect(t.ds[0]).toMatchObject({ action: 'write', layer: 'restore', bidCents: 45 })
    expect(t.lanes).toEqual([expect.objectContaining({ recipe: 'restore', lanes: [], base: fullLanes(LIVE) })])
    expect(t.plan!.adjustments).toEqual([{ placement: TOP, percentage: 900 }, { placement: REST, percentage: 0 }, { placement: PRODUCT, percentage: 50 }])
    expect(t.plan!.changes).toEqual([{ lane: 'top-of-search', from: 0, to: 900, held: null }, { lane: 'product-page', from: 0, to: 50, held: null }])
    expect(t.strategy).toEqual([expect.objectContaining({ layer: 'restore', step: { do: 'switch', to: 'AUTO_FOR_SALES', kind: 'restore', remember: null, why: 'the stop ended: bidding strategy back to up and down' } })])
    expect(stackMaxCents(t.ds[0].bidCents, t.plan!.adjustments, 'AUTO_FOR_SALES')).toBe(stackMaxCents(45, LIVE, 'AUTO_FOR_SALES'))
    expect(t.words).toBe('stop ended: the placements saved when it began come back; the stop ended: bidding strategy back to up and down')
  })

  it('a Min-bid hour is the same recipe: lanes 0 % and down only for the hour; its why no longer says the strategy is kept', () => {
    const min = spec({ key: 'min', pause: true, floorBidCents: 3 })
    const p = planFacts(hour(min), { biddingStrategy: 'AUTO_FOR_SALES' }, { entriesToday: 0, inMinBid: false, maxEntries: 2 })!
    expect(p.note).toBe('hourly plan IT GALE JACKET: min — every placement at 0 %')
    const t = tick(campaign({ placements: LIVE }), [facts({ overrides: { minBidHour: p.minBidHour }, lanes: p.lanes, planNote: p.note })], { hours: new Map([['c1', hour(min)]]) })
    expect(t.lanes[0]).toMatchObject({ recipe: 'stop', key: 'min', note: p.note })
    expect(t.strategy[0]).toMatchObject({ layer: 'min_bid_hour', step: { do: 'switch', to: 'LEGACY_FOR_SALES', why: expect.stringMatching(/down only while the Min-bid hour lasts/) } })
    expect(stackMaxCents(3, t.plan!.adjustments, 'LEGACY_FOR_SALES')).toBe(3)
  })
})

describe('when the stop ends inside a plan hour', () => {
  const zeroed = (over: Partial<CampaignRow> = {}) => campaign({ biddingStrategy: 'LEGACY_FOR_SALES', placements: [{ placement: TOP, percentage: 0 }, { placement: PRODUCT, percentage: 0 }], savedPlacements: [{ placement: TOP, percentage: 300 }, { placement: PRODUCT, percentage: 75 }], savedStrategy: 'AUTO_FOR_SALES', ...over })
  const serve = (c: CampaignRow, s: RankTargetSpec, over: Partial<TargetFacts> = {}) => {
    const p = planFacts(hour(s), { biddingStrategy: c.biddingStrategy }, { entriesToday: 0, inMinBid: false, maxEntries: 2 })!
    return tick(c, [facts({ currentCents: 30, lanes: p.lanes, planNote: p.note, ...over })], { hours: new Map([['c1', hour(s)]]), switches: 1 })
  }

  it('a single-placement hour sets its lane; the others come back from the memory, in one write', () => {
    const t = serve(zeroed(), spec({ placement: TOP, biasPct: 120 }))
    expect(t.lanes[0]).toMatchObject({ recipe: 'restore', key: 'all-out' })
    expect(t.plan!.adjustments).toEqual([{ placement: REST, percentage: 0 }, { placement: PRODUCT, percentage: 75 }, { placement: TOP, percentage: 120 }])
    expect(t.plan!.kept).toEqual([])
  })

  it('a blended hour sets all three lanes, as it would without the stop', () => {
    const t = serve(zeroed(), spec({ lanes: [{ placement: TOP, biasPct: 150 }, { placement: PRODUCT, biasPct: 50 }] }))
    expect(t.plan!.adjustments).toEqual([{ placement: TOP, percentage: 150 }, { placement: REST, percentage: 0 }, { placement: PRODUCT, percentage: 50 }])
  })

  it('under the raise cap a lane comes back to its saved %, never above it — and not held at the stop\'s 0 %', () => {
    const t = serve(zeroed(), spec({ placement: TOP, biasPct: 400 }), { raiseCap: 'spend this hour above 1.5 × its average' })
    expect(t.plan!.adjustments.find((a) => a.placement === TOP)).toEqual({ placement: TOP, percentage: 300 })
  })
})

describe('the Owner\'s locks (AB-1) are not written, and the why says so', () => {
  const LIVE: P[] = [{ placement: TOP, percentage: 900 }, { placement: PRODUCT, percentage: 50 }]

  it('a locked placements lever: no lane write, no memory; the why names the lock', async () => {
    const t = tick(campaign({ placements: LIVE }), [stopped()], { locks: locks({ placements: BY }) })
    expect(t.words).toMatch(/^stop recipe: placements locked by the Owner's campaign override \(user:owner, 2026-10-08\): not set to 0 %/)
    const r = await writeOwnedPlacements(t.lanes, { runId: 'r', guard: guard() })
    expect(r).toMatchObject({ locked: 1, written: 0 })
    expect(r.byCampaign.get('c1')).toMatchObject({ sent: 'locked', reason: `placements ${BY}: not written` })
    expect(updatePlacement).not.toHaveBeenCalled()
    expect(order.calls).toEqual([])
    expect(placementReportWords(r)).toBe('placements-locked=1')
  })

  it('a lock set during the stop: when it ends nothing is written and the saved lanes are dropped (the lever is his)', async () => {
    const t = tick(campaign({ biddingStrategy: 'LEGACY_FOR_SALES', savedPlacements: LIVE }), [facts()], { locks: locks({ placements: BY }) })
    expect(t.words).toMatch(/^stop ended: placements locked by .*: left as they are/)
    await writeOwnedPlacements(t.lanes, { runId: 'r', guard: guard() })
    expect(updatePlacement).not.toHaveBeenCalled()
    expect(order.calls).toEqual(['forgetLanes c1'])
  })

  it('one locked lane keeps its %; the others go to 0 %', () => {
    const t = tick(campaign({ placements: LIVE }), [stopped()], { locks: locks({ lanes: new Map([['TOP_OF_SEARCH', BY]]) }) })
    expect(t.plan!.adjustments).toEqual([{ placement: TOP, percentage: 900 }, { placement: REST, percentage: 0 }, { placement: PRODUCT, percentage: 0 }])
    expect(t.plan!.changes).toEqual([{ lane: 'product-page', from: 50, to: 0, held: null }])
    expect(t.plan!.locked).toEqual([{ lane: 'top-of-search', pct: 900, by: BY }])
    expect(t.words).toContain(`every placement at 0 % (top-of-search ${BY}: left as it is)`)
  })

  it('a locked bidding strategy stays up and down during the stop (said, with what may still lift the floor); after it the memory goes', () => {
    const t = tick(campaign({ placements: LIVE }), [stopped()], { locks: locks({ biddingStrategy: BY }) })
    expect(t.strategy[0].step).toEqual({ do: 'hold', why: `the bidding strategy is ${BY}: kept up and down — Amazon may still add up to +100 % at the top of search over the floor` })
    expect(t.words).toContain('kept up and down')
    expect(strategyStep({ stop: null, current: 'LEGACY_FOR_SALES', saved: 'AUTO_FOR_SALES', locked: BY, switchesToday: 0 })).toMatchObject({ do: 'forget', why: expect.stringMatching(/left down only as it is \(the up and down the stop saved is dropped\)/) })
  })
})

describe('a campaign\'s own pins hold the levers too (the gate would refuse the write: none is sent)', () => {
  const LIVE: P[] = [{ placement: TOP, percentage: 900 }, { placement: PRODUCT, percentage: 50 }]
  it('the placements pin: no lane write; the bids pin: the strategy stays (said); the Owner\'s lock wins where both hold', () => {
    const t = tick(campaign({ placements: LIVE, pinPlacement: true, pinBids: true, pinnedBy: 'user:owner' }), [stopped()])
    expect(t.lanes[0].locks).toEqual({ placements: 'held by its placements pin (user:owner)', lanes: new Map(), biddingStrategy: null })
    expect(t.strategy[0].step).toMatchObject({ do: 'hold', why: expect.stringMatching(/^the bidding strategy is held by its bids pin \(user:owner\): kept up and down/) })
    expect(t.words).toMatch(/^stop recipe: placements held by its placements pin \(user:owner\): not set to 0 %/)
    expect(placementLocks({ pinPlacement: false, pinnedBy: null }, undefined)).toBeNull()
    expect(placementLocks({ pinPlacement: true, pinnedBy: null }, { placements: BY, lanes: new Map(), biddingStrategy: null })?.placements).toBe(BY)
    expect(strategyLock({ pinBids: true, pinnedBy: null }, { placements: null, lanes: new Map(), biddingStrategy: BY })).toBe(BY)
    expect(strategyLock({ pinBids: false, pinnedBy: null }, undefined)).toBeNull()
  })
})

describe('the anti-flap: a switch at most twice a UTC day per campaign', () => {
  const stop = { kind: 'stop' as const, words: 'stop by x' }
  it('the switch down is the stop\'s brake: never held back, whatever the count', () => {
    expect(strategyStep({ stop, current: 'AUTO_FOR_SALES', saved: null, locked: null, switchesToday: 7 })).toMatchObject({ do: 'switch', to: 'LEGACY_FOR_SALES', kind: 'floor' })
  })

  it('a day of two stops: down, back, down — then it stays down only until the next UTC day, and says why', () => {
    const day = [
      strategyStep({ stop, current: 'AUTO_FOR_SALES', saved: null, locked: null, switchesToday: 0 }),
      strategyStep({ stop: null, current: 'LEGACY_FOR_SALES', saved: 'AUTO_FOR_SALES', locked: null, switchesToday: 1 }),
      strategyStep({ stop, current: 'AUTO_FOR_SALES', saved: null, locked: null, switchesToday: 2 }),
      strategyStep({ stop: null, current: 'LEGACY_FOR_SALES', saved: 'AUTO_FOR_SALES', locked: null, switchesToday: 3 }),
    ]
    expect(day.map((s) => s?.do)).toEqual(['switch', 'switch', 'switch', 'hold'])
    expect(day[3]!.why).toBe(`bidding strategy kept down only until tomorrow (UTC): it switched 3 times today, at most ${MAX_STRATEGY_SWITCHES_PER_DAY} a day (one stop on and off)`)
    // The next UTC day: the count starts again and it goes back.
    expect(strategyStep({ stop: null, current: 'LEGACY_FOR_SALES', saved: 'AUTO_FOR_SALES', locked: null, switchesToday: 0 })).toMatchObject({ do: 'switch', to: 'AUTO_FOR_SALES', kind: 'restore' })
  })

  it('only a campaign with a strategy saved and no stop is counted (no query otherwise)', () => {
    const t = tick(campaign({ biddingStrategy: 'LEGACY_FOR_SALES', savedStrategy: 'AUTO_FOR_SALES' }), [facts()])
    expect(restoreCandidates(market(campaign({ savedStrategy: 'AUTO_FOR_SALES' })), t.states)).toEqual(['c1'])
    expect(restoreCandidates(market(campaign()), t.states)).toEqual([])
  })
})

describe('the strategy someone else set is left alone', () => {
  const stop = { kind: 'stop' as const, words: 'stop by x' }
  it('fixed or down only is not touched by a stop; changed during the stop it is kept, the memory dropped', () => {
    expect(strategyStep({ stop, current: 'MANUAL', saved: null, locked: null, switchesToday: 0 })).toBeNull()
    expect(strategyStep({ stop, current: 'LEGACY_FOR_SALES', saved: null, locked: null, switchesToday: 0 })).toBeNull()
    expect(strategyStep({ stop, current: 'LEGACY_FOR_SALES', saved: 'AUTO_FOR_SALES', locked: null, switchesToday: 0 })).toBeNull()
    expect(strategyStep({ stop: null, current: 'MANUAL', saved: 'AUTO_FOR_SALES', locked: null, switchesToday: 0 })).toEqual({ do: 'forget', why: 'the bidding strategy changed during the stop (now fixed): left as it is' })
    expect(strategyStep({ stop: null, current: 'AUTO_FOR_SALES', saved: 'AUTO_FOR_SALES', locked: null, switchesToday: 0 })).toMatchObject({ do: 'forget' })
    expect(strategyStep({ stop: null, current: 'AUTO_FOR_SALES', saved: null, locked: null, switchesToday: 0 })).toBeNull()
  })

  it('a paused campaign gets nothing (the memory waits for it)', () => {
    const t = tick(campaign({ status: 'PAUSED', placements: [{ placement: TOP, percentage: 900 }] }), [stopped({ brakes: ['campaign paused'] })])
    expect(t.lanes).toEqual([])
    expect(t.strategy).toEqual([])
  })
})

describe('a campaign the brain does not own: zero change', () => {
  it('no state, no lane, no strategy step, no words — stopped, up and down at 900 %, memory or not', () => {
    const c = campaign({ placements: [{ placement: TOP, percentage: 900 }], savedPlacements: [{ placement: TOP, percentage: 300 }], savedStrategy: 'AUTO_FOR_SALES' })
    const t = tick(c, [stopped()], { owned: new Set() })
    expect(t.states.size).toBe(0)
    expect(t.lanes).toEqual([])
    expect(t.strategy).toEqual([])
    expect(t.words).toBeUndefined()
  })

  it('the saved lanes read back only from a list (null: no stop holds them)', () => {
    expect(readSavedLanes(null)).toBeNull()
    expect(readSavedLanes({})).toBeNull()
    expect(readSavedLanes([])).toEqual([])
    expect(readSavedLanes([{ placement: TOP, percentage: '120' }, { placement: 3 }, { placement: PRODUCT, percentage: 'x' }])).toEqual([{ placement: TOP, percentage: 120 }])
    expect(fullLanes([{ placement: PRODUCT, percentage: 5 }, { placement: 'PLACEMENT_AMAZON_BUSINESS', percentage: 10 }])).toEqual([
      { placement: TOP, percentage: 0 }, { placement: REST, percentage: 0 }, { placement: PRODUCT, percentage: 5 }, { placement: 'PLACEMENT_AMAZON_BUSINESS', percentage: 10 },
    ])
  })
})

describe('the writers: the memory first, the write after; given back, the memory goes', () => {
  const LIVE: P[] = [{ placement: TOP, percentage: 900 }, { placement: PRODUCT, percentage: 50 }]

  it('a stop\'s lanes: the live lanes saved, then zeroed as the brain, a floor (it lands with the caps used for raises)', async () => {
    const t = tick(campaign({ placements: LIVE }), [stopped()])
    const r = await writeOwnedPlacements(t.lanes, { runId: 'run-1', guard: guard() })
    expect(r).toMatchObject({ written: 1, refused: 0 })
    expect(order.calls).toEqual([`rememberLanes c1 ${JSON.stringify(LIVE)}`, 'updatePlacement'])
    expect(updatePlacement.mock.calls[0][0]).toMatchObject({
      campaignId: 'c1', actor: BRAIN_ACTOR, adjustments: [{ placement: TOP, percentage: 0 }, { placement: REST, percentage: 0 }, { placement: PRODUCT, percentage: 0 }],
      evidence: { metric: 'placementBidding', brain: { runId: 'run-1', layer: 'stop' } },
    })
    expect(updatePlacement.mock.calls[0][0].reason).toMatch(/^bid brain — stop by automation:budget-manager-cron — every placement at 0 %: top-of-search 900% → 0%, product-page 50% → 0%/)
  })

  it('no memory kept, nothing zeroed (the next tick tries again); under SUGGEST a stop\'s zeroing waits', async () => {
    order.memoryFails = 'db down'
    const t = tick(campaign({ placements: LIVE }), [stopped()])
    const r = await writeOwnedPlacements(t.lanes, { runId: 'r', guard: guard() })
    expect(r).toMatchObject({ refused: 1, written: 0, reasons: [expect.stringMatching(/could not be kept \(db down\): nothing zeroed/)] })
    expect(updatePlacement).not.toHaveBeenCalled()
    order.memoryFails = null
    const s = await writeOwnedPlacements(t.lanes, { runId: 'r', guard: guard('suggest') })
    expect(s.byCampaign.get('c1')).toMatchObject({ sent: 'would-apply' })
    expect(order.calls).toEqual([])
  })

  it('the give-back: written as a restore (it lands under SUGGEST), then the memory goes; refused, it is kept; nothing left to give back, it goes', async () => {
    const after = campaign({ biddingStrategy: 'LEGACY_FOR_SALES', placements: [{ placement: TOP, percentage: 0 }], savedPlacements: LIVE })
    const t = tick(after, [facts()])
    const r = await writeOwnedPlacements(t.lanes, { runId: 'r', guard: guard('suggest') })
    expect(r).toMatchObject({ written: 1 })
    expect(order.calls).toEqual(['updatePlacement', 'forgetLanes c1'])
    order.calls = []
    updatePlacement.mockResolvedValueOnce({ ok: false, mode: 'blocked', reason: 'refused by the gate', adjustments: [] })
    expect(await writeOwnedPlacements(t.lanes, { runId: 'r', guard: guard() })).toMatchObject({ refused: 1, reasons: ['refused by the gate'] })
    expect(order.calls).toEqual([])
    const back = tick(campaign({ biddingStrategy: 'LEGACY_FOR_SALES', placements: LIVE, savedPlacements: LIVE }), [facts()])
    await writeOwnedPlacements(back.lanes, { runId: 'r', guard: guard() })
    expect(order.calls).toEqual(['forgetLanes c1'])
    expect(updatePlacement).toHaveBeenCalledTimes(2)
  })

  it('the strategy: up and down saved, then down only through the campaign write, as the brain, the gate asked', async () => {
    const t = tick(campaign({ placements: LIVE }), [stopped()])
    const r = await writeOwnedStrategies(t.strategy, { runId: 'run-1', guard: guard() })
    expect(r).toMatchObject({ switched: 1, refused: 0 })
    expect(order.calls).toEqual(['rememberStrategy c1 AUTO_FOR_SALES', 'updateCampaign'])
    expect(updateCampaign.mock.calls[0][0]).toMatchObject({
      campaignId: 'c1', patch: { biddingStrategy: 'LEGACY_FOR_SALES' }, actor: BRAIN_ACTOR, askGate: true,
      evidence: { metric: 'biddingStrategy', source: { kind: 'bid-brain', id: 'run-1' }, brain: { runId: 'run-1', layer: 'stop', dataDay: '2026-10-01', goalBidCents: null } },
    })
    expect(updateCampaign.mock.calls[0][0].reason).toBe('bid brain — bidding strategy up and down → down only while the stop lasts (Amazon then never raises the floor)')
    expect(strategyReportWords(r)).toBe('strategy=1')
  })

  it('the switch back: queued → the memory goes; refused → kept; SUGGEST lets the give-back through but not a stop\'s switch', async () => {
    const back = tick(campaign({ biddingStrategy: 'LEGACY_FOR_SALES', savedStrategy: 'AUTO_FOR_SALES' }), [facts()], { switches: 1 }).strategy
    await writeOwnedStrategies(back, { runId: 'r', guard: guard('suggest') })
    expect(order.calls).toEqual(['updateCampaign', 'forgetStrategy c1'])
    order.calls = []
    updateCampaign.mockResolvedValueOnce({ ok: false, outboundQueueId: null, actionLogId: null, bidHistoryIds: [], error: 'Not sent to Amazon: refused' })
    expect(await writeOwnedStrategies(back, { runId: 'r', guard: guard() })).toMatchObject({ refused: 1, reasons: ['Not sent to Amazon: refused'] })
    expect(order.calls).toEqual([])
    const down = tick(campaign(), [stopped()]).strategy
    const s = await writeOwnedStrategies(down, { runId: 'r', guard: guard('suggest') })
    expect(s.byCampaign.get('c1')).toMatchObject({ sent: 'would-apply', to: 'LEGACY_FOR_SALES' })
    expect(order.calls).toEqual([])
  })

  it('a hold writes nothing and is said in the run line; a forget only drops the memory', async () => {
    const held = tick(campaign({ biddingStrategy: 'LEGACY_FOR_SALES', savedStrategy: 'AUTO_FOR_SALES' }), [facts()], { switches: 2 }).strategy
    const r = await writeOwnedStrategies(held, { runId: 'r', guard: guard() })
    expect(r).toMatchObject({ held: 1, switched: 0 })
    expect(strategyReportWords(r)).toMatch(/^strategy-held=1 \(bidding strategy kept down only until tomorrow \(UTC\): it switched 2 times today/)
    expect(updateCampaign).not.toHaveBeenCalled()
    const changed = tick(campaign({ biddingStrategy: 'MANUAL', savedStrategy: 'AUTO_FOR_SALES' }), [facts()]).strategy
    await writeOwnedStrategies(changed, { runId: 'r', guard: guard() })
    expect(order.calls).toEqual(['forgetStrategy c1'])
    expect(updateCampaign).not.toHaveBeenCalled()
  })
})
