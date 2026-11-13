import { describe, expect, it } from 'vitest'
import { composeDocument } from './compose'
import { DOCUMENT_LAYOUTS } from './layouts'
import type { CompanyLegal, DocumentInput } from './model'
import { groupCellsByOptions, optionsText, optionWords, travellerOptionsTable, withOptions, type PrintedOption } from './options-block'
import { confirmationFingerprint, type CustomerOrder } from '../sales/orders-depth/confirmation'
import { travellerPaper, type TravellerFacts } from '../production/work-orders/traveller'

/* Every company, person and number here is made up. */
const COMPANY: CompanyLegal = {
  legalName: 'Pelletteria Fittizia S.r.l.',
  address: { line1: 'Via dei Conciatori Finti 1', postalCode: '20121', city: 'Milano', province: 'MI', country: 'IT' },
  vatNumber: 'IT12345670009',
  fiscalCode: '12345670009',
  reaOffice: 'MI',
  reaNumber: '0000001',
  shareCapital: '10000.00',
  currency: 'EUR',
}
const OPTIONS: PrintedOption[] = [
  { group: 'Imbottitura termica', value: 'Removibile' },
  { group: 'Foratura', value: 'Anteriore', colour: 'Giallo fluo (DEMO-FLUO)' },
  { group: 'Nome sul petto', value: 'Ricamato', text: 'BIANCHI', material: 'Filo DEMO-THR-1 · Rosso' },
]
const priced = (type: DocumentInput['type'], options?: PrintedOption[]): DocumentInput => ({
  type,
  language: 'it',
  number: 'DEMO-1',
  date: '2026-11-13',
  currency: 'EUR',
  company: COMPANY,
  party: { name: 'Cliente Immaginario S.p.A.', address: { line1: 'Viale delle Prove 42', postalCode: '40121', city: 'Bologna', country: 'IT' } },
  lines: [{ code: 'DEMO-JKT-05 BLK', description: 'Giacca touring demo', quantity: '2', uom: 'pz', unitPrice: '470', amountMinor: 94000, vatRate: '22', options: options ?? null }],
  totals: { netMinor: 94000, vat: [{ rate: '22', taxableMinor: 94000, vatMinor: 20680 }], grossMinor: 114680 },
})

describe('the options as paper prints them (B-W2b-374; XF3:03)', () => {
  it('one option in words: the group, the value, the text in quotes, a colour or a material after', () => {
    expect(optionWords(OPTIONS[0]!)).toBe('Imbottitura termica: Removibile')
    expect(optionWords(OPTIONS[1]!)).toBe('Foratura: Anteriore (Giallo fluo (DEMO-FLUO))')
    expect(optionWords(OPTIONS[2]!)).toBe('Nome sul petto: Ricamato «BIANCHI» (Filo DEMO-THR-1 · Rosso)')
    expect(optionsText(OPTIONS, 'en')).toMatch(/^Options: Imbottitura termica: Removibile; Foratura/)
    expect(optionsText([], 'it')).toBeNull()
    expect(withOptions('Giacca', null, 'it')).toBe('Giacca')
  })

  it('the quote, the order confirmation and the invoice copy print a line\'s options after its description (layout version 2)', () => {
    for (const type of ['QUOTE', 'ORDER_CONFIRMATION', 'INVOICE_COPY'] as const) {
      expect(DOCUMENT_LAYOUTS[type]).toMatchObject({ id: `${type}/2`, printsOptions: true })
      const composed = composeDocument(priced(type, OPTIONS))
      const description = composed.table.rows[0]!.find((cell) => cell.startsWith('Giacca'))!
      expect(description).toBe(`Giacca touring demo — Opzioni: ${OPTIONS.map(optionWords).join('; ')}`)
      // A line without options prints as before.
      expect(composeDocument(priced(type)).table.rows[0]!.some((cell) => cell === 'Giacca touring demo')).toBe(true)
    }
    // A purchase order never prints them (its layout does not).
    expect(DOCUMENT_LAYOUTS.PURCHASE_ORDER.printsOptions).toBeUndefined()
  })

  it("a confirmation's fingerprint stays as it was for an order without options", () => {
    const order: CustomerOrder = {
      number: 'DEMO-SO-1',
      version: 1,
      date: '2026-11-13',
      language: 'it',
      currency: 'EUR',
      priceBasis: 'NET',
      orderDate: '2026-11-13',
      customerRef: null,
      quoteNumber: null,
      promiseDate: null,
      paymentTerms: null,
      deliveryTerms: null,
      shipComplete: false,
      season: null,
      party: { name: 'Cliente', address: null, vatNumber: null, fiscalCode: null, email: null },
      shipTo: null,
      lines: [{ seq: 10, code: 'X', description: 'Giacca', note: null, ppe: null, quantity: 1, unitPrice: '100', listUnitPrice: null, netAmount: 10000, vatAmount: 2200, sizes: [], deliveries: [] }],
      totals: { net: 10000, vat: [], gross: 12200 },
      deposit: null,
    }
    const withNone = confirmationFingerprint(order)
    expect(confirmationFingerprint({ ...order, lines: [{ ...order.lines[0]!, options: OPTIONS }] })).not.toBe(withNone)
    expect(confirmationFingerprint({ ...order, date: '2026-11-14' })).toBe(withNone)
  })

  it('the traveller prints the options to make per colour and the sizes made with the same ones (never a price)', () => {
    const rows = groupCellsByOptions(
      [
        { colourway: 'BLK', size: '52', quantity: 2, options: OPTIONS },
        { colourway: 'BLK', size: '50', quantity: 1, options: OPTIONS },
        { colourway: 'BLK', size: '54', quantity: 3, options: [] },
      ],
      ['50', '52', '54'],
    )
    expect(rows).toEqual([
      { colourway: 'BLK', sizes: ['50', '52'], pieces: 3, options: OPTIONS },
      { colourway: 'BLK', sizes: ['54'], pieces: 3, options: [] },
    ])
    const table = travellerOptionsTable(rows, 'en')!
    expect(table.title).toBe('Options to make')
    expect(table.rows).toEqual([['BLK', '50, 52', '3', OPTIONS.map(optionWords).join('; ')]])
    expect(travellerOptionsTable([rows[1]!], 'it')).toBeNull()
    const facts: TravellerFacts = {
      number: 'WO-DEMO-1',
      batchNumber: null,
      status: 'RELEASED',
      kind: 'SIZE_GRID',
      rush: false,
      priority: 0,
      dueDate: null,
      site: { code: 'S1', name: 'Demo' },
      style: { code: 'DEMO-JKT-05', name: 'Demo jacket' },
      revision: 1,
      orders: [],
      splitFrom: null,
      note: null,
      holdReason: null,
      releasedAt: null,
      sizes: ['50', '52', '54'],
      cells: [{ colourway: 'BLK', size: '50', quantity: 1 }],
      frozen: true,
      operations: [],
      materials: [],
      printedAt: new Date('2026-11-13T08:00:00Z'),
      timeZone: 'Europe/Rome',
    }
    expect(travellerPaper(facts, 'it').tables.map((entry) => entry.title)).toEqual(['Taglie e quantità', 'Fasi di lavorazione', 'Materiali previsti'])
    expect(travellerPaper({ ...facts, options: rows }, 'it').tables.map((entry) => entry.title)).toEqual(['Taglie e quantità', 'Opzioni da realizzare', 'Fasi di lavorazione', 'Materiali previsti'])
  })
})
