/**
 * Bid page (BAPI) — the pure half of GET /api/advertising/bids: one owner per bid (every precedence case), the night
 * floor folded away, the brain's hold, the 7-day line and who wrote a change. Made-up values.
 */
import { describe, expect, it } from 'vitest'
import {
  authorOf, brainHeldBy, collapseBidChanges, isNightFloor, ownerMatches, resolveBidOwner, sparkOf,
  rulesWritingOn, writersOf, writesBids, type BidChange, type BidOwnerFacts,
} from './bid-owner.js'

const facts = (over: Partial<BidOwnerFacts> = {}): BidOwnerFacts => ({
  pinned: false, personHold: false, allowlisted: true, running: true, brain: null, rules: [], plan: null, engine: null, ...over,
})
const RULE = { id: 'r1', name: 'Lower bids on waste' }
const RULE2 = { id: 'r2', name: 'Raise winners' }
const PLAN = { id: 'g1', name: 'Jacket plan' }
const AUTO_BID = { id: 'auto-bid', name: 'Auto-bid', leavesPersonBids: true }
const AUTOPILOT = { id: 'ap1', name: 'Jacket autopilot', leavesPersonBids: false }
const everything = { brain: { stopped: false }, rules: [RULE], plan: PLAN, engine: AUTO_BID }
const one = (kind: string, name: string, id: string | null) => ({ kind, name, id, contested: false, alsoWrites: [] })
const YOU = one('PERSON', 'You', 'you')
const NOBODY = one('NONE', 'Nobody', null)

describe('resolveBidOwner — one owner, the writer that really writes the bid most; a second writer is said', () => {
  it('a pin: the person, over every writer', () => {
    expect(resolveBidOwner(facts({ pinned: true, ...everything }))).toEqual(YOU)
    expect(resolveBidOwner(facts({ pinned: true, allowlisted: false }))).toEqual(YOU)
  })

  it('off the allowlist or not running: no automatic writer reaches it — nobody, or the person who holds it', () => {
    expect(resolveBidOwner(facts({ allowlisted: false, ...everything }))).toEqual(NOBODY)
    expect(resolveBidOwner(facts({ running: false, ...everything }))).toEqual(NOBODY)
    expect(resolveBidOwner(facts({ allowlisted: false, personHold: true, ...everything }))).toEqual(YOU)
    expect(resolveBidOwner(facts({ running: false, personHold: true }))).toEqual(YOU)
  })

  it('the brain owns the campaign: the one writer (the gate refuses the rest, a rule becomes its input); a person\'s hold over it', () => {
    expect(resolveBidOwner(facts(everything))).toEqual(one('BRAIN', 'Brain', 'brain'))
    expect(resolveBidOwner(facts({ ...everything, personHold: true }))).toEqual(YOU)
    expect(resolveBidOwner(facts({ brain: { stopped: true } }))).toEqual(one('BRAIN', 'Brain · stopped', 'brain'))
  })

  it('an hourly plan writes most (every tick): it owns over a rule and an engine, and the others are said', () => {
    expect(resolveBidOwner(facts({ plan: PLAN, rules: [RULE] }))).toEqual({
      kind: 'PLAN', name: 'Jacket plan', id: 'g1', contested: true, alsoWrites: [{ kind: 'RULE', name: 'Lower bids on waste', id: 'r1' }],
    })
    expect(resolveBidOwner(facts({ plan: PLAN }))).toEqual(one('PLAN', 'Jacket plan', 'g1'))
    expect(resolveBidOwner(facts({ plan: PLAN, personHold: true }))).toEqual(one('PLAN', 'Jacket plan', 'g1'))
  })

  it('an engine over a rule; auto-bid does not leave a bid a rule set, so both are said', () => {
    expect(resolveBidOwner(facts({ engine: AUTO_BID, rules: [RULE, RULE2] }))).toEqual({
      kind: 'ENGINE', name: 'Auto-bid', id: 'auto-bid', contested: true,
      alsoWrites: [{ kind: 'RULE', name: 'Lower bids on waste', id: 'r1' }, { kind: 'RULE', name: 'Raise winners', id: 'r2' }],
    })
    expect(resolveBidOwner(facts({ engine: AUTOPILOT, personHold: true }))).toEqual(one('ENGINE', 'Jacket autopilot', 'ap1'))
  })

  it('a rule at Auto writes over a person\'s hold; auto-bid leaves the hold, so it is no second writer then', () => {
    expect(resolveBidOwner(facts({ rules: [RULE] }))).toEqual(one('RULE', 'Lower bids on waste', 'r1'))
    expect(resolveBidOwner(facts({ rules: [RULE], engine: AUTO_BID, personHold: true }))).toEqual(one('RULE', 'Lower bids on waste', 'r1'))
    expect(resolveBidOwner(facts({ rules: [RULE, RULE2] }))).toMatchObject({ kind: 'RULE', id: 'r1', contested: true, alsoWrites: [{ kind: 'RULE', id: 'r2' }] })
  })

  it('a person\'s hold over auto-bid, which leaves it; auto-bid alone; nobody', () => {
    expect(resolveBidOwner(facts({ engine: AUTO_BID, personHold: true }))).toEqual(YOU)
    expect(resolveBidOwner(facts({ personHold: true }))).toEqual(YOU)
    expect(resolveBidOwner(facts({ engine: AUTO_BID }))).toEqual(one('ENGINE', 'Auto-bid', 'auto-bid'))
    expect(resolveBidOwner(facts())).toEqual(NOBODY)
  })

  it('owner= matches a kind in any case, or an owner\'s id', () => {
    const rule = one('RULE', 'x', 'r1') as never
    expect(ownerMatches(rule, undefined)).toBe(true)
    expect(ownerMatches(rule, 'rule')).toBe(true)
    expect(ownerMatches(rule, 'RULE')).toBe(true)
    expect(ownerMatches(rule, 'r1')).toBe(true)
    expect(ownerMatches(rule, 'BRAIN')).toBe(false)
    expect(ownerMatches(rule, 'r2')).toBe(false)
  })
})

describe('resolveBidOwner with what wrote the bid in 7 days — never a contradiction with the last change', () => {
  const tally = (kind: string, name: string, id: string | null, writes: number, lastAt: string) => ({ kind, name, id, writes, lastAt }) as never
  const SEED = { kind: 'RULE', name: 'Seed — lower bids', id: 'r-seed' }
  it('the audit case: an Ask-me rule\'s approved ask is the only writer; auto-bid only configured — the rule owns it, auto-bid is said', () => {
    expect(resolveBidOwner(facts({ engine: AUTO_BID }), [tally('RULE', SEED.name, SEED.id, 1, '2026-01-09T06:00:00.000Z')])).toEqual({
      ...SEED, contested: true, alsoWrites: [{ kind: 'ENGINE', name: 'Auto-bid', id: 'auto-bid' }],
    })
  })

  it('the one that writes most owns it; a tie goes to the most recent; one that wrote but cannot now is still said', () => {
    const plan = tally('PLAN', 'Jacket plan', 'g1', 3, '2026-01-09T06:00:00.000Z')
    const rule = tally('RULE', 'Lower bids on waste', 'r1', 3, '2026-01-09T08:00:00.000Z')
    expect(resolveBidOwner(facts({ plan: PLAN, rules: [RULE] }), [plan, rule])).toMatchObject({ kind: 'RULE', id: 'r1', alsoWrites: [{ kind: 'PLAN', id: 'g1' }] })
    expect(resolveBidOwner(facts({ plan: PLAN, rules: [RULE] }), [tally('PLAN', 'Jacket plan', 'g1', 4, '2026-01-09T06:00:00.000Z'), rule])).toMatchObject({ kind: 'PLAN', alsoWrites: [{ kind: 'RULE', id: 'r1' }] })
    // The brain owns the campaign now: auto-bid's writes before it are said, not the owner.
    expect(resolveBidOwner(facts({ brain: { stopped: false } }), [tally('ENGINE', 'Auto-bid', 'auto-bid', 2, '2026-01-08T06:00:00.000Z')])).toEqual({
      kind: 'BRAIN', name: 'Brain', id: 'brain', contested: true, alsoWrites: [{ kind: 'ENGINE', name: 'Auto-bid', id: 'auto-bid' }],
    })
    // A person who set the bid over a configured rule that has not written it: the person, and the rule is said.
    expect(resolveBidOwner(facts({ rules: [RULE], personHold: true }), [tally('PERSON', 'You', 'you', 1, '2026-01-09T06:00:00.000Z')])).toMatchObject({ kind: 'PERSON', contested: true, alsoWrites: [{ kind: 'RULE', id: 'r1' }] })
    // The same writer configured and in the log is one writer.
    expect(resolveBidOwner(facts({ rules: [RULE] }), [tally('RULE', RULE.name, RULE.id, 2, '2026-01-09T06:00:00.000Z')])).toEqual(one('RULE', RULE.name, RULE.id))
  })

  it('a pin, the gate closed or a paused bid: the owner stays; who wrote it in 7 days is said', () => {
    const rule = tally('RULE', RULE.name, RULE.id, 1, '2026-01-09T06:00:00.000Z')
    expect(resolveBidOwner(facts({ pinned: true }), [rule])).toEqual({ ...YOU, contested: true, alsoWrites: [{ kind: 'RULE', name: RULE.name, id: 'r1' }] })
    expect(resolveBidOwner(facts({ running: false }), [rule])).toMatchObject({ kind: 'NONE', contested: true, alsoWrites: [{ kind: 'RULE', id: 'r1' }] })
    // The person who holds it and wrote it is one writer.
    expect(resolveBidOwner(facts({ allowlisted: false, personHold: true }), [tally('PERSON', 'You', 'you', 2, '2026-01-09T06:00:00.000Z')])).toEqual(YOU)
  })

  it('a writer Nexus cannot name is never the owner: it is said after the others, or is the nobody it already reads as', () => {
    const unknown = tally('NONE', 'Unknown', null, 5, '2026-01-09T06:00:00.000Z')
    expect(resolveBidOwner(facts({ engine: AUTO_BID }), [unknown])).toEqual({
      kind: 'ENGINE', name: 'Auto-bid', id: 'auto-bid', contested: true, alsoWrites: [{ kind: 'NONE', name: 'Unknown', id: null }],
    })
    expect(resolveBidOwner(facts(), [unknown])).toEqual(NOBODY)
    expect(resolveBidOwner(facts({ personHold: true }), [unknown])).toMatchObject({ kind: 'PERSON', alsoWrites: [{ kind: 'NONE', id: null }] })
  })
})

describe('writersOf — who wrote a bid in the last 7 days, how often, and when last', () => {
  const NOW = new Date('2026-01-10T12:00:00.000Z')
  const change = (at: string, actor: string | null) => ({ at, from: 30, to: 25, actor })
  const names = { rules: new Map([['r1', 'Lower bids on waste']]), plans: new Map([['s1', { id: 'g1', name: 'Jacket plan' }]]) }
  const author = (actor: string | null) => authorOf(actor, names)
  it('one tally per writer (two people are one "You"); a change older than 7 days does not count', () => {
    expect(writersOf([
      change('2026-01-01T06:00:00.000Z', 'automation:auto-bid'),
      change('2026-01-05T06:00:00.000Z', 'user:u1'),
      change('2026-01-06T06:00:00.000Z', 'automation:r1'),
      change('2026-01-08T06:00:00.000Z', 'user:u2'),
      change('2026-01-09T06:00:00.000Z', 'automation:rank-defend-s1'),
    ], author, NOW)).toEqual([
      { kind: 'PERSON', name: 'You', id: 'you', writes: 2, lastAt: '2026-01-08T06:00:00.000Z' },
      { kind: 'RULE', name: 'Lower bids on waste', id: 'r1', writes: 1, lastAt: '2026-01-06T06:00:00.000Z' },
      { kind: 'PLAN', name: 'Jacket plan', id: 'g1', writes: 1, lastAt: '2026-01-09T06:00:00.000Z' },
    ])
    expect(writersOf([], author, NOW)).toEqual([])
  })
})

describe('rulesWritingOn — the rules that write a campaign\'s bids when they act', () => {
  it('a rank-defense raise leaves a campaign an hourly plan holds (rankOwnedSkip); every other bid action does not', () => {
    const rules = [
      { id: 'r1', name: 'Cut', actions: [{ type: 'bid_down', pct: 10 }] },
      { id: 'r2', name: 'Defend', actions: [{ type: 'raise_bids_for_rank_defense', percent: 20 }] },
      { id: 'r3', name: 'Defend and cut', actions: [{ type: 'raise_bids_for_rank_defense' }, { type: 'bid_down' }] },
    ]
    expect(rulesWritingOn(rules, { rankHeld: true }).map((r) => r.id)).toEqual(['r1', 'r3'])
    expect(rulesWritingOn(rules, { rankHeld: false }).map((r) => r.id)).toEqual(['r1', 'r2', 'r3'])
  })
})

describe('writesBids — a rule that writes bids when it acts', () => {
  it('a bid action does; a budget action and the target-ACoS setter do not; a builder rule belted to manual only asks', () => {
    expect(writesBids({ actions: [{ type: 'bid_down', pct: 10 }] })).toBe(true)
    expect(writesBids({ actions: [{ type: 'bid_to_target_acos' }] })).toBe(true)
    expect(writesBids({ actions: [{ type: 'adjust_ad_budget' }] })).toBe(false)
    expect(writesBids({ actions: [{ type: 'set_campaign_target_acos' }] })).toBe(false)
    expect(writesBids({ actions: [{ type: 'bid', control: 'automate', op: 'decreasePct', value: 15 }] })).toBe(true)
    expect(writesBids({ actions: [{ type: 'bid', control: 'manual', op: 'decreasePct', value: 15 }] })).toBe(false)
    expect(writesBids({ actions: [] })).toBe(false)
  })
})

const at = (h: number) => new Date(Date.UTC(2026, 0, 10, h)).toISOString()
const change = (h: number, from: number, to: number, actor: string | null, layer: string | null = null): BidChange => ({ at: at(h), from, to, actor, layer })
const BRAIN = 'automation:bid-brain'
const PLAN_ACTOR = 'automation:rank-defend-s1'

describe('collapseBidChanges — the night floor and its give-back are one change, or none', () => {
  it('a floor and a give-back to the same bid: no change', () => {
    const out = collapseBidChanges([change(0, 15, 2, BRAIN, 'min_bid_hour'), change(8, 2, 15, BRAIN, 'restore')])
    expect(out).toEqual({ net: [], openFloor: null })
  })

  it('a give-back to another bid: one change, from the bid before the floor, by the writer of the give-back', () => {
    const out = collapseBidChanges([change(0, 18, 2, BRAIN, 'min_bid_hour'), change(8, 2, 15, BRAIN, 'restore')])
    expect(out.net).toEqual([{ at: at(8), from: 18, to: 15, actor: BRAIN }])
  })

  it('an hourly plan\'s floor (no layer: its actor and a floor-sized bid) folds the same way', () => {
    expect(collapseBidChanges([change(0, 12, 2, PLAN_ACTOR), change(8, 2, 12, PLAN_ACTOR)]).net).toEqual([])
    expect(isNightFloor({ from: 12, to: 2, actor: PLAN_ACTOR, layer: null })).toBe(true)
    // A plan's base-bid cut that is not a floor is a change of its own.
    expect(isNightFloor({ from: 20, to: 16, actor: PLAN_ACTOR, layer: null })).toBe(false)
  })

  it('other lowerings are kept: auto-bid to a few cents, a brain stop, the money brake', () => {
    expect(isNightFloor({ from: 10, to: 4, actor: 'automation:auto-bid', layer: null })).toBe(false)
    expect(isNightFloor({ from: 10, to: 2, actor: BRAIN, layer: 'stop' })).toBe(false)
    const out = collapseBidChanges([change(1, 10, 4, 'automation:auto-bid'), change(2, 4, 2, BRAIN, 'stop')])
    expect(out.net).toHaveLength(2)
  })

  it('a floor still on: no change, and the bid it gives back; a second floor keeps the first one\'s bid', () => {
    expect(collapseBidChanges([change(0, 15, 2, BRAIN, 'min_bid_hour')])).toEqual({ net: [], openFloor: { fromCents: 15, at: at(0) } })
    const twice = collapseBidChanges([change(0, 15, 3, PLAN_ACTOR), change(2, 3, 2, PLAN_ACTOR), change(8, 2, 15, PLAN_ACTOR)])
    expect(twice).toEqual({ net: [], openFloor: null })
  })

  it('a person\'s change during the floor ends it: one change from the bid before the floor', () => {
    const out = collapseBidChanges([change(0, 15, 2, BRAIN, 'min_bid_hour'), change(3, 2, 20, 'user:u1')])
    expect(out.net).toEqual([{ at: at(3), from: 15, to: 20, actor: 'user:u1' }])
  })

  it('a give-back first in the list (its floor fell before the window) is left out; later it counts', () => {
    expect(collapseBidChanges([change(8, 2, 15, BRAIN, 'restore'), change(9, 15, 17, BRAIN, 'goal')]).net).toEqual([{ at: at(9), from: 15, to: 17, actor: BRAIN }])
    expect(collapseBidChanges([change(7, 3, 2, 'user:u1'), change(8, 2, 15, BRAIN, 'restore')]).net).toHaveLength(2)
  })
})

describe('sparkOf — the bid at this hour on each of the last 7 days', () => {
  const now = new Date(Date.UTC(2026, 0, 10, 12))
  it('oldest first, the last is now; a change after a point gives that point its bid before', () => {
    const net = [{ at: new Date(now.getTime() - 3.5 * 86_400_000).toISOString(), from: 30, to: 20, actor: null }, { at: new Date(now.getTime() - 0.5 * 86_400_000).toISOString(), from: 20, to: 15, actor: null }]
    expect(sparkOf(net, 15, now)).toEqual([30, 30, 30, 20, 20, 20, 15])
    expect(sparkOf([], 12, now)).toEqual([12, 12, 12, 12, 12, 12, 12])
  })
})

describe('brainHeldBy — what holds the bid away from the brain\'s aim', () => {
  it('nothing when the brain moved it to its aim or gave it back; the layer that holds it otherwise', () => {
    expect(brainHeldBy(null)).toBeNull()
    expect(brainHeldBy({ action: 'write', layer: 'goal', goalBidCents: 19 })).toBeNull()
    expect(brainHeldBy({ action: 'write', layer: 'restore', goalBidCents: null })).toBeNull()
    expect(brainHeldBy({ action: 'hold', layer: 'goal', goalBidCents: 19 })).toEqual({ kind: 'waits', label: 'Waits a day' })
    expect(brainHeldBy({ action: 'write', layer: 'min_bid_hour', goalBidCents: 19 })).toEqual({ kind: 'night_floor', label: 'Night floor' })
    expect(brainHeldBy({ action: 'hold', layer: 'no_goal', goalBidCents: null })).toEqual({ kind: 'no_evidence', label: 'No evidence' })
    expect(brainHeldBy({ action: 'hold', layer: 'pin', goalBidCents: 19 })).toEqual({ kind: 'person', label: 'You' })
    // Auto-undo's own pin (BidHold UNDO_PIN) is no person's: it reads Auto-undo.
    expect(brainHeldBy({ action: 'hold', layer: 'pin', goalBidCents: 19 }, { autoUndoPin: true })).toEqual({ kind: 'auto_undo', label: 'Auto-undo' })
    expect(brainHeldBy({ action: 'write', layer: 'money', goalBidCents: 19 })).toEqual({ kind: 'money_brake', label: 'Money brake' })
    expect(brainHeldBy({ action: 'hold', layer: 'band', goalBidCents: 19 })).toEqual({ kind: 'in_band', label: 'In band' })
  })
})

describe('authorOf — who wrote a change, in the owner\'s words', () => {
  const names = { rules: new Map([['r1', 'Lower bids on waste']]), plans: new Map([['s1', { id: 'g1', name: 'Jacket plan' }]]), autopilots: new Map([['ap1', 'Jacket autopilot']]) }
  it('person, brain, plan (its name), auto-bid, a rule by name, an unknown automation', () => {
    expect(authorOf('user:u1', names)).toEqual({ kind: 'PERSON', name: 'You', id: 'you' })
    expect(authorOf('automation:bid-brain', names)).toEqual({ kind: 'BRAIN', name: 'Brain', id: 'brain' })
    expect(authorOf('automation:rank-defend-s1', names)).toEqual({ kind: 'PLAN', name: 'Jacket plan', id: 'g1' })
    expect(authorOf('automation:rank-plan-p9', names)).toEqual({ kind: 'PLAN', name: 'Hourly plan', id: 'p9' })
    expect(authorOf('automation:auto-bid', names)).toEqual({ kind: 'ENGINE', name: 'Auto-bid', id: 'auto-bid' })
    expect(authorOf('automation:automation:auto-bid', names)).toEqual({ kind: 'ENGINE', name: 'Auto-bid', id: 'auto-bid' })
    expect(authorOf('automation:autopilot-ap1', names)).toEqual({ kind: 'ENGINE', name: 'Jacket autopilot', id: 'ap1' })
    expect(authorOf('automation:reconcile', names)).toEqual({ kind: 'ENGINE', name: 'Retry of failed changes', id: 'write-reconcile' })
    expect(authorOf('automation:rule-r1', names)).toEqual({ kind: 'RULE', name: 'Lower bids on waste', id: 'r1' })
    expect(authorOf('automation:r1', names)).toEqual({ kind: 'RULE', name: 'Lower bids on waste', id: 'r1' })
    expect(authorOf('automation:gone', names)).toEqual({ kind: 'NONE', name: 'Unknown', id: null })
    expect(authorOf(null, names)).toEqual({ kind: 'NONE', name: 'Unknown', id: null })
  })
})
