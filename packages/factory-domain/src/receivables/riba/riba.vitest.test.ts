import { describe, expect, it } from 'vitest'
import { stopHolds, stopProblems, stopState } from '../stops/stops'
import { paymentNoticeMail, trustedFor, trustedSteps, trustWords } from '../notices/notices'
import { ribaInstalmentsDue, ribaPaymentReference, settleProblem, termInstalmentsOf, windowProblems } from './riba'

const TERMS = {
  condition: 'TP01',
  installments: [
    { method: 'MP12', amount: 30000, dueDate: '2026-12-31' },
    { method: 'MP12', amount: 30000, dueDate: '2026-11-30' },
    { method: 'MP05', amount: 10000, dueDate: '2027-01-31' },
  ],
}

describe('Ri.Ba. instalments and batches (FIN-126)', () => {
  it('keeps each instalment at its place; what is settled pays the oldest due day first', () => {
    expect(termInstalmentsOf(TERMS, 0).map((entry) => [entry.instalment, entry.dueDate, entry.open])).toEqual([
      [1, '2026-12-31', 30000],
      [2, '2026-11-30', 30000],
      [3, '2027-01-31', 10000],
    ])
    expect(termInstalmentsOf(TERMS, 40000).map((entry) => entry.open)).toEqual([20000, 0, 10000])
    expect(termInstalmentsOf({ installments: [{ amount: 100 }] }, 0)).toEqual([])
    expect(termInstalmentsOf(null, 0)).toEqual([])
  })

  it('collects only the open MP12 instalments due in the window', () => {
    const terms = termInstalmentsOf(TERMS, 30000)
    expect(ribaInstalmentsDue(terms, { dueFrom: '2026-11-01', dueTo: '2027-02-28' }).map((entry) => entry.instalment)).toEqual([1])
    expect(ribaInstalmentsDue(termInstalmentsOf(TERMS, 0), { dueFrom: '2026-12-01', dueTo: '2026-12-31' }).map((entry) => entry.instalment)).toEqual([1])
  })

  it('refuses a window backwards or longer than 366 days', () => {
    expect(windowProblems('2026-11-30', '2026-11-01')).toHaveLength(1)
    expect(windowProblems('2026-01-01', '2027-01-03')).toHaveLength(1)
    expect(windowProblems('2026-11-01', '2026-11-30')).toEqual([])
  })

  it('settles an item once, on or after its due day and not after today; an unpaid return carries the fee', () => {
    const item = { status: 'ISSUED' as const, dueDate: '2026-11-10' }
    expect(settleProblem(item, { status: 'PAID', settledOn: '2026-11-10' }, '2026-11-14')).toBeNull()
    expect(settleProblem(item, { status: 'PAID', settledOn: '2026-11-09' }, '2026-11-14')).toBe('BEFORE_DUE')
    expect(settleProblem(item, { status: 'PAID', settledOn: '2026-11-15' }, '2026-11-14')).toBe('FUTURE_DAY')
    expect(settleProblem(item, { status: 'PAID', settledOn: '2026-11-12', unpaidFee: 500 }, '2026-11-14')).toBe('FEE_ON_PAID')
    expect(settleProblem(item, { status: 'UNPAID', settledOn: '2026-11-12' }, '2026-11-14')).toBe('FEE_NEEDED')
    expect(settleProblem(item, { status: 'UNPAID', settledOn: '2026-11-12', unpaidFee: 0 }, '2026-11-14')).toBeNull()
    expect(settleProblem({ ...item, status: 'PAID' }, { status: 'UNPAID', settledOn: '2026-11-12', unpaidFee: 0 }, '2026-11-14')).toBe('SETTLED')
    expect(ribaPaymentReference('0196a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b')).toBe('RIBA-0196A1B2-C3D4-7E5F-8A9B-0C1D2E3F4A5B')
  })
})

describe('reminder stops (FIN-112)', () => {
  it('holds while not lifted and its last day has not passed; a promise names its day', () => {
    expect(stopHolds({ liftedAt: null, until: null }, '2026-11-14')).toBe(true)
    expect(stopHolds({ liftedAt: null, until: '2026-11-14' }, '2026-11-14')).toBe(true)
    expect(stopState({ liftedAt: null, until: '2026-11-13' }, '2026-11-14')).toBe('over')
    expect(stopState({ liftedAt: new Date(), until: null }, '2026-11-14')).toBe('lifted')
    expect(stopProblems({ reason: 'PROMISE_TO_PAY', until: null, note: null }, '2026-11-14').map((problem) => problem.path)).toEqual(['body/until'])
    expect(stopProblems({ reason: 'DISPUTE', until: '2026-11-13', note: null }, '2026-11-14').map((problem) => problem.path)).toEqual(['body/until'])
    expect(stopProblems({ reason: 'DISPUTE', until: null, note: 'Price asked' }, '2026-11-14')).toEqual([])
  })
})

describe('trusted levels and the payment received notice (FIN-113, FIN-128)', () => {
  const ladder = [
    { level: 1, offsetDays: -3, action: 'EMAIL' as const, template: 'BEFORE_DUE' },
    { level: 2, offsetDays: 7, action: 'EMAIL' as const, template: 'LATE_7' },
    { level: 3, offsetDays: 30, action: 'LETTER' as const, template: 'LATE_30' },
  ]
  it('lets e-mails of the ladder up to the level go by themselves; a letter, a call or a reminder by hand waits', () => {
    expect(trustedSteps(3, ladder).map((step) => step.level)).toEqual([1, 2])
    expect(trustedSteps(null, ladder)).toEqual([])
    expect(trustedFor(2, { level: 2, action: 'EMAIL', byHand: false })).toBe(true)
    expect(trustedFor(2, { level: 3, action: 'EMAIL', byHand: false })).toBe(false)
    expect(trustedFor(3, { level: 3, action: 'LETTER', byHand: false })).toBe(false)
    expect(trustedFor(2, { level: 1, action: 'EMAIL', byHand: true })).toBe(false)
    expect(trustedFor(null, { level: 1, action: 'EMAIL', byHand: false })).toBe(false)
    expect(trustWords(2).en).toContain('level 2')
  })

  it('tells the customer what arrived and what it paid, in its language', () => {
    const it_ = paymentNoticeMail({ language: 'it', companyName: 'Test Atelier', customerName: 'Cliente Prova', currency: 'EUR', amount: 123450, receivedOn: '2026-11-14', placed: [{ number: 'FT-2026-00001', amount: 100000 }], unplaced: 23450 })
    expect(it_.subject).toBe('Pagamento ricevuto - Test Atelier')
    expect(it_.body).toContain('1.234,50 EUR in data 14/11/2026')
    expect(it_.body).toContain('- FT-2026-00001: 1.000,00 EUR')
    expect(it_.body).toContain('234,50 EUR restano a Vostro credito.')
    const en = paymentNoticeMail({ language: 'en', companyName: 'Test Atelier', customerName: 'Test Customer', currency: 'EUR', amount: 50000, receivedOn: '2026-11-14', placed: [], unplaced: 0 })
    expect(en.body).toContain('we received your payment of 500.00 EUR on 2026-11-14.')
    expect(en.body).not.toContain('placed on')
  })
})
