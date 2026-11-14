import { readFileSync } from 'node:fs'
import { validateXML } from 'xmllint-wasm'
import { describe, expect, it } from 'vitest'
import { taxable } from '../../tax/vat-treatment'
import { buildFatturaPa, checkFatturaPaInput } from './build'
import { FAKE_EU_BUSINESS, FAKE_EXTRA_EU_BUSINESS, FAKE_IT_BUSINESS, FAKE_SELLER, TD01_IT_B2B } from './__fixtures__/samples'
import type { FatturaPaInvoiceInput } from './types'

// B-W2b-401: the debit note TD05 and the self-invoices TD17-TD19, built and checked against the official schema (as
// xsd.vitest.test.ts). Every party, number and amount is made up (the samples' fake ones).

const FIXTURES = new URL('./__fixtures__/', import.meta.url)
const DSIG_FILE = 'xmldsig-core-schema.xsd'
const schema = readFileSync(new URL('Schema_VFPR12_v1.2.3.xsd', FIXTURES), 'utf8')
  .replace(/^﻿/, '')
  .replace('schemaLocation="http://www.w3.org/TR/2002/REC-xmldsig-core-20020212/xmldsig-core-schema.xsd"', `schemaLocation="${DSIG_FILE}"`)

async function xsdErrors(xml: string): Promise<string[]> {
  const result = await validateXML({ xml: [{ fileName: 'doc.xml', contents: xml }], schema: [{ fileName: 'fatturapa.xsd', contents: schema }], preload: [{ fileName: DSIG_FILE, contents: readFileSync(new URL(DSIG_FILE, FIXTURES), 'utf8') }] })
  return result.errors.map((error) => error.rawMessage)
}

const VAT22 = taxable(22)

const debitNote: FatturaPaInvoiceInput = {
  documentType: 'TD05',
  number: 'FT-2026-00110',
  date: '2026-11-10',
  transmission: { progressive: '0D110' },
  seller: FAKE_SELLER,
  buyer: FAKE_IT_BUSINESS,
  lines: [{ description: 'Trasporto aggiuntivo concordato dopo la fattura', quantity: '1', unitPrice: '45.00', vat: VAT22 }],
  relatedInvoices: [{ number: '2026/0101', date: '2026-10-05' }],
  causale: 'Nota di debito - integrazione della fattura n. 2026/0101 del 05/10/2026 (art. 26 c.1 DPR 633/1972)',
}

const selfInvoice = (documentType: 'TD17' | 'TD18' | 'TD19', buyer = FAKE_EU_BUSINESS): FatturaPaInvoiceInput => ({
  documentType,
  number: 'AF-2026-0001',
  date: '2026-11-12',
  transmission: { progressive: '0A001' },
  seller: FAKE_SELLER,
  buyer,
  lines: [{ description: 'Consulenza tecnica (fattura estera)', quantity: '1', unitPrice: '1000.00', vat: VAT22 }],
  relatedInvoices: [{ number: 'SEED-DE-117', date: '2026-11-02' }],
  causale: "Integrazione/autofattura per acquisto servizi dall'estero",
})

describe('the debit note TD05 (FIN-071)', () => {
  it('builds a TD05 naming the invoice it adds to, valid against the official schema', async () => {
    const doc = buildFatturaPa(debitNote)
    expect(doc.documentType).toBe('TD05')
    expect(doc.xml).toContain('<TipoDocumento>TD05</TipoDocumento>')
    expect(doc.xml).toMatch(/<DatiFattureCollegate>\s*<IdDocumento>2026\/0101<\/IdDocumento>/)
    expect(doc.totals.total.toFixed(2)).toBe('54.90')
    expect(await xsdErrors(doc.xml)).toEqual([])
  })

  it('refuses a TD05 without the invoice it adds to, or deducting a deposit', () => {
    expect(checkFatturaPaInput({ ...debitNote, relatedInvoices: [] }).map((issue) => issue.code)).toContain('TD05_NEEDS_INVOICE')
    const deduction = TD01_IT_B2B.depositDeductions ?? [{ invoiceNumber: '2026/0031', invoiceDate: '2026-09-01', amounts: [{ vat: VAT22, taxable: '10.00', vatAmount: '2.20' }] }]
    expect(checkFatturaPaInput({ ...debitNote, depositDeductions: deduction }).map((issue) => issue.code)).toContain('DEPOSIT_DEDUCTION_NOT_ALLOWED')
  })
})

describe('the self-invoices TD17, TD18, TD19 (FIN-095)', () => {
  for (const [type, buyer] of [['TD17', FAKE_EU_BUSINESS], ['TD17', FAKE_EXTRA_EU_BUSINESS], ['TD18', FAKE_EU_BUSINESS], ['TD19', FAKE_EXTRA_EU_BUSINESS]] as const) {
    it(`builds a ${type} from a supplier in ${buyer.country}: the supplier as cedente, the company as cessionario, valid against the schema`, async () => {
      const doc = buildFatturaPa(selfInvoice(type, buyer))
      const header = doc.xml.slice(doc.xml.indexOf('<FatturaElettronicaHeader>'), doc.xml.indexOf('</FatturaElettronicaHeader>'))
      const cedente = header.slice(header.indexOf('<CedentePrestatore>'), header.indexOf('</CedentePrestatore>'))
      const cessionario = header.slice(header.indexOf('<CessionarioCommittente>'), header.indexOf('</CessionarioCommittente>'))
      expect(cedente).toContain(`<IdPaese>${buyer.country}</IdPaese>`)
      expect(cedente).toContain('<RegimeFiscale>RF18</RegimeFiscale>')
      expect(cessionario).toContain(`<IdCodice>${FAKE_SELLER.vatNumber}</IdCodice>`)
      expect(cessionario).not.toContain('RegimeFiscale')
      expect(header).toContain('<CodiceDestinatario>0000000</CodiceDestinatario>')
      expect(doc.xml).toContain(`<TipoDocumento>${type}</TipoDocumento>`)
      expect(doc.xml).toContain('<AliquotaIVA>22.00</AliquotaIVA>')
      expect(doc.fileName).toMatch(new RegExp(`^IT${FAKE_SELLER.vatNumber}_0A001\\.xml$`))
      expect(await xsdErrors(doc.xml)).toEqual([])
    })
  }

  it('refuses an Italian supplier, a TD18 from outside the EU, a self-invoice without the supplier invoice or with DDTs', () => {
    expect(checkFatturaPaInput(selfInvoice('TD17', FAKE_IT_BUSINESS as never)).map((issue) => issue.code)).toContain('SELF_INVOICE_SUPPLIER')
    expect(checkFatturaPaInput(selfInvoice('TD18', FAKE_EXTRA_EU_BUSINESS)).map((issue) => issue.code)).toContain('TD18_NOT_EU')
    expect(checkFatturaPaInput({ ...selfInvoice('TD17'), relatedInvoices: [] }).map((issue) => issue.code)).toContain('SELF_INVOICE_NEEDS_INVOICE')
    expect(checkFatturaPaInput({ ...selfInvoice('TD19'), ddts: [{ number: '1', date: '2026-11-01' }] }).map((issue) => issue.code)).toContain('DDT_NOT_ALLOWED')
  })

  it('leaves the other types as they were: a TD01 to a foreign buyer keeps XXXXXXX and the company as cedente', () => {
    const doc = buildFatturaPa({ ...selfInvoice('TD17'), documentType: 'TD01', relatedInvoices: [], lines: [{ description: 'Giacca', quantity: '1', unitPrice: '100.00', vat: taxable(22) }] })
    expect(doc.xml).toContain('<CodiceDestinatario>XXXXXXX</CodiceDestinatario>')
    expect(doc.xml).toContain('<RegimeFiscale>RF01</RegimeFiscale>')
  })
})
