import type { BusinessDate } from '../core/time'
import type { CompanyLegal, DocumentInput, DocumentLanguage, DocumentType } from './model'

/**
 * A sample of each layout for a company's preview (the letterhead check in the Office's company settings): the
 * company's real legal block with a made-up party, made-up lines and the "sample, not a valid document" banner. Never
 * stored and never numbered: its number is the word SAMPLE.
 */

const PARTY = {
  name: 'Example Customer S.r.l.',
  address: { line1: 'Via Esempio 10', postalCode: '40121', city: 'Bologna', province: 'BO', country: 'IT' },
  vatNumber: 'IT00000000000',
} as const

const LINES = [
  { code: 'JKT-01', description: 'Leather jacket, black, size 50', quantity: '2', uom: 'PCS', unitPrice: '250.00', amountMinor: 50000, vatRate: '22' },
  { code: 'GLV-02', description: 'Leather gloves, brown, size L', quantity: '10', uom: 'PAIR', unitPrice: '30.00', discountPercent: '10', amountMinor: 27000, vatRate: '22' },
] as const

export function sampleDocument(type: DocumentType, language: DocumentLanguage, company: CompanyLegal, date: BusinessDate): DocumentInput {
  const base = {
    type,
    language,
    number: 'SAMPLE',
    date,
    currency: company.currency,
    company,
    party: type === 'PURCHASE_ORDER' ? { ...PARTY, name: 'Example Supplier S.p.A.' } : PARTY,
    lines: LINES,
    sample: true,
  } satisfies DocumentInput
  const totals = { netMinor: 77000, vat: [{ rate: '22', taxableMinor: 77000, vatMinor: 16940 }], grossMinor: 93940 }
  switch (type) {
    case 'QUOTE':
      return { ...base, totals, validUntil: date, paymentTerms: '30 days' }
    case 'PURCHASE_ORDER':
      return { ...base, totals, deliveryDate: date, deliveryTerms: 'EXW' }
    case 'INVOICE_COPY':
      return { ...base, totals, invoice: { kind: 'TD01' } }
    case 'DDT':
      return {
        ...base,
        lines: LINES.map(({ code, description, quantity, uom }) => ({ code, description, quantity, uom })),
        transport: { reason: 'SALE', transportBy: 'SENDER', startAt: `${date}T08:00:00Z`, appearance: 'Boxes', packages: 2, grossWeightKg: '12.5' },
      }
  }
}
