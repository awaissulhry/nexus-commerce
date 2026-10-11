import { describe, expect, it } from 'vitest'
import type { BidRuleRow } from './bidRulesModel'
import {
  BULK_MAX, DEFAULT_EXPIRE_MS, approveChanges, askUndoResults, routeMissing, approveHeld, approveLabel, askChange, askOf, askReason, chunks, decideCounts,
  decideResults, expiryWindowMs, gateOf, keepSelected, matchWord, parseCents, rejectChanges, rejectHeld, rejectLabel, ruleApproveHeld, waitingOf,
  type AskContext, type WaitingAsk, type WaitingSuggestion,
} from './waitingModel'

const NOW = Date.parse('2026-10-10T12:00:00Z')
const DAY = 86_400_000

/** A made-up ask of rule r1 on a keyword (no real business figures). */
function sug(over: Partial<WaitingSuggestion> = {}): WaitingSuggestion {
  return {
    id: 's1', ruleId: 'r1', status: 'pending', entityType: 'AD_TARGET', entityId: 't1', entityName: 'rain jacket', marketplace: 'IT',
    proposedAction: { type: 'bid_apply', op: 'incPct', value: 10, wouldChange: '60¢ → 66¢' },
    createdAt: '2026-10-08T12:00:00Z', lastSeenAt: '2026-10-10T10:00:00Z',
    source: { keyword: 'rain jacket', matchType: 'EXACT', campaignId: 'c1', campaignName: 'Jacket Exact', adGroupId: 'g1', adGroupName: 'Jacket group' },
    metrics: { windowDays: 14, clicks: 40, orders: 3, acos: 0.125 },
    current: { bidCents: 60 }, suggested: { bidCents: 66 },
    ...over,
  }
}
const ctx = (over: Partial<AskContext> = {}): AskContext => ({ market: 'IT', owners: new Map(), ruleHeld: null, expiryMs: DEFAULT_EXPIRE_MS, now: NOW, ...over })
const ask = (over: Partial<WaitingAsk> = {}): WaitingAsk => ({ ...askOf(sug(), ctx()), ...over })

describe('one ask in the page’s words', () => {
  it('what it changes: the server’s now and suggested bid, else the card’s own words, in the market’s money', () => {
    expect(askChange(sug(), 'IT')).toEqual({ what: 'Bid', now: '€0.60', next: '€0.66' })
    expect(askChange(sug({ current: null, suggested: null }), 'IT')).toEqual({ what: 'Bid', now: '€0.60', next: '€0.66' })
    expect(askChange(sug({ current: { bidCents: 50 }, suggested: { bidCents: 45 } }), 'UK')).toEqual({ what: 'Bid', now: '£0.50', next: '£0.45' })
    expect(askChange(sug({ proposedAction: { type: 'pause_target' }, current: { entityStatus: 'ENABLED' } }), 'IT')).toEqual({ what: 'State', now: 'On', next: 'Paused' })
    expect(parseCents('45¢ → 38¢')).toEqual({ from: 45, to: 38 })
    expect(parseCents(12)).toBeNull()
  })

  it('why: orders and ACoS when it sold, clicks and no orders when it did not, over its window', () => {
    expect(askReason(sug().metrics)).toBe('3 orders · ACoS 12.5 % · 14 d')
    expect(askReason({ windowDays: 30, clicks: 25, orders: 0, acos: null })).toBe('25 clicks · 0 orders · 30 d')
    expect(askReason(null)).toBe('No data')
    expect(matchWord('PHRASE')).toBe('Phrase')
    expect(matchWord('SOMETHING_NEW')).toBe('Something_new')
    expect(matchWord(null)).toBeNull()
  })

  it('links, age and when it ends if no run asks it again', () => {
    const a = askOf(sug(), ctx())
    expect(a).toMatchObject({
      keyword: 'rain jacket', match: 'Exact', age: '2 d ago',
      campaign: { id: 'c1', name: 'Jacket Exact', href: '/marketing/ads/campaigns/c1' },
      adGroup: { id: 'g1', name: 'Jacket group', href: '/marketing/ads/campaigns/c1/ad-groups/g1' },
      gate: null, held: null,
    })
    // Seen 2 h ago, a 3-day window: it ends in 2 d (70 h, said in whole days).
    expect(a.expires).toBe('in 2 d')
    expect(askOf(sug({ lastSeenAt: '2026-10-06T00:00:00Z' }), ctx()).expires).toBe('now')
    expect(askOf(sug({ lastSeenAt: null }), ctx()).expires).toBeNull()
  })

  it('expiry: three days, or twice a scheduled rule’s interval when that is longer', () => {
    expect(expiryWindowMs(undefined)).toBe(3 * DAY)
    expect(expiryWindowMs([{ type: 'bid', schedule: { frequency: 'Daily' } }])).toBe(3 * DAY)
    expect(expiryWindowMs([{ type: 'bid', schedule: { frequency: 'Weekly' } }])).toBe(14 * DAY)
    expect(expiryWindowMs([{ type: 'bid', schedule: { frequency: 'Custom', everyN: 3, interval: 'Weeks' } }])).toBe(42 * DAY)
  })

  it('a rule’s waiting asks only, newest first', () => {
    const list = [sug({ id: 'a', createdAt: '2026-10-08T00:00:00Z' }), sug({ id: 'b', createdAt: '2026-10-09T00:00:00Z' }), sug({ id: 'c', ruleId: 'r2' }), sug({ id: 'd', status: 'applied' })]
    expect(waitingOf(list, 'r1').map((s) => s.id)).toEqual(['b', 'a'])
  })
})

describe('what holds Approve', () => {
  const rule = (over: Partial<Pick<BidRuleRow, 'archived' | 'mode'>> = {}) => ({
    archived: false, mode: { set: 'ASK' as const, acts: 'ASK' as const, heldBy: null, also: [], autoLocked: null }, ...over,
  })

  it('the whole rule: a permission, archived, Off, or every automatic ads change stopped — never a stop of the Brain alone', () => {
    expect(ruleApproveHeld(rule(), null)).toBeNull()
    expect(ruleApproveHeld(rule(), 'Needs the ads campaigns permission')).toBe('Needs the ads campaigns permission')
    expect(ruleApproveHeld(rule({ archived: true }), null)).toMatch(/Archived/)
    expect(ruleApproveHeld(rule({ mode: { ...rule().mode, set: 'OFF', acts: 'OFF' } }), null)).toMatch(/Off/)
    expect(ruleApproveHeld(rule({ mode: { ...rule().mode, acts: 'OFF', heldBy: { kind: 'stopped', label: 'Ads halted' } } }), null)).toBe('Ads halted: nothing can be approved now')
    expect(ruleApproveHeld(rule({ mode: { ...rule().mode, heldBy: { kind: 'stopped', label: 'Brain off' } } }), null)).toBeNull()
  })

  it('one ask: the Brain runs its campaign (an input), or its bids are stopped (approving changes nothing)', () => {
    expect(gateOf({ kind: 'BRAIN', name: 'Brain' })).toBe('brain')
    expect(gateOf({ kind: 'BRAIN', name: 'Brain (stopped)' })).toBe('brainStopped')
    expect(gateOf({ kind: 'RULE', name: 'Rule A' })).toBeNull()
    expect(gateOf(undefined)).toBeNull()
    const owners = new Map([['t1', { kind: 'BRAIN', name: 'Brain (stopped)' }]])
    expect(askOf(sug(), ctx({ owners }))).toMatchObject({ gate: 'brainStopped', held: expect.stringMatching(/stopped the Brain/) })
    expect(askOf(sug({ entityType: 'CAMPAIGN' }), ctx({ owners }))).toMatchObject({ gate: null, held: null })
    expect(askOf(sug(), ctx({ ruleHeld: 'The rule is Off: switch it on first' })).held).toBe('The rule is Off: switch it on first')
  })

  it('the two counted buttons: Approve takes what may be approved, Reject every ticked ask; each held says why', () => {
    const asks = [ask({ id: 'a' }), ask({ id: 'b', held: 'Brain off' }), ask({ id: 'c' })]
    const none = decideCounts(asks, new Set())
    expect(approveHeld(none, null)).toBe('Tick at least one ask')
    expect(rejectHeld(none, null)).toBe('Tick at least one ask')
    const some = decideCounts(asks, new Set(['a', 'b']))
    expect(some.approve.map((x) => x.id)).toEqual(['a'])
    expect(some.reject.map((x) => x.id)).toEqual(['a', 'b'])
    expect(some.held.map((x) => x.id)).toEqual(['b'])
    expect(approveHeld(some, null)).toBeNull()
    expect(approveHeld(decideCounts(asks, new Set(['b'])), null)).toBe('Brain off')
    expect(approveHeld(some, 'Needs the ads campaigns permission')).toBe('Needs the ads campaigns permission')
    expect(approveLabel(2)).toBe('Approve 2')
    expect(approveLabel(0)).toBe('Approve')
    expect(rejectLabel(3)).toBe('Reject 3')
    expect(keepSelected(new Set(['a', 'gone']), asks)).toEqual(new Set(['a']))
  })
})

describe('the review, its results and its Undo', () => {
  it('Approve: now → asked per ask; an ask on the Brain’s campaign says the Brain decides', () => {
    expect(approveChanges([ask(), ask({ id: 's2', gate: 'brain' })])).toEqual([
      { id: 's1', where: 'rain jacket · Jacket Exact', what: 'Bid', now: '€0.60', next: '€0.66' },
      { id: 's2', where: 'rain jacket · Jacket Exact', what: 'Bid', now: '€0.60', next: '€0.66', note: 'Brain decides: passed to it for 7 days' },
    ])
  })

  it('Reject: the ask leaves the list', () => {
    expect(rejectChanges([ask()])).toEqual([{ id: 's1', where: 'rain jacket · Jacket Exact', what: 'Ask', now: '€0.60 → €0.66', next: 'Rejected' }])
  })

  it('the Done words: approved, passed to the Brain, rejected, or the server’s refusal; an ask without an answer says so', () => {
    const gates = new Map([['b', 'brain' as const]])
    expect(decideResults(['a', 'b', 'c', 'd'], [
      { id: 'a', kind: 'apply', ok: true },
      { id: 'b', kind: 'apply', ok: true },
      { id: 'c', kind: 'apply', ok: false, refused: true, error: 'the rule no longer stands behind it' },
    ], 'apply', gates)).toEqual({
      a: { ok: true, words: 'Approved' },
      b: { ok: true, words: 'Passed to the Brain' },
      c: { ok: false, words: 'Refused: the rule no longer stands behind it' },
      d: { ok: false, words: 'No answer for this ask' },
    })
    expect(decideResults(['a'], [{ id: 'a', kind: 'dismiss', ok: true }], 'dismiss')).toEqual({ a: { ok: true, words: 'Rejected' } })
  })

  it('Undo of approvals: a result per ask in the server\'s words; undone asks wait again; a refusal keeps its reason', () => {
    const body = {
      results: [
        { suggestionId: 'a', restored: true, reopened: true, reason: null },
        { suggestionId: 'b', restored: false, reopened: false, reason: 'A later change on this keyword since: the old bid would overwrite it.' },
        { suggestionId: 'c', restored: true, reopened: false, reason: 'The ask is too old to wait again: it expired.' },
        { suggestionId: 'd', restored: true, reopened: true, reason: 'Its input to the brain ended.' },
      ],
      undone: 3, reopened: 2,
    }
    expect(askUndoResults(['a', 'b', 'c', 'd', 'e'], body)).toEqual({
      a: { ok: true, words: 'Undone: waiting again' },
      b: { ok: false, words: 'A later change on this keyword since: the old bid would overwrite it', verb: 'undone' },
      c: { ok: true, words: 'Undone: The ask is too old to wait again: it expired' },
      d: { ok: true, words: 'Undone: waiting again. Its input to the brain ended' },
      e: { ok: false, words: 'No answer for this ask', verb: 'undone' },
    })
  })

  it('knows a route the server does not have from a refusal', () => {
    expect(routeMissing(404, { message: 'Route POST:/api/advertising/bid-rules/r1/asks/undo not found', error: 'Not Found' })).toBe(true)
    expect(routeMissing(404, { error: 'rule not found' })).toBe(false)
    expect(routeMissing(400, { message: 'Route x not found' })).toBe(false)
  })

  it('the bulk route takes at most 200 decisions a call', () => {
    const ids = Array.from({ length: 450 }, (_, i) => i)
    expect(chunks(ids).map((c) => c.length)).toEqual([BULK_MAX, BULK_MAX, 50])
    expect(chunks([])).toEqual([])
  })
})
