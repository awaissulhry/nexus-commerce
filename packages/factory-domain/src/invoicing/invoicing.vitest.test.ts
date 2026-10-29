import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { validateXML } from 'xmllint-wasm'
import { nonTaxable, taxable, LEGAL_WORDING } from '../tax/vat-treatment'
import { issueProblems, type IssueFacts } from './checks'
import { depositInvoiceDecision, depositInvoiceDraft, depositTreatment } from './deposit'
import { billToOf, fatturaPaInputOf, invoiceCopyOf, progressiveOf, sellerOf, type IssuedInvoice, type StoredLine } from './document'
import { buildFatturaPa } from './fatturapa/build'
import { computeInvoiceTotals, lineProblems, storedVatOf, totalsMatch, treatmentOf, type CoreLine } from './invoices'

// Every company, party, VAT number and address here is made up (the FatturaPA samples' fake numbers: office code 000).

const FIXTURES = new URL('./fatturapa/__fixtures__/', import.meta.url)
const DSIG = 'xmldsig-core-schema.xsd'
const schema = readFileSync(new URL('Schema_VFPR12_v1.2.3.xsd', FIXTURES), 'utf8')
  .replace(/^﻿/, '')
  .replace('schemaLocation="http://www.w3.org/TR/2002/REC-xmldsig-core-20020212/xmldsig-core-schema.xsd"', `schemaLocation="${DSIG}"`)
const xsdValid = async (xml: string) => {
  const result = await validateXML({ xml: [{ fileName: 'invoice.xml', contents: xml }], schema: [{ fileName: 'fatturapa.xsd', contents: schema }], preload: [{ fileName: DSIG, contents: readFileSync(new URL(DSIG, FIXTURES), 'utf8') }] })
  return result.errors.map((error) => error.rawMessage)
}

const IT22 = taxable(22)
const company = {
  legalName: 'Pelletteria Fittizia S.r.l.',
  vatNumber: 'IT12345670009',
  fiscalCode: '12345670009',
  regimeFiscale: 'RF01',
  reaOffice: 'MI',
  reaNumber: '0000001',
  shareCapital: '10000.00',
  soleShareholder: false,
  inLiquidation: false,
  address: { line1: 'Via dei Conciatori Finti 1', postalCode: '20121', city: 'Milano', province: 'MI', country: 'IT' },
}
const itIdentity = { country: 'IT', taxMode: 'IT_B2B' as const, vatNumber: 'IT76543210009', fiscalCode: null, sdiRecipientCode: 'FAKE001', pec: null }
const address = { line1: 'Viale delle Prove 42', postalCode: '40121', city: 'Bologna', province: 'BO', country: 'IT' }

describe('the totals of a draft (one computation: computeVat, then minor units)', () => {
  it('NET: line amounts rounded to the cent, VAT per treatment, stamp duty only on non-taxable amounts', () => {
    const lines: CoreLine[] = [
      { kind: 'GOODS', description: 'Giacca', quantity: '3', unitPrice: '389.90', discountPct: '5', vat: IT22 },
      { kind: 'GOODS', description: 'Catalogo', quantity: '10', unitPrice: '4.15', vat: taxable(4) },
    ]
    const totals = computeInvoiceTotals(lines, 'NET', 'EUR')
    expect(totals.lines).toEqual([
      { netAmount: 111122, grossAmount: null },
      { netAmount: 4150, grossAmount: null },
    ])
    expect(totals.vatSummary).toEqual([
      { rate: '22.00', nature: null, legalRef: null, taxable: 111122, vat: 24447, rounding: 0 },
      { rate: '4.00', nature: null, legalRef: null, taxable: 4150, vat: 166, rounding: 0 },
    ])
    expect([totals.netTotal, totals.vatTotal, totals.grossTotal, totals.stampDutyAmount]).toEqual([115272, 24613, 139885, null])
  })

  it('GROSS (a deposit received): the transferred amount is the total; taxable + VAT split it to the cent', () => {
    const totals = computeInvoiceTotals([{ kind: 'GOODS', description: 'Acconto', quantity: '1', unitPrice: '1830.000000', vat: IT22 }], 'GROSS', 'EUR')
    expect(totals).toMatchObject({ netTotal: 150000, vatTotal: 33000, grossTotal: 183000, stampDutyAmount: null, lines: [{ netAmount: 150000, grossAmount: 183000 }] })
  })

  it('stamp duty (2.00) when the non-taxable amounts pass 77.47 euro, outside the exempt codes', () => {
    const totals = computeInvoiceTotals([{ kind: 'SERVICE', description: 'Consulenza', quantity: '1', unitPrice: '100', vat: nonTaxable('N2.2', 'Operazione non soggetta') }], 'NET', 'EUR')
    expect(totals.stampDutyAmount).toBe(200)
  })

  it('stored totals are compared exactly; a changed amount is caught', () => {
    const totals = computeInvoiceTotals([{ kind: 'GOODS', description: 'Giacca', quantity: '2', unitPrice: '250', vat: IT22 }], 'NET', 'EUR')
    const stored = { ...totals, lines: totals.lines, vatSummary: JSON.parse(JSON.stringify(totals.vatSummary)) as unknown }
    expect(totalsMatch(stored, totals)).toBe(true)
    expect(totalsMatch({ ...stored, netTotal: stored.netTotal + 1, grossTotal: stored.grossTotal + 1 }, totals)).toBe(false)
    expect(totalsMatch({ ...stored, vatSummary: [] }, totals)).toBe(false)
  })

  it('a line is refused with every problem, in plain words', () => {
    const problems = lineProblems({ kind: 'GOODS', description: ' ', quantity: '0', unitPrice: '-1', discountPct: '100', vat: IT22 }, 'body/lines/0')
    expect(problems.map((problem) => problem.path)).toEqual(['body/lines/0/description', 'body/lines/0/quantity', 'body/lines/0/unitPrice', 'body/lines/0/discountPct'])
  })

  it('a stored VAT reads back as its treatment (DPR 633/1972 art. 21 c.6: a zero rate carries its Natura and law)', () => {
    for (const treatment of [IT22, taxable(4), nonTaxable('N3.2', LEGAL_WORDING.INTRA_EU_SUPPLY)]) expect(treatmentOf(storedVatOf(treatment))).toEqual(treatment)
    expect(treatmentOf({ vatRatePct: '0.00', vatNature: null, vatLegalRef: null })).toBeNull()
    expect(treatmentOf({ vatRatePct: '21.00', vatNature: null, vatLegalRef: null })).toBeNull()
  })
})

describe('the deposit invoice (DPR 633/1972 art. 6 c.4; Q12)', () => {
  const base = { fiscalDocument: 'TD02' as const, fiscalRule: 'DEPOSIT_INVOICE_IT', paidAmount: 183000, paidOn: '2026-11-02' }
  it('is due for a payment before the goods ship, for the amount paid', () => {
    expect(depositInvoiceDecision({ ...base, goodsLeftOn: null }).required).toBe(true)
    expect(depositInvoiceDecision({ ...base, goodsLeftOn: '2026-11-03' }).required).toBe(true)
  })
  it('is not due when the rule for the party issues none, when nothing was paid to it, or after the goods left', () => {
    expect(depositInvoiceDecision({ ...base, fiscalDocument: 'NONE', goodsLeftOn: null })).toMatchObject({ required: false })
    expect(depositInvoiceDecision({ ...base, paidAmount: 0, goodsLeftOn: null }).required).toBe(false)
    expect(depositInvoiceDecision({ ...base, goodsLeftOn: '2026-11-02' }).reason).toContain('02/11/2026')
  })
  it('takes the VAT of the goods from the tax profile: 22% in Italy, N3.2 to an EU business with VIES proof', () => {
    expect(depositTreatment({ taxMode: 'IT_B2B' })).toEqual({ treatment: IT22 })
    expect(depositTreatment({ taxMode: 'EU_B2B', viesValid: true })).toEqual({ treatment: nonTaxable('N3.2', LEGAL_WORDING.INTRA_EU_SUPPLY) })
    expect(depositTreatment({ taxMode: 'EU_B2B', viesValid: false })).toEqual({ treatment: IT22 })
  })
})

const issued = (overrides: Partial<IssuedInvoice> = {}): IssuedInvoice => {
  const draft = depositInvoiceDraft({ amount: 183000, currency: 'EUR', treatment: IT22, paidOn: '2026-11-02', depositPct: '30.0000', order: { number: 'SO-0001', date: '2026-10-30' } })
  const totals = computeInvoiceTotals(draft.lines, draft.priceBasis, 'EUR')
  const lines: StoredLine[] = draft.lines.map((line, index) => ({
    seq: index + 1,
    kind: line.kind,
    description: line.description,
    itemCode: null,
    quantity: '1.0000',
    uom: null,
    unitPrice: line.unitPrice,
    discountPct: null,
    ...storedVatOf(line.vat),
    netAmount: totals.lines[index]!.netAmount,
    grossAmount: totals.lines[index]!.grossAmount,
  }))
  return {
    id: '019a0000-0000-7000-8000-000000000001',
    docType: 'TD02',
    number: 'FT-2026-00004',
    issueDate: '2026-11-02',
    currency: 'EUR',
    priceBasis: 'GROSS',
    seller: sellerOf(company).seller!,
    billTo: billToOf({ legalName: 'Motoabbigliamento Immaginario S.p.A.', identity: itIdentity, address }).billTo!,
    lines,
    netTotal: totals.netTotal,
    vatTotal: totals.vatTotal,
    grossTotal: totals.grossTotal,
    vatSummary: totals.vatSummary,
    stampDutyAmount: totals.stampDutyAmount,
    causale: draft.causale,
    purchaseOrders: [],
    ddts: [],
    salesOrder: { number: 'SO-0001', date: '2026-10-30' },
    ...overrides,
  }
}

describe('the issued invoice as FatturaPA and as its courtesy copy (FIN-057, FIN-085)', () => {
  it('a TD02 from a deposit request is XSD-valid, VAT-inclusive, with its causale and a stable file name', async () => {
    const doc = buildFatturaPa(fatturaPaInputOf(issued()))
    expect(await xsdValid(doc.xml)).toEqual([])
    expect(doc.xml).toContain('<TipoDocumento>TD02</TipoDocumento>')
    expect(doc.xml).toContain('<ImportoTotaleDocumento>1830.00</ImportoTotaleDocumento>')
    expect(doc.xml).toContain('<Descrizione>Acconto 30% su ordine n. SO-0001 del 30/10/2026</Descrizione>')
    expect(doc.xml).toContain('<CodiceDestinatario>FAKE001</CodiceDestinatario>')
    expect(doc.fileName).toBe(`IT12345670009_${progressiveOf('019a0000-0000-7000-8000-000000000001')}.xml`)
    expect(buildFatturaPa(fatturaPaInputOf(issued())).xml).toBe(doc.xml)
  })

  it('a TD24 that deducts the TD02 is XSD-valid (the core B-W1-51 reuses)', async () => {
    const deposit = issued()
    const goods = computeInvoiceTotals(
      [
        { kind: 'GOODS', description: 'Giacca moto in pelle, nero, 50', quantity: '10', unitPrice: '610', vat: IT22 },
        { kind: 'DEPOSIT_DEDUCTION', description: 'Storno acconto', quantity: '1', unitPrice: '-1500', vat: IT22, deduction: { netAmount: -150000, grossAmount: -183000 } },
      ],
      'NET',
      'EUR',
    )
    const doc = buildFatturaPa(
      fatturaPaInputOf(
        issued({
          id: '019a0000-0000-7000-8000-000000000002',
          docType: 'TD24',
          number: 'FT-2026-00009',
          issueDate: '2026-11-30',
          priceBasis: 'NET',
          causale: null,
          ddts: [{ number: 'DDT-144', date: '2026-11-20' }],
          lines: [
            { seq: 1, kind: 'GOODS', description: 'Giacca moto in pelle, nero, 50', itemCode: 'JKT-1-BLK-50', quantity: '10.0000', uom: 'PZ', unitPrice: '610.000000', discountPct: null, ...storedVatOf(IT22), netAmount: goods.lines[0]!.netAmount, grossAmount: null },
            { seq: 2, kind: 'DEPOSIT_DEDUCTION', description: 'Storno acconto', itemCode: null, quantity: '1.0000', uom: null, unitPrice: '-1500.000000', discountPct: null, ...storedVatOf(IT22), netAmount: -150000, grossAmount: -183000, deposit: { number: deposit.number, issueDate: deposit.issueDate } },
          ],
          netTotal: goods.netTotal,
          vatTotal: goods.vatTotal,
          grossTotal: goods.grossTotal,
          vatSummary: goods.vatSummary,
          stampDutyAmount: goods.stampDutyAmount,
        }),
      ),
    )
    expect(await xsdValid(doc.xml)).toEqual([])
    expect(doc.totals.total.toFixed(2)).toBe('5612.00')
  })

  it('the copy prints the buyer, the lines and the totals as issued', () => {
    const copy = invoiceCopyOf(issued(), 'it')
    expect(copy).toMatchObject({ type: 'INVOICE_COPY', number: 'FT-2026-00004', invoice: { kind: 'TD02' }, party: { vatNumber: 'IT76543210009', sdiCode: 'FAKE001' }, totals: { netMinor: 150000, grossMinor: 183000 } })
  })

  it('the company and the customer say what FatturaPA still needs', () => {
    expect(sellerOf({ ...company, regimeFiscale: null }).issues.map((issue) => issue.path)).toEqual(['company/regimeFiscale'])
    expect(billToOf({ legalName: 'X', identity: null, address: null }).issues.map((issue) => issue.path)).toEqual(['party/taxIdentity', 'party/addresses'])
    expect(billToOf({ legalName: 'Beispiel GmbH', identity: { country: 'DE', taxMode: 'EU_B2B', vatNumber: 'DE999999999', fiscalCode: null, sdiRecipientCode: null, pec: null }, address: { line1: 'Musterstraße 1', postalCode: '10115', city: 'Berlin', country: 'DE' } }).billTo).toMatchObject({ kind: 'FOREIGN', country: 'DE', taxId: '999999999' })
  })
})

describe('the checks before issue, in plain words', () => {
  const totals = computeInvoiceTotals([{ kind: 'GOODS', description: 'Giacca', quantity: '1', unitPrice: '1000', vat: nonTaxable('N3.2', LEGAL_WORDING.INTRA_EU_SUPPLY) }], 'NET', 'EUR')
  const facts = (overrides: Partial<IssueFacts> = {}): IssueFacts => ({
    docType: 'TD01',
    currency: 'EUR',
    party: { status: 'ACTIVE', legalName: 'Beispiel GmbH' },
    taxMode: 'EU_B2B',
    warnings: [],
    vies: { state: 'VALID', message: 'Valid.' },
    lineNatures: ['N3.2'],
    stored: { ...totals, vatSummary: totals.vatSummary },
    computed: totals,
    lineIssues: [],
    dataIssues: [],
    fatturaPa: [],
    ...overrides,
  })
  it('passes a sound invoice', () => expect(issueProblems(facts())).toEqual([]))
  it('refuses a blocked customer, a zero-rated EU sale without VIES proof, broken totals', () => {
    expect(issueProblems(facts({ party: { status: 'BLOCKED', legalName: 'Beispiel GmbH' } })).map((problem) => problem.code)).toEqual(['PARTY_BLOCKED'])
    expect(issueProblems(facts({ vies: { state: 'EXPIRED', message: 'The last valid check is older than 30 days.' } }))[0]).toMatchObject({ code: 'NO_VIES_PROOF', path: 'party/vies' })
    expect(issueProblems(facts({ stored: { ...totals, grossTotal: 1, netTotal: 1 } })).map((problem) => problem.code)).toEqual(['TOTALS'])
  })
  it('a TD02 never invoices more than its deposit request asks', () => {
    const problems = issueProblems(facts({ docType: 'TD02', deposit: { status: 'PAID', currency: 'EUR', amount: 100000, invoicedGross: 50000 } }))
    expect(problems.map((problem) => problem.code)).toEqual(['DEPOSIT_OVER_REQUEST'])
    expect(problems[0]!.message).toContain('1000.00 EUR')
  })
})
