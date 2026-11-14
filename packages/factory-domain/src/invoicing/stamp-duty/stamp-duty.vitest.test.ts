import { describe, expect, it } from 'vitest'
import { nonTaxable, taxable } from '../../tax/vat-treatment'
import { computeInvoiceTotals, type CoreLine } from '../invoices'
import { decideStampDuty, paymentDueOf, quarterEndOf, quarterLabel, quarterStartOf, quarterStateOf, stampDutyIssueProblems, stampDutyLine, stampDutyWords } from './stamp-duty'

// B-W2b-392 (FIN-101): every amount here is made up.
const goods = (unitPrice: string, vat = nonTaxable('N3.5', 'Art. 8 c.1 lett. c) DPR 633/1972')): CoreLine => ({ kind: 'GOODS', description: 'Giacca', quantity: '1', unitPrice, vat })
const decide = (lines: CoreLine[], values: Partial<Parameters<typeof decideStampDuty>[0]> = {}) => decideStampDuty({ docType: 'TD01', currency: 'EUR', basis: 'NET', lines, switchOn: true, ...values })

describe('stamp duty decided on a draft (W1 rule; the charge to the customer, Owner 11-13)', () => {
  it('is due above 77.47 EUR of VAT-free amounts, never on exports, intra-EU supplies or taxable lines', () => {
    expect(decide([goods('77.47')])).toEqual({ amount: null, charge: false, reason: 'NOT_DUE' })
    expect(decide([goods('77.48')])).toEqual({ amount: 200, charge: true, reason: 'DUE' })
    expect(decide([goods('500.00', nonTaxable('N3.1', 'Art. 8'))]).reason).toBe('NOT_DUE')
    expect(decide([goods('500.00', nonTaxable('N3.2', 'Art. 41'))]).reason).toBe('NOT_DUE')
    expect(decide([goods('500.00', taxable(22))]).reason).toBe('NOT_DUE')
    expect(decide([]).reason).toBe('NOT_DUE')
  })

  it('is charged only while the switch is on, on a type that bills goods or services, in euro', () => {
    expect(decide([goods('100.00')], { switchOn: false })).toEqual({ amount: 200, charge: false, reason: 'SWITCH_OFF' })
    expect(decide([goods('100.00')], { docType: 'TD04' })).toMatchObject({ charge: false, reason: 'NOT_CHARGED_ON_TYPE' })
    expect(decide([goods('100.00')], { docType: 'TD02' })).toMatchObject({ amount: 200, charge: false, reason: 'NOT_CHARGED_ON_TYPE' })
    expect(decide([goods('100.00')], { currency: 'USD' })).toMatchObject({ charge: false, reason: 'NOT_EURO' })
    for (const docType of ['TD01', 'TD24', 'TD05']) expect(decide([goods('100.00')], { docType }).charge).toBe(true)
  })

  it('the line: one unit, the amount, rate 0, N1 with its law; the totals keep the same stamp duty with it', () => {
    const line = stampDutyLine(200, null)
    expect(line).toMatchObject({ kind: 'CHARGE', quantity: '1', unitPrice: '2.00', vat: { kind: 'NON_TAXABLE', natura: 'N1', legalReference: 'Art. 15 DPR 633/1972' } })
    expect(stampDutyLine(200, 'Art. 15 c.1 n. 3 DPR 633/1972').vat).toMatchObject({ legalReference: 'Art. 15 c.1 n. 3 DPR 633/1972' })
    const totals = computeInvoiceTotals([goods('100.00'), line], 'NET', 'EUR')
    expect(totals).toMatchObject({ netTotal: 10_200, vatTotal: 0, grossTotal: 10_200, stampDutyAmount: 200 })
  })

  it('the pre-check asks the line the rule decides now, in words', () => {
    const due = decide([goods('100.00')])
    expect(stampDutyIssueProblems(due, 200)).toEqual([])
    expect(stampDutyIssueProblems(due, null)).toEqual([{ code: 'STAMP_DUTY', path: 'lines/stampDuty', message: 'Stamp duty of 2.00 EUR is due and charged to the customer as a line. The line is not on the invoice yet: save the draft again to add it.' }])
    expect(stampDutyIssueProblems(decide([goods('10.00')]), 200)[0]!.message).toContain('no longer charges')
    expect(stampDutyIssueProblems(decide([goods('100.00')], { switchOn: false }), null)).toEqual([])
    expect(stampDutyWords(decide([goods('100.00')], { switchOn: false }))).toContain('waits for the accountant')
  })
})

describe("the quarter's total for payment", () => {
  it('names the calendar quarter of a day', () => {
    expect(quarterStartOf('2026-11-14')).toBe('2026-10-01')
    expect(quarterStartOf('2026-03-31')).toBe('2026-01-01')
    expect(quarterEndOf('2026-10-01')).toBe('2026-12-31')
    expect(quarterEndOf('2028-01-01')).toBe('2028-03-31')
    expect(quarterLabel('2026-07-01')).toBe('Q3 2026')
  })

  it('is due by the rule (UNVERIFIED): small first quarters go later; Q4 by the end of February', () => {
    expect(paymentDueOf('2026-10-01')).toEqual({ dueOn: '2027-02-28', f24Code: '2524', deferred: false })
    expect(paymentDueOf('2027-10-01')).toEqual({ dueOn: '2028-02-29', f24Code: '2524', deferred: false })
    expect(paymentDueOf('2026-07-01')).toEqual({ dueOn: '2026-11-30', f24Code: '2523', deferred: false })
    expect(paymentDueOf('2026-01-01', { q1: 600, q2: 400 })).toEqual({ dueOn: '2026-11-30', f24Code: '2521', deferred: true })
    expect(paymentDueOf('2026-01-01', { q1: 300_000, q2: 300_000 })).toEqual({ dueOn: '2026-09-30', f24Code: '2521', deferred: true })
    expect(paymentDueOf('2026-01-01', { q1: 600_000 })).toEqual({ dueOn: '2026-05-31', f24Code: '2521', deferred: false })
    expect(paymentDueOf('2026-04-01', { q1: 600_000 })).toEqual({ dueOn: '2026-09-30', f24Code: '2522', deferred: false })
  })

  it('is open, to pay, late or paid', () => {
    expect(quarterStateOf('2026-10-01', false, '2027-02-28', '2026-11-14')).toBe('OPEN')
    expect(quarterStateOf('2026-07-01', false, '2026-11-30', '2026-11-14')).toBe('TO_PAY')
    expect(quarterStateOf('2026-07-01', false, '2026-11-30', '2026-12-01')).toBe('LATE')
    expect(quarterStateOf('2026-07-01', true, '2026-11-30', '2026-12-01')).toBe('PAID')
  })
})
