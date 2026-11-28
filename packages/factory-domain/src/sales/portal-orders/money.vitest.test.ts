import { describe, expect, it } from 'vitest'
import { MONEY_WORDS, noticeProblem, stepStateOf } from './money'

/** owb- po2.2: the customer's Money tab — a step's state and when "I paid" is refused (design § 5m "no loophole"). */
describe('the payment plan’s steps', () => {
  const today = '2026-11-28'
  it('paid, part paid, due, late and later', () => {
    expect(stepStateOf({ amount: 300, paid: 300, due: '2026-11-01', settled: false, dueWithoutDay: true }, today)).toBe('PAID')
    expect(stepStateOf({ amount: 300, paid: 0, due: null, settled: true, dueWithoutDay: false }, today)).toBe('PAID')
    expect(stepStateOf({ amount: 300, paid: 100, due: '2026-11-01', settled: false, dueWithoutDay: true }, today)).toBe('PART_PAID')
    expect(stepStateOf({ amount: 300, paid: 0, due: '2026-11-27', settled: false, dueWithoutDay: true }, today)).toBe('LATE')
    expect(stepStateOf({ amount: 300, paid: 0, due: today, settled: false, dueWithoutDay: true }, today)).toBe('DUE')
    expect(stepStateOf({ amount: 300, paid: 0, due: '2026-12-20', settled: false, dueWithoutDay: true }, today)).toBe('LATER')
    expect(stepStateOf({ amount: 700, paid: 0, due: null, settled: false, dueWithoutDay: false }, today)).toBe('LATER')
    expect(stepStateOf({ amount: 300, paid: 0, due: null, settled: false, dueWithoutDay: true }, today)).toBe('DUE')
  })
})

describe('"I paid: tell the factory…"', () => {
  const today = '2026-11-28'
  it('refused when nothing is still to pay, for no amount, above what is open, or on a day ahead', () => {
    expect(noticeProblem({ amount: 100, stillToPay: 0, paidOn: today, today })).toBe('NOTHING_TO_PAY')
    expect(noticeProblem({ amount: 0, stillToPay: 500, paidOn: today, today })).toBe('AMOUNT')
    expect(noticeProblem({ amount: 501, stillToPay: 500, paidOn: today, today })).toBe('TOO_MUCH')
    expect(noticeProblem({ amount: 500, stillToPay: 500, paidOn: '2026-11-29', today })).toBe('FUTURE')
    expect(noticeProblem({ amount: 500, stillToPay: 500, paidOn: '2026-11-20', today })).toBeNull()
  })

  it('says every refusal in English and Italian ("voi")', () => {
    for (const words of Object.values(MONEY_WORDS)) {
      expect(words.en.length).toBeGreaterThan(10)
      expect(words.it.length).toBeGreaterThan(10)
    }
    expect(MONEY_WORDS.STEP.it).toContain('Scegliete')
  })
})
