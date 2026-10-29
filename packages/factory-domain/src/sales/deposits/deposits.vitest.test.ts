import { describe, expect, it } from 'vitest'
import { bankDetailsOf, maskIban, normaliseIban } from './bank'
import { CAPARRA_RULE, depositReference, depositRequestFor, paymentInstructions } from './deposits'

/**
 * The deposit request of an accepted quote (B-W1-24; SAL-195, FIN-066; Q12), pure. Amounts made up: a gross of
 * 7612.80 at 30 % = 2283.84. The IBAN is the documented example of the ISO 13616 / SWIFT IBAN registry for Italy.
 */

const VERSION = { depositPct: '30', depositKind: 'ACCONTO' as const, depositAmount: 228384, currency: 'EUR' }
const EXAMPLE_BANK = { accountHolder: 'Conceria Finta S.r.l.', iban: 'IT60X0542811101000000123456', bic: 'EXMPITMMXXX', bankName: 'Banca Finta' }

describe('the deposit request of an accepted version', () => {
  it("an Italian business's acconto: the version's amount, due 7 days after acceptance, a TD02 when paid", () => {
    expect(depositRequestFor(VERSION, '2026-10-29', { taxMode: 'IT_B2B' })).toEqual({
      kind: 'ACCONTO',
      depositPct: '30',
      currency: 'EUR',
      amount: 228384,
      dueDate: '2026-11-05',
      fiscalDocument: 'TD02',
      fiscalRule: 'DEPOSIT_INVOICE_IT',
      reason: 'Italian business: the deposit is invoiced on the day it is paid.',
    })
  })

  it('an EU business with a VIES proof buying goods: no TD02 (DL 331/1993 art. 39, unverified); without it, a TD02', () => {
    expect(depositRequestFor(VERSION, '2026-10-29', { taxMode: 'EU_B2B', viesValid: true })).toMatchObject({ fiscalDocument: 'NONE', fiscalRule: 'DEPOSIT_EU_B2B_GOODS' })
    expect(depositRequestFor(VERSION, '2026-10-29', { taxMode: 'EU_B2B', viesValid: false })).toMatchObject({ fiscalDocument: 'TD02', fiscalRule: 'DEPOSIT_INVOICE_IT' })
  })

  it('a caparra confirmatoria is no payment on the price: no TD02', () => {
    expect(depositRequestFor({ ...VERSION, depositKind: 'CAPARRA' }, '2026-10-29', { taxMode: 'IT_B2C' })).toMatchObject({ kind: 'CAPARRA', fiscalDocument: 'NONE', fiscalRule: CAPARRA_RULE })
  })

  it('no percent or nothing to pay: no request', () => {
    expect(depositRequestFor({ ...VERSION, depositPct: null, depositAmount: null }, '2026-10-29', { taxMode: 'IT_B2B' })).toBeNull()
    expect(depositRequestFor({ ...VERSION, depositAmount: 0 }, '2026-10-29', { taxMode: 'IT_B2B' })).toBeNull()
  })
})

describe('how to pay it (Q12: bank transfer)', () => {
  it('amount, due date, the reference naming the quote, the company account', () => {
    const instructions = paymentInstructions({ amount: 228384, currency: 'EUR', dueDate: '2026-11-05', kind: 'ACCONTO', documentNumber: 'Q-2026-0001 v2', bank: EXAMPLE_BANK, language: 'it' })
    expect(instructions).toMatchObject({ method: 'BANK_TRANSFER', reference: 'Acconto offerta Q-2026-0001 v2', bank: EXAMPLE_BANK })
    expect(instructions.text).toBe(
      "Le chiediamo un acconto di € 2.283,84 entro il 05/11/2026, con bonifico bancario sul conto intestato a Conceria Finta S.r.l., IBAN IT60X0542811101000000123456, BIC EXMPITMMXXX (Banca Finta), causale «Acconto offerta Q-2026-0001 v2».",
    )
  })

  it('without bank details on record, the page says they follow', () => {
    const instructions = paymentInstructions({ amount: 228384, currency: 'EUR', dueDate: '2026-11-05', kind: 'CAPARRA', documentNumber: 'Q-2026-0001 v2', bank: null, language: 'en' })
    expect(instructions.bank).toBeNull()
    expect(instructions.text).toBe('We ask for a confirmatory deposit (caparra confirmatoria) of €2,283.84 by 5 Nov 2026, by bank transfer, reference "Deposit quotation Q-2026-0001 v2". Our bank details will follow separately.')
    expect(depositReference('Q-1 v1', 'en')).toBe('Deposit quotation Q-1 v1')
  })
})

describe("the company's bank account (Q12; stored with a step-up)", () => {
  it('normalises and accepts an IBAN of a SEPA country with its length and check digits', () => {
    expect(bankDetailsOf({ accountHolder: ' Conceria Finta S.r.l. ', iban: 'it60 x054 2811 1010 0000 0123 456', bic: 'exmpitmm', bankName: null })).toEqual({
      value: { accountHolder: 'Conceria Finta S.r.l.', iban: 'IT60X0542811101000000123456', bic: 'EXMPITMM', bankName: null },
    })
    expect(maskIban('IT60X0542811101000000123456')).toBe('IT60…3456')
    expect(normaliseIban(' de89 3704 0044 0532 0130 00 ')).toBe('DE89370400440532013000')
  })

  it('refuses a wrong check digit, a wrong length, a country outside SEPA, a missing holder, a bad BIC', () => {
    const issues = (input: Parameters<typeof bankDetailsOf>[0]) => ('issues' in bankDetailsOf(input) ? (bankDetailsOf(input) as { issues: { path: string; message: string }[] }).issues : [])
    expect(issues({ accountHolder: 'X S.r.l.', iban: 'IT61X0542811101000000123456', bic: null, bankName: null })).toEqual([{ path: 'body/iban', message: 'The IBAN check digits do not match: check it again.' }])
    expect(issues({ accountHolder: 'X S.r.l.', iban: 'IT60X054281110100000012345', bic: null, bankName: null })).toEqual([{ path: 'body/iban', message: 'An IBAN of IT has 27 characters.' }])
    expect(issues({ accountHolder: 'X S.r.l.', iban: 'US60X0542811101000000123456', bic: null, bankName: null })[0]!.message).toBe('Not an IBAN of a SEPA country.')
    expect(issues({ accountHolder: null, iban: 'IT60X0542811101000000123456', bic: 'EXMP', bankName: null }).map((issue) => issue.path)).toEqual(['body/accountHolder', 'body/bic'])
  })

  it('every field empty removes the account; a holder without an IBAN is refused', () => {
    expect(bankDetailsOf({ accountHolder: ' ', iban: '', bic: null, bankName: null })).toEqual({ value: null })
    expect(bankDetailsOf({ accountHolder: 'X S.r.l.', iban: null, bic: null, bankName: null })).toEqual({ issues: [{ path: 'body/iban', message: 'Give the IBAN, or clear every bank field to remove the account.' }] })
  })
})
