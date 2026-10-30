import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { validateXML } from 'xmllint-wasm'
import { LEGAL_WORDING, nonTaxable, taxable } from '../../tax/vat-treatment'
import { fatturaPaInputOf, type IssuedInvoice, type StoredLine } from '../document'
import { buildFatturaPa } from '../fatturapa/build'
import { computeInvoiceTotals, lineProblems, storedVatOf, type CoreLine } from '../invoices'
import { CHARGE_KIND_WORDS, CHARGE_KINDS, CHARGE_RULES, chargeLineProblems, chargeVat, freightDescription, freightLine, freightProblems, type ShipmentFreight } from './charges'

// Every company, party, VAT number, DDT and amount here is made up (the FatturaPA samples' fake numbers: office 000).

const IT22 = taxable(22)
const IT10 = taxable(10)
const N32 = nonTaxable('N3.2', LEGAL_WORDING.INTRA_EU_SUPPLY)
const D1 = '019a0000-0000-7000-8000-0000000000d1'
const D2 = '019a0000-0000-7000-8000-0000000000d2'
const freight = (overrides: Partial<ShipmentFreight> = {}): ShipmentFreight => ({ ddtId: D1, ddtNumber: '144/2026', ddtDate: '2026-11-24', shipmentNumber: 'SH-00007', amount: 1200, currency: 'EUR', ...overrides })

const FIXTURES = new URL('../fatturapa/__fixtures__/', import.meta.url)
const DSIG = 'xmldsig-core-schema.xsd'
const schema = readFileSync(new URL('Schema_VFPR12_v1.2.3.xsd', FIXTURES), 'utf8')
  .replace(/^﻿/, '')
  .replace('schemaLocation="http://www.w3.org/TR/2002/REC-xmldsig-core-20020212/xmldsig-core-schema.xsd"', `schemaLocation="${DSIG}"`)
const xsdErrors = async (xml: string) =>
  (await validateXML({ xml: [{ fileName: 'invoice.xml', contents: xml }], schema: [{ fileName: 'fatturapa.xsd', contents: schema }], preload: [{ fileName: DSIG, contents: readFileSync(new URL(DSIG, FIXTURES), 'utf8') }] })).errors.map((error) => error.rawMessage)

describe('charge lines (FIN-060): what they bill, their VAT, the freight of a shipment', () => {
  it('the kinds are the database enum, each in words; the accessory VAT rule waits for the accountant', () => {
    expect(CHARGE_KINDS).toEqual(['FREIGHT', 'PACKAGING', 'SAMPLES', 'FEE', 'OTHER'])
    expect(CHARGE_KIND_WORDS.it.FREIGHT).toBe('Spese di trasporto')
    expect(CHARGE_KIND_WORDS.en.SAMPLES).toBe('Samples')
    expect(CHARGE_RULES.ACCESSORY_FOLLOWS_GOODS).toMatchObject({ law: 'DPR 633/1972 art. 12 c.1', status: 'UNVERIFIED' })
  })

  it('a charge says what it bills and bills no order line, size or schedule step; only a charge has a kind', () => {
    expect(chargeLineProblems({ kind: 'CHARGE', chargeKind: 'PACKAGING', salesOrderLineId: null, size: null }, 'body/lines/0')).toEqual([])
    expect(chargeLineProblems({ kind: 'CHARGE', chargeKind: null, salesOrderLineId: null, size: null }, 'body/lines/0').map((issue) => issue.path)).toEqual(['body/lines/0/chargeKind'])
    expect(chargeLineProblems({ kind: 'CHARGE', chargeKind: 'BOGUS', salesOrderLineId: null, size: null }, 'l').map((issue) => issue.path)).toEqual(['l/chargeKind'])
    expect(chargeLineProblems({ kind: 'CHARGE', chargeKind: 'FEE', salesOrderLineId: 'x', size: '52', milestoneId: 'm' }, 'l').map((issue) => issue.path)).toEqual(['l/salesOrderLineId', 'l/milestoneId'])
    expect(chargeLineProblems({ kind: 'GOODS', chargeKind: 'FREIGHT', salesOrderLineId: null, size: null }, 'l')[0]!.message).toBe('Only a charge line (kind CHARGE) says what charge it is.')
  })

  it('a charge without its own VAT follows the goods (one shared treatment), else the buyer goods rule', () => {
    expect(chargeVat([IT22, IT22], N32)).toEqual(IT22)
    expect(chargeVat([N32], IT22)).toEqual(N32)
    expect(chargeVat([IT22, IT10], N32)).toEqual(N32)
    expect(chargeVat([], IT22)).toEqual(IT22)
    expect(chargeVat([IT22], N32, { vat: 'BUYER_GOODS' })).toEqual(N32)
    const problem = { path: 'party/taxIdentity', message: 'no tax identity' }
    expect(chargeVat([], problem)).toEqual(problem)
  })

  it("the freight line of a shipment: 1 x the shipment's freight, naming its DDT; none when 0, not decided, another currency", () => {
    const made = freightLine(freight(), 'EUR', IT22)
    expect(made).toEqual({ line: { kind: 'CHARGE', description: 'Spese di trasporto DDT n. 144/2026 del 24/11/2026', itemCode: null, quantity: '1.0000', uom: null, unitPrice: '12.000000', discountPct: null, vat: IT22 } })
    expect(lineProblems((made as { line: CoreLine }).line, 'lines/0')).toEqual([])
    expect(freightDescription({ ddtNumber: '7/2026', ddtDate: '2026-01-05' })).toBe('Spese di trasporto DDT n. 7/2026 del 05/01/2026')
    expect(freightLine(freight({ amount: 0 }), 'EUR', IT22)).toEqual({ skipped: 'Shipment SH-00007 carries no freight.' })
    expect(freightLine(freight({ amount: null }), 'EUR', IT22)).toEqual({ skipped: 'The freight of shipment SH-00007 is not decided yet: set it on the shipment, then add the line.' })
    expect(freightLine(freight({ currency: 'CHF' }), 'EUR', IT22)).toEqual({ skipped: 'The freight of shipment SH-00007 is in CHF, the invoice in EUR: type the line.' })
  })

  it('at issue: a shipment freight is billed once, at the figure the shipment holds now (NET)', () => {
    const freights = new Map([[D1, freight()], [D2, freight({ ddtId: D2, ddtNumber: '145/2026', shipmentNumber: 'SH-00008', amount: 900 })]])
    expect(freightProblems([{ index: 2, ddtId: D1, netAmount: 1200 }], freights, [], 'NET', 'EUR')).toEqual([])
    expect(freightProblems([{ index: 2, ddtId: D1, netAmount: 1200 }, { index: 3, ddtId: D1, netAmount: 1200 }], freights, [], 'NET', 'EUR').map((problem) => problem.code)).toEqual(['CHARGE_FREIGHT_TWICE'])
    expect(freightProblems([{ index: 2, ddtId: D1, netAmount: 1200 }], freights, [{ ddtId: D1, invoiceNumber: 'FT-2026-00009' }], 'NET', 'EUR')).toEqual([
      { code: 'CHARGE_FREIGHT_INVOICED', path: 'lines/2', message: "The freight of DDT 144/2026 is invoiced already (FT-2026-00009): a shipment's freight is billed once." },
    ])
    expect(freightProblems([{ index: 4, ddtId: D2, netAmount: 700 }], freights, [], 'NET', 'EUR')).toEqual([
      { code: 'CHARGE_FREIGHT_CHANGED', path: 'lines/4/unitPrice', message: "The freight of shipment SH-00008 (DDT 145/2026) is now 9.00 EUR; line 5 bills 7.00 EUR. Change the line, or the shipment's freight." },
    ])
    expect(freightProblems([{ index: 4, ddtId: D2, netAmount: 700 }], freights, [], 'GROSS', 'EUR')).toEqual([])
  })

  it('a TD24 of two DDTs with a freight line per DDT and a packaging charge naming its DDT is XSD-valid', async () => {
    const goods: CoreLine[] = [
      { kind: 'GOODS', description: 'Giacca Racer nero, taglia 52', itemCode: 'JKT-01-BLK-52', quantity: '2.0000', uom: 'PZ', unitPrice: '420.000000', discountPct: null, vat: IT22 },
      { kind: 'GOODS', description: 'Giacca Racer nero, taglia 54', itemCode: 'JKT-01-BLK-54', quantity: '1.0000', uom: 'PZ', unitPrice: '420.000000', discountPct: null, vat: IT22 },
    ]
    const charges = [
      (freightLine(freight(), 'EUR', chargeVat([IT22], N32) as typeof IT22) as { line: CoreLine }).line,
      (freightLine(freight({ ddtId: D2, ddtNumber: '145/2026', ddtDate: '2026-11-27', shipmentNumber: 'SH-00008', amount: 900 }), 'EUR', IT22) as { line: CoreLine }).line,
      { kind: 'CHARGE' as const, description: 'Imballo speciale', itemCode: null, quantity: '1.0000', uom: null, unitPrice: '15.000000', discountPct: null, vat: IT22 },
    ]
    const all = [...goods, ...charges]
    const totals = computeInvoiceTotals(all, 'NET', 'EUR')
    expect(totals).toMatchObject({ netTotal: 129_600, vatTotal: 28_512, grossTotal: 158_112 })
    const ddtOf = ['144/2026', '145/2026', '144/2026', '145/2026', '145/2026']
    const lines: StoredLine[] = all.map((line, index) => ({
      seq: index + 1,
      kind: line.kind,
      description: line.description,
      itemCode: line.itemCode ?? null,
      quantity: line.quantity,
      uom: line.uom ?? null,
      unitPrice: line.unitPrice,
      discountPct: null,
      ...storedVatOf(line.vat),
      netAmount: totals.lines[index]!.netAmount,
      grossAmount: totals.lines[index]!.grossAmount,
      ddtNumber: ddtOf[index]!,
    }))
    const invoice: IssuedInvoice = {
      id: '019a0000-0000-7000-8000-0000000000f1',
      docType: 'TD24',
      number: 'FT-2026-00011',
      issueDate: '2026-12-02',
      currency: 'EUR',
      priceBasis: 'NET',
      seller: { vatNumber: '12345670009', name: 'Fabbrica Esempio S.r.l.', taxRegime: 'RF01', address: { street: 'Via Esempio 1', postcode: '20121', city: 'Milano', province: 'MI', country: 'IT' } },
      billTo: { kind: 'IT_BUSINESS', vatNumber: '76543210009', name: 'Cliente Esempio S.r.l.', address: { street: 'Via Prova 2', postcode: '00100', city: 'Roma', province: 'RM', country: 'IT' }, sdiCode: 'ABC1234' },
      lines,
      netTotal: totals.netTotal,
      vatTotal: totals.vatTotal,
      grossTotal: totals.grossTotal,
      vatSummary: totals.vatSummary,
      stampDutyAmount: totals.stampDutyAmount,
      causale: 'Fattura differita (art. 21 c.4 lett. a DPR 633/1972)',
      purchaseOrders: [],
      ddts: [
        { number: '144/2026', date: '2026-11-24' },
        { number: '145/2026', date: '2026-11-27' },
      ],
      paymentTerms: { condition: 'TP01', installments: [{ method: 'MP05', amount: 79_056, dueDate: '2026-12-31' }, { method: 'MP05', amount: 79_056, dueDate: '2027-01-31' }] },
    }
    const built = buildFatturaPa(fatturaPaInputOf(invoice))
    expect(await xsdErrors(built.xml)).toEqual([])
    expect(built.xml).toContain('<Descrizione>Spese di trasporto DDT n. 144/2026 del 24/11/2026</Descrizione>')
    expect(built.xml).toContain('<CondizioniPagamento>TP01</CondizioniPagamento>')
    expect(built.xml).toContain('<ImportoTotaleDocumento>1581.12</ImportoTotaleDocumento>')
  })
})
