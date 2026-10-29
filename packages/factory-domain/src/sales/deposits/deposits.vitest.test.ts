import { describe, expect, it } from 'vitest'
import { CAPARRA_RULE, depositReference, depositRequestFor, paymentInstructions } from './deposits'

/**
 * The deposit request of an accepted quote (B-W1-24; SAL-195, FIN-066; Q12), pure. Amounts made up: a gross of
 * 7612.80 at 30 % = 2283.84. The IBAN is the documented example of the ISO 13616 / SWIFT IBAN registry for Italy.
 */

const VERSION = { depositPct: '30', depositKind: 'ACCONTO' as const, depositAmount: 228384, currency: 'EUR' }
const EXAMPLE_BANK = { accountHolder: 'Conceria Finta S.r.l.', iban: 'IT60X0542811101000000123456', bic: 'BPMOIT22XXX', bankName: 'Banca Finta' }

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
      "Le chiediamo un acconto di € 2.283,84 entro il 05/11/2026, con bonifico bancario sul conto intestato a Conceria Finta S.r.l., IBAN IT60X0542811101000000123456, BIC BPMOIT22XXX (Banca Finta), causale «Acconto offerta Q-2026-0001 v2».",
    )
  })

  it('without bank details on record, the page says they follow', () => {
    const instructions = paymentInstructions({ amount: 228384, currency: 'EUR', dueDate: '2026-11-05', kind: 'CAPARRA', documentNumber: 'Q-2026-0001 v2', bank: null, language: 'en' })
    expect(instructions.bank).toBeNull()
    expect(instructions.text).toBe('We ask for a confirmatory deposit (caparra confirmatoria) of €2,283.84 by 5 Nov 2026, by bank transfer, reference "Deposit quotation Q-2026-0001 v2". Our bank details will follow separately.')
    expect(depositReference('Q-1 v1', 'en')).toBe('Deposit quotation Q-1 v1')
  })
})
