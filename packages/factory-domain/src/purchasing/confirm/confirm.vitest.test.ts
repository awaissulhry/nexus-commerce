import { describe, expect, it } from 'vitest'
import { ValidationError } from '../../core/errors'
import { answerProblem, answerSummary, declineText, lineAnswerText, outcomeOf, planAnswer, type AskedLine, type ConfirmInput } from './answer'
import { buyerNote, doneMessage } from './notes'
import { renewalRefusal, type RenewFacts } from './renew'

const TODAY = '2026-11-02'
const LINES: AskedLine[] = [
  { id: '00000000-0000-7000-8000-000000000010', seq: 10, quantity: '1200.0000', uom: 'FT2', needDate: '2026-11-20' },
  { id: '00000000-0000-7000-8000-000000000020', seq: 20, quantity: '5.0000', uom: 'HIDE', needDate: '2026-11-25' },
  { id: '00000000-0000-7000-8000-000000000030', seq: 30, quantity: '24.0000', uom: 'PCS', needDate: '2026-12-01' },
]
const [L10, L20, L30] = LINES.map((line) => line.id) as [string, string, string]

const issuesOf = (work: () => unknown) => {
  try {
    work()
  } catch (error) {
    if (error instanceof ValidationError) return error.issues
    throw error
  }
  throw new Error('expected a ValidationError')
}

describe('the answer (SCM-085): confirm all as asked, or line by line', () => {
  it('confirm all as asked: every line at its quantity by its need date → CONFIRMED', () => {
    const plan = planAnswer(LINES, { mode: 'ALL_AS_ASKED', supplierRef: ' OC-4711 ', note: '' }, TODAY)
    expect(plan.outcome).toBe('CONFIRMED')
    expect(plan.lines.map((line) => [line.seq, line.kind, line.quantity, line.date])).toEqual([
      [10, 'AS_ASKED', '1200.0000', '2026-11-20'],
      [20, 'AS_ASKED', '5.0000', '2026-11-25'],
      [30, 'AS_ASKED', '24.0000', '2026-12-01'],
    ])
    expect(plan).toMatchObject({ supplierRef: 'OC-4711', note: null, declineReason: null, summary: 'all 3 lines as asked' })
  })

  it('line by line, every line as asked is the same confirmation', () => {
    const plan = planAnswer(LINES, { mode: 'BY_LINE', lines: [L30, L10, L20].map((lineId) => ({ lineId, answer: 'AS_ASKED' as const })) }, TODAY)
    expect(plan.outcome).toBe('CONFIRMED')
    expect(plan.lines.map((line) => line.seq)).toEqual([10, 20, 30])
  })

  it('exceptions are a proposal for the buyer: other date, other quantity, split, cannot deliver, each with its reason', () => {
    const input: ConfirmInput = {
      mode: 'BY_LINE',
      lines: [
        { lineId: L10, answer: 'SPLIT', deliveries: [{ quantity: '700', date: '2026-11-27' }, { quantity: '500.5', date: '2026-11-18' }], reason: 'Two dye lots' },
        { lineId: L20, answer: 'OTHER', date: '2026-11-30', reason: ' Tannery closed a week ' },
        { lineId: L30, answer: 'OTHER', quantity: '12', reason: 'Only 12 in stock' },
      ],
      note: 'Call us for the rest',
    }
    const plan = planAnswer(LINES, input, TODAY)
    expect(plan.outcome).toBe('PROPOSED')
    // The split: sorted by date, 500.5 + 700 = 1200.5 ft² (a little more), complete on the later date.
    expect(plan.lines[0]).toMatchObject({ kind: 'SPLIT', quantity: '1200.5000', date: '2026-11-27', deliveries: [{ quantity: '500.5000', date: '2026-11-18' }, { quantity: '700.0000', date: '2026-11-27' }], changes: ['SPLIT', 'LATER', 'MORE'] })
    expect(plan.lines[1]).toMatchObject({ kind: 'OTHER', quantity: '5.0000', date: '2026-11-30', reason: 'Tannery closed a week', changes: ['LATER'] })
    expect(plan.lines[2]).toMatchObject({ kind: 'OTHER', quantity: '12.0000', date: '2026-12-01', changes: ['LESS'] })
    expect(plan.counts).toEqual({ lines: 3, asAsked: 0, laterDate: 2, earlierDate: 0, otherQuantity: 2, split: 1, cannotDeliver: 0 })
    expect(plan.summary).toBe('2 later dates · 2 other quantities · 1 split')
    expect(lineAnswerText(plan.lines[0]!)).toBe('Line 10: in two deliveries, 500.5 ft² by 2026-11-18 and 700 ft² by 2026-11-27 (asked 1200 ft² by 2026-11-20). Reason: Two dye lots')
    expect(lineAnswerText(plan.lines[2]!)).toBe('Line 30: 12 PCS by 2026-12-01 (asked 24 PCS by 2026-12-01). Reason: Only 12 in stock')
  })

  it('one line it cannot deliver among others is a proposal too; every line it cannot deliver is a decline with the reasons', () => {
    const mixed = planAnswer(LINES, { mode: 'BY_LINE', lines: [{ lineId: L10, answer: 'AS_ASKED' }, { lineId: L20, answer: 'AS_ASKED' }, { lineId: L30, answer: 'CANNOT_DELIVER', reason: 'Discontinued' }] }, TODAY)
    expect(mixed).toMatchObject({ outcome: 'PROPOSED', summary: '2 lines as asked · 1 line it cannot deliver' })
    expect(mixed.lines[2]).toMatchObject({ quantity: '0.0000', date: null, deliveries: [], changes: ['CANNOT_DELIVER'] })

    const none = planAnswer(LINES, { mode: 'BY_LINE', lines: LINES.map((line) => ({ lineId: line.id, answer: 'CANNOT_DELIVER' as const, reason: 'Plant closed' })), note: 'Sorry' }, TODAY)
    expect(none.outcome).toBe('DECLINED')
    expect(none.declineReason).toBe(
      [
        'Cannot deliver any line of the order.',
        'Line 10: cannot deliver (asked 1200 ft² by 2026-11-20). Reason: Plant closed',
        'Line 20: cannot deliver (asked 5 HIDE by 2026-11-25). Reason: Plant closed',
        'Line 30: cannot deliver (asked 24 PCS by 2026-12-01). Reason: Plant closed',
        'Note: Sorry',
      ].join('\n'),
    )
  })

  it('refuses an incomplete answer, naming every problem at once', () => {
    const issues = issuesOf(() =>
      planAnswer(
        LINES,
        {
          mode: 'BY_LINE',
          lines: [
            { lineId: L10, answer: 'OTHER', quantity: '1200', date: '2026-11-20', reason: 'x' },
            { lineId: L10, answer: 'AS_ASKED' },
            { lineId: L20, answer: 'OTHER', date: '2026-11-01', quantity: '-1' },
            { lineId: '00000000-0000-7000-8000-000000000099', answer: 'AS_ASKED' },
          ],
          supplierRef: 'x'.repeat(61),
        },
        TODAY,
      ),
    )
    expect(issues).toEqual([
      { path: 'body/supplierRef', message: 'At most 60 characters.' },
      { path: 'body/lines/0', message: 'That is the quantity and date asked: answer "as asked".' },
      { path: 'body/lines/1/lineId', message: 'Line 10 is answered twice.' },
      { path: 'body/lines/2/quantity', message: 'Give a quantity above 0 (or answer that you cannot deliver the line).' },
      { path: 'body/lines/2/date', message: 'Give a date from today on.' },
      { path: 'body/lines/2/reason', message: 'Say why (a few words for the buyer).' },
      { path: 'body/lines/3/lineId', message: 'Not a line of this order.' },
      { path: 'body/lines', message: 'Answer line 30 too.' },
    ])
    expect(issuesOf(() => planAnswer(LINES, { mode: 'BY_LINE', lines: [{ lineId: L10, answer: 'SPLIT', deliveries: [{ quantity: '600', date: '2026-11-20' }], reason: 'r' }, { lineId: L20, answer: 'AS_ASKED', reason: 'why not' }, { lineId: L30, answer: 'SPLIT', deliveries: [{ quantity: '12', date: '2026-12-01' }, { quantity: '12', date: '2026-12-01' }], reason: 'r' }] }, TODAY))).toEqual([
      { path: 'body/lines/0/deliveries', message: 'A split is 2 deliveries, each with its quantity and date.' },
      { path: 'body/lines/1/reason', message: 'Not part of an answer AS_ASKED.' },
      { path: 'body/lines/2/deliveries/1/date', message: 'The two deliveries are on two different days.' },
    ])
    expect(issuesOf(() => planAnswer(LINES, { mode: 'ALL_AS_ASKED', lines: [{ lineId: L10, answer: 'AS_ASKED' }] }, TODAY))).toEqual([{ path: 'body/lines', message: '"Confirm all as asked" takes no lines: answer line by line instead.' }])
    expect(issuesOf(() => planAnswer(LINES, { mode: 'BY_LINE', lines: [{ lineId: L10, answer: 'OTHER', date: '2028-11-03', reason: 'r' }, { lineId: L20, answer: 'OTHER', reason: 'r' }, { lineId: L30, answer: 'OTHER', quantity: '1.23456', reason: 'r' }] }, TODAY))).toEqual([
      { path: 'body/lines/0/date', message: 'Give a date within two years.' },
      { path: 'body/lines/1', message: 'Give the other quantity, the other date, or both.' },
      { path: 'body/lines/2/quantity', message: 'Give the quantity as a number with at most four decimals.' },
    ])
  })

  it('only a SENT order waits for an answer; the others say why in words', () => {
    expect(answerProblem('SENT')).toBeNull()
    expect(answerProblem('CONFIRMED')).toMatch(/confirmed already/)
    expect(answerProblem('PARTLY_RECEIVED')).toMatch(/received already/)
    expect(answerProblem('CANCELLED')).toBe('This order is cancelled: it needs no answer.')
    expect(answerProblem('CHANGES_PROPOSED')).toMatch(/with the buyer/)
  })

  it('THE outcome rule: all as asked → CONFIRMED, all cannot deliver → DECLINED, anything else → PROPOSED', () => {
    expect(outcomeOf([{ kind: 'AS_ASKED' }, { kind: 'AS_ASKED' }])).toBe('CONFIRMED')
    expect(outcomeOf([{ kind: 'CANNOT_DELIVER' }])).toBe('DECLINED')
    expect(outcomeOf([{ kind: 'AS_ASKED' }, { kind: 'CANNOT_DELIVER' }])).toBe('PROPOSED')
    expect(outcomeOf([{ kind: 'OTHER' }])).toBe('PROPOSED')
    expect(answerSummary({ lines: 1, asAsked: 1, laterDate: 0, earlierDate: 0, otherQuantity: 0, split: 0, cannotDeliver: 0 })).toBe('the line as asked')
  })
})

describe('decline, words for people', () => {
  it('a decline has a reason; "another reason" needs its note', () => {
    expect(declineText({ reason: 'NO_CAPACITY' })).toBe('No capacity for this order.')
    expect(declineText({ reason: 'MATERIAL_NOT_AVAILABLE', note: ' Hides sold out ' })).toBe('The material is not available: Hides sold out')
    expect(issuesOf(() => declineText({ reason: 'OTHER', note: ' ' }))).toEqual([{ path: 'body/note', message: 'Say why you decline the order.' }])
    expect(issuesOf(() => declineText({ reason: 'LATER' as never }))).toEqual([{ path: 'body/reason', message: 'Expected one of NO_CAPACITY, MATERIAL_NOT_AVAILABLE, OTHER.' }])
  })

  it("the link page's end state and the buyer's note", () => {
    expect(doneMessage('CONFIRMED', 'Bianca Buyer')).toBe('Confirmed — thank you. Bianca Buyer sees it now. Need to change something later? Reply to our e-mail.')
    expect(doneMessage('PROPOSED', null)).toMatch(/^Thank you: your changes are with the buyer/)
    expect(buyerNote({ documentNumber: 'PO-2026-0001', outcome: 'CONFIRMED', byName: 'Mario Rossi', supplierRef: 'OC-1', note: 'Thanks', summary: 'all 3 lines as asked' })).toBe(
      'The supplier confirmed PO-2026-0001 through its link by Mario Rossi (their reference OC-1): all 3 lines as asked.\nTheir note: Thanks',
    )
    expect(buyerNote({ documentNumber: 'PO-2026-0001', outcome: 'DECLINED', byName: null, supplierRef: null, note: null, summary: null, declineReason: 'No capacity for this order.' })).toBe(
      'The supplier declined PO-2026-0001 through its link.\nNo capacity for this order.\nChange the order and send it again, or cancel it.',
    )
    expect(buyerNote({ documentNumber: 'PO-2026-0001', outcome: 'PROPOSED', byName: null, supplierRef: null, note: null, summary: '1 later date', lines: ['Line 10: …'] })).toMatch(/^The supplier proposed changes to PO-2026-0001 through its link: 1 later date\.\nLine 10: …\nAccept or refuse them/)
  })
})

describe('ask for a new link: only an expired link of an order that still waits, only to the address on file', () => {
  const base: RenewFacts = { purpose: 'PO_CONFIRM', recordType: 'PurchaseOrder', state: 'EXPIRED', orderStatus: 'SENT', liveLinks: 0, email: 'orders@example.com', contact: { email: 'Orders@Example.com ', status: 'ACTIVE' }, askedRecently: false }
  it('renews an expired link to the same address', () => {
    expect(renewalRefusal(base)).toBeNull()
  })
  it('refuses everything else, in order', () => {
    expect(renewalRefusal({ ...base, purpose: 'DOCUMENT_VIEW' })).toBe('NOT_A_CONFIRM_LINK')
    expect(renewalRefusal({ ...base, orderStatus: null })).toBe('NOT_A_CONFIRM_LINK')
    expect(renewalRefusal({ ...base, state: 'REVOKED' })).toBe('WITHDRAWN')
    expect(renewalRefusal({ ...base, state: 'USED_UP' })).toBe('ANSWERED')
    expect(renewalRefusal({ ...base, state: 'LIVE' })).toBe('STILL_LIVE')
    expect(renewalRefusal({ ...base, orderStatus: 'CANCELLED' })).toBe('ORDER_NOT_WAITING')
    expect(renewalRefusal({ ...base, liveLinks: 1 })).toBe('NEWER_LINK')
    expect(renewalRefusal({ ...base, email: null })).toBe('NO_ADDRESS')
    expect(renewalRefusal({ ...base, contact: { email: 'someone.else@example.com', status: 'ACTIVE' } })).toBe('ADDRESS_NOT_ON_FILE')
    expect(renewalRefusal({ ...base, contact: { email: 'orders@example.com', status: 'ARCHIVED' } })).toBe('ADDRESS_NOT_ON_FILE')
    expect(renewalRefusal({ ...base, contact: null })).toBe('ADDRESS_NOT_ON_FILE')
    expect(renewalRefusal({ ...base, askedRecently: true })).toBe('ASKED_RECENTLY')
  })
})
