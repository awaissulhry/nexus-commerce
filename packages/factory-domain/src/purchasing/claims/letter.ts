import type { BusinessDate } from '../../core/time'
import { formatDate, formatQuantity } from '../../documents/format'
import type { DocumentLanguage } from '../../documents/model'
import type { DiscrepancyReport, ReportCompany, ReportSupplier } from '../../inventory/receipts/report'
import { UNITS, type Uom } from '../../product/units/units'
import type { ClaimFoundAt, ClaimKind, ClaimRemedy } from './rules'

/**
 * The claim letter to the supplier (B-W2b-14; SCM-135; design purchasing.claims rec "Supplier claim › Claim": "what is
 * wrong, with evidence and the remedy asked"), pure: every word and number of the PDF in the supplier's language
 * (Italian or English). It has the layout of the discrepancy report (inventory/receipts/report: our company and its
 * art. 2250 lines, the title, the supplier, the facts, the lines as a table, the closing, the footer), so
 * apps/factory-api paints both with the same pdfkit renderer; each version made is a GeneratedDocument CLAIM_LETTER of
 * the claim with its StoredFile (the mail to the supplier carries it). No price, no cost, no value anywhere (Owner
 * answer C2); the photos are counted, not printed (they stay the office's files).
 */

export interface LetterLine {
  readonly seq: number
  readonly code: string
  readonly name: string
  readonly colour: string | null
  /** Our lot code and the supplier's own reference beside it. */
  readonly lot: string | null
  /** Our hide tag and the tannery's number beside it. */
  readonly hide: string | null
  readonly quantity: string
  readonly uom: Uom
  /** What is wrong with this line, when more than the claim's reason. */
  readonly reason: string | null
  readonly note: string | null
  /** The receipt discrepancy the line pursues (its number on the receipt). */
  readonly discrepancySeq: number | null
}

export interface ClaimLetterInput {
  readonly language: DocumentLanguage
  readonly date: BusinessDate
  readonly company: ReportCompany
  readonly supplier: ReportSupplier
  readonly number: string
  readonly kind: ClaimKind
  readonly foundAt: ClaimFoundAt
  readonly remedy: ClaimRemedy | null
  /** The reason's words in the letter's language (the CLAIM list) and the person's own words. */
  readonly reason: { readonly label: string | null; readonly note: string | null }
  readonly receiptNumber: string | null
  readonly supplierDdtNumber: string | null
  readonly supplierDdtDate: BusinessDate | null
  readonly orderNumber: string | null
  /** The live return DDTs the goods travel with (a return). */
  readonly returnDdts: readonly string[]
  readonly lines: readonly LetterLine[]
  /** The claim's own photos (counted only). */
  readonly photos: number
  /** A preview, not what was sent: a banner says so. */
  readonly sample: boolean
}

const WORDS = {
  it: {
    title: { CLAIM: 'Reclamo al fornitore', RETURN: 'Reso merce e reclamo' },
    sample: 'ANTEPRIMA - non inviato',
    number: 'Reclamo n.',
    date: 'Data',
    receipt: 'Nostro ricevimento',
    ddt: 'Vostro DDT',
    order: 'Nostro ordine',
    foundAt: 'Rilevato',
    returnDdt: 'Nostro DDT di reso',
    supplier: 'Fornitore',
    vat: 'P. IVA',
    found: { RECEIPT: 'al ricevimento', STOCK: 'a magazzino', CUTTING: 'al taglio', PRODUCTION: 'in produzione', INSPECTION: 'al controllo qualità' },
    intro: {
      CLAIM: 'Vi segnaliamo un problema con la merce indicata qui sotto.',
      RETURN: 'Vi rendiamo la merce indicata qui sotto, che non possiamo usare.',
    },
    reason: 'Motivo',
    ask: { CREDIT: 'Vi chiediamo una nota di credito per questa merce.', REPLACEMENT: 'Vi chiediamo la sostituzione della merce.' },
    photos: (n: number) => (n === 1 ? 'Abbiamo documentato il problema con 1 foto, disponibile su richiesta.' : `Abbiamo documentato il problema con ${n} foto, disponibili su richiesta.`),
    reply: (number: string) => `Vi preghiamo di rispondere citando il reclamo ${number}: la vostra risposta resta legata al reclamo.`,
    columns: { seq: 'N.', material: 'Articolo', kind: 'Problema', quantity: 'Quantità', note: 'Note' },
    lot: 'lotto',
    hide: 'pelle',
    discrepancy: (seq: number) => `difformità ${seq} del ricevimento`,
    page: (page: number, pages: number) => `Pagina ${page} di ${pages}`,
    file: 'Reclamo',
  },
  en: {
    title: { CLAIM: 'Supplier claim', RETURN: 'Goods returned and claim' },
    sample: 'PREVIEW - not sent',
    number: 'Claim no.',
    date: 'Date',
    receipt: 'Our goods receipt',
    ddt: 'Your delivery note',
    order: 'Our order',
    foundAt: 'Found',
    returnDdt: 'Our return DDT',
    supplier: 'Supplier',
    vat: 'VAT no.',
    found: { RECEIPT: 'at receiving', STOCK: 'in stock', CUTTING: 'at cutting', PRODUCTION: 'in production', INSPECTION: 'at the quality check' },
    intro: {
      CLAIM: 'We report a problem with the goods listed below.',
      RETURN: 'We are returning the goods listed below, which we cannot use.',
    },
    reason: 'Reason',
    ask: { CREDIT: 'We ask you for a credit note for these goods.', REPLACEMENT: 'We ask you to replace the goods.' },
    photos: (n: number) => (n === 1 ? 'We recorded the problem with 1 photo, available on request.' : `We recorded the problem with ${n} photos, available on request.`),
    reply: (number: string) => `Please reply quoting claim ${number}: your answer stays with the claim.`,
    columns: { seq: 'No.', material: 'Article', kind: 'Problem', quantity: 'Quantity', note: 'Note' },
    lot: 'lot',
    hide: 'hide',
    discrepancy: (seq: number) => `receipt discrepancy ${seq}`,
    page: (page: number, pages: number) => `Page ${page} of ${pages}`,
    file: 'Claim',
  },
} as const

const join = (parts: readonly (string | null | undefined)[], separator = ' · '): string => parts.filter((part): part is string => typeof part === 'string' && part.trim() !== '').join(separator)

/** The claim letter as the PDF prints it: every word decided here. */
export function claimLetter(input: ClaimLetterInput): DiscrepancyReport {
  const w = WORDS[input.language]
  const title = w.title[input.kind]
  const reason = join([input.reason.label, input.reason.note], ': ')
  const facts = [
    { label: w.number, value: input.number },
    { label: w.date, value: formatDate(input.date, input.language) },
    ...(input.receiptNumber ? [{ label: w.receipt, value: input.receiptNumber }] : []),
    ...(input.supplierDdtNumber ? [{ label: w.ddt, value: input.supplierDdtDate ? `${input.supplierDdtNumber} · ${formatDate(input.supplierDdtDate, input.language)}` : input.supplierDdtNumber }] : []),
    ...(input.orderNumber ? [{ label: w.order, value: input.orderNumber }] : []),
    { label: w.foundAt, value: w.found[input.foundAt] },
    ...(input.returnDdts.length > 0 ? [{ label: w.returnDdt, value: input.returnDdts.join(', ') }] : []),
  ]
  const rows = [...input.lines]
    .sort((a, b) => a.seq - b.seq)
    .map((line) => ({
      seq: String(line.seq),
      material: join([`${line.code} ${line.name}`.trim(), line.colour, line.lot ? `${w.lot} ${line.lot}` : null, line.hide ? `${w.hide} ${line.hide}` : null]),
      kind: line.reason?.trim() ? line.reason.trim() : reason,
      quantity: `${formatQuantity(line.quantity, input.language)} ${UNITS[line.uom].symbol}`,
      note: join([line.note, line.discrepancySeq !== null ? w.discrepancy(line.discrepancySeq) : null]),
    }))
  const supplierLines = [input.supplier.name, input.supplier.address, input.supplier.vatNumber ? `${w.vat} ${input.supplier.vatNumber}` : null].filter((part): part is string => part !== null && part !== '')
  const intro = join([w.intro[input.kind], reason ? `${w.reason}: ${reason}.` : null], ' ')
  const closing = join([input.remedy ? w.ask[input.remedy] : null, input.photos > 0 ? w.photos(input.photos) : null, w.reply(input.number)], ' ')
  const safe = input.number.replace(/[^A-Za-z0-9-]/g, '-')
  return {
    language: input.language,
    meta: { title: `${title} ${input.number}`, subject: `${title} ${input.number}`, createdAt: `${input.date}T00:00:00.000Z` },
    title,
    sample: input.sample ? w.sample : null,
    company: input.company,
    facts,
    supplier: { label: w.supplier, lines: supplierLines },
    intro,
    columns: [
      { key: 'seq', label: w.columns.seq, width: 0.06, align: 'right' },
      { key: 'material', label: w.columns.material, width: 0.36, align: 'left' },
      { key: 'kind', label: w.columns.kind, width: 0.22, align: 'left' },
      { key: 'quantity', label: w.columns.quantity, width: 0.12, align: 'right' },
      { key: 'note', label: w.columns.note, width: 0.24, align: 'left' },
    ],
    rows,
    closing,
    page: w.page,
    fileName: `${w.file}-${safe}.pdf`,
  }
}

/**
 * What a letter version is made of, as one stable text (its fingerprint's input): the same claim, words and language give
 * the same text, so a send reuses the newest version instead of storing the same letter again. The date and the preview
 * banner are left out (a letter made on another day with the same contents is the same letter).
 */
export function letterFingerprintText(input: ClaimLetterInput): string {
  const { date: _date, sample: _sample, ...rest } = input
  return JSON.stringify(rest)
}
