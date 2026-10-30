import type { BusinessDate } from '../../core/time'
import { formatDate, formatQuantity } from '../../documents/format'
import type { DocumentLanguage } from '../../documents/model'
import { UNITS, type Uom } from '../../product/units/units'
import { DISCREPANCY_KIND_WORDS, type DiscrepancyKind } from './discrepancies'

/**
 * The discrepancy report to the supplier (B-W2a-31; SCM-118; design warehouse.receipts pop rc-disc-send and tab
 * rc-tab-disc "Discrepancy report PDF"), pure: every word and number of the PDF and of its mail, in the supplier's
 * language (Italian or English). apps/factory-api's modules/inventory/receipts/report.ts reads the facts and paints it
 * on A4 with pdfkit (the documents platform's fonts and WinAnsi rule). No price, no cost, no value anywhere (Owner
 * answer C2: no prices on supplier screens and papers); no person but the sender's name in the mail.
 */

export interface ReportCompany {
  /** documents/legal legalName and legalLines. */
  readonly name: string
  readonly lines: readonly string[]
  /** documents/legal legalFooter (art. 2250 c.c.). */
  readonly legal: string
}

export interface ReportSupplier {
  readonly name: string
  readonly address: string | null
  readonly vatNumber: string | null
}

export interface ReportReceipt {
  readonly number: string
  readonly receivedOn: BusinessDate
  readonly site: string
  readonly supplierDdtNumber: string | null
  readonly supplierDdtDate: BusinessDate | null
  readonly purchaseOrderNumber: string | null
}

export interface ReportLine {
  readonly seq: number
  readonly kind: DiscrepancyKind
  /** The reason's words in the report's language (the DISCREPANCY list), else null. */
  readonly reason: string | null
  /** The receipt line it is about: the material's code and name, the colour, the order line. Null: the delivery. */
  readonly material: { readonly code: string; readonly name: string; readonly colour: string | null; readonly orderLine: number | null; readonly supplierCode: string | null } | null
  readonly quantity: string | null
  readonly uom: Uom | null
  readonly note: string | null
  readonly photos: number
}

export interface DiscrepancyReportInput {
  readonly language: DocumentLanguage
  readonly date: BusinessDate
  readonly company: ReportCompany
  readonly supplier: ReportSupplier
  readonly receipt: ReportReceipt
  readonly lines: readonly ReportLine[]
  /** A preview, not what was sent: a banner says so. */
  readonly sample: boolean
}

export interface ReportColumn {
  readonly key: 'seq' | 'material' | 'kind' | 'quantity' | 'note'
  readonly label: string
  /** Share of the table's width. */
  readonly width: number
  readonly align: 'left' | 'right'
}

export interface DiscrepancyReport {
  readonly language: DocumentLanguage
  readonly meta: { readonly title: string; readonly subject: string; readonly createdAt: string }
  readonly title: string
  readonly sample: string | null
  readonly company: ReportCompany
  /** Label → value, two columns under the title. */
  readonly facts: readonly { readonly label: string; readonly value: string }[]
  readonly supplier: { readonly label: string; readonly lines: readonly string[] }
  readonly intro: string
  readonly columns: readonly ReportColumn[]
  readonly rows: readonly Readonly<Record<ReportColumn['key'], string>>[]
  readonly closing: string
  readonly page: (page: number, pages: number) => string
  readonly fileName: string
}

const WORDS = {
  it: {
    title: 'Rapporto di non conformità della consegna',
    sample: 'ANTEPRIMA - non inviato',
    receipt: 'Nostro ricevimento',
    receivedOn: 'Ricevuto il',
    site: 'Luogo di ricevimento',
    ddt: 'Vostro DDT',
    order: 'Nostro ordine',
    reportDate: 'Data del rapporto',
    supplier: 'Fornitore',
    vat: 'P. IVA',
    intro: 'Alla consegna abbiamo riscontrato quanto segue. Vi chiediamo di risponderci indicando come intendete procedere (nota di credito, sostituzione o reso).',
    closing: 'Le foto sono disponibili su richiesta. Rispondete a questa e-mail: la vostra risposta resta legata al ricevimento.',
    columns: { seq: 'N.', material: 'Articolo', kind: 'Problema', quantity: 'Quantità', note: 'Note' },
    delivery: 'Consegna nel suo insieme',
    line: 'riga ordine',
    yourCode: 'vs. cod.',
    photos: (n: number) => (n === 1 ? '1 foto' : `${n} foto`),
    page: (page: number, pages: number) => `Pagina ${page} di ${pages}`,
    file: 'Rapporto-non-conformita',
  },
  en: {
    title: 'Delivery discrepancy report',
    sample: 'PREVIEW - not sent',
    receipt: 'Our goods receipt',
    receivedOn: 'Received on',
    site: 'Received at',
    ddt: 'Your delivery note',
    order: 'Our order',
    reportDate: 'Report date',
    supplier: 'Supplier',
    vat: 'VAT no.',
    intro: 'We found the following when the goods arrived. Please reply and tell us how you will settle it (a credit note, a replacement or a return).',
    closing: 'Photos are available on request. Reply to this e-mail: your answer stays with the goods receipt.',
    columns: { seq: 'No.', material: 'Article', kind: 'Problem', quantity: 'Quantity', note: 'Note' },
    delivery: 'The delivery as a whole',
    line: 'order line',
    yourCode: 'your code',
    photos: (n: number) => (n === 1 ? '1 photo' : `${n} photos`),
    page: (page: number, pages: number) => `Page ${page} of ${pages}`,
    file: 'Discrepancy-report',
  },
} as const

const unitSymbol = (uom: Uom): string => UNITS[uom].symbol

/** The report as the PDF prints it: every word decided here. */
export function discrepancyReport(input: DiscrepancyReportInput): DiscrepancyReport {
  const w = WORDS[input.language]
  const kinds = DISCREPANCY_KIND_WORDS[input.language]
  const { receipt } = input
  const facts = [
    { label: w.receipt, value: receipt.number },
    { label: w.receivedOn, value: formatDate(receipt.receivedOn, input.language) },
    { label: w.site, value: receipt.site },
    ...(receipt.supplierDdtNumber ? [{ label: w.ddt, value: receipt.supplierDdtDate ? `${receipt.supplierDdtNumber} · ${formatDate(receipt.supplierDdtDate, input.language)}` : receipt.supplierDdtNumber }] : []),
    ...(receipt.purchaseOrderNumber ? [{ label: w.order, value: receipt.purchaseOrderNumber }] : []),
    { label: w.reportDate, value: formatDate(input.date, input.language) },
  ]
  const rows = [...input.lines]
    .sort((a, b) => a.seq - b.seq)
    .map((line) => ({
      seq: String(line.seq),
      material: line.material
        ? [
            `${line.material.code} ${line.material.name}`,
            line.material.colour,
            line.material.supplierCode ? `${w.yourCode} ${line.material.supplierCode}` : null,
            line.material.orderLine !== null ? `${w.line} ${line.material.orderLine}` : null,
          ]
            .filter((part): part is string => part !== null && part !== '')
            .join(' · ')
        : w.delivery,
      kind: line.reason && line.reason !== kinds[line.kind] ? `${kinds[line.kind]}: ${line.reason}` : kinds[line.kind],
      quantity: line.quantity !== null && line.uom !== null ? `${formatQuantity(line.quantity, input.language)} ${unitSymbol(line.uom)}` : '',
      note: [line.note, line.photos > 0 ? w.photos(line.photos) : null].filter((part): part is string => part !== null && part !== '').join(' · '),
    }))
  const supplierLines = [input.supplier.name, input.supplier.address, input.supplier.vatNumber ? `${w.vat} ${input.supplier.vatNumber}` : null].filter((part): part is string => part !== null && part !== '')
  const safe = receipt.number.replace(/[^A-Za-z0-9-]/g, '-')
  return {
    language: input.language,
    meta: { title: `${w.title} ${receipt.number}`, subject: `${w.title} ${receipt.number}`, createdAt: `${input.date}T00:00:00.000Z` },
    title: w.title,
    sample: input.sample ? w.sample : null,
    company: input.company,
    facts,
    supplier: { label: w.supplier, lines: supplierLines },
    intro: w.intro,
    columns: [
      { key: 'seq', label: w.columns.seq, width: 0.06, align: 'right' },
      { key: 'material', label: w.columns.material, width: 0.32, align: 'left' },
      { key: 'kind', label: w.columns.kind, width: 0.2, align: 'left' },
      { key: 'quantity', label: w.columns.quantity, width: 0.12, align: 'right' },
      { key: 'note', label: w.columns.note, width: 0.3, align: 'left' },
    ],
    rows,
    closing: w.closing,
    page: w.page,
    fileName: `${w.file}-${safe}.pdf`,
  }
}

/** The mail that carries the report: its subject and text in the supplier's language (the office's message on top). */
export function discrepancyReportMail(input: { readonly language: DocumentLanguage; readonly receiptNumber: string; readonly supplierDdtNumber: string | null; readonly count: number; readonly recipientName: string | null; readonly message: string | null }): { readonly subject: string; readonly body: string } {
  const it = input.language === 'it'
  const ddt = input.supplierDdtNumber ? (it ? ` (vs. DDT ${input.supplierDdtNumber})` : ` (your delivery note ${input.supplierDdtNumber})`) : ''
  const subject = it ? `Non conformità della consegna ${input.receiptNumber}${ddt}` : `Delivery discrepancies ${input.receiptNumber}${ddt}`
  const greeting = input.recipientName ? (it ? `Gentile ${input.recipientName},` : `Dear ${input.recipientName},`) : it ? 'Buongiorno,' : 'Hello,'
  const standard = it
    ? `in allegato il rapporto delle ${input.count === 1 ? 'non conformità riscontrata' : `${input.count} non conformità riscontrate`} alla consegna ${input.receiptNumber}${ddt}. Vi chiediamo di risponderci indicando come intendete procedere.`
    : `attached is the report of the ${input.count === 1 ? 'discrepancy' : `${input.count} discrepancies`} we found in the delivery ${input.receiptNumber}${ddt}. Please reply and tell us how you will settle ${input.count === 1 ? 'it' : 'them'}.`
  const own = input.message?.trim() ? input.message.trim() : null
  return { subject, body: [greeting, own ?? standard, it ? 'Cordiali saluti' : 'Kind regards'].join('\n\n') }
}
