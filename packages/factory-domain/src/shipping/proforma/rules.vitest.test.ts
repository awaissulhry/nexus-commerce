import { describe, expect, it } from 'vitest'
import { composeDocument } from '../../documents/compose'
import type { CompanyLegal } from '../../documents/model'
import { sampleDocument } from '../../documents/sample'
import { nonTaxable, taxable } from '../../tax/vat-treatment'
import { customsDescription, prepaymentLineText, proformaDocument, proformaFingerprint, proformaSourceProblems, purposeOf, treatmentOfStored, type ProformaSource } from './rules'

// Made-up company and customer.
const COMPANY: CompanyLegal = {
  legalName: 'Pelletteria Esempio S.r.l.',
  address: { line1: 'Via Prova 1', postalCode: '20100', city: 'Milano', province: 'MI', country: 'IT' },
  vatNumber: 'IT12345670009',
  fiscalCode: '12345670009',
  reaOffice: 'MI',
  reaNumber: '0000001',
  shareCapital: '10000.00',
  currency: 'EUR',
}

const SHIPMENT: ProformaSource = {
  purpose: 'CUSTOMS',
  number: 'PF-2026-0001',
  date: '2026-11-14',
  language: 'en',
  currency: 'EUR',
  party: { name: 'Example Rider Shop Ltd', address: { line1: '1 Test Road', postalCode: 'AB1 2CD', city: 'Testtown', country: 'GB' } },
  references: [{ kind: 'SALES_ORDER', number: 'SO-0001', date: '2026-10-01' }, { kind: 'SHIPMENT', number: 'SH-00001' }],
  lines: [
    { code: 'JKT-01 BLK', description: customsDescription('Leather jacket, black, 50×2, 52×1', { hsCode: '420310', originCountry: 'it' }, 'en'), quantity: 3, uom: 'PCS', unitPrice: '199.995', treatment: nonTaxable('N3.1', 'N3.1') },
    { code: 'GLV-02 BRN', description: 'Gloves, brown, L×1', quantity: 1, uom: 'PAIR', unitPrice: '30', treatment: nonTaxable('N3.1', 'N3.1') },
  ],
  basis: 'NET',
  deliveryTerms: 'EXW Milano',
  facts: { packages: 2, grossWeightKg: '7.5', origin: ['IT'] },
}

describe('the proforma of a shipment (customs)', () => {
  it('prices each line at the order price (one rounding per line) and totals per VAT nature', () => {
    const document = proformaDocument(SHIPMENT)
    // 3 × 199.995 = 599.985, rounded half up once at the line: 599.99.
    expect(document.lines.map((line) => line.amountMinor)).toEqual([59999, 3000])
    expect(document.totals).toEqual({ netMinor: 62999, vat: [{ rate: '0', nature: 'N3.1', taxableMinor: 62999, vatMinor: 0 }], grossMinor: 62999 })
    expect(document.lines[0]!.description).toBe('Leather jacket, black, 50×2, 52×1 · HS 420310 · Origin IT')
  })

  it('composes with its notices: no tax document, values for customs', () => {
    const composed = composeDocument({ ...proformaDocument(SHIPMENT), company: COMPANY })
    expect(composed.title).toBe('Proforma invoice')
    expect(composed.layout).toBe('PROFORMA/1')
    expect(composed.notices).toEqual([expect.stringContaining('not an invoice under art. 21 of DPR 633/1972'), 'Values stated for customs purposes.'])
    expect(composed.facts.map((fact) => fact.label)).toEqual(['Purpose', 'Our order', 'Shipment', 'Delivery terms', 'Number of packages', 'Gross weight (kg)', 'Country of origin'])
    expect(composed.facts.at(-1)!.value).toBe('Italy')
    expect(composed.totals.at(-1)).toMatchObject({ label: 'Proforma total', strong: true })
  })

  it('keeps the same fingerprint on another day, a new one when a line changes', () => {
    const one = proformaFingerprint(proformaDocument(SHIPMENT))
    expect(proformaFingerprint(proformaDocument({ ...SHIPMENT, date: '2026-11-20' }))).toBe(one)
    expect(proformaFingerprint(proformaDocument({ ...SHIPMENT, lines: SHIPMENT.lines.slice(0, 1) }))).not.toBe(one)
  })

  it('refuses a proforma without lines, a line without a price, a party without an address', () => {
    expect(proformaSourceProblems({ ...SHIPMENT, lines: [] })).toEqual(['The shipment has no garments yet: add its lines first.'])
    expect(proformaSourceProblems({ ...SHIPMENT, lines: [{ ...SHIPMENT.lines[0]!, unitPrice: 'x' }] })).toEqual(['JKT-01 BLK: it has no price to print.'])
    expect(() => composeDocument({ ...proformaDocument({ ...SHIPMENT, party: { name: 'No address', address: null } }), company: COMPANY })).toThrow('The document cannot be printed as it stands.')
  })
})

describe('the proforma of a deposit request (prepayment) and of samples', () => {
  it('splits the amount asked (VAT included) into net and VAT so the total is exactly the amount', () => {
    const document = proformaDocument({
      ...SHIPMENT,
      purpose: 'PREPAYMENT',
      language: 'it',
      basis: 'GROSS',
      lines: [{ code: null, description: prepaymentLineText('ACCONTO', { order: 'SO-0001', quote: null }, 'it'), quantity: 1, uom: 'PCS', unitPrice: '1000', treatment: taxable(22) }],
      facts: { dueDate: '2026-11-30' },
    })
    expect(document.totals).toEqual({ netMinor: 81967, vat: [{ rate: '22', nature: null, taxableMinor: 81967, vatMinor: 18033 }], grossMinor: 100000 })
    expect(document.lines[0]).toMatchObject({ description: "Acconto sull'ordine SO-0001", unitPrice: '819.67', amountMinor: 81967, vatRate: '22', vatNature: null })
    const composed = composeDocument({ ...document, company: COMPANY })
    expect(composed.title).toBe('Fattura proforma')
    expect(composed.notices[1]).toBe("Richiesta di pagamento: la fattura d'acconto sarà emessa al ricevimento del pagamento.")
    expect(composed.facts).toContainEqual({ label: 'Scadenza', value: '30/11/2026' })
  })

  it('says samples of no commercial value carry a value for customs only', () => {
    const samples = proformaDocument({ ...SHIPMENT, purpose: 'SAMPLES', lines: SHIPMENT.lines.map((line) => ({ ...line, treatment: null })), facts: { noCommercialValue: true } })
    // Valued for customs only: no VAT printed, the total is the values.
    expect(samples.totals).toEqual({ netMinor: 62999, vat: [], grossMinor: 62999 })
    expect(samples.lines[0]).toMatchObject({ vatRate: null, vatNature: null })
    const composed = composeDocument({ ...samples, company: COMPANY })
    expect(composed.notices[1]).toBe('Samples of no commercial value: value stated for customs purposes only.')
    expect(composed.facts[0]).toEqual({ label: 'Purpose', value: 'Samples' })
  })

  it('names the purpose of each record, and a payment request has one line and its amount', () => {
    expect([purposeOf('Shipment'), purposeOf('SampleShipment'), purposeOf('DepositRequest')]).toEqual(['CUSTOMS', 'SAMPLES', 'PREPAYMENT'])
    expect(proformaSourceProblems({ ...SHIPMENT, purpose: 'PREPAYMENT' })).toEqual(['A payment request has one line: the amount it asks.'])
    expect(proformaSourceProblems({ ...SHIPMENT, lines: [SHIPMENT.lines[0]!, { ...SHIPMENT.lines[1]!, treatment: null }] })).toEqual(['The lines either all carry VAT or none does.'])
    expect(prepaymentLineText('CAPARRA', { order: null, quote: 'Q-0001/2' }, 'en')).toBe('Confirmatory deposit (art. 1385 Italian Civil Code) on quotation Q-0001/2')
  })

  it('reads a stored VAT as its treatment, and refuses one it cannot print', () => {
    expect(treatmentOfStored('22.00', null)).toEqual(taxable(22))
    expect(treatmentOfStored('0.00', 'N3.1')).toEqual(nonTaxable('N3.1', 'N3.1'))
    expect(treatmentOfStored('19.00', null)).toBeNull()
    expect(treatmentOfStored('0.00', 'X9')).toBeNull()
  })

  it("composes the company's preview sample of the layout", () => {
    expect(composeDocument(sampleDocument('PROFORMA', 'it', COMPANY, '2026-11-14')).banner).toBe('ESEMPIO - documento non valido')
  })
})
