import { describe, expect, it } from 'vitest'
import { countedSign, invoicedOf, type InvoicedDocumentLine, type InvoicedOrderLine } from './invoiced'

/**
 * "Invoiced" on the orders sheet (B-TH-017; threads plan rule C8): by pieces on issued invoices less issued credit notes;
 * drafts and deposit invoices never count. Made-up lines and documents.
 */

const jackets: InvoicedOrderLine = { id: 'line-jackets', kind: 'SIZE_GRID', quantity: 10, closedShortQuantity: null }
const trousers: InvoicedOrderLine = { id: 'line-trousers', kind: 'SIZE_GRID', quantity: 4, closedShortQuantity: null }
const fee: InvoicedOrderLine = { id: 'line-fee', kind: 'FEE', quantity: 1, closedShortQuantity: null }

const bill = (salesOrderLineId: string, quantity: string, netAmount: number, fields: Partial<InvoicedDocumentLine> = {}): InvoicedDocumentLine => ({
  docType: 'TD24',
  status: 'ISSUED',
  kind: 'GOODS',
  salesOrderLineId,
  quantity,
  netAmount,
  ...fields,
})

describe('which document lines count', () => {
  it('an issued TD01 or TD24 adds, an issued TD04 takes away, a draft or a deposit invoice is nothing', () => {
    expect(countedSign({ docType: 'TD01', status: 'ISSUED' })).toBe(1)
    expect(countedSign({ docType: 'TD24', status: 'DELIVERED' })).toBe(1)
    expect(countedSign({ docType: 'TD04', status: 'SENT' })).toBe(-1)
    expect(countedSign({ docType: 'TD24', status: 'DRAFT' })).toBe(0)
    expect(countedSign({ docType: 'TD04', status: 'DRAFT' })).toBe(0)
    expect(countedSign({ docType: 'TD02', status: 'DELIVERED' })).toBe(0)
  })
})

describe('the Invoiced state of an order', () => {
  it('nothing invoiced: None, and the pieces still to invoice', () => {
    expect(invoicedOf([jackets, trousers], [])).toEqual({ state: 'NONE', pieces: '0', toInvoice: 14, amount: 0 })
  })

  it('a draft invoice of every piece is still None (only issued invoices count)', () => {
    const answer = invoicedOf([jackets], [bill(jackets.id, '10', 450000, { status: 'DRAFT' })])
    expect(answer).toMatchObject({ state: 'NONE', pieces: '0', amount: 0 })
  })

  it('a deposit invoice (TD02) is not Part: it bills money in advance, not goods', () => {
    const answer = invoicedOf([jackets], [bill(jackets.id, '1', 135000, { docType: 'TD02', kind: 'SERVICE' }), bill(jackets.id, '1', 135000, { docType: 'TD02' })])
    expect(answer.state).toBe('NONE')
  })

  it('part of the pieces: Part, with the pieces and the net amount', () => {
    expect(invoicedOf([jackets, trousers], [bill(jackets.id, '6', 270000)])).toEqual({ state: 'PART', pieces: '6', toInvoice: 14, amount: 270000 })
  })

  it('every piece of every line: All', () => {
    const answer = invoicedOf([jackets, trousers], [bill(jackets.id, '10', 450000, { docType: 'TD01' }), bill(trousers.id, '4', 120000)])
    expect(answer).toEqual({ state: 'ALL', pieces: '14', toInvoice: 14, amount: 570000 })
  })

  it('a credit note takes its pieces back: All becomes Part, and a full credit makes it None', () => {
    const issued = [bill(jackets.id, '10', 450000), bill(trousers.id, '4', 120000)]
    const partCredit = invoicedOf([jackets, trousers], [...issued, bill(trousers.id, '2', 60000, { docType: 'TD04' })])
    expect(partCredit).toEqual({ state: 'PART', pieces: '12', toInvoice: 14, amount: 510000 })
    const fullCredit = invoicedOf([jackets, trousers], [...issued, bill(jackets.id, '10', 450000, { docType: 'TD04' }), bill(trousers.id, '4', 120000, { docType: 'TD04' })])
    expect(fullCredit).toMatchObject({ state: 'NONE', pieces: '0', amount: 0 })
  })

  it('a draft credit note takes nothing back', () => {
    const answer = invoicedOf([jackets], [bill(jackets.id, '10', 450000), bill(jackets.id, '10', 450000, { docType: 'TD04', status: 'DRAFT' })])
    expect(answer.state).toBe('ALL')
  })

  it('mixed lines: one line billed beyond its pieces never covers another line that is not billed', () => {
    const answer = invoicedOf([jackets, trousers], [bill(jackets.id, '14', 630000)])
    expect(answer).toMatchObject({ state: 'PART', pieces: '14', toInvoice: 14 })
  })

  it('pieces closed short are not to invoice: what shipped and was billed makes it All', () => {
    const closed = { ...jackets, closedShortQuantity: 3 }
    const answer = invoicedOf([closed, trousers], [bill(jackets.id, '7', 315000), bill(trousers.id, '4', 120000)])
    expect(answer).toEqual({ state: 'ALL', pieces: '11', toInvoice: 11, amount: 435000 })
  })

  it('a fee is billed by its SERVICE line; a fee credited against a bulk order owes nothing here', () => {
    const goodsBilled = [bill(jackets.id, '10', 450000)]
    expect(invoicedOf([jackets, fee], goodsBilled).state).toBe('PART')
    expect(invoicedOf([jackets, fee], [...goodsBilled, bill(fee.id, '1', 50000, { kind: 'SERVICE' })])).toMatchObject({ state: 'ALL', amount: 500000 })
    expect(invoicedOf([jackets, { ...fee, feeCredited: true }], goodsBilled).state).toBe('ALL')
  })

  it('deposit deductions, charges, a SERVICE line of a goods line and lines of another order do not count', () => {
    const answer = invoicedOf(
      [jackets],
      [
        bill(jackets.id, '-1', -135000, { kind: 'DEPOSIT_DEDUCTION' }),
        bill(jackets.id, '1', 2500, { kind: 'CHARGE' }),
        bill(jackets.id, '1', 9000, { kind: 'SERVICE' }),
        bill('line-of-another-order', '5', 225000),
        bill(jackets.id, '2', 90000, { salesOrderLineId: null }),
      ],
    )
    expect(answer).toMatchObject({ state: 'NONE', pieces: '0', amount: 0 })
  })

  it('decimal quantities add up exactly', () => {
    const answer = invoicedOf([trousers], [bill(trousers.id, '1.5000', 45000), bill(trousers.id, '2.5000', 75000)])
    expect(answer).toMatchObject({ state: 'ALL', pieces: '4' })
  })
})

// ── B-TH-244 (threads plan TH-4; feature SHEET.overall-F06): shipped goods no issued invoice bills yet ──
import { shippedNotInvoiced } from './invoiced'

describe('shippedNotInvoiced (B-TH-244)', () => {
  it('true while more pieces left than issued invoices bill (less credit notes); never for an order that shipped nothing', () => {
    expect(shippedNotInvoiced(10, { pieces: '0' })).toBe(true)
    expect(shippedNotInvoiced(10, undefined)).toBe(true)
    expect(shippedNotInvoiced(10, { pieces: '6' })).toBe(true)
    expect(shippedNotInvoiced(10, { pieces: '10' })).toBe(false)
    expect(shippedNotInvoiced(10, { pieces: '12.0000' })).toBe(false)
    expect(shippedNotInvoiced(0, { pieces: '0' })).toBe(false)
    // The Invoiced rule's own pieces: a credit note takes pieces back, so they wait to be invoiced again.
    const state = invoicedOf([jackets], [bill('line-jackets', '10', 1000), bill('line-jackets', '4', 400, { docType: 'TD04' })])
    expect(shippedNotInvoiced(10, state)).toBe(true)
  })
})
// ── end B-TH-244 ──
