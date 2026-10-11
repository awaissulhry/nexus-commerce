import { describe, expect, it } from 'vitest'
import { gridRowOf, type BidRow } from './bidsModel'
import { applyHeld, applyLabel, applyPlan, applySummary, BRAIN_STOPS, movesNext, readBulkBid, skipWords, suggestedCellOf, suggestedWords, type SuggestedState } from './suggestedModel'

const row = (over: Partial<BidRow> = {}) => gridRowOf({
  targetId: 't1', text: 'race jacket', match: 'EXACT', portfolio: null,
  campaign: { id: 'c1', name: 'Jacket Exact' }, adGroup: { id: 'g1', name: 'Jacket group' },
  owner: { kind: 'NONE', name: 'Nobody', id: null }, market: 'IT', currency: 'EUR',
  bidNow: 40, nightFloor: false, heldBy: null, lastChange: null, changes7d: 0, d7: { clicks: 0, orders: 0 }, ...over,
}, 'IT')

const NOW = Date.parse('2026-10-10T12:00:00Z')
const ready = (rows: Array<{ targetId: string; low?: number | null; mid?: number | null; high?: number | null }>, unavailable: string | null = null): SuggestedState =>
  ({ kind: 'ready', answer: { fetchedAt: '2026-10-10T09:00:00Z', rows, unavailable } })

describe('Amazon\'s suggested bid in a cell', () => {
  it('says the median, and the range and its age on hover', () => {
    const cell = suggestedCellOf(ready([{ targetId: 't1', low: 30, mid: 55, high: 90 }]), 't1')
    expect(suggestedWords(cell, 'EUR', NOW)).toEqual({ text: '€0.55', hint: '€0.30 – €0.90 · Amazon · 3 h ago', mid: 55 })
    expect(suggestedWords(cell, 'GBP', NOW).text).toBe('£0.55')
  })

  it('says a dash with the reason: unavailable, none for this keyword, not read, hidden, still reading', () => {
    expect(suggestedWords(suggestedCellOf(ready([], 'Amazon has no suggestion for this ad group'), 't1'), 'EUR')).toMatchObject({ text: '—', hint: 'Amazon has no suggestion for this ad group' })
    expect(suggestedWords(suggestedCellOf(ready([{ targetId: 'other', mid: 10 }]), 't1'), 'EUR').hint).toBe('Amazon suggests no bid for this keyword')
    expect(suggestedWords(suggestedCellOf({ kind: 'failed', error: 'HTTP 502' }, 't1'), 'EUR').hint).toBe('Suggested bid not read: HTTP 502')
    expect(suggestedWords(suggestedCellOf(ready([{ targetId: 't1' }]), 't1'), 'EUR').hint).toBe('Bids are hidden for you')
    expect(suggestedWords(suggestedCellOf(undefined, 't1'), 'EUR').text).toBe('…')
  })
})

describe('Apply', () => {
  const cellFor = (mid: number | null) => () => suggestedCellOf(ready(mid === null ? [] : [{ targetId: 't1', mid }]), 't1')

  it('on a bid the brain runs at Auto: it goes Manual, and the review says so plainly', () => {
    const plan = applyPlan([row({ owner: { kind: 'BRAIN', name: 'Brain', id: 'brain' }, auto: 'AUTO' })], cellFor(55))
    expect(plan.send[0]).toMatchObject({ now: 40, next: 55, goesManual: true, note: BRAIN_STOPS })
    expect(applySummary(plan)).toBe(`Sends to Amazon now. ${BRAIN_STOPS}.`)
  })

  it('on a rule, a plan or an engine: allowed, and it says who may move it again; on you or nothing: a plain bid', () => {
    expect(movesNext(row({ owner: { kind: 'RULE', name: 'Cut losers', id: 'r1' } }))).toEqual({ note: 'Rule “Cut losers” may move it again', goesManual: false })
    expect(movesNext(row({ owner: { kind: 'PLAN', name: 'Jacket hours', id: 'g1' } })).note).toBe('Hourly plan “Jacket hours” may move it again')
    expect(movesNext(row({ owner: { kind: 'ENGINE', name: 'Auto-bid', id: 'auto-bid' } })).note).toBe('Engine may move it again')
    expect(movesNext(row({ owner: { kind: 'PERSON', name: 'You', id: 'you' } }))).toEqual({ note: null, goesManual: false })
    expect(movesNext(row({ owner: { kind: 'BRAIN', name: 'Brain', id: 'brain' }, auto: 'MANUAL' })).goesManual).toBe(false)
    expect(applySummary(applyPlan([row()], cellFor(55)))).toBe('Sends to Amazon now.')
  })

  it('leaves out a row with no suggestion, a hidden bid, the same bid, or one under the floor — and says why', () => {
    expect(applyPlan([row()], cellFor(null)).lines[0].skip).toBe('Amazon suggests no bid for this keyword')
    expect(applyPlan([row({ bidNow: undefined })], cellFor(55)).lines[0].skip).toBe('Bids are hidden for you')
    expect(applyPlan([row()], cellFor(40)).lines[0].skip).toBe('Already at the suggested bid')
    expect(applyPlan([row()], cellFor(3)).lines[0].skip).toBe('Under Nexus\'s €0.05 floor')
    expect(applyPlan([row()], () => ({ kind: 'loading' })).lines[0].skip).toBe('Still reading Amazon\'s suggested bid')
    expect(applySummary({ send: [], manual: 0 })).toBe('Nothing to apply.')
  })

  it('counts the button and the many-row brain line', () => {
    expect(applyLabel(1)).toBe('Apply 1 suggested bid')
    expect(applyLabel(3)).toBe('Apply 3 suggested bids')
    const brain = { owner: { kind: 'BRAIN' as const, name: 'Brain', id: 'brain' }, auto: 'AUTO' as const }
    const plan = applyPlan([row({ ...brain }), row({ ...brain, targetId: 't2' }), row({ targetId: 't3' })], (r) => suggestedCellOf(ready([{ targetId: r.targetId, mid: 60 }]), r.targetId))
    expect(applySummary(plan)).toBe('Sends to Amazon now. The brain stops moving 2 of these keywords until you switch them back to Auto.')
  })
})

describe('the bulk send\'s answer', () => {
  const list = [{ targetId: 'a' }, { targetId: 'b' }, { targetId: 'c' }]

  it('gives each row its own answer and its change\'s Undo handle', () => {
    const out = readBulkBid(list, 200, { ok: true, outcomes: [
      { ok: true, actionLogId: 'l1', error: null, outboundQueueId: 'q1' },
      { ok: false, actionLogId: null, error: 'bid_below_floor_5_cents' },
      { ok: true, actionLogId: 'l3', error: null, outboundQueueId: null },
    ] })
    expect(out.results).toEqual([
      { targetId: 'a', ok: true, words: 'Sent', actionLogId: 'l1' },
      { targetId: 'b', ok: false, words: 'Nexus refuses bids under 5 cents.', actionLogId: null },
      { targetId: 'c', ok: true, words: 'Saved', actionLogId: 'l3' },
    ])
    expect(out.waits).toEqual([])
  })

  it('holds back the rows over his CPC ceiling (no outcome) and the rows past another of his limits, for Send anyway', () => {
    const limits = [{ limit: 'CPC ceiling', reason: 'above €1.00' }]
    const out = readBulkBid(list, 200, {
      ok: true,
      outcomes: [{ ok: true, actionLogId: 'l1', outboundQueueId: 'q1' }, { ok: false, actionLogId: null, error: 'past', needsConfirmation: { limits } }],
      needsConfirmation: [{ adTargetId: 'b', limits }, { adTargetId: 'c', limits }],
    })
    expect(out.results).toEqual([{ targetId: 'a', ok: true, words: 'Sent', actionLogId: 'l1' }])
    expect(out.waits.map((w) => w.adTargetId)).toEqual(['b', 'c'])
  })

  it('says the server\'s refusal on every row', () => {
    const out = readBulkBid(list, 400, { ok: false, error: 'entries_required' })
    expect(out.results.every((r) => !r.ok && r.words === 'entries_required')).toBe(true)
  })
})

describe('the bulk Apply is held when nothing can go (audit R7)', () => {
  it('says why, each reason once, with no doubled full stop', () => {
    const lines = [{ skip: 'Amazon suggests no bid for this keyword' }, { skip: 'Amazon suggests no bid for this keyword' }, { skip: 'Bids are hidden for you.' }]
    expect(skipWords(lines)).toBe('Amazon suggests no bid for this keyword; Bids are hidden for you')
    expect(applyHeld({ lines, send: [] })).toBe('Nothing to apply: Amazon suggests no bid for this keyword; Bids are hidden for you')
    expect(applyHeld({ lines: [], send: [] })).toBe('Select the keywords first')
    expect(applyHeld({ lines, send: [1] })).toBeNull()
  })
})
