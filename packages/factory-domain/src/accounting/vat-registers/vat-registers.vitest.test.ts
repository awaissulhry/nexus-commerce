import { describe, expect, it } from 'vitest'
import type { SalesInvoiceFacts, SupplierInvoiceFacts } from '../journals'
import { purchasesRegisterDocument, salesRegisterDocument, vatTotalCells, vatTotals } from './registers'

const sale = (over: Partial<SalesInvoiceFacts>): SalesInvoiceFacts => ({
  id: '00000000-0000-4000-8000-000000000011',
  number: 'FT-2026-00011',
  version: 1,
  docType: 'TD01',
  issueDate: '2026-10-03',
  currency: 'EUR',
  netTotal: 100000,
  vatTotal: 22000,
  grossTotal: 122000,
  stampDutyAmount: null,
  summary: [{ rate: '22.00', nature: null, taxable: 100000, vat: 22000 }],
  buyerCode: 'C-MADEUP',
  buyer: { kind: 'IT_BUSINESS', name: 'Made-up Moto Srl', vatId: 'IT00000000000', fiscalCode: null, country: 'IT' },
  creditOfNumber: null,
  ...over,
})

const purchase = (over: Partial<SupplierInvoiceFacts>): SupplierInvoiceFacts => ({
  id: '00000000-0000-4000-8000-000000000012',
  number: '2026/9',
  version: 1,
  kind: 'INVOICE',
  docType: 'TD01',
  source: 'SDI',
  issueDate: '2026-10-01',
  receivedOn: '2026-10-02',
  currency: 'EUR',
  netTotal: 40000,
  vatTotal: 8800,
  grossTotal: 48800,
  withholdingAmount: null,
  stampDutyAmount: null,
  summary: [{ rate: '22.00', nature: null, taxable: 40000, vat: 8800 }],
  supplierCode: 'S-MADEUP',
  supplierName: 'Made-up Tannery',
  supplierVatId: 'IT00000000001',
  sdiIdentifier: null,
  ...over,
})

describe('the VAT registers (B-W2b-408, FIN-106)', () => {
  it('lists a sale per VAT rate or Natura, a credit note below 0', () => {
    const mixed = salesRegisterDocument(sale({ netTotal: 150000, grossTotal: 172000, summary: [{ rate: '22.00', nature: null, taxable: 100000, vat: 22000 }, { rate: '0.00', nature: 'N3.2', taxable: 50000, vat: 0 }] }))
    expect(mixed.rows.map((row) => [row[7], row[8], row[9], row[10]])).toEqual([
      [{ decimal: '22.00' }, null, { minor: 100000, currency: 'EUR' }, { minor: 22000, currency: 'EUR' }],
      [{ decimal: '0.00' }, 'N3.2', { minor: 50000, currency: 'EUR' }, { minor: 0, currency: 'EUR' }],
    ])
    expect(mixed.document).toMatchObject({ package: 'VAT_REGISTERS', recordType: 'Invoice', number: 'FT-2026-00011' })
    const credit = salesRegisterDocument(sale({ docType: 'TD04' }))
    expect([credit.rows[0]![9], credit.rows[0]![10], credit.rows[0]![11]]).toEqual([{ minor: -100000, currency: 'EUR' }, { minor: -22000, currency: 'EUR' }, { minor: -122000, currency: 'EUR' }])
  })

  it('lists a purchase by the day it was registered, a supplier credit note below 0', () => {
    const row = purchasesRegisterDocument(purchase({})).rows[0]!
    expect([row[0], row[1], row[4], row[9], row[10]]).toEqual([{ day: '2026-10-02' }, '2026/9', 'S-MADEUP', { minor: 40000, currency: 'EUR' }, { minor: 8800, currency: 'EUR' }])
    expect(purchasesRegisterDocument(purchase({ kind: 'CREDIT_NOTE' })).rows[0]![10]).toEqual({ minor: -8800, currency: 'EUR' })
  })

  it("sums the month: each rate of each register, then the VAT due (sales less purchases)", () => {
    const totals = vatTotals([sale({}), sale({ id: 'x', docType: 'TD04', netTotal: 10000, vatTotal: 2200, grossTotal: 12200, summary: [{ rate: '22.00', nature: null, taxable: 10000, vat: 2200 }] })], [purchase({})])
    expect(totals).toEqual([
      { side: 'SALES', rate: '22.00', nature: null, currency: 'EUR', taxable: 90000, vat: 19800 },
      { side: 'PURCHASES', rate: '22.00', nature: null, currency: 'EUR', taxable: 40000, vat: 8800 },
      { side: 'DUE', rate: null, nature: null, currency: 'EUR', taxable: 0, vat: 11000 },
    ])
    expect(vatTotalCells(totals[2]!)).toEqual(['DUE', null, null, 'EUR', null, { minor: 11000, currency: 'EUR' }])
    // More purchase VAT than sales VAT: a credit (below 0).
    expect(vatTotals([], [purchase({})]).at(-1)).toEqual({ side: 'DUE', rate: null, nature: null, currency: 'EUR', taxable: 0, vat: -8800 })
  })
})
