import { describe, expect, it } from 'vitest'
import { currencySymbol } from '../_shared/format'
import {
  adjustForm, adjustNothing, adjustPlan, adjustStart, adjustSummary, changeHeld, changeTitle, currenciesOf, MIXED_LIMIT, MIXED_MONEY,
  parsePercent, readDraft, sendLabel, tableOrder, withHow, type AdjustDraft, type AdjustHow,
} from './adjustModel'
import { gridRowOf, type BidGridRow, type BidRow } from './bidsModel'
import { BRAIN_STOPS } from './suggestedModel'

const row = (over: Partial<BidRow> = {}, extra: Partial<BidGridRow> = {}): BidGridRow => ({
  ...gridRowOf({
    targetId: 't1', text: 'race jacket', match: 'EXACT', portfolio: null,
    campaign: { id: 'c1', name: 'Jacket Exact' }, adGroup: { id: 'g1', name: 'Jacket group' },
    owner: { kind: 'NONE', name: 'Nobody', id: null }, market: 'IT', currency: 'EUR',
    bidNow: 40, nightFloor: false, heldBy: null, lastChange: null, changes7d: 0, d7: { clicks: 0, orders: 0 }, ...over,
  }, 'IT'),
  ...extra,
})
const draft = (how: AdjustHow, amount: string, limit = ''): AdjustDraft => ({ how, amount, limit })
const one = (r: BidGridRow, d: AdjustDraft) => adjustPlan([r], d).lines[0]

describe('Change bid — Now → New, rounded to the cent', () => {
  it('sets, raises and lowers by an amount', () => {
    expect(one(row(), draft('set', '0.55'))).toMatchObject({ now: 40, next: 55, skip: null })
    expect(one(row(), draft('set', '0,55')).next).toBe(55)
    expect(one(row(), draft('raiseBy', '0.05'))).toMatchObject({ now: 40, next: 45 })
    expect(one(row(), draft('lowerBy', '0.10'))).toMatchObject({ now: 40, next: 30 })
  })

  it('raises and lowers by a percent, half a cent up', () => {
    expect(one(row({ bidNow: 15 }), draft('raisePct', '10')).next).toBe(17) // 16.5
    expect(one(row({ bidNow: 15 }), draft('lowerPct', '10')).next).toBe(14) // 13.5
    expect(one(row({ bidNow: 40 }), draft('raisePct', '12.5')).next).toBe(45)
    expect(one(row({ bidNow: 33 }), draft('raisePct', '7,5')).next).toBe(35) // 35.475
    expect(one(row({ bidNow: 99 }), draft('lowerPct', '33.33')).next).toBe(66) // 66.0033
    expect(one(row({ bidNow: 40 }), draft('raisePct', '10%')).next).toBe(44)
  })

  it('a change too small to move the cent stays, and says so', () => {
    expect(one(row({ bidNow: 5 }), draft('raisePct', '1'))).toMatchObject({ next: null, skip: 'Rounds to the same bid', note: 'Rounds to the same bid' })
  })
})

describe('Change bid — where it stops', () => {
  it('stops at the floor and the ceiling, and the line says so', () => {
    expect(one(row({ bidNow: 8 }), draft('lowerBy', '0.05'))).toMatchObject({ next: 5, note: 'Stops at the €0.05 floor' })
    expect(one(row({ bidNow: 8 }), draft('lowerPct', '90'))).toMatchObject({ next: 5, note: 'Stops at the €0.05 floor' })
    expect(one(row({ bidNow: 90_000 }), draft('raisePct', '50'))).toMatchObject({ next: 100_000, note: 'Stops at the €1,000.00 ceiling' })
    expect(one(row({ bidNow: 99_990 }), draft('raiseBy', '1'))).toMatchObject({ next: 100_000, note: 'Stops at the €1,000.00 ceiling' })
  })

  it('a bid already at the floor is not lowered, one at the ceiling not raised', () => {
    expect(one(row({ bidNow: 5 }), draft('lowerBy', '0.01')).skip).toBe('Already at the €0.05 floor')
    expect(one(row({ bidNow: 3 }), draft('lowerPct', '10')).skip).toBe('Already at the €0.05 floor')
    expect(one(row({ bidNow: 100_000 }), draft('raiseBy', '0.01')).skip).toBe('Already at the €1,000.00 ceiling')
  })

  it('stops at your limit, and leaves a bid already past it', () => {
    expect(one(row(), draft('raisePct', '50', '0.50'))).toMatchObject({ next: 50, note: 'Stops at your limit €0.50' })
    expect(one(row(), draft('raiseBy', '0.05', '0.50'))).toMatchObject({ next: 45, note: null })
    expect(one(row(), draft('lowerBy', '0.30', '0.20'))).toMatchObject({ next: 20, note: 'Stops at your limit €0.20' })
    expect(one(row(), draft('set', '0.90', '0.60'))).toMatchObject({ next: 60, note: 'Stops at your limit €0.60' })
    expect(one(row(), draft('raisePct', '10', '0.40')).skip).toBe('Already at or over your limit €0.40')
    expect(one(row({ bidNow: 70 }), draft('raiseBy', '0.05', '0.60')).skip).toBe('Already at or over your limit €0.60')
    expect(one(row(), draft('lowerPct', '10', '0.40')).skip).toBe('Already at or under your limit €0.40')
    expect(one(row({ bidNow: 60 }), draft('set', '0.90', '0.60')).skip).toBe('Already at your limit €0.60')
  })
})

describe('Change bid — a bid that cannot change says why', () => {
  it('already at that bid, hidden, a market Nexus only reads', () => {
    expect(one(row(), draft('set', '0.40'))).toMatchObject({ next: null, skip: 'Already at that bid', note: 'Already at that bid' })
    expect(one(row({ bidNow: undefined }), draft('set', '0.50'))).toMatchObject({ now: null, skip: 'Bids are hidden for you' })
    const ro = row({}, { writeBlock: 'Reading only: writes are off for this market' })
    expect(one(ro, draft('raisePct', '10')).skip).toBe('Reading only: writes are off for this market')
    // Said before a value is typed too: the table shows it from the first moment.
    expect(one(ro, draft('raisePct', '')).skip).toBe('Reading only: writes are off for this market')
  })

  it('while the value waits, no bid goes and none is said to stay', () => {
    const plan = adjustPlan([row(), row({ targetId: 't2' })], draft('set', ''))
    expect(plan.input.held).toBe('Type a bid')
    expect(plan.send).toEqual([])
    expect(plan.lines.map((l) => [l.now, l.next, l.skip])).toEqual([[40, null, null], [40, null, null]])
    expect(adjustNothing(plan)).toBeNull()
  })

  it('when the value is typed and nothing can go, the review says each reason once', () => {
    const plan = adjustPlan([row(), row({ targetId: 't2' }), row({ targetId: 't3', bidNow: undefined })], draft('set', '0.40'))
    expect(plan.send).toEqual([])
    expect(adjustNothing(plan)).toBe('Nothing to send: Already at that bid; Bids are hidden for you')
  })

  it('puts the bids that change first in the table', () => {
    const plan = adjustPlan([row({ targetId: 'a', bidNow: 60 }), row({ targetId: 'b' }), row({ targetId: 'c', bidNow: 50 })], draft('set', '0.60'))
    expect(tableOrder(plan.lines).map((l) => l.row.targetId)).toEqual(['b', 'c', 'a'])
  })
})

describe('Change bid — who moves it next (the same rule as Apply suggested)', () => {
  it('the brain\'s keyword at Auto goes Manual; a rule, a plan or an engine may move it again', () => {
    const brain = row({ owner: { kind: 'BRAIN', name: 'Brain', id: 'brain' }, auto: 'AUTO' })
    expect(one(brain, draft('raiseBy', '0.05'))).toMatchObject({ goesManual: true, note: BRAIN_STOPS })
    expect(one(row({ owner: { kind: 'BRAIN', name: 'Brain', id: 'brain' }, auto: 'MANUAL' }), draft('raiseBy', '0.05'))).toMatchObject({ goesManual: false, note: null })
    expect(one(row({ owner: { kind: 'RULE', name: 'Cut losers', id: 'r1' } }), draft('lowerPct', '10')).note).toBe('Rule “Cut losers” may move it again')
    expect(one(row({ owner: { kind: 'RULE', name: 'Cut losers', id: 'r1' } }), draft('lowerPct', '90')).note).toBe('Stops at the €0.05 floor · Rule “Cut losers” may move it again')
    // A bid that stays does not go Manual.
    expect(one(brain, draft('set', '0.40'))).toMatchObject({ goesManual: false, skip: 'Already at that bid' })
  })

  it('says it in the summary, one keyword or many', () => {
    const brain = { owner: { kind: 'BRAIN' as const, name: 'Brain', id: 'brain' }, auto: 'AUTO' as const }
    expect(adjustSummary(adjustPlan([row()], draft('set', '0.50')))).toBe('Sends to Amazon now.')
    expect(adjustSummary(adjustPlan([row(brain)], draft('set', '0.50')))).toBe(`Sends to Amazon now. ${BRAIN_STOPS}.`)
    const plan = adjustPlan([row(brain), row({ ...brain, targetId: 't2' }), row({ targetId: 't3' })], draft('raisePct', '10'))
    expect(plan.manual).toBe(2)
    expect(adjustSummary(plan)).toBe('Sends to Amazon now. The brain stops moving 2 of these keywords until you switch them back to Auto.')
  })
})

describe('Change bid — the value, in plain words', () => {
  const eur = ['EUR']
  it('waits for a value without calling it wrong', () => {
    expect(readDraft(draft('set', ''), eur)).toMatchObject({ held: 'Type a bid', errors: {} })
    expect(readDraft(draft('raiseBy', ' '), eur)).toMatchObject({ held: 'Type an amount', errors: {} })
    expect(readDraft(draft('lowerPct', ''), eur)).toMatchObject({ held: 'Type a percent', errors: {} })
  })
  it('says what is wrong with a typed value, on its field', () => {
    expect(readDraft(draft('set', 'abc'), eur).errors.amount).toBe('Type a bid like 0.45')
    expect(readDraft(draft('set', '0.03'), eur).errors.amount).toBe('At least €0.05')
    expect(readDraft(draft('set', '1000.01'), eur).errors.amount).toBe('At most €1,000.00')
    expect(readDraft(draft('raiseBy', '0'), eur).errors.amount).toBe('More than €0.00')
    expect(readDraft(draft('lowerBy', 'x'), eur).errors.amount).toBe('Type an amount like 0.05')
    expect(readDraft(draft('raisePct', '0'), eur).errors.amount).toBe('More than 0 %')
    expect(readDraft(draft('raisePct', '501'), eur).errors.amount).toBe('At most 500 %')
    expect(readDraft(draft('lowerPct', '100'), eur).errors.amount).toBe('Under 100 %')
    expect(readDraft(draft('lowerPct', 'ten'), eur).errors.amount).toBe('Type a percent like 10')
    expect(readDraft(draft('raisePct', '10', '0.01'), eur)).toMatchObject({ held: 'At least €0.05', errors: { limit: 'At least €0.05' } })
    expect(readDraft(draft('raisePct', '10', 'x'), eur).errors.limit).toBe('Type a bid like 0.45')
    expect(readDraft(draft('raisePct', '10', '0.80'), eur)).toMatchObject({ value: 1000, limit: 80, held: null })
  })
  it('reads a percent as typed', () => {
    expect(parsePercent('12,5')).toBe(1250)
    expect(parsePercent('10 %')).toBe(1000)
    expect(parsePercent('')).toBeNull()
    expect(Number.isNaN(parsePercent('1.234') as number)).toBe(true)
  })
})

describe('Change bid — more than one currency', () => {
  const it_ = row({ targetId: 'it' })
  const uk = row({ targetId: 'uk', market: 'UK', currency: 'GBP' })

  it('holds the money modes and lets a percent go', () => {
    expect(currenciesOf([it_, uk])).toEqual(['EUR', 'GBP'])
    for (const how of ['set', 'raiseBy', 'lowerBy'] as const) {
      const plan = adjustPlan([it_, uk], draft(how, '0.05'))
      expect(plan.input.held).toBe(MIXED_MONEY)
      expect(plan.send).toEqual([])
    }
    const pct = adjustPlan([it_, uk], draft('raisePct', '10'))
    expect(pct.send.map((l) => [l.row.targetId, l.next])).toEqual([['it', 44], ['uk', 44]])
  })

  it('ignores a limit across currencies, and starts on a percent', () => {
    expect(adjustPlan([it_, uk], draft('raisePct', '50', '0.50')).send.map((l) => l.next)).toEqual([60, 60])
    expect(adjustStart([it_, uk]).how).toBe('raisePct')
    expect(adjustStart([it_]).how).toBe('set')
  })

  it('counts only the bids that may change: a market Nexus only reads does not make it mixed', () => {
    const ro = row({ targetId: 'uk', market: 'UK', currency: 'GBP' }, { writeBlock: 'Reading only' })
    expect(currenciesOf([it_, ro])).toEqual(['EUR'])
    expect(adjustPlan([it_, ro], draft('set', '0.50')).send.map((l) => l.row.targetId)).toEqual(['it'])
  })

  it('the form says why: the money mark of each currency, no amount for a money mode, no limit', () => {
    const f = adjustForm([it_, uk], draft('set', ''), currencySymbol)
    expect(f.hows.map((h) => h.label)).toEqual(['Set to €/£', 'Raise by €/£', 'Lower by €/£', 'Raise by %', 'Lower by %'])
    expect(f).toMatchObject({ amount: null, limit: null, note: MIXED_MONEY })
    expect(adjustForm([it_, uk], draft('lowerPct', ''), currencySymbol)).toMatchObject({ amount: { label: 'Percent', suffix: '%' }, limit: null, note: MIXED_LIMIT })
  })
})

describe('Change bid — the form and the buttons', () => {
  it('labels each field for the How chosen; the limit reads Not above or Not below', () => {
    const f = adjustForm([row()], draft('set', '', ''), currencySymbol)
    expect(f.hows.map((h) => h.label)).toEqual(['Set to €', 'Raise by €', 'Lower by €', 'Raise by %', 'Lower by %'])
    expect(f.amount).toMatchObject({ label: 'New bid', prefix: '€', placeholder: '0.40' })
    expect(f.limit).toMatchObject({ label: 'Not above', prefix: '€', placeholder: 'No limit' })
    expect(f.note).toBeNull()
    expect(adjustForm([row(), row({ targetId: 't2' })], draft('set', ''), currencySymbol).amount?.placeholder).toBe('0.50')
    expect(adjustForm([row()], draft('lowerBy', ''), currencySymbol)).toMatchObject({ amount: { label: 'Amount', prefix: '€' }, limit: { label: 'Not below' } })
    expect(adjustForm([row({ currency: 'GBP', market: 'UK' })], draft('raiseBy', '0.1', 'x'), currencySymbol)).toMatchObject({ amount: { prefix: '£' }, limit: { error: 'Type a bid like 0.45' } })
  })

  it('another How starts the value empty, and the limit too when its side turns', () => {
    const d = draft('raiseBy', '0.05', '0.80')
    expect(withHow(d, 'raiseBy')).toBe(d)
    expect(withHow(d, 'raisePct')).toEqual(draft('raisePct', '', '0.80'))
    expect(withHow(d, 'set')).toEqual(draft('set', '', '0.80'))
    expect(withHow(d, 'lowerPct')).toEqual(draft('lowerPct', '', ''))
    expect(withHow(draft('lowerBy', '0.05', '0.20'), 'lowerPct')).toEqual(draft('lowerPct', '', '0.20'))
  })

  it('counts the Send button and names the dialog', () => {
    expect(sendLabel(0)).toBe('Send bids')
    expect(sendLabel(1)).toBe('Send 1 bid')
    expect(sendLabel(12)).toBe('Send 12 bids')
    expect(changeTitle(1)).toBe('Change bid')
    expect(changeTitle(3)).toBe('Change 3 bids')
  })

  it('holds Change bid with the reason when nothing selected can change — never for who sets the bid', () => {
    expect(changeHeld([row()], true)).toBeNull()
    for (const owner of [{ kind: 'PERSON', name: 'You', id: 'you' }, { kind: 'RULE', name: 'Cut losers', id: 'r1' }, { kind: 'BRAIN', name: 'Brain', id: 'brain' }] as const) {
      expect(changeHeld([row({ owner })], true)).toBeNull()
    }
    expect(changeHeld([row()], false)).toBe('Needs the ads bids permission')
    // The market's reason first, as on every control of the detail.
    expect(changeHeld([row({}, { writeBlock: 'Reading only' })], false)).toBe('Reading only')
    expect(changeHeld([], true)).toBe('Select the keywords first')
    expect(changeHeld([row({ bidNow: undefined })], true)).toBe('Bids are hidden for you')
    const ro = row({}, { writeBlock: 'Reading only: writes are off for this market' })
    expect(changeHeld([ro], true)).toBe('Reading only: writes are off for this market')
    expect(changeHeld([ro, row({ bidNow: undefined })], true)).toBe('Nothing to change: Reading only: writes are off for this market; Bids are hidden for you')
    expect(changeHeld([ro, row()], true)).toBeNull()
  })
})
