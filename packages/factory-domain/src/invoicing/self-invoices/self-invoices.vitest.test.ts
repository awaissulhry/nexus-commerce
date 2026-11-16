import { describe, expect, it } from 'vitest'
import { debitNoteCausale, debitProblem, vatDecreaseVerdict } from '../debit-notes/debit-notes'
import { deadlineStateOf, depthRuleWords, integrationLines, isReverseChargeNature, isSelfInvoiceDocType, refusalWords, selfInvoiceCausale, selfInvoiceDeadline, selfInvoiceProblems, suggestedKind, waitsWords } from './self-invoices'

// B-W2b-401 (FIN-095, FIN-071, FIN-073): self-invoices, the debit note and the VAT time limit. Every rule here is UNVERIFIED.

describe('self-invoices for foreign purchases (FIN-095)', () => {
  it('suggests the kind from the supplier country and its lines', () => {
    expect(suggestedKind({ country: 'DE', lineKinds: ['SERVICE'] }).kind).toBe('TD17')
    expect(suggestedKind({ country: 'US', lineKinds: ['SERVICE', 'SUBCONTRACT'] }).kind).toBe('TD17')
    expect(suggestedKind({ country: 'FR', lineKinds: ['GOODS', 'CHARGE'] }).kind).toBe('TD18')
    expect(suggestedKind({ country: 'CN', lineKinds: ['GOODS'] })).toMatchObject({ kind: null, why: expect.stringContaining('customs') })
    expect(suggestedKind({ country: 'IT', lineKinds: ['GOODS'] })).toMatchObject({ kind: null, why: expect.stringContaining('Italian') })
    expect(suggestedKind({ country: 'ES', lineKinds: ['GOODS', 'SERVICE'] }).kind).toBeNull()
  })

  it('is due by the 15th of the month after it was received, and says how it stands', () => {
    expect(selfInvoiceDeadline('2026-11-02')).toBe('2026-12-15')
    expect(selfInvoiceDeadline('2026-12-31')).toBe('2027-01-15')
    expect(deadlineStateOf('2026-12-15', '2026-11-14', 'PENDING')).toMatchObject({ state: 'OPEN', daysLeft: 31 })
    expect(deadlineStateOf('2026-12-15', '2026-12-12', 'PENDING')).toMatchObject({ state: 'DUE_SOON', daysLeft: 3 })
    expect(deadlineStateOf('2026-12-15', '2026-12-16', 'PENDING')).toMatchObject({ state: 'LATE', daysLeft: -1 })
    expect(deadlineStateOf('2026-12-15', '2026-12-16', 'ISSUED').state).toBe('DONE')
  })

  it('refuses what has no self-invoice, in codes', () => {
    const ok = { status: 'RECEIVED', kind: 'INVOICE', country: 'DE', netTotal: 100_00, live: false, selfKind: 'TD17' as const }
    expect(selfInvoiceProblems(ok)).toEqual([])
    expect(selfInvoiceProblems({ ...ok, status: 'VOIDED' })).toEqual(['VOIDED'])
    expect(selfInvoiceProblems({ ...ok, kind: 'CREDIT_NOTE' })).toEqual(['CREDIT_NOTE'])
    expect(selfInvoiceProblems({ ...ok, country: 'IT' })).toEqual(['ITALIAN_SUPPLIER'])
    expect(selfInvoiceProblems({ ...ok, country: 'US', selfKind: 'TD18' })).toEqual(['TD18_NOT_EU'])
    expect(selfInvoiceProblems({ ...ok, live: true, netTotal: 0 })).toEqual(['ALREADY', 'NO_AMOUNT'])
  })

  it('makes its lines in euro: one per supplier line, or one for the total when a line is a discount', () => {
    const half = (minor: number) => Math.round(minor / 2)
    expect(integrationLines([{ description: 'Consulenza', netAmount: 800_00 }, { description: 'Trasferta', netAmount: 200_00 }], 1000_00, 'fattura n. 7', half)).toEqual([
      { description: 'Consulenza', netEur: 400_00 },
      { description: 'Trasferta', netEur: 100_00 },
    ])
    expect(integrationLines([{ description: 'Servizio', netAmount: 1000_00 }, { description: 'Sconto', netAmount: -100_00 }], 900_00, 'fattura n. 7', (minor) => minor)).toEqual([{ description: 'Integrazione IVA fattura n. 7', netEur: 900_00 }])
    expect(selfInvoiceCausale('TD18', 'R-1', '2026-11-02', 'Beispiel GmbH')).toBe('Integrazione per acquisto di beni intracomunitari - fattura n. R-1 del 02/11/2026 di Beispiel GmbH')
    expect(isSelfInvoiceDocType('TD17')).toBe(true)
    expect(isSelfInvoiceDocType('TD05')).toBe(false)
  })

  // ---- B-W2b-GB02 (G150): TD16, the integration of an Italian supplier's reverse-charge invoice.
  it('TD16: an Italian supplier invoicing under the reverse charge (N6.x) is integrated with a TD16, never one that charged VAT', () => {
    expect(isReverseChargeNature('N6.3')).toBe(true)
    expect(isReverseChargeNature('N6')).toBe(true)
    expect(isReverseChargeNature('N3.2')).toBe(false)
    expect(isReverseChargeNature(null)).toBe(false)
    expect(suggestedKind({ country: 'IT', lineKinds: ['SUBCONTRACT'], lineNatures: ['N6.3'] })).toMatchObject({ kind: 'TD16', why: expect.stringContaining('reverse charge') })
    expect(suggestedKind({ country: 'IT', lineKinds: ['GOODS'], lineNatures: [null] })).toMatchObject({ kind: null, why: expect.stringContaining('charged VAT') })
    const td16 = { status: 'RECEIVED', kind: 'INVOICE', country: 'IT', netTotal: 100_00, live: false, selfKind: 'TD16' as const, lineNatures: ['N6.3'] }
    expect(selfInvoiceProblems(td16)).toEqual([])
    expect(selfInvoiceProblems({ ...td16, lineNatures: [null] })).toEqual(['TD16_NO_REVERSE_CHARGE'])
    expect(selfInvoiceProblems({ ...td16, country: 'DE' })).toEqual(['TD16_FOREIGN'])
    expect(selfInvoiceProblems({ ...td16, selfKind: 'TD17' })).toEqual(['ITALIAN_SUPPLIER'])
    expect(refusalWords('TD16_NO_REVERSE_CHARGE')).toMatch(/Natura N6/)
    expect(selfInvoiceCausale('TD16', 'A-9', '2026-11-03', 'Terzista Fittizio S.r.l.')).toBe('Integrazione fattura reverse charge interno (art. 17 c.6 DPR 633/1972) - fattura n. A-9 del 03/11/2026 di Terzista Fittizio S.r.l.')
    expect(isSelfInvoiceDocType('TD16')).toBe(true)
  })
  // ---- end B-W2b-GB02

  it('waits for the accountant while the switch is off: three rules, one switch', () => {
    expect(waitsWords(false, 'SELF_INVOICES')).toMatch(/^Waits for the accountant/)
    expect(waitsWords(true, 'DEBIT_NOTES')).toBeNull()
    expect(Object.values(depthRuleWords(false)).every((words) => words.startsWith('Waits for the accountant'))).toBe(true)
  })
})

describe('the debit note (FIN-071) and the time limit on VAT decreases (FIN-073)', () => {
  it('adds only to an issued invoice or deferred invoice', () => {
    expect(debitProblem({ docType: 'TD01', status: 'DELIVERED', number: 'FT-1' })).toBeNull()
    expect(debitProblem({ docType: 'TD24', status: 'ISSUED', number: 'FT-2' })).toBeNull()
    expect(debitProblem({ docType: 'TD04', status: 'ISSUED', number: 'NC-1' })?.code).toBe('NOT_DEBITABLE')
    expect(debitProblem({ docType: 'TD01', status: 'DRAFT', number: null })?.code).toBe('NOT_ISSUED')
    expect(debitProblem({ docType: 'TD01', status: 'REJECTED', number: 'FT-3' })?.code).toBe('REJECTED')
    expect(debitNoteCausale({ number: 'FT-1', issueDate: '2026-10-05' }, 'trasporto')).toBe('Nota di debito: trasporto - integrazione della fattura n. FT-1 del 05/10/2026 (art. 26 c.1 DPR 633/1972)')
  })

  it('judges an agreed decrease by the one-year limit, other reasons have none, and waits while off', () => {
    const base = { switchOn: true, operationDate: '2025-10-05', waits: 'Waits for the accountant.' }
    expect(vatDecreaseVerdict({ ...base, reason: 'PRICE_REDUCTION', creditDate: '2026-10-05' })).toMatchObject({ state: 'WITHIN', limitDate: '2026-10-05' })
    expect(vatDecreaseVerdict({ ...base, reason: 'BILLING_ERROR', creditDate: '2026-10-06' })).toMatchObject({ state: 'BEYOND', limitDate: '2026-10-05' })
    expect(vatDecreaseVerdict({ ...base, reason: 'RETURN', creditDate: '2027-10-06' })).toMatchObject({ state: 'NO_LIMIT', limitDate: null })
    expect(vatDecreaseVerdict({ ...base, reason: 'OTHER', creditDate: '2026-01-01' }).state).toBe('ASK')
    expect(vatDecreaseVerdict({ ...base, operationDate: '2024-02-29', reason: 'PRICE_REDUCTION', creditDate: '2025-02-28' })).toMatchObject({ state: 'WITHIN', limitDate: '2025-02-28' })
    expect(vatDecreaseVerdict({ ...base, switchOn: false, reason: 'PRICE_REDUCTION', creditDate: '2030-01-01' })).toEqual({ state: 'WAITS', limitDate: null, words: 'Waits for the accountant.' })
  })
})
