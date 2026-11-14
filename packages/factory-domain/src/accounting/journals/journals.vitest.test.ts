import { describe, expect, it } from 'vitest'
import type { MappingRow, TaxCodeFacts } from '../mapping/keys'
import { costRegisterDocument, costTotals, type CostRegisterFacts } from './cost-of-sales'
import { balanceOf, balances, costEntry, entryDocument, moneyEntry, purchaseEntry, resolveEntry, salesEntry, unmappedOf, type SalesEntryFacts } from './entries'

const codes: TaxCodeFacts[] = [{ code: '22', label: 'Ordinary 22%', ratePct: '22.00', natura: null, accountCodeKey: 'VAT_SALES_22', validFrom: '2026-01-01', validTo: null }]

const invoice = (over: Partial<SalesEntryFacts> = {}): SalesEntryFacts => ({
  id: '00000000-0000-4000-8000-000000000001',
  number: 'FT-2026-00010',
  version: 3,
  docType: 'TD01',
  issueDate: '2026-10-12',
  currency: 'EUR',
  // Garments 800.00 + freight 20.00 at 22 %: VAT 180.40, gross 1000.40.
  netTotal: 82000,
  grossTotal: 100040,
  summary: [{ rate: '22.00', nature: null, taxable: 82000, vat: 18040 }],
  rounding: 0,
  lines: [
    { kind: 'GOODS', chargeKind: null, netAmount: 50000 },
    { kind: 'GOODS', chargeKind: null, netAmount: 30000 },
    { kind: 'CHARGE', chargeKind: 'FREIGHT', netAmount: 2000 },
  ],
  partyCode: 'C-MADEUP',
  partyName: 'Made-up Moto Srl',
  partyCountry: 'IT',
  ...over,
})

describe('the journal entries (B-W2b-408, FIN-151)', () => {
  it('posts an invoice: the receivable against revenue per group of lines and the output VAT of its rate', () => {
    const entry = salesEntry(invoice(), codes)
    expect(entry.lines).toEqual([
      { side: 'DEBIT', kind: 'PARTY_GROUP', key: 'CUSTOMERS_IT', amount: 100040 },
      { side: 'CREDIT', kind: 'ITEM_GROUP', key: 'SALES_GARMENTS', amount: 80000 },
      { side: 'CREDIT', kind: 'ITEM_GROUP', key: 'SALES_FREIGHT', amount: 2000 },
      { side: 'CREDIT', kind: 'TAX_CODE', key: 'VAT_SALES_22', amount: 18040 },
    ])
    expect(balanceOf(entry)).toEqual({ debit: 100040, credit: 100040 })
    expect([entry.package, entry.recordType, entry.number, entry.day]).toEqual(['SALES_JOURNAL', 'Invoice', 'FT-2026-00010', '2026-10-12'])
  })

  it('takes a credit note the other way round, a deposit invoice to the deposits, a deducted deposit back from them', () => {
    expect(salesEntry(invoice({ docType: 'TD04' }), codes).lines.map((line) => line.side)).toEqual(['CREDIT', 'DEBIT', 'DEBIT', 'DEBIT'])
    expect(salesEntry(invoice({ docType: 'TD02', lines: [{ kind: 'SERVICE', chargeKind: null, netAmount: 82000 }] }), codes).lines[1]).toEqual({ side: 'CREDIT', kind: 'ITEM_GROUP', key: 'CUSTOMER_DEPOSITS', amount: 82000 })
    // 1000.00 of garments less a 180.00 deposit deducted: the deposit's line is a debit on the deposits.
    const deducted = salesEntry(invoice({ lines: [{ kind: 'GOODS', chargeKind: null, netAmount: 100000 }, { kind: 'DEPOSIT_DEDUCTION', chargeKind: null, netAmount: -18000 }] }), codes)
    expect(deducted.lines[2]).toEqual({ side: 'DEBIT', kind: 'ITEM_GROUP', key: 'CUSTOMER_DEPOSITS', amount: 18000 })
    expect(balances(deducted)).toBe(true)
  })

  it('adds the VAT summary roundings to the first group, and does not balance when the lines are not the total', () => {
    expect(balances(salesEntry(invoice({ rounding: -1, lines: [{ kind: 'GOODS', chargeKind: null, netAmount: 82001 }] }), codes))).toBe(true)
    expect(balances(salesEntry(invoice({ lines: [{ kind: 'GOODS', chargeKind: null, netAmount: 81000 }] }), codes))).toBe(false)
  })

  it('posts a supplier invoice: purchases by item kind, charges, input VAT and stamp duty against the payable and the tax withheld', () => {
    const entry = purchaseEntry({
      id: '00000000-0000-4000-8000-000000000002',
      number: '2026/77',
      version: 1,
      kind: 'INVOICE',
      docType: 'TD01',
      receivedOn: '2026-10-05',
      currency: 'EUR',
      netTotal: 60000,
      vatTotal: 13200,
      grossTotal: 73400,
      withholdingAmount: 1000,
      stampDutyAmount: 200,
      lines: [
        { kind: 'GOODS', itemKind: 'LEATHER', netAmount: 50000 },
        { kind: 'CHARGE', itemKind: null, netAmount: 5000 },
        { kind: 'GOODS', itemKind: null, netAmount: 5000 },
      ],
      supplierCode: 'S-MADEUP',
      supplierName: 'Made-up Tannery',
      supplierCountry: 'IT',
    })
    expect(entry.lines).toEqual([
      { side: 'DEBIT', kind: 'ITEM_GROUP', key: 'LEATHER', amount: 50000 },
      { side: 'DEBIT', kind: 'COST_CATEGORY', key: 'CHARGES', amount: 5000 },
      { side: 'DEBIT', kind: 'ITEM_GROUP', key: 'MATERIALS', amount: 5000 },
      { side: 'DEBIT', kind: 'COST_CATEGORY', key: 'STAMP_DUTY', amount: 200 },
      { side: 'DEBIT', kind: 'TAX_CODE', key: 'VAT_INPUT', amount: 13200 },
      { side: 'CREDIT', kind: 'PARTY_GROUP', key: 'SUPPLIERS_IT', amount: 72400 },
      { side: 'CREDIT', kind: 'TAX_CODE', key: 'WITHHOLDING', amount: 1000 },
    ])
    expect(balances(entry)).toBe(true)
    expect(entry.number).toBe('S-MADEUP 2026/77')
  })

  it('posts a payment and a refund between the money and the receivable', () => {
    const money = { id: '00000000-0000-4000-8000-000000000003', reference: 'CRO-MADEUP-1', version: 1, day: '2026-10-20', method: 'BANK_TRANSFER', currency: 'EUR', amount: 41000, partyCode: 'C-MADEUP', partyName: 'Made-up Moto', partyCountry: 'DE' }
    expect(moneyEntry('Payment', money).lines).toEqual([
      { side: 'DEBIT', kind: 'PAYMENT_METHOD', key: 'BANK_TRANSFER', amount: 41000 },
      { side: 'CREDIT', kind: 'PARTY_GROUP', key: 'CUSTOMERS_EU', amount: 41000 },
    ])
    expect(moneyEntry('Refund', money).lines.map((line) => line.side)).toEqual(['CREDIT', 'DEBIT'])
  })

  it('posts the cost bridge: cost of goods sold, a variance against WIP (favourable the other way), a purchase price variance', () => {
    const base = { reference: 'SH-1', day: '2026-10-21', currency: 'EUR', partyCode: null, partyName: null, category: null, itemKind: null } as const
    expect(costEntry({ ...base, recordType: 'CostOfSalesEntry', id: 'a', amount: 4321 }).lines).toEqual([
      { side: 'DEBIT', kind: 'COST_CATEGORY', key: 'COST_OF_SALES', amount: 4321 },
      { side: 'CREDIT', kind: 'COST_CATEGORY', key: 'FINISHED_GOODS', amount: 4321 },
    ])
    expect(costEntry({ ...base, recordType: 'WorkOrderVariance', id: 'b', amount: -150, category: 'LABOUR_EFFICIENCY' }).lines).toEqual([
      { side: 'CREDIT', kind: 'COST_CATEGORY', key: 'VARIANCE_LABOUR_EFFICIENCY', amount: 150 },
      { side: 'DEBIT', kind: 'COST_CATEGORY', key: 'WIP', amount: 150 },
    ])
    expect(costEntry({ ...base, recordType: 'PurchasePriceVariance', id: 'c', amount: 900, itemKind: 'LEATHER' }).lines.map((line) => line.key)).toEqual(['PPV', 'LEATHER'])
    expect(costEntry({ ...base, recordType: 'CostOfSalesEntry', id: 'd', amount: 0 }).lines).toEqual([])
  })

  it('takes the account in force on the document day and names the keys with none', () => {
    const mapping: MappingRow[] = [
      { id: 'm1', kind: 'PARTY_GROUP', key: 'CUSTOMERS_IT', accountCode: '1201', validFrom: '2026-01-01' },
      { id: 'm2', kind: 'ITEM_GROUP', key: 'SALES_GARMENTS', accountCode: '7001', validFrom: '2026-11-01' },
      { id: 'm3', kind: 'TAX_CODE', key: 'VAT_SALES_22', accountCode: '2601', validFrom: '2026-01-01' },
    ]
    const entry = salesEntry(invoice(), codes)
    expect(resolveEntry(entry, mapping).map((line) => line.accountCode)).toEqual(['1201', null, null, '2601'])
    expect(unmappedOf(entry, mapping)).toEqual([
      { kind: 'ITEM_GROUP', key: 'SALES_GARMENTS' },
      { kind: 'ITEM_GROUP', key: 'SALES_FREIGHT' },
    ])
    const document = entryDocument(entry, mapping)
    expect(document.rows[0]).toEqual([{ day: '2026-10-12' }, 'Invoice', 'FT-2026-00010', 'C-MADEUP', 'Made-up Moto Srl', 1, '1201', 'PARTY_GROUP', 'CUSTOMERS_IT', { minor: 100040, currency: 'EUR' }, null])
    expect(document.document).toMatchObject({ package: 'SALES_JOURNAL', recordType: 'Invoice', recordId: entry.recordId })
  })
})

describe('the cost of goods sold and variances register (B-W2b-408)', () => {
  const figure = (over: Partial<CostRegisterFacts>): CostRegisterFacts => ({
    recordType: 'CostOfSalesEntry',
    id: '00000000-0000-4000-8000-0000000000aa',
    reference: 'SH-2026-0001',
    day: '2026-10-21',
    currency: 'EUR',
    amount: 10000,
    partyCode: 'C-MADEUP',
    partyName: 'Made-up Moto',
    category: null,
    itemKind: null,
    workOrderNumber: null,
    itemCode: null,
    at: null,
    quantity: '2.0000',
    parts: { material: 6000, labour: 3000, subcontract: 0, overhead: 1000 },
    reverses: null,
    ...over,
  })

  it('writes one row per figure, its parts, and sums per kind and currency', () => {
    const sold = costRegisterDocument(figure({}))
    expect(sold.rows).toEqual([['COST_OF_SALES', { day: '2026-10-21' }, 'SH-2026-0001', null, 'C-MADEUP', 'Made-up Moto', null, null, { decimal: '2.0000' }, { minor: 6000, currency: 'EUR' }, { minor: 3000, currency: 'EUR' }, { minor: 0, currency: 'EUR' }, { minor: 1000, currency: 'EUR' }, { minor: 10000, currency: 'EUR' }, null]])
    expect(sold.document).toMatchObject({ package: 'COST_OF_SALES', recordType: 'CostOfSalesEntry', number: 'SH-2026-0001', version: null })
    const variance = costRegisterDocument(figure({ recordType: 'WorkOrderVariance', id: 'v', reference: 'WO-7', workOrderNumber: 'WO-7', category: 'SCRAP', parts: null, amount: -250, partyCode: null, partyName: null }))
    expect(variance.rows[0]!.slice(0, 8)).toEqual(['VARIANCE', { day: '2026-10-21' }, 'WO-7', 'WO-7', null, null, null, 'SCRAP'])
    expect(costTotals([figure({}), figure({ amount: -10000 }), figure({ recordType: 'PurchasePriceVariance', amount: 900 })])).toEqual([
      { kind: 'COST_OF_SALES', currency: 'EUR', amount: 0 },
      { kind: 'PPV', currency: 'EUR', amount: 900 },
    ])
  })
})
