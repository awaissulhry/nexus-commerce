import { buildFatturaPa } from '../invoicing/fatturapa/build'
import type { FatturaPaDocumentType } from '../invoicing/fatturapa/types'
import { decideVatTreatment } from '../tax/vat-treatment'

/**
 * Test support (B-W2a-62): a supplier's FatturaPA, as an Italian supplier's software would send it through SDI to the
 * factory's company, made with the factory's own FatturaPA builder (so it passes the official schema). For the domain
 * and API tests and the local live check only. EVERY name, VAT number, IBAN and address is FAKE (office code 000 for
 * the VAT numbers, bank code 99999).
 */

export interface SupplierXmlInput {
  readonly supplierVat: string
  readonly supplierName?: string
  readonly buyerVat: string
  readonly buyerName?: string
  readonly documentType?: FatturaPaDocumentType
  readonly number: string
  readonly date: string
  readonly progressive?: string
  readonly lines: readonly { readonly description: string; readonly quantity: string; readonly uom?: string; readonly unitPrice: string; readonly itemCode?: string }[]
  readonly orders?: readonly { readonly number: string; readonly date?: string }[]
  readonly ddts?: readonly { readonly number: string; readonly date: string }[]
  readonly relatedInvoices?: readonly { readonly number: string; readonly date?: string }[]
  readonly dueDate?: string
  readonly causale?: string
}

const GOODS = decideVatTreatment({ customer: { taxMode: 'IT_B2B' }, supply: 'GOODS', rate: 22 }).treatment

export function supplierInvoiceXml(input: SupplierXmlInput): { xml: string; fileName: string; total: string } {
  const base = {
    documentType: input.documentType ?? 'TD01',
    number: input.number,
    date: input.date,
    transmission: { progressive: input.progressive ?? '00001' },
    seller: {
      vatNumber: input.supplierVat,
      name: input.supplierName ?? 'Conceria Fittizia S.r.l.',
      taxRegime: 'RF01' as const,
      address: { street: 'Via delle Concerie Finte', streetNumber: '7', postcode: '56029', city: 'Santa Croce sull Arno', province: 'PI', country: 'IT' },
    },
    buyer: {
      kind: 'IT_BUSINESS' as const,
      vatNumber: input.buyerVat,
      name: input.buyerName ?? 'Fabbrica Fittizia S.r.l.',
      address: { street: 'Via della Prova', streetNumber: '1', postcode: '20121', city: 'Milano', province: 'MI', country: 'IT' },
      sdiCode: 'FAKE001',
    },
    lines: input.lines.map((line) => ({ description: line.description, quantity: line.quantity, unitOfMeasure: line.uom ?? 'PZ', unitPrice: line.unitPrice, vat: GOODS, ...(line.itemCode ? { itemCode: { type: 'CODICE', value: line.itemCode } } : {}) })),
    ...(input.orders ? { purchaseOrders: input.orders.map((order) => ({ number: order.number, ...(order.date ? { date: order.date } : {}) })) } : {}),
    ...(input.ddts ? { ddts: [...input.ddts] } : {}),
    ...(input.relatedInvoices ? { relatedInvoices: input.relatedInvoices.map((entry) => ({ number: entry.number, ...(entry.date ? { date: entry.date } : {}) })) } : {}),
    ...(input.causale ? { causale: input.causale } : {}),
    stampDuty: 'NONE' as const,
  }
  const first = buildFatturaPa(base)
  const total = first.totals.total.toFixed(2)
  const built = input.dueDate ? buildFatturaPa({ ...base, payment: { condition: 'TP02', installments: [{ method: 'MP05', amount: total, dueDate: input.dueDate, iban: 'IT47X9999999999000000000001' }] } }) : first
  return { xml: built.xml, fileName: built.fileName, total }
}
