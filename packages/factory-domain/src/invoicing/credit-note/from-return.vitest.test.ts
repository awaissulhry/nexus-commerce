import { describe, expect, it } from 'vitest'
import { taxable } from '../../tax/vat-treatment'
import { computeInvoiceTotals } from '../invoices'
import { planReturnCredit, pricePerPiece, returnCreditProblems, type BilledLine, type InvoiceToCredit, type ReturnedLine } from './from-return'

/** B-W2a-61 (FIN-070): credit notes from a customer return's decided lines. Every name, number and amount is made up. */

const rma = { id: 'rma-1', number: 'RMA-2026-0001', companyId: 'company-a' }
const invoice = (id: string, overrides: Partial<InvoiceToCredit> = {}): InvoiceToCredit => ({ id, companyId: 'company-a', docType: 'TD24', status: 'DELIVERED', number: `FT-2026-0000${id.slice(-1)}`, issueDate: '2026-10-15', currency: 'EUR', ...overrides })
const billed = (invoiceId: string, overrides: Partial<BilledLine> = {}): BilledLine => ({ invoiceLineId: `${invoiceId}-l1`, invoiceId, description: 'Giacca SEED-JKT-01 nero, taglia 50', itemCode: 'SEED-JKT-01-BLK-50', uom: 'PZ', vat: taxable(22), salesOrderLineId: 'sol-1', size: '50', named: true, ...overrides })
const line = (id: string, seq: number, overrides: Partial<ReturnedLine> = {}): ReturnedLine => ({ id, seq, quantity: 2, receivedQuantity: 2, disposition: 'CREDIT_ONLY', creditAmount: 50_000, billedBy: billed('inv-1'), onCreditNotes: [], ...overrides })
const invoices = new Map([
  ['inv-1', invoice('inv-1')],
  ['inv-2', invoice('inv-2')],
])

describe('a credit note per invoice from the decided lines (FIN-070)', () => {
  it('groups the lines by the invoice that billed them: the pieces received at the credit per piece, the billed VAT, the return line named', () => {
    const plan = planReturnCredit(rma, [line('l10', 10), line('l20', 20, { creditAmount: 33_333, receivedQuantity: 3, quantity: 3, billedBy: billed('inv-2') })], invoices)
    expect(plan.skipped).toEqual([])
    expect(plan.notes.map((note) => [note.creditOfId, note.netTotal])).toEqual([
      ['inv-1', 50_000],
      ['inv-2', 33_333],
    ])
    const [first, second] = plan.notes
    expect(first!.causale).toBe('Nota di credito: Reso merce - RMA RMA-2026-0001 - rif. fattura n. FT-2026-00001 del 15/10/2026 (art. 26 DPR 633/1972)')
    expect(first!.lines[0]).toMatchObject({ returnLineId: 'l10', pieces: 2, core: { kind: 'GOODS', description: 'Reso RMA-2026-0001 riga 10: Giacca SEED-JKT-01 nero, taglia 50', quantity: '2.0000', unitPrice: '250.000000', itemCode: 'SEED-JKT-01-BLK-50', uom: 'PZ', vat: { kind: 'TAXABLE', rate: 22 } } })
    // The pieces × the price per piece give back exactly the decided credit (the totals' rounding, to the cent).
    expect(second!.lines[0]!.core.unitPrice).toBe('111.110000')
    expect(computeInvoiceTotals(second!.lines.map((entry) => entry.core), 'NET', 'EUR').netTotal).toBe(33_333)
  })

  it('the credit per piece never loses a cent, whatever the pieces', () => {
    for (const [credit, pieces] of [
      [1, 3],
      [99_999, 7],
      [12_345, 11],
      [2_147_000, 997],
    ] as const) {
      const core = { kind: 'GOODS' as const, description: 'x', quantity: pieces.toFixed(4), unitPrice: pricePerPiece(credit, pieces, 'EUR'), vat: taxable(22) }
      expect(computeInvoiceTotals([core], 'NET', 'EUR').netTotal).toBe(credit)
    }
  })

  it('says why each line is left out: not decided, no credit, on a credit note, never invoiced, an invoice that cannot be credited, another company', () => {
    const plan = planReturnCredit(
      rma,
      [
        line('a', 10, { disposition: null, creditAmount: null }),
        line('b', 20, { creditAmount: 0, disposition: 'REPLACE' }),
        line('c', 30, { onCreditNotes: [{ invoiceId: 'nc-1', number: null, status: 'DRAFT' }] }),
        line('d', 40, { billedBy: null }),
        line('e', 50, { billedBy: billed('inv-3') }),
        line('f', 60, { billedBy: billed('inv-4') }),
        line('g', 70, { billedBy: billed('inv-5') }),
      ],
      new Map([
        ['inv-3', invoice('inv-3', { status: 'REJECTED' })],
        ['inv-4', invoice('inv-4', { companyId: 'company-b' })],
        ['inv-5', invoice('inv-5', { docType: 'TD04' })],
      ]),
    )
    expect(plan.notes).toEqual([])
    expect(plan.skipped.map((entry) => [entry.seq, entry.code])).toEqual([
      [10, 'NOT_DECIDED'],
      [20, 'NO_CREDIT'],
      [30, 'ON_CREDIT_NOTE'],
      [40, 'NOT_INVOICED'],
      [50, 'INVOICE_STATE'],
      [60, 'OTHER_COMPANY'],
      [70, 'INVOICE_STATE'],
    ])
    expect(plan.skipped[2]!.message).toBe('Line 30 is on credit note (draft) already (DRAFT).')
    expect(plan.skipped[4]!.message).toContain('rejected by SDI')
  })

  it('only the lines asked for, the others named as not asked', () => {
    const plan = planReturnCredit(rma, [line('l10', 10), line('l20', 20)], invoices, new Set(['l20']))
    expect(plan.notes[0]!.lines.map((entry) => entry.returnLineId)).toEqual(['l20'])
    expect(plan.skipped).toEqual([{ lineId: 'l10', seq: 10, code: 'NOT_ASKED', message: 'Line 10 was not asked for.' }])
  })
})

describe('the checks at issue of a credit note that credits return lines', () => {
  const base = { id: 'l10', seq: 10, rmaNumber: 'RMA-2026-0001', rmaCompanyId: 'company-a', quantity: 2, creditAmount: 50_000, billedOnInvoiceId: 'inv-1', otherPieces: '0', otherNet: 0, thisPieces: '2', thisNet: 50_000 }
  const note = { companyId: 'company-a', creditOfId: 'inv-1', currency: 'EUR' }

  it('passes within the pieces and the decided credit', () => {
    expect(returnCreditProblems(note, [base])).toEqual([])
  })

  it('refuses another company, another invoice, more pieces, more money, an undecided line — in words', () => {
    const codes = returnCreditProblems(note, [
      { ...base, id: 'a', rmaCompanyId: 'company-b' },
      { ...base, id: 'b', billedOnInvoiceId: 'inv-2' },
      { ...base, id: 'c', otherPieces: '1.0000' },
      { ...base, id: 'd', thisNet: 50_001 },
      { ...base, id: 'e', creditAmount: null },
    ])
    expect(codes.map((problem) => problem.code)).toEqual(['RETURN_OF', 'RETURN_OF', 'RETURN_OVER', 'RETURN_CREDIT_OVER', 'RETURN_CREDIT_OVER'])
    expect(codes[2]!.message).toBe('Return RMA-2026-0001 line 10 brings back 2 piece(s); with this credit note 3 would be credited (1 on other credit notes).')
    expect(codes[3]!.message).toBe('Return RMA-2026-0001 line 10 was decided a credit of 500.00 EUR; this credit note credits 500.01 EUR of it.')
  })
})
