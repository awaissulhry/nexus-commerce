/**
 * ADS PLAYBOOK PB-6c — the winners view, pure (winners.ts classifyWinner, winnerLadder). Values are made up (public repo).
 *
 *   states     winning where it runs · declining (ACoS over the target, or under the bar after meeting it) · lost (it
 *              met the bar before and sold nothing since) · unproven; "cannot compare" (the window before reaches past
 *              the search terms Nexus keeps) → never declining, unproven
 *   no number  the bar and the target are inputs: two strategies give two answers for the same results
 *   ladder     a winner gets no step; a floor or a pause is named and gets none; else bid (auto-bid really on it, the
 *              target spent in its window, inside the band) → placement (a research slot or its own campaign, never an
 *              hourly plan's or a performance slot's) → a campaign of its own → none; every rung says why
 *   handover   the hero proven: the old exact keyword to the floor (never a negative); reported only where an hourly
 *              plan or a performance slot holds the campaign, nothing over a floor
 */
import { describe, expect, it } from 'vitest'
import { classifyWinner, winnerLadder, type LadderFacts, type TermResults, type WinnerBar } from './winners.js'

const bar = (over: Partial<WinnerBar> = {}): WinnerBar => ({ minOrders: 2, minClicks: 10, maxAcosPct: null, windowDays: 30, ...over })
const r = (orders: number, clicks: number, costCents: number, salesCents: number): TermResults => ({ orders, clicks, costCents, salesCents })

describe('classifyWinner — where a term stands, on the strategy\'s numbers only', () => {
  it('winning, declining (ACoS over the target), declining (under the bar now), lost, unproven', () => {
    expect(classifyWinner({ current: r(4, 40, 2000, 10_000), previous: null, bar: bar(), targetAcosPct: 30 })).toMatchObject({ state: 'winning' })
    expect(classifyWinner({ current: r(4, 40, 4000, 10_000), previous: null, bar: bar(), targetAcosPct: 30 }))
      .toEqual({ state: 'declining', why: 'it meets the harvest bar over the settled 30 days, but its ACoS is over the target' })
    expect(classifyWinner({ current: r(1, 12, 500, 2500), previous: r(5, 50, 2000, 12_000), bar: bar(), targetAcosPct: 30 }))
      .toEqual({ state: 'declining', why: 'it met the harvest bar in the 30 days before and sells less now: under the bar over the settled 30 days' })
    expect(classifyWinner({ current: r(0, 9, 400, 0), previous: r(5, 50, 2000, 12_000), bar: bar(), targetAcosPct: 30 })).toMatchObject({ state: 'lost' })
    expect(classifyWinner({ current: null, previous: r(3, 30, 900, 6000), bar: bar(), targetAcosPct: null })).toMatchObject({ state: 'lost' })
    expect(classifyWinner({ current: r(1, 3, 100, 900), previous: r(1, 2, 80, 700), bar: bar(), targetAcosPct: null })).toMatchObject({ state: 'unproven' })
    // No target set: the bar alone decides; no sales → no ACoS to hold against it.
    expect(classifyWinner({ current: r(4, 40, 9000, 10_000), previous: null, bar: bar(), targetAcosPct: null })).toMatchObject({ state: 'winning' })
  })

  it('cannot compare (the window before reaches past the search terms Nexus keeps): a winner still wins, anything else is unproven', () => {
    expect(classifyWinner({ current: r(4, 40, 2000, 10_000), previous: null, comparable: false, bar: bar({ windowDays: 60 }), targetAcosPct: 30 }).state).toBe('winning')
    for (const current of [r(4, 40, 4000, 10_000), r(1, 12, 500, 2500), null]) {
      const out = classifyWinner({ current, previous: r(5, 50, 2000, 12_000), comparable: false, bar: bar({ windowDays: 60 }), targetAcosPct: 30 })
      expect(out).toEqual({ state: 'unproven', why: 'cannot compare: the 60 days before reach past the 90 days of search terms Nexus keeps, so it is not judged declining and nothing is proposed' })
    }
  })

  it('two strategies, two answers: the same results against another bar, another target, another ceiling', () => {
    const results = { current: r(3, 30, 2400, 10_000), previous: r(6, 60, 3000, 20_000) }
    expect(classifyWinner({ ...results, bar: bar({ minOrders: 2 }), targetAcosPct: 30 }).state).toBe('winning')
    expect(classifyWinner({ ...results, bar: bar({ minOrders: 5 }), targetAcosPct: 30 }).state).toBe('declining')
    expect(classifyWinner({ ...results, bar: bar(), targetAcosPct: 20 }).state).toBe('declining')
    expect(classifyWinner({ ...results, bar: bar({ maxAcosPct: 20 }), targetAcosPct: null }).state).toBe('declining')
    expect(classifyWinner({ ...results, bar: bar({ minClicks: 31 }), targetAcosPct: null }).state).toBe('declining')
    expect(classifyWinner({ ...results, bar: bar({ windowDays: 60 }), targetAcosPct: null }).why).toMatch(/over the settled 60 days/)
  })
})

const facts = (over: Partial<LadderFacts> = {}, campaign: Partial<LadderFacts['campaign']> = {}): LadderFacts => ({
  state: 'declining',
  autoBid: { on: true, why: 'auto-bid runs' },
  held: null,
  campaign: { liveWrites: true, holder: null, performance: false, research: true, hero: false, ...campaign },
  servedBy: { bidCents: 50, live: true, personSet: false, spent: true, exact: false },
  targetAcosPct: 30,
  band: { minBidCents: 10, maxBidCents: 100 },
  hero: { exists: null, refusal: null },
  ...over,
})
const served = (over: Partial<NonNullable<LadderFacts['servedBy']>>) => ({ servedBy: { bidCents: 50, live: true, personSet: false, spent: true, exact: false, ...over } })
const step = (f: LadderFacts) => winnerLadder(f).nextStep

describe('winnerLadder — bid, then placement, then a campaign of its own', () => {
  it('a winner is kept where it is: no step at all', () => {
    expect(winnerLadder(facts({ state: 'winning' }))).toEqual({ nextStep: 'none', why: expect.stringMatching(/^winning where it runs: it stays there/), ladder: [] })
    expect(winnerLadder(facts({ state: 'unproven' })).ladder).toEqual([])
  })

  it('bid first: auto-bid really runs, the target spent in its window, inside the band', () => {
    const l = winnerLadder(facts())
    expect(l.nextStep).toBe('bid')
    expect(l.ladder.map((x) => [x.step, x.open])).toEqual([['bid', true], ['placement', true], ['ownCampaign', true]])
  })

  it('auto-bid cannot move it → placement on a research slot; each blocker says why', () => {
    const blocked: Array<[Partial<LadderFacts>, Partial<LadderFacts['campaign']>, RegExp]> = [
      [{ autoBid: { on: false, why: 'auto-bid does not run: Bid optimiser is switched off on the server' } }, {}, /does not run: Bid optimiser is switched off on the server/],
      [{}, { holder: 'pinned' }, /a pin holds its bids/],
      [{}, { holder: 'goalPlan' }, /a goal plan holds/],
      [{ servedBy: null }, {}, /cannot tell which keyword/],
      [served({ live: false }), {}, /not live at Amazon/],
      [served({ personSet: true }), {}, /a person set its bid/],
      [served({ spent: false }), {}, /spent nothing in auto-bid's own settled window/],
      [{ targetAcosPct: null }, {}, /no target ACoS you set/],
      [served({ bidCents: 100 }), {}, /strategy's highest bid: auto-bid cannot raise it/],
      [served({ bidCents: 10 }), {}, /strategy's lowest bid: auto-bid cannot lower it/],
    ]
    for (const [over, campaign, why] of blocked) {
      const l = winnerLadder(facts(over, campaign))
      expect(l.nextStep).toBe('placement')
      expect(l.ladder[0]).toMatchObject({ step: 'bid', open: false, why: expect.stringMatching(why) })
      expect(l.ladder[1].why).toMatch(/set-placement-multipliers/)
    }
  })

  it('a floor or a pause holds it: named, and nothing is proposed around it — never a placement or a campaign of its own', () => {
    for (const held of ['its campaign is at a floor set by user:u-owner', "its ad group is at its own floor, set by automation:stock-test (stock, or a product's monthly cap)", 'its campaign is paused']) {
      const l = winnerLadder(facts({ held, autoBid: { on: false, why: 'off' } }))
      expect(l).toEqual({ nextStep: 'none', why: `${held}: the one who set it lifts it — no bid, placement or campaign of its own is proposed around a floor or a pause`, ladder: [] })
    }
  })

  it('never a placement or a move where an hourly plan holds the campaign or the slot plays performance: reported only', () => {
    const off = { autoBid: { on: false, why: 'off' } }
    for (const campaign of [{ holder: 'hourlyPlan' as const }, { performance: true, research: false }]) {
      const l = winnerLadder(facts(off, campaign))
      expect(l.nextStep).toBe('none')
      expect(l.why).toMatch(/the Owner's Hourly Bids own its bids and placements — reported only/)
      expect(l.ladder.map((x) => x.open)).toEqual([false, false, false])
    }
    expect(step(facts({}, { holder: 'hourlyPlan' }))).toBe('none')
  })

  it('a campaign of its own: an Exact slot that is not research, or a campaign off the allowlist; never twice', () => {
    const off = { autoBid: { on: false, why: 'off' } }
    const exact = winnerLadder(facts(off, { research: false }))
    expect(exact.nextStep).toBe('ownCampaign')
    expect(exact.ladder[1].why).toMatch(/placements move only on a research slot/)
    expect(exact.why).toMatch(/apply-ads-playbook op hero.*the term keeps running here until it proves itself/)
    expect(step(facts(off, { liveWrites: false }))).toBe('ownCampaign')
    const twice = winnerLadder(facts({ ...off, hero: { exists: { key: 'hero:x', campaignName: 'T | IT | Hero | x', proven: false }, refusal: null } }, { research: false }))
    expect(twice.nextStep).toBe('none')
    expect(twice.ladder[2].why).toMatch(/it has its own campaign already \("T \| IT \| Hero \| x"\)/)
    expect(winnerLadder(facts({ ...off, hero: { exists: null, refusal: 'it is an ASIN' } }, { research: false })).ladder[2]).toMatchObject({ open: false, why: 'it is an ASIN' })
  })

  it('the hero itself, declining: its own placement, never a second hero', () => {
    const l = winnerLadder(facts({ autoBid: { on: false, why: 'off' } }, { research: false, hero: true }))
    expect(l.nextStep).toBe('placement')
    expect(l.ladder[2]).toMatchObject({ step: 'ownCampaign', open: false, why: "it is the term's own campaign already" })
  })
})

describe('winnerLadder — handover B: the old place of a term whose own campaign proved itself', () => {
  const own = (proven: boolean) => ({ exists: { key: 'hero:x', campaignName: 'T | IT | Hero | x', proven }, refusal: null })
  it('the hero proven → its old exact keyword to the floor (never a negative), whatever the old place\'s own state', () => {
    for (const state of ['winning', 'declining', 'lost'] as const) {
      const l = winnerLadder(facts({ state, hero: own(true), ...served({ exact: true }) }, { research: false }))
      expect(l).toMatchObject({ nextStep: 'closeOldPlace', ladder: [] })
      expect(l.why).toMatch(/^hero proven → old keyword to the floor: its own campaign \("T \| IT \| Hero \| x"\) meets the harvest bar, so its exact keyword here goes to low bids .*never a negative/)
    }
    // An old research place (a broad keyword or Auto served it): the isolation rule's negative exact there, never its keyword's floor.
    expect(winnerLadder(facts({ hero: own(true) })).why).toMatch(/^hero proven → old place to be closed: .*isolation rule negates it exact here/)
  })

  it('reported only where an hourly plan or a performance slot holds the campaign; nothing over a floor', () => {
    expect(winnerLadder(facts({ hero: own(true), ...served({ exact: true }) }, { performance: true, research: false }))).toMatchObject({ nextStep: 'none', why: expect.stringMatching(/^hero proven .*reported only$/) })
    expect(step(facts({ hero: own(true), ...served({ exact: true }) }, { holder: 'hourlyPlan' }))).toBe('none')
    expect(winnerLadder(facts({ hero: own(true), held: 'its campaign is paused', ...served({ exact: true }) }, { research: false }))).toMatchObject({ nextStep: 'none', why: expect.stringMatching(/held already — its campaign is paused$/) })
  })

  it('the hero not proven yet: both run — a winning old place stays, a declining one keeps its ladder (never a second hero)', () => {
    expect(winnerLadder(facts({ state: 'winning', hero: own(false) }))).toMatchObject({ nextStep: 'none', why: expect.stringMatching(/runs too until that campaign meets the harvest bar/) })
    const l = winnerLadder(facts({ hero: own(false) }))
    expect(l.nextStep).toBe('bid')
    expect(l.ladder[2]).toMatchObject({ step: 'ownCampaign', open: false })
  })

  it('the hero itself is never an old place', () => {
    expect(winnerLadder(facts({ state: 'winning', hero: { exists: null, refusal: null } }, { hero: true, research: false })).nextStep).toBe('none')
  })
})
