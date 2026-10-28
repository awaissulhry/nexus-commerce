import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { composeDocument } from '@nexus/factory-domain/documents/compose'
import type { CompanyLegal, DocumentInput } from '@nexus/factory-domain/documents/model'
import { composeLabel } from '@nexus/factory-domain/labels/model'
import { formatScanId, tenantTag } from '@nexus/factory-domain/numbering/scan-id'
import { renderLabelPdf } from './label-pdf'
import { renderDocumentPdf, winAnsi } from './pdf'
import { pdfPageCount, pdfStreams, pdfText } from './testing/pdf-text'

// The renderer on its own: what a printed document says, read back from the PDF bytes. Every company, tax number and
// address is FAKE (as in the FatturaPA fixtures: office code 000 has no tax office).

const COMPANY: CompanyLegal = {
  legalName: 'Pelletteria Fittizia S.r.l.',
  address: { line1: 'Via dei Conciatori Finti 1', postalCode: '20121', city: 'Milano', province: 'MI', country: 'IT' },
  vatNumber: 'IT12345670009',
  fiscalCode: '12345670009',
  reaOffice: 'MI',
  reaNumber: '0000001',
  shareCapital: '10000.00',
  currency: 'EUR',
  documentFooter: 'Made up for tests',
}

const ddt = (lines = 2): DocumentInput => ({
  type: 'DDT',
  language: 'it',
  number: '2026/000143',
  date: '2026-10-28',
  currency: 'EUR',
  company: COMPANY,
  party: { name: 'Motoabbigliamento Immaginario S.p.A.', address: { line1: 'Viale delle Prove 42', postalCode: '40121', city: 'Bologna', province: 'BO', country: 'IT' } },
  lines: Array.from({ length: lines }, (_, index) => ({ code: `JKT-${index}`, description: `Giacca in pelle bovina nera, taglia ${46 + index}`, quantity: '2', uom: 'PCS' })),
  transport: { reason: 'SALE', transportBy: 'CARRIER', carrier: { name: 'Trasporti Esempio S.r.l.' }, startAt: '2026-10-28T13:30:00Z', appearance: 'Scatole', packages: 3, grossWeightKg: '12.5' },
})
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

describe('renderDocumentPdf', () => {
  it('prints the c.c. art. 2250 block and the DPR 472/1996 fields of a DDT, readable back from the PDF', async () => {
    const pdf = await renderDocumentPdf(composeDocument(ddt()))
    expect(pdf.subarray(0, 8).toString('latin1')).toMatch(/^%PDF-1\.\d/)
    const text = pdfText(pdf)
    for (const expected of [
      'Pelletteria Fittizia S.r.l.',
      'Sede legale: Via dei Conciatori Finti 1, 20121 Milano (MI)',
      'P. IVA IT12345670009 · C.F. 12345670009',
      'Registro Imprese di MI n. 12345670009 · REA MI-0000001',
      'Capitale sociale versato € 10.000,00',
      'Documento di trasporto (DDT)',
      'Numero: 2026/000143',
      'Causale del trasporto',
      'Vendita',
      'Trasporto a cura del',
      'Trasporti Esempio S.r.l.',
      'Inizio trasporto (data e ora)',
      '28/10/2026 14:30',
      'Aspetto esteriore dei beni',
      'Numero colli',
      'Peso lordo (kg)',
      'Descrizione dei beni (natura e qualità)',
      'Giacca in pelle bovina nera, taglia 46',
      'Firma del destinatario',
      'Pagina 1 di 1',
    ]) {
      expect(text, expected).toContain(expected)
    }
    expect(text).not.toMatch(/Importo|€ 0/)
  })

  it('gives the same bytes for the same document (fixed metadata, no clock)', async () => {
    const first = await renderDocumentPdf(composeDocument(ddt()))
    const second = await renderDocumentPdf(composeDocument(ddt()))
    expect(sha256(second)).toBe(sha256(first))
    // The info dictionary: the producer and the creation date (the document's date in Rome), never the clock.
    expect(first.toString('latin1')).toContain('(Nexus Factory)')
    expect(first.toString('latin1')).toContain('(D:20261027230000Z)')
  })

  it('repeats the table header, the legal footer and the page count on every page of a long document', async () => {
    const pdf = await renderDocumentPdf(composeDocument(ddt(100)))
    expect(pdfPageCount(pdf)).toBe(3)
    const text = pdfText(pdf)
    expect(text.match(/REA MI-0000001 · Capitale sociale/g)).toHaveLength(3)
    expect(text).toContain('Pagina 3 di 3')
    expect(text.match(/Descrizione dei beni \(natura e qualità\)/g)).toHaveLength(3)
    expect(text).toContain('Documento di trasporto (DDT) 2026/000143 (segue)')
  })

  it('says on an invoice copy that it is a courtesy copy, in English too', async () => {
    const invoice: DocumentInput = {
      ...ddt(),
      type: 'INVOICE_COPY',
      language: 'en',
      transport: null,
      lines: [{ description: 'Leather jacket', quantity: '1', uom: 'PCS', unitPrice: '250', amountMinor: 25000, vatRate: '22' }],
      totals: { netMinor: 25000, vat: [{ rate: '22', taxableMinor: 25000, vatMinor: 5500 }], grossMinor: 30500 },
    }
    const text = pdfText(await renderDocumentPdf(composeDocument(invoice)))
    expect(text).toContain('Invoice - courtesy copy')
    expect(text).toContain('Courtesy copy with no fiscal value.')
    expect(text).toContain('€305.00')
  })

  it('prints only what the standard fonts can: other characters become "?"', () => {
    expect(winAnsi('Società € “x” — Łódź\n')).toBe('Società € “x” — ?ód? ')
  })
})

describe('renderLabelPdf', () => {
  it('draws a label per copy on the stock size, with the scannable id as text and as Code 128 bars', async () => {
    const scanId = formatScanId({ type: 'BUNDLE', tenantTag: tenantTag('0199f0a0-0000-7000-8000-000000000001'), ref: 70000 })
    const label = composeLabel({ kind: 'BUNDLE', language: 'en', scanId, maker: 'Seed A', title: 'Style JKT-01', fields: { size: '50', pieces: '12' } })
    const pdf = await renderLabelPdf(label, { widthMm: 100, heightMm: 50 }, 2)
    expect(pdfPageCount(pdf)).toBe(2)
    expect(pdf.toString('latin1')).toMatch(/\/MediaBox \[0 0 283\.46\d* 141\.73\d*\]/)
    const text = pdfText(pdf)
    expect(text.match(new RegExp(scanId, 'g'))).toHaveLength(2)
    expect(text).toContain('Bundle · Seed A')
    // (start + 14 symbols + check) × 3 bars + the stop's 4 bars, per copy, drawn as filled rectangles.
    const rectangles = pdfStreams(pdf).join('\n').match(/ re\n/g) ?? []
    expect(rectangles.length).toBe(2 * (16 * 3 + 4))
    await expect(renderLabelPdf(label, { widthMm: 100, heightMm: 50 }, 0)).rejects.toThrow(RangeError)
  })
})
