/**
 * ONE BRAIN AB-2 — the stop recipe of a campaign the bid brain owns (pure parts, and its writers with the mutation layer
 * stood in for).
 *
 *   which stop   a stop, stock (not buyable) or the plan's Min-bid hour on every keyword that is not braked holds the whole
 *                campaign; one serving keyword (an ad group floored alone) leaves it serving
 *   60¢ case     a 3¢ stop at 900 % top of search under "up and down" may cost 60¢: the recipe zeroes the lanes and switches
 *                to down only (→ 3¢); when the stop ends the bids, the lanes and the strategy come back exactly
 *   plan hour    the hour's own lanes over the saved ones; the raise cap measures from the saved lanes, not the zeros
 *   D, locks     a stop lowers past the Owner's lock (lanes 0 %, down only), as it beats a pinned bid; the give-back puts
 *                his value back (his lock's, else the saved one), never the plan's; the hour's own plan leaves it alone
 *   A            locks that cannot be read hold the give-back a tick — nothing written, nothing dropped — logged once
 *   C            a person's own strategy (a STRATEGY hold) is left alone until the hold ends
 *   pins         the campaign's own pins hold both ways (the gate would refuse); nothing dropped
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
const warn = vi.hoisted(() => vi.fn())
vi.mock('../../../utils/logger.js', () => ({ logger: { warn, info: vi.fn(), error: vi.fn() } }))
const lockRead = vi.hoisted(() => vi.fn())
vi.mock('../brain/owner-brakes.js', async (importOriginal) => ({ ...(await importOriginal<object>()), ownerLeverLocks: (...a: unknown[]) => lockRead(...a) }))

const { campaignStopOf, keywordStop, stackMaxCents, strategyStep, fullLanes, readSavedLanes, MAX_STRATEGY_SWITCHES_PER_DAY } = await import('./stop-recipe.js')
const { campaignStates, placementWrites, strategyWrites, recipeWords, restoreCandidates, placementPin, strategyPin, strategyHolds, readLeverLocks } = await import('./shadow.js')
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
function tick(c: CampaignRow, fs: TargetFacts[], opts: { hours?: Map<string, PlanHour>; locks?: Map<string, LeverLocks>; switches?: number; owned?: Set<string>; held?: Map<string, string> } = {}) {
  const ds = fs.map((f) => decide(f))
  const owned = opts.owned ?? OWNED
  const states = campaignStates(fs, ds, owned, one, opts.hours)
  const lanes = placementWrites(market(c), fs, ds, owned, one, opts.hours, { states, locks: opts.locks })
  const strategy = strategyWrites(market(c), states, opts.locks ?? new Map(), new Map([['c1', opts.switches ?? 0]]), opts.held ?? new Map())
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

describe('D — a stop lowers past the Owner\'s lock (as it beats a pinned bid); only the give-back obeys it', () => {
  const LIVE: P[] = [{ placement: TOP, percentage: 900 }, { placement: PRODUCT, percentage: 50 }]
  const zeroed = (over: Partial<CampaignRow> = {}) => campaign({ biddingStrategy: 'LEGACY_FOR_SALES', placements: [{ placement: TOP, percentage: 0 }, { placement: PRODUCT, percentage: 0 }], savedPlacements: LIVE, savedStrategy: 'AUTO_FOR_SALES', ...over })

  it('during the stop: a locked placements lever, a locked lane and a locked strategy are all lowered — the why says the stop passes his lock', async () => {
    const t = tick(campaign({ placements: LIVE }), [stopped()], { locks: locks({ placements: { words: BY, value: null }, lanes: new Map([['TOP_OF_SEARCH', BY]]), biddingStrategy: { words: BY, value: 'AUTO_FOR_SALES' } }) })
    expect(t.plan!.adjustments).toEqual([{ placement: TOP, percentage: 0 }, { placement: REST, percentage: 0 }, { placement: PRODUCT, percentage: 0 }])
    expect(t.strategy[0].step).toMatchObject({ do: 'switch', to: 'LEGACY_FOR_SALES', kind: 'floor', why: expect.stringMatching(new RegExp(`the stop passes the Owner's lock \\(${BY.replace(/[()]/g, '\\$&')}\\), as a stop passes a pinned bid; his value comes back when it ends`)) })
    expect(t.words).toMatch(/^stop recipe: every placement at 0 % — the stop passes the Owner's lock, as a stop passes a pinned bid; his value comes back when it ends/)
    const r = await writeOwnedPlacements(t.lanes, { runId: 'r', guard: guard() })
    expect(r).toMatchObject({ written: 1, locked: 0 })
    expect(order.calls[0]).toBe(`rememberLanes c1 ${JSON.stringify(LIVE)}`)
  })

  it('after it: a locked lever goes back to the Owner\'s value — his lock\'s, else what it held before the stop — never the plan\'s', () => {
    const allOut = spec({ lanes: [{ placement: TOP, biasPct: 150 }, { placement: PRODUCT, biasPct: 25 }] })
    const p = planFacts(hour(allOut), { biddingStrategy: 'AUTO_FOR_SALES' }, { entriesToday: 0, inMinBid: false, maxEntries: 2 })!
    const serve = (l: Map<string, LeverLocks>) => tick(zeroed(), [facts({ currentCents: 30, lanes: p.lanes, planNote: p.note })], { hours: new Map([['c1', hour(allOut)]]), locks: l, switches: 1 })
    // The whole lever, with his value for top of search: his 40 %, the other lanes as saved; the plan's 150 % / 25 % not applied.
    const whole = serve(locks({ placements: { words: BY, value: { TOP_OF_SEARCH: 40 } } }))
    expect(whole.plan!.adjustments).toEqual([{ placement: TOP, percentage: 40 }, { placement: REST, percentage: 0 }, { placement: PRODUCT, percentage: 50 }])
    expect(whole.words).toContain(`stop ended: the placements go back to the Owner's value (${BY})`)
    // The whole lever "as it was": the saved lanes exactly.
    expect(serve(locks({ placements: { words: BY, value: null } })).plan!.adjustments).toEqual([{ placement: TOP, percentage: 900 }, { placement: REST, percentage: 0 }, { placement: PRODUCT, percentage: 50 }])
    // One lane locked: it goes back to its saved %, the plan sets the others.
    const lane = serve(locks({ lanes: new Map([['TOP_OF_SEARCH', BY]]) }))
    expect(lane.plan!.adjustments).toEqual([{ placement: TOP, percentage: 900 }, { placement: REST, percentage: 0 }, { placement: PRODUCT, percentage: 25 }])
    expect(lane.words).toContain(`top-of-search ${BY}: back to its value before the stop`)
    // The strategy: his locked value now — his lock wins over the anti-flap; "as it was" is the saved one.
    expect(tick(zeroed(), [facts()], { locks: locks({ biddingStrategy: { words: BY, value: 'MANUAL' } }), switches: 5 }).strategy[0].step).toMatchObject({ do: 'switch', to: 'MANUAL', kind: 'restore', why: `the stop ended: the bidding strategy goes back to the Owner's value, fixed (${BY})` })
    expect(tick(zeroed(), [facts()], { locks: locks({ biddingStrategy: { words: BY, value: null } }), switches: 5 }).strategy[0].step).toMatchObject({ do: 'switch', to: 'AUTO_FOR_SALES', kind: 'restore' })
  })

  it('the hour\'s own plan (no stop, no memory) still leaves a locked lever alone: not written, a locked lane keeps its %', async () => {
    const allOut = spec({ lanes: [{ placement: TOP, biasPct: 150 }, { placement: PRODUCT, biasPct: 25 }] })
    const p = planFacts(hour(allOut), { biddingStrategy: 'LEGACY_FOR_SALES' }, { entriesToday: 0, inMinBid: false, maxEntries: 2 })!
    const run = (l: Map<string, LeverLocks>) => tick(campaign({ biddingStrategy: 'LEGACY_FOR_SALES', placements: LIVE }), [facts({ currentCents: 30, lanes: p.lanes, planNote: p.note })], { hours: new Map([['c1', hour(allOut)]]), locks: l })
    const r = await writeOwnedPlacements(run(locks({ placements: { words: BY, value: null } })).lanes, { runId: 'r', guard: guard() })
    expect(r).toMatchObject({ locked: 1, written: 0 })
    expect(updatePlacement).not.toHaveBeenCalled()
    expect(run(locks({ lanes: new Map([['TOP_OF_SEARCH', BY]]) })).plan!.adjustments.find((a) => a.placement === TOP)).toEqual({ placement: TOP, percentage: 900 })
  })
})

describe('A — the Owner\'s locks cannot be read: the give-back waits, nothing is dropped, logged once', () => {
  const LIVE: P[] = [{ placement: TOP, percentage: 900 }, { placement: PRODUCT, percentage: 50 }]
  const UNREADABLE = new Map([['c1', { unreadable: true as const, placements: null, lanes: new Map<string, string>(), biddingStrategy: null }]])

  it('on the tick the stop ends: no write, no forget — the lanes and the strategy wait for the next tick (the probe: was forgetLanes, forgetStrategy)', async () => {
    const after = campaign({ biddingStrategy: 'LEGACY_FOR_SALES', placements: [{ placement: TOP, percentage: 0 }], savedPlacements: LIVE, savedStrategy: 'AUTO_FOR_SALES' })
    const t = tick(after, [facts()], { locks: UNREADABLE, switches: 1 })
    expect(t.strategy[0].step).toEqual({ do: 'hold', why: 'the Owner\'s locks could not be read: the bidding strategy\'s give-back waits for the next tick (the saved strategy is kept)' })
    const placed = await writeOwnedPlacements(t.lanes, { runId: 'r', guard: guard() })
    const switched = await writeOwnedStrategies(t.strategy, { runId: 'r', guard: guard() })
    expect(order.calls).toEqual([])
    expect(updatePlacement).not.toHaveBeenCalled()
    expect(updateCampaign).not.toHaveBeenCalled()
    expect(placed).toMatchObject({ waiting: 1, written: 0 })
    expect(placementReportWords(placed)).toMatch(/^placements-waiting=1 \(the Owner's locks could not be read: the give-back waits for the next tick/)
    expect(switched).toMatchObject({ held: 1 })
    // The next tick reads them: the give-back lands.
    const next = tick(after, [facts()], { switches: 1 })
    await writeOwnedPlacements(next.lanes, { runId: 'r', guard: guard() })
    await writeOwnedStrategies(next.strategy, { runId: 'r', guard: guard() })
    expect(order.calls).toEqual(['updatePlacement', 'forgetLanes c1', 'updateCampaign', 'forgetStrategy c1'])
  })

  it('a stop still lowers (it passes a lock, read or not)', () => {
    const t = tick(campaign({ placements: LIVE }), [stopped()], { locks: UNREADABLE })
    expect(t.plan!.adjustments.every((a) => a.percentage === 0)).toBe(true)
    expect(t.strategy[0].step).toMatchObject({ do: 'switch', to: 'LEGACY_FOR_SALES' })
  })

  it('readLeverLocks: a failed read marks every campaign unreadable and is logged once until a read succeeds', async () => {
    lockRead.mockRejectedValue(new Error('db down'))
    const first = await readLeverLocks(['c1', 'c2'])
    expect(first.get('c1')).toEqual({ unreadable: true, placements: null, lanes: new Map(), biddingStrategy: null })
    await readLeverLocks(['c1'])
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('could not read the Owner')).length).toBe(1)
    lockRead.mockResolvedValue(new Map())
    expect((await readLeverLocks(['c1'])).size).toBe(0)
    lockRead.mockRejectedValue(new Error('db down again'))
    await readLeverLocks(['c1'])
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('could not read the Owner')).length).toBe(2)
  })
})

describe('C — a person\'s own strategy is a hold: the brain leaves it until it ends', () => {
  const HELD = new Map([['c1', 'user:owner until 2026-12-07']])
  it('during a stop: up and down stays (said); when the hold ends the recipe applies again; a stop that ends under it drops its saved strategy', () => {
    const t = tick(campaign({ placements: [{ placement: TOP, percentage: 300 }] }), [stopped()], { held: HELD })
    expect(t.strategy[0].step).toEqual({ do: 'hold', why: 'the bidding strategy is a person\'s own (held by user:owner until 2026-12-07): kept up and down — Amazon may still add up to +100 % at the top of search over the floor' })
    // The lanes are not his: they still go to 0 %.
    expect(t.plan!.adjustments.every((a) => a.percentage === 0)).toBe(true)
    expect(tick(campaign(), [stopped()]).strategy[0].step).toMatchObject({ do: 'switch', to: 'LEGACY_FOR_SALES' })
    expect(tick(campaign({ biddingStrategy: 'LEGACY_FOR_SALES', savedStrategy: 'AUTO_FOR_SALES' }), [facts()], { held: HELD }).strategy[0].step).toMatchObject({ do: 'forget', why: expect.stringMatching(/a person's own \(held by user:owner until 2026-12-07\): left down only \(the up and down the stop saved is dropped\)/) })
  })

  it('strategyHolds reads only an open campaign-wide STRATEGY hold', () => {
    const until = new Date('2026-12-07T10:00:00Z')
    expect(strategyHolds([
      { campaignId: 'c1', targetId: null, kind: 'STRATEGY', by: 'user:owner', until },
      { campaignId: 'c2', targetId: null, kind: 'STOP', by: 'automation:budget-manager', until: null },
      { campaignId: 'c3', targetId: 't1', kind: 'PERSON', by: 'user:owner', until },
    ])).toEqual(new Map([['c1', 'user:owner until 2026-12-07']]))
  })
})

describe('a campaign\'s own pins hold both ways (the gate would refuse the write: none is sent, nothing dropped)', () => {
  const LIVE: P[] = [{ placement: TOP, percentage: 900 }, { placement: PRODUCT, percentage: 50 }]
  it('the placements pin: no lane write in a stop or after it; the bids pin: the strategy stays, its memory kept', async () => {
    const t = tick(campaign({ placements: LIVE, pinPlacement: true, pinBids: true, pinnedBy: 'user:owner' }), [stopped()])
    expect(t.lanes[0]).toMatchObject({ pinned: 'held by its placements pin (user:owner)' })
    expect(t.strategy[0].step).toMatchObject({ do: 'hold', why: expect.stringMatching(/^the bidding strategy is held by its bids pin \(user:owner\): kept up and down/) })
    expect(t.words).toMatch(/^stop recipe: placements held by its placements pin \(user:owner\): not set to 0 %/)
    const after = tick(campaign({ biddingStrategy: 'LEGACY_FOR_SALES', placements: [{ placement: TOP, percentage: 0 }], savedPlacements: LIVE, savedStrategy: 'AUTO_FOR_SALES', pinPlacement: true, pinBids: true, pinnedBy: null }), [facts()], { switches: 1 })
    expect(after.strategy[0].step).toMatchObject({ do: 'hold', why: expect.stringMatching(/held by its bids pin: left down only until the pin is lifted/) })
    expect(await writeOwnedPlacements(after.lanes, { runId: 'r', guard: guard() })).toMatchObject({ locked: 1 })
    await writeOwnedStrategies(after.strategy, { runId: 'r', guard: guard() })
    expect(order.calls).toEqual([])
    expect(placementPin({ pinPlacement: false, pinnedBy: null })).toBeNull()
    expect(strategyPin({ pinBids: true, pinnedBy: null })).toBe('held by its bids pin')
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
