import { describe, expect, it } from 'vitest'
import {
  aboveSoldWords,
  closeWarningsOf,
  canMove,
  decisionProblems,
  defaultCredit,
  effectWithAmount,
  effectWords,
  followUpOf,
  freightPayerOf,
  goodsDueByOf,
  isSafetyReturn,
  leftOf,
  OUTCOMES_BY_DISPOSITION,
  policyInForce,
  policyProblems,
  restockHeldWords,
  returnActions,
  RETURN_MOVES,
  RETURN_STATUSES,
  statusWords,
  suggestedOutcome,
  trackingOf,
  valueOf,
  windowWarning,
} from './rules'

describe('the RMA moves (the …_sales_w2a_guards trigger’s)', () => {
  it('starts authorised in the office, receives, inspects and closes; final states never move', () => {
    expect(canMove('AUTHORISED', 'RECEIVED')).toBe(true)
    expect(canMove('RECEIVED', 'INSPECTED')).toBe(true)
    expect(canMove('INSPECTED', 'RECEIVED')).toBe(true)
    expect(canMove('INSPECTED', 'CLOSED')).toBe(true)
    expect(canMove('RECEIVED', 'CANCELLED')).toBe(false)
    for (const final of ['CLOSED', 'REJECTED', 'CANCELLED'] as const) expect(RETURN_MOVES[final]).toEqual([])
    expect(Object.keys(RETURN_MOVES)).toEqual([...RETURN_STATUSES])
  })
})

describe('the return policy', () => {
  it('takes each field from the company, else from the tenant', () => {
    expect(policyInForce({ windowDays: 14, goodsDueDays: null }, { windowDays: 30, goodsDueDays: 15, freightPaidBy: 'BY_CAUSE', restockingFeePct: '10', conditions: 'Unworn' })).toEqual({
      windowDays: 14,
      goodsDueDays: 15,
      freightPaidBy: 'BY_CAUSE',
      restockingFeePct: '10',
      conditions: 'Unworn',
    })
  })
  it('refuses days outside 1–365 and a fee outside (0, 100]', () => {
    expect(policyProblems({ windowDays: 0, goodsDueDays: 366, freightPaidBy: null, restockingFeePct: '0', conditions: null }).map((problem) => problem.path)).toEqual(['windowDays', 'goodsDueDays', 'restockingFeePct'])
    expect(policyProblems({ windowDays: 30, goodsDueDays: 15, freightPaidBy: 'COMPANY', restockingFeePct: '12.5', conditions: 'x' })).toEqual([])
  })
  it('dates the goods from the authorisation and warns (never refuses) past the window', () => {
    expect(goodsDueByOf('2026-11-05', { goodsDueDays: 15 })).toBe('2026-11-20')
    expect(goodsDueByOf('2026-11-05', { goodsDueDays: null })).toBeNull()
    expect(windowWarning('2026-10-01', '2026-10-31', { windowDays: 30 })).toBeNull()
    expect(windowWarning('2026-10-01', '2026-11-15', { windowDays: 30 })).toBe('Delivered 45 days ago (2026-10-01); the return window is 30 days.')
  })
  it('lets the cause decide who pays the freight when the policy says so', () => {
    expect(freightPayerOf({ freightPaidBy: 'BY_CAUSE' }, 'OUR_DEFECT')).toBe('COMPANY')
    expect(freightPayerOf({ freightPaidBy: 'BY_CAUSE' }, 'NO_FAULT')).toBe('CUSTOMER')
    expect(freightPayerOf({ freightPaidBy: 'BY_CAUSE' }, null)).toBeNull()
    expect(freightPayerOf({ freightPaidBy: 'CUSTOMER' }, 'OUR_DEFECT')).toBe('CUSTOMER')
  })
})

describe('never above what was sold (SAL-335)', () => {
  it('counts other returns and the shipped bound, and says the sold number', () => {
    expect(leftOf({ sold: 2, taken: 1 })).toBe(1)
    expect(leftOf({ sold: 5, taken: 0, shippedLeft: 2 })).toBe(2)
    expect(aboveSoldWords(1, { sold: 2, taken: 1 })).toBeNull()
    expect(aboveSoldWords(2, { sold: 2, taken: 1 })).toBe('At most 1 can come back: 2 sold, 1 already on other returns.')
    expect(aboveSoldWords(1, { sold: 1, taken: 1 })).toBe('Nothing of it can come back: 1 sold, 1 already on other returns.')
  })
})

describe('grading and the suggested outcome (QHS-117)', () => {
  const jacket = { ppe: false, reasonCode: 'WRONG_SIZE', cause: null } as const
  const protective = { ppe: true, reasonCode: 'WRONG_SIZE', cause: null } as const
  it('restocks the new, sends the used protective garment to second quality, repairs the damaged, scraps the unusable', () => {
    expect(suggestedOutcome({ ...jacket, grade: 'LIKE_NEW' })).toBe('RESTOCK')
    expect(suggestedOutcome({ ...protective, grade: 'LIKE_NEW' })).toBe('SECOND_QUALITY')
    expect(suggestedOutcome({ ...jacket, grade: 'DAMAGED' })).toBe('REPAIR')
    expect(suggestedOutcome({ ...jacket, grade: 'UNUSABLE' })).toBe('SCRAP')
  })
  it('holds a protective garment returned for a defect for a safety check', () => {
    expect(isSafetyReturn({ ppe: true, reasonCode: 'DEFECT' })).toBe(true)
    expect(isSafetyReturn({ ppe: true, reasonCode: 'WRONG_SIZE', cause: 'MISUSE' })).toBe(true)
    expect(isSafetyReturn({ ppe: false, reasonCode: 'DEFECT' })).toBe(false)
    expect(suggestedOutcome({ ppe: true, reasonCode: 'DEFECT', cause: null, grade: 'NEW' })).toBe('QUARANTINE')
    expect(restockHeldWords({ ...protective, grade: 'LIKE_NEW' })).toBe('A used protective garment is never restocked as new: second quality, quarantine or scrap.')
    expect(restockHeldWords({ ...jacket, grade: 'NEW' })).toBeNull()
  })
})

describe('the decision (SAL-341)', () => {
  const facts = { received: 1, value: 42_000, grade: 'NEW', cause: 'NO_FAULT', ppe: false, reasonCode: 'WRONG_SIZE' } as const
  it('fits each disposition its outcomes and refuses the remake (made to measure, later)', () => {
    expect(decisionProblems({ disposition: 'CREDIT_ONLY', goodsOutcome: 'RESTOCK' }, facts)).toEqual([])
    expect(decisionProblems({ disposition: 'RETURN_UNCHANGED', goodsOutcome: 'RESTOCK' }, facts).map((problem) => problem.path)).toEqual(['goodsOutcome'])
    expect(decisionProblems({ disposition: 'REMAKE', goodsOutcome: 'SCRAP' }, facts)[0]!.message).toMatch(/made-to-measure/)
    expect(OUTCOMES_BY_DISPOSITION.SCRAP).toEqual(['SCRAP'])
  })
  it('never credits more than what came back is worth, and a credit only needs one', () => {
    expect(decisionProblems({ disposition: 'CREDIT_ONLY', goodsOutcome: 'RESTOCK', creditAmount: 42_001 }, facts).map((problem) => problem.message)).toEqual(['Never more than what came back is worth.'])
    expect(decisionProblems({ disposition: 'CREDIT_ONLY', goodsOutcome: 'RESTOCK', creditAmount: 0 }, facts).map((problem) => problem.message)).toEqual(['A credit only needs a credit above 0.'])
    expect(defaultCredit('CREDIT_ONLY', 42_000)).toBe(42_000)
    expect(defaultCredit('REPAIR', 42_000)).toBe(0)
  })
  it('refuses to restock a used protective garment and sends a safety return only to repair, quarantine or scrap', () => {
    expect(decisionProblems({ disposition: 'CREDIT_ONLY', goodsOutcome: 'RESTOCK' }, { ...facts, ppe: true, grade: 'GOOD' })[0]!.message).toMatch(/never restocked as new/)
    const safety = { ...facts, ppe: true, reasonCode: 'DEFECT', cause: 'OUR_DEFECT' } as const
    expect(decisionProblems({ disposition: 'CREDIT_ONLY', goodsOutcome: 'SECOND_QUALITY' }, safety)[0]!.message).toMatch(/safety check/)
    expect(decisionProblems({ disposition: 'RETURN_UNCHANGED', goodsOutcome: 'BACK_TO_CUSTOMER' }, safety)[0]!.message).toMatch(/safety check/)
    expect(decisionProblems({ disposition: 'CREDIT_ONLY', goodsOutcome: 'QUARANTINE' }, safety)).toEqual([])
  })
  it('decides only received, graded lines', () => {
    expect(decisionProblems({ disposition: 'REPAIR', goodsOutcome: 'REPAIR' }, { ...facts, received: 0 })[0]!.message).toMatch(/receive it first/)
    expect(decisionProblems({ disposition: 'REPAIR', goodsOutcome: 'REPAIR' }, { received: 1, value: null })[0]!.message).toMatch(/Grade the line first/)
  })
  it('says the effect in words, the amount only beside it', () => {
    const credit = { disposition: 'CREDIT_ONLY', goodsOutcome: 'QUARANTINE', creditAmount: 12_000 } as const
    expect(effectWords(credit, 'A1-QUA')).toBe('A credit; goods are held in quarantine at A1-QUA; a credit note to make (Finance)')
    expect(effectWithAmount(credit, 'A1-QUA', '120.00 EUR')).toBe('Credit 120.00 EUR; goods are held in quarantine at A1-QUA; a credit note to make (Finance)')
    expect(effectWords({ disposition: 'REPAIR', goodsOutcome: 'REPAIR', creditAmount: 0 })).toBe('No credit; goods go to repair; a repair order to make')
    expect(followUpOf('RETURN_UNCHANGED', 0)).toBe('RETURN_DDT')
    expect(followUpOf('SCRAP', 0)).toBeNull()
  })
  it('values the received pieces from the invoiced line, rounded once', () => {
    expect(valueOf({ netAmount: 50_000, quantity: '2.0000' }, 1, 'EUR')).toBe(25_000)
    expect(valueOf({ netAmount: 10_001, quantity: '3' }, 1, 'EUR')).toBe(3_334)
    expect(valueOf({ netAmount: null, quantity: null }, 1, 'EUR')).toBeNull()
  })
})

describe('status and tracking (SAL-362)', () => {
  const base = { requestedAt: '2026-11-05T09:00:00.000Z', authorisedAt: '2026-11-05T09:00:00.000Z', goodsDueBy: '2026-11-20', receivedAt: null, inspectedAt: null, closedAt: null, linesReceived: 0, linesDecided: 0 }
  it('shows each step with its date and what it waits for', () => {
    expect(trackingOf({ ...base, status: 'AUTHORISED' }).map((row) => [row.step, row.state])).toEqual([
      ['REQUESTED', 'DONE'],
      ['AUTHORISED', 'DONE'],
      ['GOODS_BACK', 'CURRENT'],
      ['INSPECTED', 'WAITING'],
      ['OUTCOME', 'WAITING'],
    ])
    expect(trackingOf({ ...base, status: 'AUTHORISED' })[1]!.words).toBe('Authorised: send it back by 2026-11-20')
    expect(trackingOf({ ...base, status: 'INSPECTED', receivedAt: '2026-12-01T08:15:00.000Z', inspectedAt: '2026-12-01T10:30:00.000Z', linesReceived: 1, linesDecided: 1 }).map((row) => row.state)).toEqual(['DONE', 'DONE', 'DONE', 'DONE', 'CURRENT'])
    expect(trackingOf({ ...base, status: 'CANCELLED', closedAt: '2026-11-06T00:00:00.000Z' }).at(-1)).toMatchObject({ state: 'SKIPPED', words: 'Cancelled' })
  })
  it('says a late return in its status words', () => {
    expect(statusWords({ status: 'AUTHORISED', goodsDueBy: '2026-11-20', linesReceived: 0, linesDecided: 0 }, '2026-11-25')).toBe('Goods late: due by 2026-11-20')
    expect(statusWords({ status: 'RECEIVED', goodsDueBy: null, linesReceived: 2, linesDecided: 1 }, '2026-11-25')).toBe('Received: 1 of 2 lines decided')
  })
  it('holds each action of the record with its reason', () => {
    const line: Parameters<typeof returnActions>[0]['lines'][number] = { quantity: 1, received: 1, graded: true, disposition: null, goodsOutcome: null, replaced: false }
    const byAction = (status: Parameters<typeof returnActions>[0]['status'], lines = [line]) => Object.fromEntries(returnActions({ status, lines, replacementOrder: false }).map((entry) => [entry.action, entry.held]))
    expect(byAction('AUTHORISED', [{ ...line, received: 0, graded: false }])).toMatchObject({ editLines: null, receive: null, cancel: null, close: null })
    expect(byAction('RECEIVED')).toMatchObject({ editLines: 'The goods arrived: what comes back is fixed.', cancel: 'The goods arrived: close it instead.', close: 'Decide the 1 received line(s) first.', decide: null })
    expect(byAction('INSPECTED', [{ ...line, disposition: 'REPLACE', goodsOutcome: 'RESTOCK' }])).toMatchObject({ makeReplacement: null, close: null })
    expect(byAction('CLOSED')).toMatchObject({ receive: 'The return is closed.', close: 'The return is closed.' })
  })
})

describe('closeWarningsOf (B-W2b-16: what a close leaves behind)', () => {
  const line = (over: Partial<Parameters<typeof closeWarningsOf>[0][number]>) => ({ id: 'l10', seq: 10, received: 1, disposition: null, goodsOutcome: null, replaced: false, repairs: 0, ...over })
  it('names Repair lines without a repair order for every garment received, beside the two W2a warnings', () => {
    expect(closeWarningsOf([line({ disposition: 'REPAIR', goodsOutcome: 'REPAIR' })], false)).toEqual([
      { code: 'REPAIR_WITHOUT_ORDER', path: 'repairOrder', lineIds: ['l10'], seqs: [10], message: 'Line 10 is decided Repair and no repair order was made for the garment (make it from the line, or the garment stays here unrepaired).' },
    ])
    // Two garments on the line, one repair order: still one garment without its order.
    expect(closeWarningsOf([line({ disposition: 'REPAIR', received: 2, repairs: 1 })], false)[0]).toMatchObject({ code: 'REPAIR_WITHOUT_ORDER', message: expect.stringContaining('for the garment') })
    expect(closeWarningsOf([line({ disposition: 'REPAIR', received: 2, repairs: 0 })], false)[0]!.message).toContain('for every garment')
    expect(closeWarningsOf([line({ disposition: 'REPAIR', repairs: 1 })], false)).toEqual([])
  })
  it('keeps the Replace and unchanged-goods warnings, in that order', () => {
    const lines = [line({ id: 'a', seq: 10, disposition: 'REPLACE' }), line({ id: 'b', seq: 20, disposition: 'RETURN_UNCHANGED' }), line({ id: 'c', seq: 30, disposition: 'REPAIR' })]
    expect(closeWarningsOf(lines, false).map((warning) => [warning.code, warning.seqs])).toEqual([['REPLACE_WITHOUT_ORDER', [10]], ['BACK_WITHOUT_DDT', [20]], ['REPAIR_WITHOUT_ORDER', [30]]])
    expect(closeWarningsOf(lines, true).map((warning) => warning.code)).toEqual(['REPLACE_WITHOUT_ORDER', 'REPAIR_WITHOUT_ORDER'])
    expect(closeWarningsOf([line({ id: 'a', seq: 10, disposition: 'REPLACE' }), line({ id: 'b', seq: 20, disposition: 'REPLACE' })], true)[0]!.message).toBe('Lines 10, 20 are decided Replace and no replacement order was made.')
  })
})
