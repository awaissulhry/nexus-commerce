import { describe, expect, it } from 'vitest'
import { salesEntry } from '../journals/entries'
import {
  allocationsCheck,
  errorOutcome,
  exportedDocumentsCheck,
  FAILURES_KEPT,
  handedOverFingerprint,
  INTEGRITY_CHECK_CODES,
  invoiceTotalsCheck,
  ledgerCheck,
  paymentsPlacedCheck,
  supplierTotalsCheck,
  windowStart,
} from './checks'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

describe('the integrity checks (B-W2b-408, FIN-157)', () => {
  it('reads a window of thirteen months ending with this one', () => {
    expect(windowStart('2026-11-14')).toBe('2025-11-01')
    expect(windowStart('2026-01-31')).toBe('2025-01-01')
    expect(INTEGRITY_CHECK_CODES).toContain('INVOICE_TOTALS_EQUAL_LINES')
  })

  it("fails an invoice whose totals are not its summary's (SUMMARY) or whose lines are not its net (LINES)", () => {
    const good = { id: id(1), number: 'FT-1', netTotal: 1000, vatTotal: 220, grossTotal: 1220, stampDutyAmount: null, vatSummary: [{ rate: '22.00', taxable: 1000, vat: 220, rounding: 0 }], linesNet: 1000, rounding: 0 }
    expect(invoiceTotalsCheck([good])).toEqual({ code: 'INVOICE_TOTALS_EQUAL_LINES', result: 'PASSED', failureCount: 0, failures: [], errorWords: null })
    const outcome = invoiceTotalsCheck([good, { ...good, id: id(2), vatTotal: 221 }, { ...good, id: id(3), linesNet: 999 }, { ...good, id: id(4), linesNet: 999, rounding: 1 }])
    expect(outcome).toMatchObject({ result: 'FAILED', failureCount: 2, failures: [{ recordType: 'Invoice', recordId: id(2), code: 'SUMMARY' }, { recordType: 'Invoice', recordId: id(3), code: 'LINES' }] })
  })

  it('checks a supplier invoice typed with no summary by its gross alone, and its lines when it has some', () => {
    const typed = { id: id(5), netTotal: 1000, vatTotal: 220, grossTotal: 1220, stampDutyAmount: null, vatSummary: [], linesNet: null }
    expect(supplierTotalsCheck([typed]).result).toBe('PASSED')
    expect(supplierTotalsCheck([{ ...typed, grossTotal: 1300 }]).failures).toEqual([{ recordType: 'SupplierInvoice', recordId: id(5), code: 'SUMMARY' }])
    expect(supplierTotalsCheck([{ ...typed, vatSummary: [{ rate: '22.00', taxable: 1000, vat: 220 }], linesNet: 900 }]).failures).toEqual([{ recordType: 'SupplierInvoice', recordId: id(5), code: 'LINES' }])
  })

  it('fails a payment placed, refunded and written off beyond its amount, and an invoice paid beyond what it is open for', () => {
    const payment = { id: id(6), amount: 1000, placed: 800, refunded: 100, writtenOff: 100 }
    expect(allocationsCheck([payment], [{ id: id(7), payable: 500, allocated: 400, writtenOff: 100 }]).result).toBe('PASSED')
    expect(allocationsCheck([{ ...payment, writtenOff: 101 }], [{ id: id(7), payable: 500, allocated: 450, writtenOff: 51 }]).failures).toEqual([
      { recordType: 'Payment', recordId: id(6), code: 'PAYMENT' },
      { recordType: 'Invoice', recordId: id(7), code: 'INVOICE' },
    ])
    expect(paymentsPlacedCheck([payment, { ...payment, id: id(8), placed: 500 }]).failures).toEqual([{ recordType: 'Payment', recordId: id(8), code: 'NOT_PLACED' }])
  })

  it('fails an entry whose debits are not its credits', () => {
    const entry = salesEntry(
      { id: id(9), number: 'FT-9', version: 1, docType: 'TD01', issueDate: '2026-10-01', currency: 'EUR', netTotal: 1000, grossTotal: 1220, summary: [{ rate: '22.00', nature: null, taxable: 1000, vat: 220 }], rounding: 0, lines: [{ kind: 'GOODS', chargeKind: null, netAmount: 990 }], partyCode: 'C', partyName: 'C', partyCountry: 'IT' },
      [],
    )
    expect(ledgerCheck([entry]).failures).toEqual([{ recordType: 'Invoice', recordId: id(9), code: 'UNBALANCED' }])
  })

  it('keeps at most a hundred failures with the whole count; an error in words', () => {
    const many = Array.from({ length: 130 }, (_, n) => ({ recordType: 'Invoice', recordId: id(100 + n) }))
    const outcome = exportedDocumentsCheck(many)
    expect([outcome.result, outcome.failureCount, outcome.failures.length, outcome.failures[0]!.code]).toEqual(['FAILED', 130, FAILURES_KEPT, 'CHANGED_AFTER_EXPORT'])
    expect(errorOutcome('LEDGER_BALANCES', 'the month could not be read')).toEqual({ code: 'LEDGER_BALANCES', result: 'ERROR', failureCount: 0, failures: [], errorWords: 'the month could not be read' })
  })

  it("fingerprints a handed-over document over its packages, whatever their order", () => {
    const a = handedOverFingerprint([{ package: 'SALES_JOURNAL', hash: 'aa' }, { package: 'VAT_REGISTERS', hash: 'bb' }])
    expect(handedOverFingerprint([{ package: 'VAT_REGISTERS', hash: 'bb' }, { package: 'SALES_JOURNAL', hash: 'aa' }])).toBe(a)
    expect(handedOverFingerprint([{ package: 'SALES_JOURNAL', hash: 'aa' }, { package: 'VAT_REGISTERS', hash: 'bc' }])).not.toBe(a)
    expect(a).toMatch(/^[0-9a-f]{16}$/)
  })
})
