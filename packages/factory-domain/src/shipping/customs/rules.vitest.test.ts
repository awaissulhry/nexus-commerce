import { describe, expect, it } from 'vitest'
import { alertPhrase } from '../../alerts/rules'
import { KINDS } from '../../alerts/kinds'
import { composeDocument } from '../../documents/compose'
import type { CompanyLegal } from '../../documents/model'
import { sampleDocument } from '../../documents/sample'
import { actionRule, PURPOSE_RULES } from '../../links/purposes'
import { Dec } from '../../tax/decimal'
import { brokerPackMail } from '../broker-pack/rules'
import { commercialInvoiceDocument, commercialInvoiceFingerprint, customsLineProblems, type CommercialInvoiceSource } from './commercial-invoice'
import { parcelValueMinor, postalFormFingerprint, type PostalFormDocument } from './postal-forms'
import { destinationClassOf, eoriOf, exitDaysLeft, exitDueAt, exitOverdue, mrnOf, postalFormOf } from './rules'

// Made-up company, customer and numbers.
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

const SOURCE: CommercialInvoiceSource = {
  number: 'SH-00042',
  date: '2026-11-14',
  language: 'en',
  currency: 'EUR',
  party: { name: 'Example Moto AG', address: { line1: 'Teststrasse 1', postalCode: '8001', city: 'Zürich', country: 'CH' } },
  references: [{ kind: 'SALES_ORDER', number: 'SO-0042', date: '2026-10-01' }, { kind: 'SHIPMENT', number: 'SH-00042' }],
  lines: [
    { code: 'JKT-01 BLK', goods: 'Leather jacket, black, 50×2, 52×1', hsCode: '420310', originCountry: 'IT', quantity: 3, uom: 'PCS', unitPrice: '199.995' },
    { code: 'GLV-02 BRN', goods: 'Gloves, brown, L×1', hsCode: '420329', originCountry: 'IT', quantity: 1, uom: 'PCS', unitPrice: '30' },
  ],
  deliveryTerms: 'DAP Zürich',
  facts: { exporterEori: 'IT12345670009', reason: 'SALE_OF_GOODS', destinationCountry: 'CH', packages: 2, grossWeightKg: '7.5', netWeightKg: '5.2', origin: ['IT'], nonTaxableExport: true },
}

describe('where a shipment goes', () => {
  it('tells Italy, another member state and outside the EU apart', () => {
    expect(destinationClassOf('IT')).toBe('DOMESTIC')
    expect(destinationClassOf('de')).toBe('EU')
    expect(destinationClassOf('GR')).toBe('EU')
    expect(destinationClassOf('CH')).toBe('EXPORT')
    expect(destinationClassOf('GB')).toBe('EXPORT')
    expect(destinationClassOf('NO')).toBe('EXPORT')
    expect(destinationClassOf(null)).toBeNull()
    expect(destinationClassOf('Italy')).toBeNull()
  })
})

describe('EORI and MRN as typed', () => {
  it('reads an EORI without spaces or dots, upper case; refuses what is not one', () => {
    expect(eoriOf(' it 1234.5670-009 ')).toBe('IT12345670009')
    expect(eoriOf('I1')).toBeNull()
    expect(eoriOf('IT1234567890123456')).toBeNull()
  })

  it('reads an MRN of 18 characters (year, country, 14) as the database checks it', () => {
    expect(mrnOf('26it 0000 0000 0000 01')).toBe('26IT00000000000001')
    expect(mrnOf('26IT0000')).toBeNull()
    expect(mrnOf('2AIT00000000000001')).toBeNull()
  })
})

describe('CN 22 or CN 23', () => {
  const kg = (value: string) => new Dec(value)
  it('lets a CN 22 go for light parcels worth little, in euro', () => {
    expect(postalFormOf([{ grossKg: kg('1.2'), value: kg('120') }, { grossKg: kg('2'), value: kg('300') }], 'EUR')).toEqual({ form: 'CN22', because: [] })
  })

  it('asks a CN 23 for a heavy parcel, contents worth more, another currency or a parcel not weighed', () => {
    expect(postalFormOf([{ grossKg: kg('2.01'), value: kg('10') }], 'EUR')).toEqual({ form: 'CN23', because: ['HEAVY'] })
    expect(postalFormOf([{ grossKg: kg('1'), value: kg('300.01') }], 'EUR')).toEqual({ form: 'CN23', because: ['VALUE'] })
    expect(postalFormOf([{ grossKg: kg('1'), value: kg('10') }], 'CHF')).toEqual({ form: 'CN23', because: ['CURRENCY'] })
    expect(postalFormOf([{ grossKg: null, value: kg('10') }], 'EUR')).toEqual({ form: 'CN23', because: ['NOT_WEIGHED'] })
  })
})

describe('the proof of exit', () => {
  const left = new Date('2026-10-01T10:00:00Z')
  it('is due its days after the goods left, overdue after, never once EXITED', () => {
    expect(exitDueAt(left, 30)?.toISOString()).toBe('2026-10-31T10:00:00.000Z')
    expect(exitDueAt(null, 30)).toBeNull()
    expect(exitOverdue({ status: 'FILED', alertAfterDays: 30 }, left, new Date('2026-10-31T10:00:01Z'))).toBe(true)
    expect(exitOverdue({ status: 'FILED', alertAfterDays: 30 }, left, new Date('2026-10-30T10:00:00Z'))).toBe(false)
    expect(exitOverdue({ status: 'EXITED', alertAfterDays: 30 }, left, new Date('2026-12-31T10:00:00Z'))).toBe(false)
    expect(exitDaysLeft(left, 30, new Date('2026-10-21T10:00:00Z'))).toBe(10)
    expect(exitDaysLeft(left, 30, new Date('2026-11-02T10:00:00Z'))).toBe(-2)
  })

  it('raises the exception rule EXIT_PROOF_MISSING on the shipment, telling finance', () => {
    expect(KINDS.EXIT_PROOF_MISSING.recordType).toBe('Shipment')
    expect(KINDS.EXIT_PROOF_MISSING.builtIn.recipientRole).toBe('finance')
    expect(KINDS.EXIT_PROOF_MISSING.recheck).toEqual([{ event: 'customs.declaration_changed', key: 'shipmentId' }])
    expect(alertPhrase('EXIT_PROOF_MISSING', 'SH-00042', { shippedDate: '2026-10-01', days: 30 })).toEqual({ key: 'alerts.EXIT_PROOF_MISSING', params: { label: 'SH-00042', shippedDate: '2026-10-01', days: 30 } })
  })
})

describe('the commercial invoice', () => {
  it('values each line at the order price (one rounding per line), no VAT, the HS code and origin in the words', () => {
    const document = commercialInvoiceDocument(SOURCE)
    expect(document.type).toBe('COMMERCIAL_INVOICE')
    expect(document.lines.map((line) => line.amountMinor)).toEqual([59999, 3000])
    expect(document.totals).toEqual({ netMinor: 62999, vat: [], grossMinor: 62999 })
    expect(document.lines[0]!.description).toBe('Leather jacket, black, 50×2, 52×1 · HS 420310 · Origin IT')
  })

  it('composes with the EORI, the reason, the destination and the export notice; refuses one without an EORI', () => {
    const composed = composeDocument({ ...commercialInvoiceDocument(SOURCE), company: COMPANY })
    expect(composed.layout).toBe('COMMERCIAL_INVOICE/1')
    expect(composed.title).toBe('Commercial invoice (for customs)')
    expect(composed.facts).toEqual(expect.arrayContaining([{ label: "Exporter's EORI", value: 'IT12345670009' }, { label: 'Reason for export', value: 'Sale of goods' }]))
    expect(composed.notices.join(' ')).toMatch(/art\. 8\(1\)\(a\)/)
    expect(composed.table.columns.map((column) => column.key)).toEqual(['code', 'description', 'quantity', 'uom', 'unitPrice', 'amount'])
    expect(() => composeDocument({ ...commercialInvoiceDocument({ ...SOURCE, facts: { ...SOURCE.facts, exporterEori: '' } }), company: COMPANY })).toThrow(/cannot be printed/)
  })

  it('keeps one version per contents: the day does not count, the language does', () => {
    const first = commercialInvoiceFingerprint(commercialInvoiceDocument(SOURCE))
    expect(commercialInvoiceFingerprint(commercialInvoiceDocument({ ...SOURCE, date: '2026-11-20' }))).toBe(first)
    expect(commercialInvoiceFingerprint(commercialInvoiceDocument({ ...SOURCE, language: 'it' }))).not.toBe(first)
  })

  it('names the lines customs cannot read and those without a price', () => {
    expect(customsLineProblems([{ ...SOURCE.lines[0]!, hsCode: null }, { ...SOURCE.lines[1]!, originCountry: null, unitPrice: null }])).toEqual({
      customsData: ['JKT-01 BLK: no HS code', 'GLV-02 BRN: no country of origin'],
      unpriced: ['GLV-02 BRN'],
    })
  })

  it("prints in the company's sample preview", () => {
    for (const language of ['it', 'en'] as const) expect(composeDocument(sampleDocument('COMMERCIAL_INVOICE', language, COMPANY, '2026-11-14')).banner).not.toBeNull()
  })
})

describe('the CN 22 / CN 23 document', () => {
  const form: PostalFormDocument = {
    form: 'CN22',
    language: 'en',
    number: 'SH-00042',
    date: '2026-11-14',
    currency: 'EUR',
    sender: { name: 'Pelletteria Esempio', lines: ['Via Prova 1, 20100 Milano (MI)'], eori: 'IT12345670009' },
    addressee: { name: 'Example Moto AG', lines: ['Teststrasse 1, 8001 Zürich, Switzerland'] },
    reason: 'SALE_OF_GOODS',
    reasonText: null,
    invoiceNumber: null,
    comments: null,
    parcels: [{ seq: 1, grossKg: '1.5', items: [{ description: 'Gloves, brown, L×2', quantity: 2, netKg: '0.6', valueMinor: 6000, hsCode: '420329', originCountry: 'IT' }, { description: 'Belt, black, 90×1', quantity: 1, netKg: '0.2', valueMinor: 2500, hsCode: '420330', originCountry: 'IT' }] }],
  }
  it("sums a parcel's value and keeps one version per contents", () => {
    expect(parcelValueMinor(form.parcels[0]!)).toBe(8500)
    expect(postalFormFingerprint({ ...form, date: '2026-12-01' })).toBe(postalFormFingerprint(form))
    expect(postalFormFingerprint({ ...form, form: 'CN23' })).not.toBe(postalFormFingerprint(form))
  })
})

describe('the broker pack', () => {
  it('is a link of a customs declaration: downloads are evidence, the MRN typed back its one use, no price grain', () => {
    expect(PURPOSE_RULES.BROKER_PACK.recordTypes).toEqual(['CustomsDeclaration'])
    expect(actionRule('BROKER_PACK', 'download')?.counts).toBe(false)
    expect(actionRule('BROKER_PACK', 'submit')?.counts).toBe(true)
    expect(PURPOSE_RULES.BROKER_PACK.grains).toEqual([])
    expect(PURPOSE_RULES.BROKER_PACK.fileSet).toBe(false)
  })

  it("mails the broker in its language, with the link only when it is there", () => {
    const facts = { companyName: 'Pelletteria Esempio', shipmentNumber: 'SH-00042', destination: 'Svizzera', openUntil: '2026-11-28' } as const
    const it = brokerPackMail({ ...facts, locale: 'it' }, 'https://example.test/l#token')
    expect(it.subject).toBe('Documenti per la dichiarazione di esportazione - spedizione SH-00042')
    expect(it.body).toContain('28/11/2026')
    expect(it.body).toContain('https://example.test/l#token')
    expect(brokerPackMail({ ...facts, locale: 'en' }, null).body).not.toContain('https://')
  })
})
