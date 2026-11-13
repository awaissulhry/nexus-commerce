import { describe, expect, it } from 'vitest'
import { composeDocument } from '../../documents/compose'
import { DOCUMENT_LAYOUTS } from '../../documents/layouts'
import type { CompanyLegal } from '../../documents/model'
import { groupOrders, orderImporter, ORDER_IMPORT_EXAMPLES } from '../order-import/importer'
import { closedSeasonWords, seasonNotice, seasonProblems, seasonState } from '../seasons/rules'
import { confirmationDocument, confirmationFingerprint, confirmationMail, confirmationNumber, ppeWords, type CustomerOrder } from './confirmation'
import { discountPctOf, planSplit, priorityOf, salesOrderFacts, SALES_ORDER_FIELDS, type SplitSourceLine } from './rules'

/** Orders in depth (B-W2b-303): priority, split, the SALES_ORDER facts, the confirmation, seasons, the sheet import. Made-up data. */

describe('priority and the urgent flag (SAL-207)', () => {
  it('URGENT carries its reason, one line; no other level takes one', () => {
    expect(priorityOf({ priorityLevel: 'URGENT', urgentReason: '  Race on Sunday (made-up) ' })).toEqual({ priorityLevel: 'URGENT', urgentReason: 'Race on Sunday (made-up)' })
    expect(priorityOf({ priorityLevel: 'URGENT' })).toEqual([{ path: 'body/urgentReason', message: 'Say why the order is urgent.' }])
    expect(priorityOf({ priorityLevel: 'URGENT', urgentReason: 'two\nlines' })).toEqual([expect.objectContaining({ path: 'body/urgentReason' })])
    expect(priorityOf({ priorityLevel: 'URGENT', urgentReason: 'x'.repeat(501) })).toEqual([expect.objectContaining({ path: 'body/urgentReason' })])
    expect(priorityOf({ priorityLevel: 'HIGH', urgentReason: 'Not with HIGH' })).toEqual([{ path: 'body/urgentReason', message: 'A reason goes with Urgent only: leave it out for this level.' }])
    expect(priorityOf({ priorityLevel: 'LOW', urgentReason: '  ' })).toEqual({ priorityLevel: 'LOW', urgentReason: null })
  })
})

const line = (id: string, seq: number, sizes: [string, number][], extra: Partial<SplitSourceLine> = {}): SplitSourceLine => ({ id, seq, kind: 'SIZE_GRID', closedShort: false, sizes: sizes.map(([size, quantity]) => ({ size, quantity })), hasDeliveries: false, hasOptions: false, ...extra })

describe('several orders from one (SAL-201)', () => {
  const source = [line('a', 10, [['50', 4], ['52', 6]]), line('b', 20, [['48', 2]], { hasDeliveries: true }), line('f', 30, [], { kind: 'FEE' })]

  it('moves a whole line and some sizes of another into two parts; the order keeps the rest', () => {
    const plan = planSplit(source, [{ lines: [{ lineId: 'b' }] }, { lines: [{ lineId: 'a', sizes: [{ size: '52', quantity: 2 }] }] }])
    if (Array.isArray(plan)) throw new Error(JSON.stringify(plan))
    expect(plan.parts).toEqual([[{ lineId: 'b', seq: 20, whole: true, sizes: [{ size: '48', quantity: 2 }] }], [{ lineId: 'a', seq: 10, whole: false, sizes: [{ size: '52', quantity: 2 }] }]])
    expect(plan.leaving).toEqual(['b'])
    expect([...plan.remaining.entries()]).toEqual([
      ['a', [{ size: '50', quantity: 4 }, { size: '52', quantity: 4 }]],
      ['f', []],
    ])
  })

  it('refuses in words: a line twice, more than the order has, a size it lacks, part of a scheduled line, a fee, everything', () => {
    expect(planSplit(source, [])).toEqual([expect.objectContaining({ path: 'body/parts' })])
    expect(planSplit(source, [{ lines: [{ lineId: 'a' }, { lineId: 'a' }] }])).toEqual([{ path: 'body/parts/0/lines/1/lineId', message: 'Line 10 is named twice in this part.' }])
    expect(planSplit(source, [{ lines: [{ lineId: 'a', sizes: [{ size: '52', quantity: 4 }] }] }, { lines: [{ lineId: 'a', sizes: [{ size: '52', quantity: 3 }] }] }])).toEqual([{ path: 'body/parts/1/lines/0/sizes/0/quantity', message: 'Line 10 has 2 of size 52 left to move, not 3.' }])
    expect(planSplit(source, [{ lines: [{ lineId: 'a', sizes: [{ size: '56', quantity: 1 }] }] }])).toEqual([{ path: 'body/parts/0/lines/0/sizes/0/size', message: 'Line 10 has no size 56.' }])
    expect(planSplit(source, [{ lines: [{ lineId: 'b', sizes: [{ size: '48', quantity: 1 }] }] }])).toEqual([{ path: 'body/parts/0/lines/0/sizes', message: 'Line 20 has a delivery schedule: it moves whole or stays.' }])
    expect(planSplit(source, [{ lines: [{ lineId: 'f' }] }])).toEqual([{ path: 'body/parts/0/lines/0/lineId', message: 'Line 30 is a fee: it stays on this order.' }])
    expect(planSplit([line('a', 10, [['50', 1]])], [{ lines: [{ lineId: 'a' }] }])).toEqual([{ path: 'body/parts', message: 'The order keeps at least one line: move less, or change the order itself.' }])
    expect(planSplit(source, [{ lines: [{ lineId: 'zz' }] }])).toEqual([{ path: 'body/parts/0/lines/0/lineId', message: 'Not a line of this order.' }])
  })
})

describe('the SALES_ORDER facts (SAL-205)', () => {
  it('the value (net, price grain), the discount off the list from the waterfalls, lines, pieces, customer, priority', () => {
    const lines = [
      { kind: 'SIZE_GRID', quantity: 10, unitPrice: '90.000000', priceSteps: [{ kind: 'LIST', unitPrice: '100' }, { kind: 'NET', unitPrice: '90' }] },
      { kind: 'SIZE_GRID', quantity: 10, unitPrice: '100', priceSteps: null },
      { kind: 'FEE', quantity: 1, unitPrice: '50', priceSteps: null },
    ]
    expect(discountPctOf(lines)).toBe('10.00')
    expect(discountPctOf([lines[1]!])).toBeNull()
    expect(discountPctOf([{ kind: 'SIZE_GRID', quantity: 1, unitPrice: '120', priceSteps: [{ kind: 'LIST', unitPrice: '100' }] }])).toBe('0.00')
    expect(salesOrderFacts({ currency: 'EUR', netAmount: 195_000, customerCode: 'CLI-EX', priorityLevel: 'HIGH', fromQuote: true, lines })).toEqual({ orderValue: '1950', discountPct: '10.00', currency: 'EUR', lineCount: 3, pieces: 20, customerCode: 'CLI-EX', priorityLevel: 'HIGH', fromQuote: true })
    expect(SALES_ORDER_FIELDS.find((field) => field.id === 'orderValue')).toMatchObject({ grain: 'price' })
    // The seeded rule's two facts exist (approvals seed "Large orders or deep discounts").
    expect(SALES_ORDER_FIELDS.map((field) => field.id)).toEqual(expect.arrayContaining(['orderValue', 'discountPct']))
  })
})

const ORDER: CustomerOrder = {
  number: 'SO-EX-0001',
  version: 2,
  date: '2026-11-13',
  language: 'en',
  currency: 'EUR',
  priceBasis: 'NET',
  orderDate: '2026-11-10',
  customerRef: 'PO-EX-7',
  quoteNumber: 'Q-EX-0003 v2',
  promiseDate: '2027-02-01',
  paymentTerms: '30 days end of month',
  deliveryTerms: 'DAP Milano (Delivered at place)',
  shipComplete: true,
  season: { code: 'FW27', name: 'Autumn-winter 2027' },
  party: { name: 'Moto Esempio S.r.l.', address: { line1: 'Via dei Tigli 4', postalCode: '40100', city: 'Bologna', province: 'BO', country: 'IT' }, vatNumber: 'IT00000000000', fiscalCode: null, email: 'acquisti@moto-esempio.example' },
  shipTo: { name: 'Warehouse', line1: 'Via del Porto 1', postalCode: '20100', city: 'Milano', country: 'IT' },
  lines: [{ seq: 10, code: 'JK-210 BLK', description: 'Racing jacket', note: null, ppe: 'PPE cat. II · EN 17092-4 · class AA', quantity: 6, unitPrice: '90', listUnitPrice: '100', netAmount: 54_000, vatAmount: 11_880, sizes: [{ size: '50', quantity: 2, unitPrice: null }, { size: '52', quantity: 4, unitPrice: null }], deliveries: [{ date: '2027-01-15', quantity: 2 }, { date: '2027-02-01', quantity: 4 }] }],
  totals: { net: 54_000, vat: [{ rate: '22.00', nature: null, taxable: 54_000, vat: 11_880 }], gross: 65_880 },
  deposit: { amount: 19_764, kind: 'ACCONTO' },
}

describe('the order confirmation (SAL-208)', () => {
  it('composes the fixed ORDER_CONFIRMATION layout: lines with sizes, PPE class and deliveries, the discount, the references and terms', () => {
    const document = confirmationDocument(ORDER, (minor) => `€ ${(minor / 100).toFixed(2)}`)
    expect(document).toMatchObject({ type: 'ORDER_CONFIRMATION', number: 'SO-EX-0001 v2', deliveryDate: '2027-02-01', deliveryTerms: 'DAP Milano (Delivered at place)' })
    expect(document.lines[0]).toMatchObject({ code: 'JK-210 BLK', quantity: '6', uom: 'pcs', unitPrice: '90', discountPercent: '10', amountMinor: 54_000 })
    expect(document.lines[0]!.description).toContain('Sizes: 50×2 · 52×4')
    expect(document.lines[0]!.description).toContain('PPE cat. II · EN 17092-4 · class AA')
    expect(document.lines[0]!.description).toContain('Deliveries: 2027-01-15 × 2 · 2027-02-01 × 4')
    expect(document.references).toEqual([{ kind: 'CUSTOMER_ORDER', number: 'PO-EX-7' }, { kind: 'QUOTE', number: 'Q-EX-0003 v2' }, { kind: 'SALES_ORDER', number: 'SO-EX-0001', date: '2026-11-10' }])
    expect(document.notes).toContain('Season: FW27 - Autumn-winter 2027.')
    expect(document.notes).toContain('Deposit asked: € 197.64.')
    expect(DOCUMENT_LAYOUTS.ORDER_CONFIRMATION.priced).toBe(true)
    const company: CompanyLegal = { legalName: 'Pelletteria Esempio S.r.l.', address: { line1: 'Via Esempio 1', postalCode: '50100', city: 'Firenze', province: 'FI', country: 'IT' }, vatNumber: 'IT00000000001', fiscalCode: '00000000001', reaOffice: 'FI', reaNumber: '000000', shareCapital: '10000.00', currency: 'EUR' }
    const composed = composeDocument({ ...document, company, sample: false })
    expect(composed.title).toBe('Order confirmation')
    expect(composed.layout).toBe('ORDER_CONFIRMATION/1')
  })

  it('the fingerprint ignores the day and the version; anything printed changes it', () => {
    expect(confirmationFingerprint({ ...ORDER, date: '2026-12-01', version: 3 })).toBe(confirmationFingerprint(ORDER))
    expect(confirmationFingerprint({ ...ORDER, promiseDate: '2027-02-08' })).not.toBe(confirmationFingerprint(ORDER))
    expect(confirmationNumber('SO-1', 4)).toBe('SO-1 v4')
  })

  it('the mail in the order language, or the office\'s own words; the PPE words of a style', () => {
    expect(confirmationMail({ language: 'it', number: 'SO-1 v1', recipientName: 'Ufficio acquisti', message: null })).toEqual({ subject: "Conferma d'ordine SO-1 v1", body: expect.stringContaining('Gentile Ufficio acquisti,') })
    expect(confirmationMail({ language: 'en', number: 'SO-1 v1', recipientName: null, message: 'Our own words.' })).toEqual({ subject: 'Order confirmation SO-1 v1', body: 'Our own words.' })
    expect(ppeWords({ ppeCategory: 'NOT_PPE', ppeStandard: null, ppeClass: null }, 'en')).toBeNull()
    expect(ppeWords({ ppeCategory: 'CATEGORY_II', ppeStandard: 'EN 17092-4', ppeClass: 'AA' }, 'it')).toBe('DPI cat. II · EN 17092-4 · classe AA')
  })
})

describe('seasons per company (SAL-277)', () => {
  it('says the database rules first, in words', () => {
    expect(seasonProblems({ code: 'FW27', name: 'Autumn 27', startsOn: '2027-01-01', endsOn: '2027-06-30', orderBookClosesOn: '2027-03-31', note: null })).toEqual([])
    expect(seasonProblems({ code: ' FW', name: '', startsOn: '2027-02-01', endsOn: '2027-01-01', orderBookClosesOn: '2027-03-01', note: null }).map((issue) => issue.path)).toEqual(['body/code', 'body/name', 'body/endsOn', 'body/orderBookClosesOn'])
    expect(closedSeasonWords('SS26')).toBe('Season SS26 is closed: name an open season, or reopen it first.')
  })

  it('reads its state on a day: open, order book closed, ended, closed', () => {
    const season = { code: 'FW27', status: 'OPEN' as const, endsOn: '2027-06-30', orderBookClosesOn: '2027-03-31' }
    expect(seasonState(season, '2027-03-31')).toBe('OPEN')
    expect(seasonState(season, '2027-04-01')).toBe('BOOK_CLOSED')
    expect(seasonState(season, '2027-07-01')).toBe('ENDED')
    expect(seasonState({ ...season, status: 'CLOSED' }, '2027-01-01')).toBe('CLOSED')
    expect(seasonNotice(season, '2027-04-01')?.en).toBe('The order book of FW27 closed on 2027-03-31.')
    expect(seasonNotice(season, '2027-01-01')).toBeNull()
  })
})

describe('import orders from a sheet (SAL-215)', () => {
  it('groups the rows by order reference, one line per style and colour; the header cells agree', () => {
    const rows = ORDER_IMPORT_EXAMPLES.map((values, index) => ({ rowNumber: index + 2, values: { ...values, quantity: Number(values.quantity) } }))
    const { orders, issues } = groupOrders(rows)
    expect(issues.every((list) => list.length === 0)).toBe(true)
    expect(orders.map((order) => order.reference)).toEqual(['1', '2'])
    expect(orders[0]!.header).toMatchObject({ customer: 'CLI-001', customerPo: 'PO-ESEMPIO-7', season: 'FW27' })
    expect(orders[0]!.lines).toEqual([{ style: 'JK-210', colour: 'BLK', unitPrice: null, note: null, sizes: [{ size: '50', quantity: 4, rowNumber: 2 }, { size: '52', quantity: 6, rowNumber: 3 }] }])
    expect(orders[1]!.header).toMatchObject({ priority: 'URGENT', urgentReason: 'Made-up race weekend' })
  })

  it('names the rows that disagree, two prices of one style and colour, an urgent order without its reason', () => {
    const { issues } = groupOrders([
      { rowNumber: 2, values: { order: 'A', customer: 'CLI-001', style: 'JK-1', colour: 'BLK', size: '50', quantity: 1, unitPrice: '10' } },
      { rowNumber: 3, values: { order: 'A', customer: 'CLI-002', style: 'JK-1', colour: 'blk', size: '52', quantity: 1, unitPrice: '11' } },
      { rowNumber: 4, values: { order: 'B', customer: 'CLI-001', style: 'JK-1', colour: 'BLK', size: '50', quantity: 1, priority: 'URGENT' } },
    ])
    expect(issues[0]!.map((issue) => issue.column)).toEqual(['customer', 'unitPrice'])
    expect(issues[1]!.map((issue) => issue.column)).toEqual(['customer', 'unitPrice'])
    expect(issues[2]).toEqual([{ column: 'urgentReason', message: 'Order B is URGENT: say why on one of its rows.' }])
  })

  it('declares a key of order, style, colour and size; only new orders; a price column of the price grain', () => {
    expect(orderImporter.keyColumns).toEqual(['order', 'style', 'colour', 'size'])
    expect(orderImporter.columns.unitPrice.grain).toBe('price')
    expect(orderImporter.plan({ order: '1' }, null)).toEqual({ action: 'CREATE', after: { order: '1' } })
    expect(orderImporter.validateRow({ urgentReason: 'x', priority: 'HIGH' })).toEqual([{ column: 'urgentReason', message: 'A reason goes with URGENT only.' }])
  })
})
