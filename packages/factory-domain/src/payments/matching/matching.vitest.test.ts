import { describe, expect, it } from 'vitest'
import { accountFor, importRefusal, planImport } from '../bank/import'
import type { ParsedStatement } from '../bank-formats/statement'
import { writeOffProblem } from '../write-offs/write-offs'
import { differenceOf, planLine } from './accept'
import { chosenReasons, confidenceOf, namesMatch, numberInText, suggest, type LineFacts, type MatchFacts } from './match'

// Every name, number and IBAN here is made up (bank and branch code 00000).
const PAYER = 'IT27X0000000000000000370003'
const TODAY = '2026-11-14'

const line = (amount: number, more: Partial<LineFacts> = {}): LineFacts => ({ id: 'line-1', amount, currency: 'EUR', bankReference: null, referenceText: null, counterpartyName: null, counterpartyIban: null, ...more })
const facts = (more: Partial<MatchFacts> = {}): MatchFacts => ({
  parties: [
    { id: 'P1', names: ['Test Customer One S.r.l.'], ibans: [PAYER] },
    { id: 'P2', names: ['Other Buyer S.p.A.'], ibans: [] },
    { id: 'S1', names: ['Test Leather Supplier S.p.A.'], ibans: ['IT97X0000000000000000370101'] },
  ],
  items: [
    { kind: 'INVOICE', id: 'I1', partyId: 'P1', number: 'FT-2026-00001', currency: 'EUR', open: 41000, date: '2026-10-01' },
    { kind: 'INVOICE', id: 'I2', partyId: 'P1', number: 'FT-2026-00007', currency: 'EUR', open: 12000, date: '2026-10-20' },
    { kind: 'DEPOSIT_REQUEST', id: 'D1', partyId: 'P2', number: 'SO-0002', currency: 'EUR', open: 30000, date: '2026-11-01' },
  ],
  payments: [{ id: 'PAY1', partyId: 'P2', amount: 25000, currency: 'EUR', externalRef: 'TRN-TEST-0001' }],
  supplierInvoices: [{ id: 'SI1', partyId: 'S1', number: '2026/0412', currency: 'EUR', due: 56913 }],
  tolerance: 100,
  ...more,
})

describe('reading a line', () => {
  it('finds a number by its letters and digits, never a short or digit-less one', () => {
    expect(numberInText('FT-2026-00001', 'Saldo fattura FT 2026/00001 grazie')).toBe(true)
    expect(numberInText('FT-2026-00001', 'saldo ft202600001')).toBe(true)
    expect(numberInText('FT-2026-00001', 'FT-2026-000012')).toBe(false)
    expect(numberInText('2026/0412', 'Pagamento fattura 2026/0412')).toBe(true)
    expect(numberInText('A1', 'A1 A1')).toBe(false)
    expect(numberInText('ABCDE', 'ABCDE')).toBe(false)
  })

  it('matches names without legal forms and with a cut last word', () => {
    expect(namesMatch('TEST CUSTOMER ONE SRL', 'Test Customer One S.r.l.')).toBe(true)
    expect(namesMatch('TEST CUSTOM', 'Test Customer One S.r.l.')).toBe(true)
    expect(namesMatch('Test Customer On', 'Test Customer One S.r.l.')).toBe(false)
    expect(namesMatch('Test Customer Two', 'Test Customer One S.r.l.')).toBe(false)
    expect(namesMatch(null, 'Test Customer One S.r.l.')).toBe(false)
  })
})

describe('suggestions with how sure and why', () => {
  it('HIGH: the amount and the invoice number in the reference, with the IBAN known and the name', () => {
    const [best] = suggest(line(41000, { referenceText: 'Saldo FT-2026-00001', counterpartyIban: PAYER, counterpartyName: 'Test Customer One Srl' }), facts())
    expect(best).toMatchObject({ partyId: 'P1', invoiceIds: ['I1'], confidence: 'HIGH', reasons: ['AMOUNT_EQUAL', 'NUMBER_IN_REFERENCE', 'IBAN_KNOWN', 'NAME_MATCHES'] })
  })

  it('a few cents short within the tolerance is still HIGH with the number; the reason says within the tolerance', () => {
    const [best] = suggest(line(40970, { referenceText: 'FT-2026-00001' }), facts())
    expect(best).toMatchObject({ invoiceIds: ['I1'], confidence: 'HIGH', reasons: ['AMOUNT_WITHIN_TOLERANCE', 'NUMBER_IN_REFERENCE'] })
  })

  it('two invoices quoted and paid together are one suggestion', () => {
    const [best] = suggest(line(53000, { referenceText: 'FT-2026-00001 FT-2026-00007' }), facts())
    expect(best).toMatchObject({ invoiceIds: ['I1', 'I2'], confidence: 'HIGH', reasons: ['AMOUNT_EQUAL', 'NUMBER_IN_REFERENCE'] })
  })

  it('a deposit request by its order number; a payment typed by hand by its reference', () => {
    expect(suggest(line(30000, { referenceText: 'Acconto ordine SO-0002' }), facts())[0]).toMatchObject({ depositRequestIds: ['D1'], reasons: ['AMOUNT_EQUAL', 'NUMBER_IN_REFERENCE'] })
    expect(suggest(line(25000, { bankReference: 'TRN TEST 0001' }), facts())[0]).toMatchObject({ paymentId: 'PAY1', invoiceIds: [], reasons: ['AMOUNT_EQUAL', 'NUMBER_IN_REFERENCE'] })
  })

  it('we know who paid, not what: LOW with the oldest item; an amount alone says nothing when many share it', () => {
    expect(suggest(line(5000, { counterpartyIban: PAYER }), facts())[0]).toMatchObject({ partyId: 'P1', invoiceIds: ['I1'], confidence: 'LOW', reasons: ['IBAN_KNOWN'] })
    const many = facts({ items: [1, 2, 3, 4].map((n) => ({ kind: 'INVOICE' as const, id: `X${n}`, partyId: 'P2', number: `FT-2026-0010${n}`, currency: 'EUR', open: 9900, date: '2026-10-01' })) })
    expect(suggest(line(9900), many)).toEqual([])
  })

  it('two suggestions that tie at the top are each one step less sure', () => {
    const twins = facts({ items: [1, 2].map((n) => ({ kind: 'INVOICE' as const, id: `T${n}`, partyId: 'P2', number: `FT-2026-0020${n}`, currency: 'EUR', open: 7700, date: '2026-10-0' + n })) })
    const found = suggest(line(7700), twins)
    expect(found.map((entry) => entry.confidence)).toEqual(['LOW', 'LOW'])
  })

  it('money out: the supplier invoice by amount and number', () => {
    expect(suggest(line(-56913, { referenceText: 'Pagamento fattura 2026/0412', counterpartyIban: 'IT97X0000000000000000370101' }), facts())[0]).toMatchObject({ supplierInvoiceId: 'SI1', confidence: 'HIGH', reasons: ['AMOUNT_EQUAL', 'NUMBER_IN_REFERENCE', 'IBAN_KNOWN'] })
    expect(suggest(line(-100, { counterpartyName: 'Test Leather Supplier' }), facts())).toEqual([])
  })

  it('confidence from the reasons, and a person’s choice says what the matcher sees in it', () => {
    expect(confidenceOf(['AMOUNT_EQUAL'])).toBe('MEDIUM')
    expect(confidenceOf(['NAME_MATCHES'])).toBe('LOW')
    expect(confidenceOf(['AMOUNT_EQUAL', 'IBAN_KNOWN'])).toBe('HIGH')
    expect(chosenReasons(line(41000), { partyId: 'P1', open: 41000, numbers: ['FT-2026-00001'] }, undefined, 100)).toEqual({ reasons: ['AMOUNT_EQUAL', 'CHOSEN_BY_PERSON'], confidence: 'MEDIUM' })
  })
})

describe('accepting: the line placed, the difference', () => {
  it('oldest first; a leftover is an OVERPAYMENT, a short last invoice an UNDERPAYMENT, each within the tolerance or not', () => {
    const items = [
      { kind: 'INVOICE' as const, id: 'I1', open: 41000, label: 'invoice FT-2026-00001', path: 'items/0' },
      { kind: 'INVOICE' as const, id: 'I2', open: 12000, label: 'invoice FT-2026-00007', path: 'items/1' },
    ]
    const over = planLine(53030, items, 'EUR')
    expect(over).toMatchObject({ allocations: [{ id: 'I1', amount: 41000 }, { id: 'I2', amount: 12000 }], leftover: 30, short: [] })
    expect(differenceOf(over, 100)).toEqual({ kind: 'OVERPAYMENT', amount: 30, invoiceId: null, refusal: null })
    const under = planLine(52950, items, 'EUR')
    expect(differenceOf(under, 100)).toEqual({ kind: 'UNDERPAYMENT', amount: 50, invoiceId: 'I2', refusal: null })
    expect(differenceOf(under, 10)).toMatchObject({ refusal: 'OVER_TOLERANCE' })
    expect(differenceOf(under, null)).toMatchObject({ refusal: 'NO_TOLERANCE' })
    expect(differenceOf(planLine(30000, items, 'EUR'), 100)).toMatchObject({ refusal: 'SHORT_ON_SEVERAL' })
    expect(differenceOf(planLine(41000, items.slice(0, 1), 'EUR'), 100)).toEqual({ kind: null, amount: 0, invoiceId: null, refusal: null })
  })

  it('a split takes the amounts typed; a deposit left short is never written off; caps are issues', () => {
    const split = planLine(10000, [{ kind: 'INVOICE', id: 'I1', open: 41000, amount: 6000, label: 'invoice A', path: 'items/0' }, { kind: 'DEPOSIT_REQUEST', id: 'D1', open: 30000, amount: 4000, label: 'deposit', path: 'items/1' }], 'EUR')
    expect(split.allocations.map((entry) => entry.amount)).toEqual([6000, 4000])
    expect(differenceOf(planLine(29990, [{ kind: 'DEPOSIT_REQUEST', id: 'D1', open: 30000, label: 'deposit', path: 'items/0' }], 'EUR'), 100)).toMatchObject({ refusal: 'SHORT_ON_DEPOSIT' })
    expect(planLine(100, [{ kind: 'INVOICE', id: 'I1', open: 50, amount: 80, label: 'invoice A', path: 'items/0' }], 'EUR').issues[0]!.path).toBe('items/0/amount')
  })

  it('a write-off within the tolerance, with a note for another reason', () => {
    expect(writeOffProblem({ amount: 30, tolerance: 100, reason: 'ROUNDING', note: null })).toBeNull()
    expect(writeOffProblem({ amount: 30, tolerance: null, reason: 'ROUNDING', note: null })).toBe('NO_TOLERANCE')
    expect(writeOffProblem({ amount: 101, tolerance: 100, reason: 'ROUNDING', note: null })).toBe('OVER_TOLERANCE')
    expect(writeOffProblem({ amount: 0, tolerance: 100, reason: 'ROUNDING', note: null })).toBe('NOTHING_LEFT')
    expect(writeOffProblem({ amount: 30, tolerance: 100, reason: 'OTHER', note: null })).toBe('NOTE_NEEDED')
  })
})

describe('importing: the account and each line’s verdict', () => {
  const accounts = [
    { id: 'A1', iban: 'IT60X0000000000000000123456', currency: 'EUR', active: true },
    { id: 'A0', iban: 'IT81X0000000000000000370001', currency: 'EUR', active: false },
  ]
  it('the file’s IBAN picks the account; a sheet needs one chosen; a wrong choice or a switched-off account is refused', () => {
    expect(accountFor({ iban: 'IT60X0000000000000000123456', currency: 'EUR' }, accounts, null)).toEqual({ account: accounts[0] })
    expect(accountFor({ iban: null, currency: null }, accounts, null)).toEqual({ refusal: 'ACCOUNT_NEEDED' })
    expect(accountFor({ iban: 'IT60X0000000000000000123456', currency: 'EUR' }, accounts, 'A0')).toEqual({ refusal: 'ACCOUNT_DIFFERS' })
    expect(accountFor({ iban: null, currency: null }, accounts, 'A0')).toEqual({ refusal: 'ACCOUNT_OFF' })
    expect(accountFor({ iban: 'IT27X0000000000000000370003', currency: 'EUR' }, accounts, null)).toEqual({ refusal: 'ACCOUNT_UNKNOWN' })
    expect(accountFor({ iban: 'IT60X0000000000000000123456', currency: 'USD' }, accounts, null)).toEqual({ refusal: 'CURRENCY_DIFFERS' })
  })

  it('NEW, DUPLICATE (the account has it) or ERROR; nothing new or unread lines refuse the import', () => {
    const statement: ParsedStatement = {
      format: 'CSV',
      iban: null,
      currency: 'EUR',
      periodStart: null,
      periodEnd: null,
      lines: [
        { row: 2, bookedOn: '2026-11-06', valueOn: null, amount: 41000, currency: 'EUR', bankReference: 'R1', referenceText: 'A', counterpartyName: null, counterpartyIban: null, problems: [] },
        { row: 3, bookedOn: '2026-11-07', valueOn: null, amount: -1250, currency: 'EUR', bankReference: 'R2', referenceText: 'B', counterpartyName: null, counterpartyIban: null, problems: [] },
        { row: 4, bookedOn: null, valueOn: null, amount: 100, currency: 'EUR', bankReference: null, referenceText: 'C', counterpartyName: null, counterpartyIban: null, problems: ['NO_DATE'] },
      ],
    }
    const first = planImport(statement, 'A1', new Set(), TODAY)
    expect(first.counts).toEqual({ NEW: 2, DUPLICATE: 0, ERROR: 1 })
    expect(first.totals).toEqual({ moneyIn: 41000, moneyOut: 1250 })
    expect(first.period).toEqual({ start: '2026-11-06', end: '2026-11-07' })
    expect(importRefusal(first, { skipErrors: false })).toBe('LINES_UNREADABLE')
    expect(importRefusal(first, { skipErrors: true })).toBeNull()
    const again = planImport(statement, 'A1', new Set(first.lines.map((entry) => entry.fingerprint)), TODAY)
    expect(again.lines.map((entry) => entry.verdict)).toEqual(['DUPLICATE', 'DUPLICATE', 'ERROR'])
    expect(importRefusal(again, { skipErrors: true })).toBe('NOTHING_NEW')
  })
})
