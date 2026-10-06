/**
 * ADS PLAYBOOK PB-6c — the winners view, pure (winners.ts classifyWinner, winnerLadder). Values are made up (public repo).
 *
 *   states     winning where it runs · declining (ACoS over the target, or under the bar after meeting it) · lost (it
 *              met the bar before and sold nothing since) · unproven
 *   no number  the bar and the target are inputs: two strategies give two answers for the same results
 *   ladder     a winner gets no step (kept where it is); else bid (auto-bid on it, inside the band) → placement (a
 *              research slot or its own campaign, never an hourly plan's or a performance slot's) → a campaign of its
 *              own → none; every rung says why it is open or closed
 */
import { describe, expect, it } from 'vitest'
import { classifyWinner, winnerLadder, type LadderFacts, type TermResults, type WinnerBar } from './winners.js'

const bar = (over: Partial<WinnerBar> = {}): WinnerBar => ({ minOrders: 2, minClicks: 10, maxAcosPct: null, windowDays: 30, ...over })
const r = (orders: number, clicks: number, costCents: number, salesCents: number): TermResults => ({ orders, clicks, costCents, salesCents })

describe('classifyWinner — where a term stands, on the strategy\'s numbers only', () => {
  it('winning, declining (ACoS over the target), declining (under the bar now), lost, unproven', () => {
    expect(classifyWinner({ current: r(4, 40, 2000, 10_000), previous: null, bar: bar(), targetAcosPct: 30 })).toMatchObject({ state: 'winning' })
    expect(classifyWinner({ current: r(4, 40, 4000, 10_000), previous: null, bar: bar(), targetAcosPct: 30 }))
      .toEqual({ state: 'declining', why: 'it meets the harvest bar over the last 30 days, but its ACoS is over the target' })
    expect(classifyWinner({ current: r(1, 12, 500, 2500), previous: r(5, 50, 2000, 12_000), bar: bar(), targetAcosPct: 30 }))
      .toEqual({ state: 'declining', why: 'it met the harvest bar in the 30 days before and sells less now: under the bar over the last 30 days' })
    expect(classifyWinner({ current: r(0, 9, 400, 0), previous: r(5, 50, 2000, 12_000), bar: bar(), targetAcosPct: 30 })).toMatchObject({ state: 'lost' })
    expect(classifyWinner({ current: null, previous: r(3, 30, 900, 6000), bar: bar(), targetAcosPct: null })).toMatchObject({ state: 'lost' })
    expect(classifyWinner({ current: r(1, 3, 100, 900), previous: r(1, 2, 80, 700), bar: bar(), targetAcosPct: null })).toMatchObject({ state: 'unproven' })
    // No target set: the bar alone decides; no sales → no ACoS to hold against it.
    expect(classifyWinner({ current: r(4, 40, 9000, 10_000), previous: null, bar: bar(), targetAcosPct: null })).toMatchObject({ state: 'winning' })
  })

  it('two strategies, two answers: the same results against another bar, another target, another ceiling', () => {
    const results = { current: r(3, 30, 2400, 10_000), previous: r(6, 60, 3000, 20_000) }
    expect(classifyWinner({ ...results, bar: bar({ minOrders: 2 }), targetAcosPct: 30 }).state).toBe('winning')
    expect(classifyWinner({ ...results, bar: bar({ minOrders: 5 }), targetAcosPct: 30 }).state).toBe('declining')
    expect(classifyWinner({ ...results, bar: bar(), targetAcosPct: 20 }).state).toBe('declining')
    expect(classifyWinner({ ...results, bar: bar({ maxAcosPct: 20 }), targetAcosPct: null }).state).toBe('declining')
    expect(classifyWinner({ ...results, bar: bar({ minClicks: 31 }), targetAcosPct: null }).state).toBe('declining')
    expect(classifyWinner({ ...results, bar: bar({ windowDays: 60 }), targetAcosPct: null }).why).toMatch(/over the last 60 days/)
  })
})

const facts = (over: Partial<LadderFacts> = {}, campaign: Partial<LadderFacts['campaign']> = {}): LadderFacts => ({
  state: 'declining',
  autoBid: { on: true, why: 'auto-bid runs' },
  campaign: { liveWrites: true, floored: null, holder: null, performance: false, research: true, hero: false, ...campaign },
  servedBy: { bidCents: 50, live: true, suppressed: false, personSet: false },
  targetAcosPct: 30,
  band: { minBidCents: 10, maxBidCents: 100 },
  hero: { exists: null, refusal: null },
  ...over,
})
const step = (f: LadderFacts) => winnerLadder(f).nextStep

describe('winnerLadder — bid, then placement, then a campaign of its own', () => {
  it('a winner is kept where it is: no step at all', () => {
    expect(winnerLadder(facts({ state: 'winning' }))).toEqual({ nextStep: 'none', why: expect.stringMatching(/^winning where it runs: it stays there/), ladder: [] })
    expect(winnerLadder(facts({ state: 'unproven' })).ladder).toEqual([])
  })

  it('bid first: auto-bid already moves it, inside the band', () => {
    const l = winnerLadder(facts())
    expect(l.nextStep).toBe('bid')
    expect(l.ladder.map((x) => [x.step, x.open])).toEqual([['bid', true], ['placement', true], ['ownCampaign', true]])
  })

  it('auto-bid cannot move it → placement on a research slot; each blocker says why', () => {
    const blocked: Array<[Partial<LadderFacts>, Partial<LadderFacts['campaign']>, RegExp]> = [
      [{ autoBid: { on: false, why: 'auto-bid is switched off for this business' } }, {}, /switched off/],
      [{}, { floored: 'user:u-1' }, /at a floor \(user:u-1\)/],
      [{}, { holder: 'pinned' }, /a pin holds its bids/],
      [{}, { holder: 'goalPlan' }, /a goal plan holds/],
      [{ servedBy: null }, {}, /cannot tell which keyword/],
      [{ servedBy: { bidCents: 50, live: false, suppressed: false, personSet: false } }, {}, /not live at Amazon/],
      [{ servedBy: { bidCents: 50, live: true, suppressed: true, personSet: false } }, {}, /keyword that serves it is at a floor/],
      [{ servedBy: { bidCents: 50, live: true, suppressed: false, personSet: true } }, {}, /a person set its bid/],
      [{ targetAcosPct: null }, {}, /no target ACoS you set/],
      [{ servedBy: { bidCents: 100, live: true, suppressed: false, personSet: false } }, {}, /strategy's highest bid: auto-bid cannot raise it/],
      [{ servedBy: { bidCents: 10, live: true, suppressed: false, personSet: false } }, {}, /strategy's lowest bid: auto-bid cannot lower it/],
    ]
    for (const [over, campaign, why] of blocked) {
      const l = winnerLadder(facts(over, campaign))
      expect(l.nextStep).toBe('placement')
      expect(l.ladder[0]).toMatchObject({ step: 'bid', open: false, why: expect.stringMatching(why) })
      expect(l.ladder[1].why).toMatch(/set-placement-multipliers/)
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
    // An hourly plan holds it even while auto-bid is on: auto-bid leaves it (bid closed), and nothing else is proposed.
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

describe('winnerLadder — PB-6c handover B: the old place of a term with its own campaign', () => {
  const own = (proven: boolean) => ({ exists: { key: 'hero:x', campaignName: 'T | IT | Hero | x', proven }, refusal: null })
  it('the hero proven → old place to be closed, whatever the old place\'s own state', () => {
    for (const state of ['winning', 'declining', 'lost'] as const) {
      const l = winnerLadder(facts({ state, hero: own(true) }, { research: false }))
      expect(l).toMatchObject({ nextStep: 'closeOldPlace', ladder: [] })
      expect(l.why).toMatch(/^hero proven → old place to be closed: its own campaign \("T \| IT \| Hero \| x"\) meets the harvest bar/)
    }
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
