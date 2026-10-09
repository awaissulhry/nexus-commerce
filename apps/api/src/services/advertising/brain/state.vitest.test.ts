/**
 * ONE BRAIN AB-12 — the state lever, pure (brain/state.ts): the stop's horizon from its cause, the pause for a stop of
 * 3 days or more and never for a shorter one, the resume when every cause has ended (back to the status before, nothing
 * else touched), no flip-flop, the holds (the brain never resumes a pause it did not make; anyone's status change holds
 * 60 days), archive only ever as a proposal, the Owner's lock / exclusion / levels, and the day's cap.
 * Values are made up (public repo).
 */
import { describe, expect, it } from 'vitest'
import {
  coreStateDecision, decideState, declaredStop, monthlyCapStop, nextMonthStart, playbookStop, productRestock, stateDecisionHash, stateRowKind, stockStop, stopHorizon,
  MAX_PAUSES_PER_MARKET_DAY, type StateContext, type StateFacts, type StockGroupFacts, type StopCause,
} from './state.js'

const NOW = new Date('2026-10-08T12:00:00Z')
const H = 3_600_000
const D = 86_400_000
const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * H)
const inDays = (days: number) => new Date(NOW.getTime() + days * D)

const STOP_MEMORY = { savedPlacements: [{ placement: 'PLACEMENT_TOP', percentage: 50 }], savedStrategy: 'AUTO_FOR_SALES', biddingStrategy: 'LEGACY_FOR_SALES', flooredKeywords: 4, floorBy: 'automation:budget-manager' }
const stockLong: StopCause = { cause: 'stock', endsAt: inDays(10), source: 'restock_date', words: 'out of stock (1 product): the first back — JACKET-M back on 2026-10-18' }
const capShort: StopCause = { cause: 'monthly_cap', endsAt: inDays(2), source: 'month_end', words: 'the month\'s spend cap stopped it' }
const playbookOpen: StopCause = { cause: 'playbook', endsAt: null, source: 'open', words: 'a playbook STOP (Jacket IT)' }

function facts(over: Partial<StateFacts> = {}): StateFacts {
  return {
    campaignId: 'c1', name: 'Jacket exact', productId: 'jacket', market: 'IT', status: 'ENABLED', owner: 'product',
    lever: { effective: 'AUTO', why: 'AUTO by the Owner\'s product override (user:owner, 2026-10-08)' },
    pauseMinDays: 3, archiveDeadWeeks: 4, causes: [], stockNotRecovered: false, stopSince: null, lastStatusChange: null,
    memory: null, stopMemory: STOP_MEMORY, asked: null, impressions: 500, ageDays: 200, ...over,
  }
}
const CTX: StateContext = { now: NOW, ceilingLive: true, posture: { posture: 'auto', why: 'the account ads dial is AUTO' }, pausesLeft: { acting: 3, shadow: 3 } }
const ctx = (over: Partial<StateContext> = {}): StateContext => ({ ...CTX, ...over })
/** The brain's own AUTO pause, `hoursAgo` hours ago, for `causes`. */
const brainPaused = (hoursAgo: number, causes: StateFacts['causes'] = [], memoryCauses: Array<'stock' | 'monthly_cap' | 'playbook' | 'declared' | 'dead'> = ['stock']): Partial<StateFacts> => ({
  status: 'PAUSED', causes,
  lastStatusChange: { to: 'PAUSED', at: at(hoursAgo), by: 'brain', who: 'automation:ads-brain-state', via: 'auto', approvalId: null },
  memory: { pausedAt: at(hoursAgo).toISOString(), via: 'auto', approvalId: null, statusBefore: 'ENABLED', causes: memoryCauses, expectedEndAt: null, stop: STOP_MEMORY },
})

describe('horizons — how long a stop lasts, from its cause', () => {
  const product = (over: Record<string, unknown> = {}) => ({ productId: 'p1', sku: 'JACKET-M', units: 0, inboundUnits: 0, leadTimeDays: null, arrivalAt: null, ...over })

  it('a product\'s restock: a dated arrival, an overdue or undated one (any day), the lead time (the forecast), or nothing (open)', () => {
    expect(productRestock(product({ arrivalAt: inDays(10), arrivalFrom: 'purchase_order' }), NOW)).toMatchObject({ source: 'restock_date', endsAt: inDays(10), words: expect.stringMatching(/a purchase order's date/) })
    expect(productRestock(product({ arrivalAt: inDays(-2) }), NOW)).toMatchObject({ source: 'soon', endsAt: null, words: expect.stringMatching(/has not arrived/) })
    expect(productRestock(product({ inboundUnits: 20 }), NOW)).toMatchObject({ source: 'soon', words: expect.stringMatching(/20 units inbound with no date/) })
    expect(productRestock(product({ leadTimeDays: 30 }), NOW)).toMatchObject({ source: 'forecast', endsAt: inDays(30) })
    expect(productRestock(product(), NOW)).toMatchObject({ source: 'open', endsAt: null })
  })

  it('a campaign is stopped by stock only when every enabled ad group with an ad is out; the first product back ends it', () => {
    const out = (products: Array<Record<string, unknown>>, over: Partial<StockGroupFacts> = {}): StockGroupFacts => ({ status: 'ENABLED', risk: 'out-of-stock', recovered: false, products: products.map((p) => product(p)), ...over })
    // Two products: one back in 12 days (dated), one in 20 days (its lead time) → the first back: 12 days.
    const two = stockStop([out([{ productId: 'p1', arrivalAt: inDays(12) }]), out([{ productId: 'p2', leadTimeDays: 20 }])], NOW)
    expect(two).toMatchObject({ stopped: true, notRecovered: true, cause: { cause: 'stock', source: 'restock_date', endsAt: inDays(12) } })
    // One that may land any day makes the whole stop "soon".
    expect(stockStop([out([{ productId: 'p1', arrivalAt: inDays(12) }, { productId: 'p2', inboundUnits: 5 }])], NOW).cause).toMatchObject({ source: 'soon' })
    // Nothing coming and no lead time: open-ended.
    expect(stockStop([out([{ productId: 'p1' }])], NOW).cause).toMatchObject({ source: 'open' })
    // An ad group still selling, an ad Nexus cannot tie, a paused ad group's verdict: no stock stop.
    expect(stockStop([out([{ productId: 'p1' }]), out([], { risk: 'ok', recovered: true })], NOW)).toMatchObject({ stopped: false, notRecovered: false, cause: null })
    expect(stockStop([out([{ productId: 'p1' }]), out([], { risk: 'unknown' })], NOW).stopped).toBe(false)
    expect(stockStop([out([{ productId: 'p1' }], { status: 'PAUSED' }), out([], { risk: 'ok' })], NOW).stopped).toBe(false)
    // Back in stock but under its restart line: no stop, yet not recovered (what a pause for stock waits for).
    expect(stockStop([out([], { risk: 'low-stock', recovered: false })], NOW)).toMatchObject({ stopped: false, notRecovered: true })
    expect(stockStop([], NOW)).toMatchObject({ stopped: false, notRecovered: false })
  })

  it('the month\'s cap lifts on the 1st (UTC month); only budget enforcement\'s floor or declared stop is one', () => {
    expect(nextMonthStart(new Date('2026-12-20T10:00:00Z'))).toEqual(new Date('2027-01-01T00:00:00Z'))
    expect(monthlyCapStop({ by: 'automation:budget-manager', at: at(30) }, [], NOW)).toMatchObject({ cause: 'monthly_cap', source: 'month_end', endsAt: new Date('2026-11-01T00:00:00Z') })
    expect(monthlyCapStop({ by: 'automation:retail-guard', at: at(30) }, ['automation:budget-manager'], NOW)).toMatchObject({ cause: 'monthly_cap' })
    expect(monthlyCapStop({ by: 'automation:retail-guard', at: at(30) }, [], NOW)).toBeNull()
    expect(monthlyCapStop({ by: 'automation:budget-manager', at: null }, [], NOW)).toBeNull()
  })

  it('a playbook STOP is open-ended; the Owner\'s long stop runs through its day', () => {
    expect(playbookStop('Jacket IT')).toMatchObject({ cause: 'playbook', source: 'open', endsAt: null })
    expect(playbookStop(null)).toBeNull()
    expect(declaredStop('2026-10-20', NOW)).toMatchObject({ cause: 'declared', endsAt: new Date('2026-10-21T00:00:00Z') })
    expect(declaredStop('2026-10-07', NOW)).toBeNull()
    expect(declaredStop(null, NOW)).toBeNull()
    expect(declaredStop('soon', NOW)).toBeNull()
  })

  it('the stop lasts until every cause has ended: open wins, else the latest end; long from pauseMinDays days', () => {
    expect(stopHorizon([], NOW, 3)).toEqual({ kind: 'none' })
    expect(stopHorizon([capShort, playbookOpen], NOW, 3)).toMatchObject({ kind: 'open', cause: { cause: 'playbook' } })
    expect(stopHorizon([capShort, stockLong], NOW, 3)).toMatchObject({ kind: 'long', cause: { cause: 'stock' }, hours: 240 })
    expect(stopHorizon([capShort], NOW, 3)).toMatchObject({ kind: 'short', hours: 48 })
    expect(stopHorizon([stockLong], NOW, 14)).toMatchObject({ kind: 'short' })
    expect(stopHorizon([{ ...stockLong, endsAt: null, source: 'soon' }], NOW, 3)).toMatchObject({ kind: 'soon' })
  })
})

describe('pause — a stop of 3 days or more, never a shorter one', () => {
  it('a long stop at AUTO: paused by the brain, its memory the status before and the stop recipe\'s memory as it is', () => {
    const d = decideState(facts({ causes: [stockLong] }), CTX)
    expect(d).toMatchObject({ action: 'pause', mode: 'LIVE', outcome: 'write', to: 'PAUSED', cause: 'stock', horizonHours: 240, expectedEndAt: inDays(10).toISOString() })
    expect(d.startsMemory).toEqual({ pausedAt: NOW.toISOString(), via: 'auto', approvalId: null, statusBefore: 'ENABLED', causes: ['stock'], expectedEndAt: inDays(10).toISOString(), stop: STOP_MEMORY })
    // Nothing of the brain's is paused yet: no pause in force to carry.
    expect(d.memory).toBeNull()
    expect(d.why).toMatch(/a stop of 3 days or more is a pause \(D4\); it resumes when the stop ends, and the stop's memory \(4 keyword bids remembered, the lanes saved, the AUTO_FOR_SALES strategy saved\) stays as it is/)
  })

  it('a short stop stays on the stop recipe at 3¢ — never a pause; the Owner\'s longer threshold wins', () => {
    const d = decideState(facts({ causes: [capShort] }), CTX)
    expect(d).toMatchObject({ action: 'keep', outcome: 'none', to: null, memory: null, startsMemory: null })
    expect(d.why).toMatch(/a short stop .*: low bids hold it \(the stop recipe where the bid brain runs the campaign, else the floor of the stop's owner\) — never a pause$/)
    expect(decideState(facts({ causes: [{ ...stockLong, source: 'soon', endsAt: null }] }), CTX).action).toBe('keep')
    expect(decideState(facts({ causes: [stockLong], pauseMinDays: 14 }), CTX).action).toBe('keep')
  })

  it('an open-ended stop pauses once it has held 24 hours (first seen now: the recipe holds it meanwhile)', () => {
    expect(decideState(facts({ causes: [playbookOpen] }), CTX)).toMatchObject({ action: 'keep', stopSince: NOW.toISOString() })
    expect(decideState(facts({ causes: [playbookOpen], stopSince: at(10) }), CTX)).toMatchObject({ action: 'keep', stopSince: at(10).toISOString() })
    expect(decideState(facts({ causes: [playbookOpen], stopSince: at(25) }), CTX)).toMatchObject({ action: 'pause', cause: 'playbook', expectedEndAt: null })
  })

  it('the Owner\'s long stop (longStopUntil) is a pause; a declared stop of 2 days is not', () => {
    expect(decideState(facts({ causes: [declaredStop('2026-10-20', NOW)!] }), CTX)).toMatchObject({ action: 'pause', cause: 'declared' })
    expect(decideState(facts({ causes: [declaredStop('2026-10-09', NOW)!] }), CTX)).toMatchObject({ action: 'keep' })
  })
})

describe('resume — when every cause has ended, back to what was there', () => {
  it('the brain\'s own pause, its cause gone, 30 h on: resumed to ENABLED — the stop\'s memory left to its owner', () => {
    const d = decideState(facts(brainPaused(30)), CTX)
    expect(d).toMatchObject({ action: 'resume', mode: 'LIVE', outcome: 'write', to: 'ENABLED', liftsAutomationPause: true })
    expect(d.memory?.stop).toEqual(STOP_MEMORY)
    expect(d.why).toMatch(/back to ENABLED, as before the pause on 2026-10-07\. The pause changed nothing else: the stop's memory \(4 keyword bids remembered, the lanes saved, the AUTO_FOR_SALES strategy saved\) is given back by its owner as the stop ends/)
  })

  it('a cause still on keeps it paused (the memory carried, its causes grown); stock waits for the restart line', () => {
    const on = decideState(facts(brainPaused(30, [capShort])), CTX)
    expect(on).toMatchObject({ action: 'keep', outcome: 'none' })
    expect(on.memory?.causes).toEqual(['stock', 'monthly_cap'])
    expect(on.why).toMatch(/the stop goes on/)
    const low = decideState(facts({ ...brainPaused(30), stockNotRecovered: true }), CTX)
    expect(low).toMatchObject({ action: 'keep' })
    expect(low.why).toMatch(/not above their restart line yet/)
    // A stop that was never about stock does not wait for it.
    expect(decideState(facts({ ...brainPaused(30, [], ['monthly_cap']), stockNotRecovered: true }), CTX).action).toBe('resume')
  })

  it('a pause a request made (a person approved it) is the brain\'s too: resumed without lifting an automation\'s pause', () => {
    const viaRequest = brainPaused(30)
    const d = decideState(facts({ ...viaRequest, memory: { ...viaRequest.memory!, via: 'request', approvalId: 'ap-1' } }), CTX)
    expect(d).toMatchObject({ action: 'resume' })
    expect(d.liftsAutomationPause).toBeUndefined()
  })
})

describe('hysteresis — no flip-flop', () => {
  it('a pause stands 24 hours before the brain resumes it', () => {
    const d = decideState(facts(brainPaused(10)), CTX)
    expect(d).toMatchObject({ action: 'keep', outcome: 'none' })
    expect(d.why).toMatch(/it was paused 10 h ago: it resumes once the pause has stood 24 h/)
  })

  it('a campaign the brain resumed serves 24 hours before another pause', () => {
    const resumed = { to: 'ENABLED', by: 'brain' as const, who: 'automation:ads-brain-state', via: 'auto' as const }
    expect(decideState(facts({ causes: [stockLong], lastStatusChange: { ...resumed, at: at(5) } }), CTX)).toMatchObject({ action: 'keep' })
    expect(decideState(facts({ causes: [stockLong], lastStatusChange: { ...resumed, at: at(30) } }), CTX)).toMatchObject({ action: 'pause' })
  })

  it('the brain\'s own pause or resume that did not land (refused at dispatch, failed at Amazon) waits 24 hours — no loop against Amazon', () => {
    const missedPause = decideState(facts({ causes: [stockLong], brainMiss: { to: 'PAUSED', at: at(3), result: 'SKIPPED' } }), CTX)
    expect(missedPause).toMatchObject({ action: 'keep', outcome: 'none' })
    expect(missedPause.why).toMatch(/but the brain's pause at 09:00 UTC did not land \(SKIPPED\): it tries again 24 h after it; meanwhile low bids hold it/)
    expect(decideState(facts({ causes: [stockLong], brainMiss: { to: 'PAUSED', at: at(25), result: 'FAILED' } }), CTX).action).toBe('pause')
    const missedResume = decideState(facts({ ...brainPaused(40), brainMiss: { to: 'ENABLED', at: at(2), result: 'FAILED' } }), CTX)
    expect(missedResume).toMatchObject({ action: 'keep', why: expect.stringMatching(/^the stop has ended, but the brain's resume at 10:00 UTC did not land \(FAILED\)/) })
    expect(missedResume.memory).not.toBeNull()
  })

  it('a refusal is logged once a UTC day (its hash names the day); an unchanged decision writes no row, a carried pause one a day', () => {
    const d = decideState(facts({ causes: [stockLong] }), CTX)
    expect(stateDecisionHash({ ...d, outcome: 'queued' })).toBe(stateDecisionHash({ ...d, outcome: 'queued' }))
    expect(stateDecisionHash({ ...d, outcome: 'refused', refusedOn: '2026-10-08' })).not.toBe(stateDecisionHash({ ...d, outcome: 'refused', refusedOn: '2026-10-09' }))
    const hash = stateDecisionHash({ ...d, outcome: 'queued' })
    expect(stateRowKind(hash, false, undefined, NOW)).toBe('change')
    expect(stateRowKind(hash, true, { decisionHash: hash, createdAt: at(2) }, NOW)).toBeNull()
    expect(stateRowKind(hash, true, { decisionHash: hash, createdAt: at(24) }, NOW)).toBe('snapshot')
    expect(stateRowKind(hash, false, { decisionHash: hash, createdAt: at(24) }, NOW)).toBeNull()
    expect(stateRowKind(hash, false, { decisionHash: 'other', createdAt: at(1) }, NOW)).toBe('change')
  })
})

describe('holds — the brain pauses only what serves, and resumes only its own pause', () => {
  it('a person\'s pause is never resumed, whatever the stop does', () => {
    const d = decideState(facts({ status: 'PAUSED', lastStatusChange: { to: 'PAUSED', at: at(48), by: 'person', who: 'user:owner' } }), CTX)
    expect(d).toMatchObject({ action: 'hold', outcome: 'none', to: null })
    expect(d.why).toMatch(/paused by a person \(user:owner\) on 2026-10-06: a pause the brain did not make is a hold — it never resumes it/)
    // Paused outside any record Nexus keeps: never resumed either.
    expect(decideState(facts({ status: 'PAUSED' }), CTX)).toMatchObject({ action: 'hold' })
  })

  it('a person\'s (or Amazon\'s) status change holds 60 days: no pause meanwhile, then the brain decides again', () => {
    const enabled = (by: 'person' | 'outside' | 'automation', hoursAgo: number) => facts({ causes: [stockLong], lastStatusChange: { to: 'ENABLED', at: at(hoursAgo), by, who: by === 'person' ? 'user:owner' : 'automation:cr1' } })
    for (const by of ['person', 'outside', 'automation'] as const) {
      const d = decideState(enabled(by, 24 * 10), CTX)
      expect(d, by).toMatchObject({ action: 'hold', hold: expect.stringMatching(/set it ENABLED on 2026-09-28: a hold until 2026-11-27/) })
    }
    expect(decideState(enabled('person', 24 * 61), CTX).action).toBe('pause')
  })

  it('a shared campaign is no brain\'s; an archived one has nothing to decide', () => {
    expect(decideState(facts({ owner: 'shared', causes: [stockLong] }), CTX)).toMatchObject({ action: 'skip', why: expect.stringMatching(/D2 = A/) })
    expect(decideState(facts({ status: 'ARCHIVED' }), CTX)).toMatchObject({ action: 'skip' })
  })
})

describe('dead — paused, never archived (the Owner, 2026-10-09)', () => {
  const dead = { impressions: 0, ageDays: 60 }

  it('no impression for 4 weeks while enabled: paused alone at AUTO, asked at PROPOSE, logged at OBSERVE — never an archive', () => {
    const auto = decideState(facts({ ...dead, lever: { effective: 'AUTO', why: 'AUTO' } }), CTX)
    expect(auto).toMatchObject({ action: 'pause', mode: 'LIVE', outcome: 'write', to: 'PAUSED', cause: 'dead' })
    expect(auto.startsMemory).toMatchObject({ causes: ['dead'], expectedEndAt: null })
    expect(auto.why).toMatch(/paused, never archived/)
    expect(decideState(facts({ ...dead, lever: { effective: 'PROPOSE', why: 'PROPOSE' } }), CTX)).toMatchObject({ action: 'pause', mode: 'PROPOSE', outcome: 'ask', to: 'PAUSED' })
    expect(decideState(facts({ ...dead, lever: { effective: 'OBSERVE', why: 'OBSERVE' } }), CTX)).toMatchObject({ action: 'pause', mode: 'SHADOW', outcome: 'shadow' })
    // It counts in the day's pauses like any other.
    expect(decideState(facts(dead), ctx({ pausesLeft: { acting: 0, shadow: 3 } }))).toMatchObject({ action: 'pause', outcome: 'capped' })
  })

  it('not judged without the report, too young, in a stop, or held; a campaign already paused stays as it is', () => {
    expect(decideState(facts({ impressions: null, ageDays: 60 }), CTX).action).toBe('keep')
    expect(decideState(facts({ impressions: 0, ageDays: 20 }), CTX).action).toBe('keep')
    expect(decideState(facts({ ...dead, causes: [stockLong] }), CTX)).toMatchObject({ action: 'pause', cause: 'stock' })
    expect(decideState(facts({ ...dead, status: 'PAUSED', lastStatusChange: { to: 'PAUSED', at: at(24 * 10), by: 'person', who: 'user:owner' } }), CTX).action).toBe('hold')
    expect(decideState(facts({ ...dead, status: 'PAUSED', lastStatusChange: { to: 'PAUSED', at: at(24 * 90), by: 'person', who: 'user:owner' } }), CTX)).toMatchObject({ action: 'hold', outcome: 'none' })
  })

  it('the brain never switches a campaign it paused for no impressions on again — a person does', () => {
    const d = decideState(facts({ ...dead, ...brainPaused(24 * 30, [], ['dead']) }), CTX)
    expect(d).toMatchObject({ action: 'keep', cause: 'dead', to: null })
    expect(d.memory).toMatchObject({ causes: ['dead'] })
    expect(d.why).toMatch(/stays paused, never archived; the brain never switches it on again \(a person does: enable-ads\)/)
  })
})

describe('levels and the Owner', () => {
  const at_ = (effective: string, over: Partial<StateFacts> = {}, c: Partial<StateContext> = {}) => decideState(facts({ causes: [stockLong], lever: { effective, why: `${effective} — the lever's why` }, ...over }), ctx(c))

  it('OFF, not enrolled, excluded: nothing — today\'s engines run it', () => {
    for (const level of ['OFF', 'NOT_ENROLLED', 'EXCLUDED']) expect(at_(level), level).toMatchObject({ action: 'skip', outcome: 'none', why: `${level} — the lever's why` })
  })

  it('the Owner\'s lock: nothing written, the recommendation only', () => {
    const d = at_('LOCKED')
    // The recommendation carries no memory: a pause that never happened is never read back as the brain's.
    expect(d).toMatchObject({ action: 'hold', outcome: 'held', wouldDo: 'pause', memory: null })
    expect(d.why).toMatch(/^LOCKED — the lever's why — the brain would pause it: /)
  })

  it('OBSERVE logs; PROPOSE asks (a pause asked for becomes the brain\'s once approved); AUTO writes', () => {
    expect(at_('OBSERVE')).toMatchObject({ action: 'pause', mode: 'SHADOW', outcome: 'shadow', why: expect.stringMatching(/^SHADOW \(OBSERVE\) — would pause/) })
    const asked = at_('PROPOSE')
    expect(asked).toMatchObject({ action: 'pause', mode: 'PROPOSE', outcome: 'ask' })
    expect(asked.startsMemory?.via).toBe('request')
    expect(asked.memory).toBeNull()
    expect(at_('AUTO')).toMatchObject({ mode: 'LIVE', outcome: 'write' })
  })

  it('AUTO writes only under the live server switch and while the account\'s ads automation runs', () => {
    expect(at_('AUTO', {}, { ceilingLive: false })).toMatchObject({ mode: 'SHADOW', outcome: 'shadow', why: expect.stringMatching(/NEXUS_BID_BRAIN_MODE\) is not live: SHADOW/) })
    expect(at_('AUTO', {}, { posture: { posture: 'stopped', why: 'halted: test' } })).toMatchObject({ mode: 'LIVE', outcome: 'held', why: expect.stringMatching(/not running \(halted: test\): nothing written now/) })
  })

  it('a resume at PROPOSE of the brain\'s own AUTO pause is asked with the lift of an automation\'s pause', () => {
    const d = decideState(facts({ ...brainPaused(30), lever: { effective: 'PROPOSE', why: 'PROPOSE' } }), CTX)
    // Batch 2 fix — the brain's own resume is Nexus's own request: a person's normal approval lifts it (ads-status.tools.ts).
    expect(d).toMatchObject({ action: 'resume', outcome: 'ask', liftsAutomationPause: true, why: expect.stringMatching(/the brain paused it alone: its own resume, a person's normal approval lifts it/) })
  })

  it('a pause the brain made, its lever no longer PROPOSE or AUTO: a person is told it will not be resumed', () => {
    for (const level of ['OBSERVE', 'OFF', 'LOCKED', 'EXCLUDED']) {
      const d = decideState(facts({ ...brainPaused(30), lever: { effective: level, why: level } }), CTX)
      expect(d.attention, level).toMatch(/the brain paused it on 2026-10-07 and its state lever is .* now: the brain will not resume it — enable-ads, or the lever back to PROPOSE or AUTO, does/)
      expect(d.memory, level).not.toBeNull()
    }
    expect(decideState(facts(brainPaused(30)), CTX).attention).toBeNull()
  })

  it('the state lever writes the status only: a pause, a resume — never an archive, nothing else', () => {
    const tos = [decideState(facts({ causes: [stockLong] }), CTX), decideState(facts(brainPaused(30)), CTX), decideState(facts({ impressions: 0, ageDays: 60 }), CTX)].map((d) => d.to)
    expect(tos).toEqual(['PAUSED', 'ENABLED', 'PAUSED'])
    expect(coreStateDecision(facts(), NOW)).toMatchObject({ wouldDo: 'keep', to: null, why: 'serving: no stop holds it' })
  })
})

describe('caps — at most 3 pauses a day per market', () => {
  it('the 4th pause of the day waits for the next UTC day; the shadow counts its own', () => {
    expect(MAX_PAUSES_PER_MARKET_DAY).toBe(3)
    expect(decideState(facts({ causes: [stockLong] }), ctx({ pausesLeft: { acting: 0, shadow: 3 } }))).toMatchObject({ action: 'pause', outcome: 'capped', why: expect.stringMatching(/3 pauses a day is the most in IT/) })
    expect(decideState(facts({ causes: [stockLong], lever: { effective: 'OBSERVE', why: '' } }), ctx({ pausesLeft: { acting: 0, shadow: 1 } }))).toMatchObject({ outcome: 'shadow' })
    expect(decideState(facts({ causes: [stockLong], lever: { effective: 'OBSERVE', why: '' } }), ctx({ pausesLeft: { acting: 3, shadow: 0 } }))).toMatchObject({ outcome: 'capped' })
    // A campaign the shadow already counts as paused takes no new slot.
    expect(decideState(facts({ causes: [stockLong], lever: { effective: 'OBSERVE', why: '' }, shadowPaused: true }), ctx({ pausesLeft: { acting: 3, shadow: 0 } }))).toMatchObject({ outcome: 'shadow' })
    // A resume is never capped.
    expect(decideState(facts(brainPaused(30)), ctx({ pausesLeft: { acting: 0, shadow: 0 } }))).toMatchObject({ action: 'resume', outcome: 'write' })
  })
})
