import { describe, expect, it } from 'vitest'
import { canFor } from '../demo/fixtures'
import { ESTIMATES_ACCEPTED, ESTIMATES_DECLINED, ESTIMATES_DRAFT, ESTIMATES_HISTORY, ESTIMATES_NO_PRICES, ESTIMATES_NONE, ESTIMATES_SENT } from './demo/fixtures'
import { answerProblems, blankLine, cellBody, decimalOf, decisionWords, estimateHeld, lineBody, lineDraftProblems, minutesOf, newEstimateHeld, shownEstimate, termsBody, termsOf, termsProblems, workHeldWords } from './model'

const owner = canFor('owner')
const TODAY = '2026-10-31'

describe("a repair's Estimate tab (B-W2b-352)", () => {
  it('decimals as the API wants them; minutes whole', () => {
    expect(decimalOf(' 12,5 ', 'price')).toBe('12.5')
    expect(decimalOf('1.23456', 'quantity')).toBeNull()
    expect(decimalOf('', 'price')).toBeNull()
    expect(minutesOf('40')).toBe(40)
    expect(minutesOf('0')).toBeNull()
    expect(minutesOf('4.5')).toBeNull()
  })

  it('the revision shown: the one asked, else the newest', () => {
    expect(shownEstimate(ESTIMATES_NONE, null)).toBeNull()
    expect(shownEstimate(ESTIMATES_HISTORY, null)?.revision).toBe(2)
    expect(shownEstimate(ESTIMATES_HISTORY, ESTIMATES_HISTORY.estimates[1]!.id)?.revision).toBe(1)
    expect(shownEstimate(ESTIMATES_HISTORY, 'gone')?.revision).toBe(2)
  })

  it('a cell sends one field; a bad value sends nothing', () => {
    const labour = { kind: 'LABOUR' as const }
    const part = { kind: 'PART' as const }
    expect(cellBody('quantity', '2', part)).toEqual({ quantity: '2' })
    expect(cellBody('quantity', '0', part)).toBeNull()
    expect(cellBody('unitPrice', '24,00', part)).toEqual({ unitPrice: '24.00' })
    expect(cellBody('minutes', '40', part)).toBeNull()
    expect(cellBody('minutes', '40', labour)).toEqual({ minutes: 40 })
    expect(cellBody('unitCost', '', part)).toEqual({ unitCost: null })
    expect(cellBody('description', 'two\nlines', part)).toBeNull()
  })

  it('a new line: what stops it, and what it sends (the cost only with the cost grain)', () => {
    expect(lineDraftProblems(blankLine('LABOUR')).map((entry) => entry.field)).toEqual(['description', 'minutes', 'unitPrice'])
    const draft = { ...blankLine('LABOUR'), description: ' Re-sew ', minutes: '30', unitPrice: '25', unitCost: '10' }
    expect(lineDraftProblems(draft)).toEqual([])
    expect(lineBody(draft, true)).toEqual({ kind: 'LABOUR', description: 'Re-sew', quantity: '1', unitPrice: '25', minutes: 30, unitCost: '10' })
    expect(lineBody(draft, false)).not.toHaveProperty('unitCost')
    expect(lineBody({ ...draft, kind: 'PART' }, false)).not.toHaveProperty('minutes')
  })

  it('each step held with why: the role, the prices, the state', () => {
    const draft = ESTIMATES_DRAFT.estimates[0]!
    expect(estimateHeld('edit', draft, ESTIMATES_DRAFT, owner, false, TODAY)).toBeNull()
    expect(estimateHeld('send', draft, ESTIMATES_DRAFT, owner, false, TODAY)).toBeNull()
    expect(estimateHeld('edit', draft, ESTIMATES_DRAFT, canFor('warehouse'), false, TODAY)).toEqual({ key: 'held.right.repairsManage' })
    expect(estimateHeld('edit', ESTIMATES_NO_PRICES.estimates[0]!, ESTIMATES_NO_PRICES, owner, false, TODAY)).toEqual({ key: 'depth:estimate.held.prices' })
    expect(estimateHeld('send', draft, ESTIMATES_DRAFT, owner, true, TODAY)).toEqual({ key: 'held.offline' })
    const sent = ESTIMATES_SENT.estimates[0]!
    expect(estimateHeld('edit', sent, ESTIMATES_SENT, owner, false, TODAY)).toEqual({ key: 'depth:estimate.held.edit.SENT' })
    expect(estimateHeld('answer', sent, ESTIMATES_SENT, owner, false, TODAY)).toBeNull()
    expect(estimateHeld('send', sent, ESTIMATES_SENT, owner, false, TODAY)).toEqual({ key: 'depth:estimate.held.sentAlready' })
    expect(estimateHeld('answer', draft, ESTIMATES_DRAFT, owner, false, TODAY)).toEqual({ key: 'depth:estimate.held.notSent' })
    expect(estimateHeld('send', { ...draft, lines: [], actions: draft.actions.map((entry) => ({ ...entry, allowed: false })) }, ESTIMATES_DRAFT, owner, false, TODAY)).toEqual({ key: 'depth:estimate.held.noLines' })
  })

  it('New estimate: allowed, or held by the open draft', () => {
    expect(newEstimateHeld(ESTIMATES_NONE, owner, false)).toBeNull()
    expect(newEstimateHeld(ESTIMATES_DRAFT, owner, false)).toEqual({ key: 'depth:estimate.held.draftOpen', params: { revision: 1 } })
    expect(newEstimateHeld(ESTIMATES_SENT, owner, false)).toBeNull()
  })

  it('what the estimate holds of the work, and the decision in words', () => {
    expect(workHeldWords(ESTIMATES_SENT, 'approve')).toEqual({ key: 'depth:estimate.work.waiting', params: { revision: 1 } })
    expect(workHeldWords(ESTIMATES_DECLINED, 'startRepair')).toEqual({ key: 'depth:estimate.work.declined', params: { revision: 1 } })
    expect(workHeldWords(ESTIMATES_DRAFT, 'approve')).toBeNull()
    expect(decisionWords(ESTIMATES_ACCEPTED.estimates[0]!)).toEqual({ key: 'depth:estimate.decision.ACCEPTED.PORTAL', params: { name: 'Mario Esempio' } })
    expect(decisionWords(ESTIMATES_DECLINED.estimates[0]!)).toEqual({ key: 'depth:estimate.decision.DECLINED.OFFICE', params: { name: 'Mario Esempio' } })
    expect(decisionWords(ESTIMATES_DRAFT.estimates[0]!)).toBeNull()
  })

  it('the answer and the terms', () => {
    expect(answerProblems({ answer: '', how: '', name: '', declineReason: '' }).map((words) => words.key)).toEqual(['depth:estimate.answer.problem.answer', 'depth:estimate.answer.problem.how'])
    expect(answerProblems({ answer: 'DECLINED', how: 'phone', name: '', declineReason: '' }).map((words) => words.key)).toEqual(['depth:estimate.answer.problem.reason'])
    const terms = termsOf(ESTIMATES_DRAFT.estimates[0]!)
    expect(termsProblems({ ...terms, validUntil: '2026-10-01' }, TODAY)).toEqual([{ key: 'depth:estimate.terms.problem.past' }])
    expect(termsBody({ ...terms, internalNote: ' call first ' }, { status: 'SENT' })).toEqual({ internalNote: 'call first' })
    expect(termsBody(terms, { status: 'DRAFT' })).toEqual({ validUntil: '2026-11-15', customerNote: 'Valid for 15 days (made-up).', internalNote: null })
  })
})
