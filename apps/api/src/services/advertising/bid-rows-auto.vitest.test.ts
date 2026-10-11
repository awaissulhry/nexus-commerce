/**
 * Bid page R2 — a row's Auto line (`autoWhy`) and its owner chip (`owner`) never give two answers to "who sets this bid":
 * every combination of the owner facts and the writers of 7 days, read by the same resolveBidOwner the row uses. Also
 * R4's fold: an undone approved ask leaves "who sets it" as it was. Made-up names (public repo).
 */
import { describe, expect, it } from 'vitest'
import { resolveBidOwner, withoutUndonePairs, type BidOwnerFacts, type BidWriterTally } from './bid-owner.js'
import { autoOf, keywordLockWhy, ownerWhy, type KeywordAutoFacts } from './bid-rows.service.js'

const RULE = { id: 'r1', name: 'Lower bids on waste' }
const PLAN = { id: 'g1', name: 'Jacket plan' }
const PRODUCT_PLAN = { id: 'pp1', name: 'Hourly plan' }
const AUTO_BID = { id: 'auto-bid', name: 'Auto-bid', leavesPersonBids: true }
const AUTOPILOT = { id: 'ap1', name: 'Jacket autopilot', leavesPersonBids: false }
const AT = '2026-10-09T10:00:00.000Z'
const wrote = (kind: BidWriterTally['kind'], name: string, id: string | null, writes = 1): BidWriterTally => ({ kind, name, id, writes, lastAt: AT })
const WRITERS: BidWriterTally[][] = [
  [], [wrote('RULE', RULE.name, RULE.id)], [wrote('PERSON', 'You', 'you')], [wrote('ENGINE', 'Auto-bid', 'auto-bid', 3)],
  [wrote('PLAN', PLAN.name, PLAN.id, 2), wrote('RULE', RULE.name, RULE.id)], [wrote('NONE', 'Unknown', null)],
]
const JARGON = /auto-bid|shadow|user:|operator|console|allowlist|lever|observe|propose/i

function* combos(): Generator<{ facts: BidOwnerFacts; k: KeywordAutoFacts; writers: BidWriterTally[] }> {
  for (const pinned of [false, true]) for (const personHold of [false, true]) for (const allowlisted of [true, false])
    for (const running of [true, false]) for (const brain of [null, { stopped: false }, { stopped: true }]) for (const enrolled of [false, true])
      for (const rules of [[], [RULE]]) for (const plan of [null, PLAN, PRODUCT_PLAN]) for (const engine of [null, AUTO_BID, AUTOPILOT])
        for (const writers of WRITERS) {
          if (brain && !enrolled) continue
          const facts: BidOwnerFacts = { pinned, personHold, allowlisted, running, brain, rules, plan, engine }
          const k: KeywordAutoFacts = {
            brain, enrollment: brain ? 'LIVE' : enrolled ? 'SHADOW' : null, pinned, lock: null, campaignHold: false, targetHold: null,
            personBid: personHold, running,
          }
          yield { facts, k, writers }
        }
}

describe('R2 — autoWhy names the row\'s own owner', () => {
  it('in every combination, the line and the owner chip agree; no jargon, never another writer\'s name', () => {
    let n = 0
    for (const { facts, k, writers } of combos()) {
      n++
      const owner = resolveBidOwner(facts, writers)
      const { auto, autoWhy } = autoOf(k, { allowlisted: facts.allowlisted, owner })
      const where = JSON.stringify({ facts, writers, owner: owner.kind, auto, autoWhy })
      expect(autoWhy ?? '', where).not.toMatch(JARGON)
      if (auto === 'MANUAL') expect(owner.kind, where).toBe('PERSON')
      if (auto === 'AUTO') expect(owner.kind === 'BRAIN' || (owner.kind === 'NONE' && /^Paused/.test(autoWhy ?? '')), where).toBe(true)
      if (auto !== 'NONE') continue
      const others = [RULE.name, PLAN.name, AUTOPILOT.name].filter((x) => x !== owner.name)
      for (const other of others) expect(autoWhy, where).not.toContain(other)
      if (owner.kind === 'PERSON') expect(autoWhy, where).toMatch(/^You set this bid/)
      else if (owner.kind === 'RULE') expect(autoWhy, where).toMatch(new RegExp(`^The rule "${owner.name}" sets it`))
      else if (owner.kind === 'PLAN') expect(autoWhy, where).toMatch(owner.name === PRODUCT_PLAN.name ? /^The hourly plan sets it/ : new RegExp(`^The hourly plan "${owner.name}" sets it`))
      else if (owner.kind === 'ENGINE') expect(autoWhy, where).toMatch(/^An engine sets it/)
      else expect(autoWhy, where).toMatch(/^(No engine runs this campaign|Nobody sets this bid|Live bid writes are off)/)
    }
    expect(n).toBeGreaterThan(1000)
  })

  it('the audit\'s two rows: a person\'s bid over an hourly plan says You; a rule over auto-bid names the rule', () => {
    const touring: BidOwnerFacts = { pinned: false, personHold: true, allowlisted: true, running: true, brain: null, rules: [], plan: PLAN, engine: null }
    const youOwner = resolveBidOwner(touring, [wrote('PERSON', 'You', 'you', 2)])
    expect(youOwner).toMatchObject({ kind: 'PERSON', alsoWrites: [{ kind: 'PLAN' }] })
    expect(autoOf({ brain: null, enrollment: null, pinned: false, lock: null, campaignHold: false, targetHold: null, personBid: true, running: true }, { allowlisted: true, owner: youOwner }).autoWhy).toBe('You set this bid, not the brain')
    const moto: BidOwnerFacts = { pinned: false, personHold: false, allowlisted: true, running: true, brain: null, rules: [RULE], plan: null, engine: AUTO_BID }
    const ruleOwner = resolveBidOwner(moto, [wrote('RULE', RULE.name, RULE.id, 2)])
    expect(ruleOwner).toMatchObject({ kind: 'RULE', name: RULE.name })
    expect(autoOf({ brain: null, enrollment: null, pinned: false, lock: null, campaignHold: false, targetHold: null, personBid: false, running: true }, { allowlisted: true, owner: ruleOwner }).autoWhy).toBe(`The rule "${RULE.name}" sets it`)
  })

  it('each owner in its words; a campaign the brain only watches says so without jargon', () => {
    const f = { allowlisted: true, enrolled: false }
    expect(ownerWhy({ kind: 'PERSON', name: 'You' }, f)).toBe('You set this bid, not the brain')
    expect(ownerWhy({ kind: 'PLAN', name: PLAN.name }, f)).toBe(`The hourly plan "${PLAN.name}" sets it`)
    expect(ownerWhy({ kind: 'PLAN', name: 'Hourly plan' }, f)).toBe('The hourly plan sets it')
    expect(ownerWhy({ kind: 'ENGINE', name: 'Auto-bid' }, f)).toBe('An engine sets it')
    expect(ownerWhy({ kind: 'NONE', name: 'Nobody' }, f)).toBe('No engine runs this campaign')
    expect(ownerWhy({ kind: 'NONE', name: 'Nobody' }, { allowlisted: false, enrolled: false })).toBe('Live bid writes are off for this campaign: no engine changes its bids')
    expect(ownerWhy({ kind: 'RULE', name: RULE.name }, { allowlisted: true, enrolled: true })).toBe(`The rule "${RULE.name}" sets it: the brain only watches this campaign`)
    expect(ownerWhy({ kind: 'PERSON', name: 'You' }, { allowlisted: true, enrolled: true })).toBe('You set this bid: the brain only watches this campaign')
  })

  it('the Owner\'s lock is the person\'s, in plain words', () => {
    expect(keywordLockWhy({ ref: 'target:t-1' })).toBe('You locked this keyword\'s bid: the brain leaves it')
    expect(keywordLockWhy({ ref: 'adGroup:g-1' })).toBe('You locked the bids of its ad group: the brain leaves them')
    expect(keywordLockWhy(null)).toBeNull()
  })
})

describe('R4 — an undone approved ask folds away', () => {
  it('the write and the undo that names it leave; every other row stays, a person\'s undo of something else included', () => {
    const rows = [
      { id: 'a', undoOf: null }, { id: 'b', undoOf: null }, { id: 'c', undoOf: 'b' }, { id: 'd', undoOf: null },
    ]
    expect(withoutUndonePairs(rows).map((r) => r.id)).toEqual(['a', 'd'])
    expect(withoutUndonePairs([{ id: 'x' }, { id: 'y' }]).map((r) => r.id)).toEqual(['x', 'y'])
    // An undo whose write is outside the rows read still never counts as a change of its own.
    expect(withoutUndonePairs([{ id: 'u', undoOf: 'gone' }, { id: 'v', undoOf: null }]).map((r) => r.id)).toEqual(['v'])
  })
})
