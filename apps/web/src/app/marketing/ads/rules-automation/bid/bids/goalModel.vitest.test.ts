import { describe, expect, it } from 'vitest'
import { gridRowOf, type BidRow } from './bidsModel'
import { draftOf, goalBody, goalChanges, goalHeld, goalResult, goalText, parseGoal, goalRaises } from './goalModel'

const row = (over: Partial<BidRow> = {}) => gridRowOf({
  targetId: 't1', text: 'race jacket', match: 'EXACT', portfolio: null,
  campaign: { id: 'c1', name: 'Jacket Exact' }, adGroup: { id: 'g1', name: 'Jacket group' },
  owner: { kind: 'BRAIN', name: 'Brain', id: 'brain' }, market: 'IT', currency: 'EUR', auto: 'AUTO', brainProductId: 'p1',
  goal: { acosPct: 20, tosPct: null, maxCents: 80 },
  bidNow: 40, nightFloor: false, heldBy: null, lastChange: null, changes7d: 0, d7: { clicks: 0, orders: 0 }, ...over,
}, 'IT')

describe('a keyword\'s goal in a cell', () => {
  it('says target ACoS · max · top of search, or a dash', () => {
    expect(goalText({ acosPct: 20, tosPct: null, maxCents: 80 }, 'EUR')).toBe('20 % · max €0.80')
    expect(goalText({ acosPct: null, tosPct: 30, maxCents: null }, 'EUR')).toBe('ToS 30 %')
    expect(goalText({ acosPct: null, tosPct: null, maxCents: 120 }, 'GBP')).toBe('max £1.20')
    expect(goalText(null, 'EUR')).toBe('—')
  })
})

describe('the Goal tab', () => {
  it('starts from the keyword\'s own values and reads what was typed', () => {
    expect(draftOf({ acosPct: 20, tosPct: null, maxCents: 80 })).toEqual({ acos: '20', max: '0.80', tos: '' })
    const p = parseGoal({ acos: '25 %', max: '0,9', tos: '' })
    expect(p.values).toEqual({ targetAcosPct: 25, maxBidCents: 90, tosTargetPct: null })
    expect(p.problems).toEqual({})
  })

  it('says what is wrong with each box: not whole, out of bounds, not a bid', () => {
    expect(parseGoal({ acos: '20.5', max: '', tos: '' }).problems.targetAcosPct).toBe('A whole percent')
    expect(parseGoal({ acos: '', max: '0.01', tos: '' }).problems.maxBidCents).toBe('From 0.05 to 1000.00')
    expect(parseGoal({ acos: '', max: 'x', tos: '' }).problems.maxBidCents).toBe('Not a bid')
    expect(parseGoal({ acos: '', max: '', tos: '99' }).problems.tosTargetPct).toBe('From 5 to 95 %')
  })

  it('lists only what changes', () => {
    const { values } = parseGoal({ acos: '25', max: '', tos: '' })
    expect(goalChanges({ acosPct: 20, tosPct: null, maxCents: 80 }, values)).toEqual([
      { key: 'targetAcosPct', now: 20, next: 25 },
      { key: 'maxBidCents', now: 80, next: null },
    ])
  })

  it('is honest where no engine runs the keyword, and says the other reasons it waits', () => {
    expect(goalHeld(row({ auto: 'NONE', autoWhy: 'No engine runs this campaign: not on the allowlist' }), 'IT', true)).toBe('No engine runs this campaign: not on the allowlist')
    expect(goalHeld(row({ auto: 'NONE' }), 'IT', true)).toBe('No engine runs this campaign')
    expect(goalHeld(row(), 'IT', false)).toBe('Needs the ads automation permission')
    expect(goalHeld(row({ brainProductId: null }), 'IT', true)).toBe('The brain that runs this keyword is not known')
    expect(goalHeld(row({ market: null }), 'all', true)).toBe('Pick a market first')
    expect(goalHeld(row(), 'IT', true)).toBeNull()
  })
})

describe('the brain control call', () => {
  it('sends one setting per call with the keyword\'s ref, approved in the same click', () => {
    expect(goalBody(row(), { key: 'targetAcosPct', next: 25 }, 'IT')).toEqual({
      op: 'set-value', productId: 'p1', market: 'IT', campaignId: 'c1', ref: 'target:t1', key: 'targetAcosPct', value: 25,
      why: 'Bid page: Target ACoS for race jacket', approve: true,
    })
  })

  it('clears a box with reset (the campaign\'s or product\'s value applies), and needs the brain\'s product', () => {
    expect(goalBody(row(), { key: 'maxBidCents', next: null }, 'IT')).toMatchObject({ key: 'maxBidCents', reset: true })
    expect(goalBody(row(), { key: 'maxBidCents', next: null }, 'IT')).not.toHaveProperty('value')
    expect(goalBody(row({ brainProductId: null }), { key: 'maxBidCents', next: 50 }, 'IT')).toBeNull()
    expect(goalBody(row({ market: null }), { key: 'maxBidCents', next: 50 }, 'DE')?.market).toBe('DE')
  })

  it('reads the answer: saved, waiting, refused, with the brain\'s warnings', () => {
    expect(goalResult(202, { status: 'scheduled', approve: { ok: true }, preview: { warnings: ['A warning.'] } })).toEqual({ ok: true, words: 'Saved', warnings: ['A warning.'] })
    expect(goalResult(202, { status: 'pending', approve: { ok: false, error: 'Past your own limit' } })).toEqual({ ok: false, words: 'Past your own limit', warnings: [] })
    expect(goalResult(400, { error: 'targetAcosPct is set per product' }).words).toBe('targetAcosPct is set per product')
    expect(goalResult(403, null).words).toBe('HTTP 403')
  })
})

describe('a goal change that lets the brain spend more (audit R9)', () => {
  it('a max is a cap: setting, lowering or raising it is never a raise; only taking it away is', () => {
    expect(goalRaises({ key: 'maxBidCents', now: null, next: 80 })).toBe(false)
    expect(goalRaises({ key: 'maxBidCents', now: 80, next: 120 })).toBe(false)
    expect(goalRaises({ key: 'maxBidCents', now: 80, next: null })).toBe(true)
  })
  it('a target ACoS is measured against what applies now: its own, else the inherited one', () => {
    expect(goalRaises({ key: 'targetAcosPct', now: null, next: 20 }, { targetAcosPct: 25 })).toBe(false)
    expect(goalRaises({ key: 'targetAcosPct', now: null, next: 30 }, { targetAcosPct: 25 })).toBe(true)
    expect(goalRaises({ key: 'targetAcosPct', now: 20, next: 25 }, { targetAcosPct: 40 })).toBe(true)
    expect(goalRaises({ key: 'targetAcosPct', now: 30, next: null }, { targetAcosPct: 25 })).toBe(false)
    expect(goalRaises({ key: 'targetAcosPct', now: 20, next: null }, { targetAcosPct: 25 })).toBe(true)
    // Nothing known applies: not called a raise.
    expect(goalRaises({ key: 'targetAcosPct', now: null, next: 30 })).toBe(false)
  })
})
