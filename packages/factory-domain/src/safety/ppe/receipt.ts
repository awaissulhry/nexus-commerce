import { BUSINESS_TIME_ZONE } from '../../core/time'
import { formatDateTime } from '../../documents/format'
import type { DocumentLanguage } from '../../documents/model'
import type { DiscrepancyReport, ReportColumn } from '../../inventory/receipts/report'
import { ISSUE_LAW, RECEIPT_LAW, RECEIPT_STATEMENT, type PpeIssueReason, type PpeReceiptMethod, type ReceiptState } from './rules'

/**
 * A PPE receipt (B-W2b-134; QHS-261; design plant.ppe new tab "Receipt (PDF) — Per issue, signed"; arts. 18 c.1 d, 77 c.4): one
 * A4 page that says who received which items (size, how many, why) at which site and when, who handed them over, and how the
 * person signed: with their badge and PIN on the tablet (the worker, the tablet, the SHA-256 of what they signed) or on a paper
 * receipt whose scan is on file. A voided line keeps its place with the void mark and the reason (a wrong issue is voided,
 * never removed). Painted by apps/factory-api with the A4 renderer of the discrepancy report (the same shape as the DVR seal);
 * kept as a GeneratedDocument PPE_RECEIPT of the receipt's first row for a receipt signed with the PIN (a paper receipt is its
 * own signed scan).
 *
 * A pure function of what it prints: the same receipt and language give the same text (its fingerprint). No money; the person
 * is named (the register names them: art. 77 c.4 asks the receipt to be kept with the person).
 */

export interface ReceiptLine {
  readonly code: string
  readonly name: string
  readonly size: string | null
  readonly quantity: number
  readonly reason: PpeIssueReason
  /** The void, when the line was voided: when and why. */
  readonly voided: { readonly at: string; readonly reason: string | null } | null
}

export interface ReceiptInput {
  readonly language: DocumentLanguage
  /** When the PDF is made (its metadata only). */
  readonly createdAt: string
  readonly company: DiscrepancyReport['company']
  readonly site: { readonly code: string; readonly name: string }
  readonly person: { readonly name: string; readonly employeeCode: string | null }
  /** ISO instant. */
  readonly issuedAt: string
  /** Who handed the items over (an office person or the worker at the tablet; null: nobody else). */
  readonly handedOverBy: string | null
  readonly method: PpeReceiptMethod
  readonly state: ReceiptState
  /** FLOOR_PIN: the worker who signed, the tablet, the SHA-256 of what they signed and the words they read. */
  readonly signature: { readonly worker: string; readonly device: string; readonly sha256: string; readonly statement: string } | null
  /** PAPER: the scan's file name (null: not on file yet). */
  readonly scan: string | null
  readonly lines: readonly ReceiptLine[]
  /** A preview, not the kept document: a banner says so. */
  readonly sample: boolean
}

const WORDS = {
  it: {
    title: 'Ricevuta di consegna DPI',
    sample: 'ANTEPRIMA - non conservata',
    voided: 'ANNULLATA - ogni riga è stata annullata',
    person: 'Lavoratore',
    code: 'Matricola',
    site: 'Sito',
    issuedAt: 'Consegnato il',
    by: 'Consegnato da',
    signed: 'Firma',
    methods: { FLOOR_PIN: 'badge e PIN sul tablet', PAPER: 'ricevuta su carta' },
    worker: 'Firmato da',
    device: 'Tablet',
    sha: 'Impronta SHA-256 di quanto firmato',
    scan: 'Scansione della ricevuta',
    noScan: 'non ancora in archivio',
    law: 'Riferimento normativo',
    none: '-',
    unit: 'Azienda',
    columns: { seq: 'N.', material: 'DPI', kind: 'Taglia', quantity: 'Quantità', note: 'Motivo' },
    oneSize: 'taglia unica',
    reasons: { NEW: 'prima consegna', REPLACEMENT: 'sostituzione', LOST: 'smarrito' },
    void: (at: string, reason: string | null) => `ANNULLATA il ${at}${reason ? `: ${reason}` : ''}`,
    paperIntro: 'Il lavoratore ha firmato su carta la ricevuta dei DPI elencati e delle relative istruzioni; la scansione firmata resta in archivio con questa consegna.',
    closing: 'Ricevuta generata dal registro delle consegne DPI. Una consegna errata si annulla con il motivo; la ricevuta resta, con il segno di annullamento.',
    page: (page: number, pages: number) => `Pagina ${page} di ${pages}`,
    fileName: 'Ricevuta-DPI',
  },
  en: {
    title: 'PPE receipt',
    sample: 'PREVIEW - not kept',
    voided: 'VOID - every line was voided',
    person: 'Worker',
    code: 'Employee no.',
    site: 'Site',
    issuedAt: 'Handed over on',
    by: 'Handed over by',
    signed: 'Signature',
    methods: { FLOOR_PIN: 'badge and PIN on the tablet', PAPER: 'paper receipt' },
    worker: 'Signed by',
    device: 'Tablet',
    sha: 'SHA-256 of what was signed',
    scan: 'Scan of the receipt',
    noScan: 'not on file yet',
    law: 'Legal basis',
    none: '-',
    unit: 'Company',
    columns: { seq: 'No.', material: 'PPE', kind: 'Size', quantity: 'Quantity', note: 'Why' },
    oneSize: 'one size',
    reasons: { NEW: 'first issue', REPLACEMENT: 'replacement', LOST: 'lost' },
    void: (at: string, reason: string | null) => `VOID on ${at}${reason ? `: ${reason}` : ''}`,
    paperIntro: 'The worker signed the paper receipt of the PPE listed and of their instructions; the signed scan is kept with this issue.',
    closing: 'Made from the PPE issue register. A wrong issue is voided with the reason; the receipt stays, marked void.',
    page: (page: number, pages: number) => `Page ${page} of ${pages}`,
    fileName: 'PPE-receipt',
  },
} as const

const COLUMNS = (language: DocumentLanguage): ReportColumn[] => {
  const w = WORDS[language].columns
  return [
    { key: 'seq', label: w.seq, width: 0.06, align: 'right' },
    { key: 'material', label: w.material, width: 0.38, align: 'left' },
    { key: 'kind', label: w.kind, width: 0.14, align: 'left' },
    { key: 'quantity', label: w.quantity, width: 0.1, align: 'right' },
    { key: 'note', label: w.note, width: 0.32, align: 'left' },
  ]
}

const safeName = (value: string): string => value.replace(/[^A-Za-z0-9_-]/g, '_')

/** The receipt, ready to paint (the discrepancy report's A4 shape). */
export function ppeReceipt(input: ReceiptInput): DiscrepancyReport {
  const w = WORDS[input.language]
  const when = (iso: string) => formatDateTime(new Date(iso), BUSINESS_TIME_ZONE, input.language)
  const facts: { label: string; value: string }[] = [
    { label: w.person, value: input.person.name },
    { label: w.code, value: input.person.employeeCode ?? w.none },
    { label: w.site, value: `${input.site.code} · ${input.site.name}` },
    { label: w.issuedAt, value: when(input.issuedAt) },
    { label: w.by, value: input.handedOverBy ?? w.none },
    { label: w.signed, value: w.methods[input.method] },
    ...(input.signature
      ? [
          { label: w.worker, value: input.signature.worker },
          { label: w.device, value: input.signature.device },
          { label: w.sha, value: input.signature.sha256 },
        ]
      : [{ label: w.scan, value: input.scan ?? w.noScan }]),
    { label: w.law, value: `${ISSUE_LAW}; ${RECEIPT_LAW}` },
  ]
  const rows = input.lines.map((line, index) => ({
    seq: String(index + 1),
    material: `${line.code} · ${line.name}`,
    kind: line.size ?? w.oneSize,
    quantity: String(line.quantity),
    note: line.voided ? `${w.reasons[line.reason]} · ${w.void(when(line.voided.at), line.voided.reason)}` : w.reasons[line.reason],
  }))
  const intro = input.signature ? `«${input.signature.statement}»` : w.paperIntro
  const banner = input.state === 'VOIDED' ? w.voided : input.sample ? w.sample : null
  const stamp = new Date(input.issuedAt).toISOString().slice(0, 10)
  return {
    language: input.language,
    meta: { title: `${w.title} · ${input.person.name} · ${stamp}`, subject: `${w.title} ${stamp}`, createdAt: input.createdAt },
    title: w.title,
    sample: banner,
    company: input.company,
    facts,
    supplier: { label: w.unit, lines: [input.company.name, `${input.site.code} · ${input.site.name}`] },
    intro,
    columns: COLUMNS(input.language),
    rows,
    closing: w.closing,
    page: w.page,
    fileName: `${w.fileName}-${safeName(input.site.code)}-${stamp}.pdf`,
  }
}

/** What the receipt shows, as one text: its fingerprint's source (the same contents give the same text, whatever the day). */
export function receiptFingerprintText(input: Omit<ReceiptInput, 'createdAt' | 'sample'>): string {
  return JSON.stringify({ ...input, lines: input.lines.map((line) => ({ ...line })) })
}

/** The words the tablet shows before the PIN (the statement the SHA-256 binds). */
export const statementOf = (language: keyof typeof RECEIPT_STATEMENT): string => RECEIPT_STATEMENT[language]
