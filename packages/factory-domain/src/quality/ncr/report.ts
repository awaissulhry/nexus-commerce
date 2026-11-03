import type { BusinessDate } from '../../core/time'
import { formatDate, formatDecimal } from '../../documents/format'
import type { DocumentLanguage } from '../../documents/model'
import type { EightDCompany, EightDReport, EightDSection, EightDTable } from '../capa/report'
import { GARMENT_ZONES, type DefectClass, type QualityStage } from '../defects/rules'
import { classWordsIn } from '../defects/severity'
import type { NcrStage } from './rules'

/**
 * The NCR report (B-W2b-113; design quality.ncr new tab "NCR report (PDF)": "To send to a supplier or attach to a
 * complaint"), pure: every word of the PDF in Italian or English, laid out as the 8D report (the same A4 renderer, the CAPA
 * module's) — our letterhead, the facts, what happened, the containment, the decisions by quantity and the closure. A view of
 * the record, never a document to keep in step: each version kept is a GeneratedDocument NCR_REPORT of the NCR.
 *
 * It leaves the company, so it never prints a cost (the plan says no cost figure there), a worker's name, a person's
 * figure, the customer's concession (between us and the customer) or the internal notes; the office people who own and
 * close the NCR are named inside the record as on the screen.
 */

export interface NcrReportInput {
  readonly language: DocumentLanguage
  /** The report's date. */
  readonly date: BusinessDate
  readonly company: EightDCompany
  readonly number: string
  readonly title: string
  readonly stage: NcrStage
  readonly severity: DefectClass
  readonly foundAt: QualityStage
  readonly foundOn: BusinessDate
  /** Where it came from, as its number (an inspection, a bundle, a receipt, a complaint …), or null (raised by hand). */
  readonly source: string | null
  readonly style: string | null
  readonly colourway: string | null
  readonly size: string | null
  readonly serial: string | null
  readonly lot: string | null
  readonly supplier: string | null
  readonly workOrder: string | null
  readonly quantityAffected: string
  readonly quantitySuspect: string | null
  readonly uom: string
  readonly defect: string | null
  readonly zone: string | null
  readonly cause: string | null
  readonly capa: string | null
  readonly owner: string | null
  readonly description: string | null
  readonly containment: readonly { readonly kind: string; readonly description: string | null; readonly status: string; readonly doneOn: BusinessDate | null }[]
  readonly decisions: readonly { readonly seq: number; readonly disposition: string; readonly quantity: string; readonly state: string; readonly followUp: string | null }[]
  readonly closedOn: BusinessDate | null
  readonly closeNote: string | null
  readonly cancelReason: string | null
  /** A preview, not a version kept: a banner says so. */
  readonly sample: boolean
}

const WORDS = {
  it: {
    title: 'Rapporto di non conformità',
    sample: 'ANTEPRIMA - versione non conservata',
    number: 'Numero',
    subject: 'Oggetto',
    stage: 'Stato',
    severity: 'Gravità',
    found: 'Rilevata',
    source: 'Origine',
    style: 'Modello',
    size: 'Taglia',
    serial: 'Matricola',
    lot: 'Lotto',
    supplier: 'Fornitore',
    workOrder: 'Ordine di lavoro',
    quantity: 'Quantità coinvolta',
    suspect: 'Quantità sospetta',
    defect: 'Difetto',
    zone: 'Zona',
    cause: 'Causa',
    capa: 'Azione correttiva',
    owner: 'Responsabile',
    reportDate: 'Data del rapporto',
    s1: '1 - Descrizione',
    s2: '2 - Contenimento',
    s3: '3 - Decisioni per quantità',
    s4: '4 - Chiusura',
    notStated: 'Non indicata.',
    noContainment: 'Nessuna azione di contenimento registrata.',
    noDecision: 'Nessuna decisione presa.',
    open: 'Aperta: non ancora chiusa.',
    closed: (on: string) => `Chiusa il ${on} con firma elettronica.`,
    cancelled: (why: string) => `Annullata: ${why}`,
    at: (stage: string, on: string) => `${stage}, ${on}`,
    containmentColumns: { action: 'Azione', state: 'Stato' },
    decisionColumns: { seq: 'N.', disposition: 'Decisione', quantity: 'Quantità', state: 'Stato', followUp: 'Seguito' },
    stages: { OPEN: 'Aperta', CONTAINED: 'Contenuta', DECIDED: 'Decisa', CLOSED: 'Chiusa', CANCELLED: 'Annullata' } as Record<string, string>,
    foundAt: { INCOMING: 'In accettazione', STOCK: 'A magazzino', CUTTING: 'Al taglio', IN_LINE: 'In linea', FINAL: 'Al collaudo finale', PACKING: "All'imballo", CUSTOMER: 'Dal cliente', AUDIT: 'In audit' } as Record<string, string>,
    containmentKind: { HOLD_STOCK: 'Blocco della merce', CHECK_WIP: 'Verifica del semilavorato', CHECK_SHIPPED: 'Verifica della merce spedita', TELL_CUSTOMER: 'Avviso al cliente', OTHER: 'Altro' } as Record<string, string>,
    status: { OPEN: 'Aperta', DONE: 'Fatta', CANCELLED: 'Annullata' } as Record<string, string>,
    decisionState: { WAITING_APPROVAL: 'In attesa di approvazione', TO_CARRY_OUT: 'Da eseguire', DONE: 'Eseguita' } as Record<string, string>,
    done: (on: string) => `fatta il ${on}`,
    page: (page: number, pages: number) => `Pagina ${page} di ${pages}`,
    file: 'Rapporto-NC',
  },
  en: {
    title: 'Nonconformance report',
    sample: 'PREVIEW - version not kept',
    number: 'Number',
    subject: 'Subject',
    stage: 'Status',
    severity: 'Severity',
    found: 'Found',
    source: 'Came from',
    style: 'Style',
    size: 'Size',
    serial: 'Serial',
    lot: 'Lot',
    supplier: 'Supplier',
    workOrder: 'Work order',
    quantity: 'Quantity affected',
    suspect: 'Quantity suspect',
    defect: 'Defect',
    zone: 'Zone',
    cause: 'Cause',
    capa: 'Corrective action',
    owner: 'Owner',
    reportDate: 'Report date',
    s1: '1 - What happened',
    s2: '2 - Containment',
    s3: '3 - Decisions by quantity',
    s4: '4 - Closure',
    notStated: 'Not stated.',
    noContainment: 'No containment action is recorded.',
    noDecision: 'Nothing is decided yet.',
    open: 'Open: not closed yet.',
    closed: (on: string) => `Closed on ${on} with an e-signature.`,
    cancelled: (why: string) => `Cancelled: ${why}`,
    at: (stage: string, on: string) => `${stage}, ${on}`,
    containmentColumns: { action: 'Action', state: 'Status' },
    decisionColumns: { seq: 'No.', disposition: 'Decision', quantity: 'Quantity', state: 'Status', followUp: 'Follow-up' },
    stages: { OPEN: 'Open', CONTAINED: 'Contained', DECIDED: 'Decided', CLOSED: 'Closed', CANCELLED: 'Cancelled' } as Record<string, string>,
    foundAt: { INCOMING: 'At goods in', STOCK: 'In stock', CUTTING: 'At cutting', IN_LINE: 'In line', FINAL: 'At final inspection', PACKING: 'At packing', CUSTOMER: 'By the customer', AUDIT: 'At an audit' } as Record<string, string>,
    containmentKind: { HOLD_STOCK: 'Goods put on hold', CHECK_WIP: 'Work in progress checked', CHECK_SHIPPED: 'Shipped goods checked', TELL_CUSTOMER: 'Customer told', OTHER: 'Other' } as Record<string, string>,
    status: { OPEN: 'Open', DONE: 'Done', CANCELLED: 'Cancelled' } as Record<string, string>,
    decisionState: { WAITING_APPROVAL: 'Waiting for approval', TO_CARRY_OUT: 'To carry out', DONE: 'Carried out' } as Record<string, string>,
    done: (on: string) => `done on ${on}`,
    page: (page: number, pages: number) => `Page ${page} of ${pages}`,
    file: 'NCR-report',
  },
} as const

const paragraphs = (text: string | null): string[] => (text ? text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '') : [])

/** A zone's words in the language (a zone outside the map: its code). */
export const zoneWordsIn = (zone: string, language: DocumentLanguage): string => {
  const found = GARMENT_ZONES.find((entry) => entry.id === zone)
  return found ? (language === 'it' ? found.it : found.en) : zone
}

/** The NCR report as the PDF prints it: every word decided here. */
export function ncrReport(input: NcrReportInput): EightDReport {
  const w = WORDS[input.language]
  const day = (date: BusinessDate) => formatDate(date, input.language)
  const amount = (value: string) => `${formatDecimal(value, input.language, 0, 4)} ${input.uom}`
  const style = [input.style, input.colourway, input.size ? `${w.size} ${input.size}` : null].filter(Boolean).join(' · ')
  const facts = [
    { label: w.number, value: input.number },
    { label: w.subject, value: input.title },
    { label: w.stage, value: w.stages[input.stage] ?? input.stage },
    { label: w.severity, value: classWordsIn(input.severity, input.language) },
    { label: w.found, value: w.at(w.foundAt[input.foundAt] ?? input.foundAt, day(input.foundOn)) },
    ...(input.source ? [{ label: w.source, value: input.source }] : []),
    ...(style ? [{ label: w.style, value: style }] : []),
    ...(input.serial ? [{ label: w.serial, value: input.serial }] : []),
    ...(input.lot ? [{ label: w.lot, value: input.lot }] : []),
    ...(input.supplier ? [{ label: w.supplier, value: input.supplier }] : []),
    ...(input.workOrder ? [{ label: w.workOrder, value: input.workOrder }] : []),
    { label: w.quantity, value: amount(input.quantityAffected) },
    ...(input.quantitySuspect ? [{ label: w.suspect, value: amount(input.quantitySuspect) }] : []),
    ...(input.defect ? [{ label: w.defect, value: input.defect }] : []),
    ...(input.zone ? [{ label: w.zone, value: zoneWordsIn(input.zone, input.language) }] : []),
    ...(input.cause ? [{ label: w.cause, value: input.cause }] : []),
    ...(input.capa ? [{ label: w.capa, value: input.capa }] : []),
    ...(input.owner ? [{ label: w.owner, value: input.owner }] : []),
    { label: w.reportDate, value: day(input.date) },
  ]

  const containment: EightDTable | null =
    input.containment.length === 0
      ? null
      : {
          columns: [
            { label: w.containmentColumns.action, width: 0.72, align: 'left' },
            { label: w.containmentColumns.state, width: 0.28, align: 'left' },
          ],
          rows: input.containment.map((action) => [
            `${w.containmentKind[action.kind] ?? action.kind}${action.description?.trim() ? `: ${action.description.trim()}` : ''}`,
            action.status === 'DONE' && action.doneOn ? w.done(day(action.doneOn)) : (w.status[action.status] ?? action.status),
          ]),
        }
  const decisions: EightDTable | null =
    input.decisions.length === 0
      ? null
      : {
          columns: [
            { label: w.decisionColumns.seq, width: 0.07, align: 'right' },
            { label: w.decisionColumns.disposition, width: 0.3, align: 'left' },
            { label: w.decisionColumns.quantity, width: 0.16, align: 'right' },
            { label: w.decisionColumns.state, width: 0.22, align: 'left' },
            { label: w.decisionColumns.followUp, width: 0.25, align: 'left' },
          ],
          rows: input.decisions.map((decision) => [String(decision.seq), decision.disposition, amount(decision.quantity), w.decisionState[decision.state] ?? decision.state, decision.followUp ?? '-']),
        }
  const closure =
    input.stage === 'CLOSED' && input.closedOn ? [w.closed(day(input.closedOn)), ...paragraphs(input.closeNote)] : input.stage === 'CANCELLED' ? [w.cancelled(input.cancelReason ?? '-')] : [w.open]

  const description = paragraphs(input.description)
  const sections: EightDSection[] = [
    { heading: w.s1, lines: description.length === 0 ? [w.notStated] : description, table: null },
    { heading: w.s2, lines: containment ? [] : [w.noContainment], table: containment },
    { heading: w.s3, lines: decisions ? [] : [w.noDecision], table: decisions },
    { heading: w.s4, lines: closure, table: null },
  ]

  return {
    language: input.language,
    meta: { title: `${w.title} ${input.number}`, subject: input.title, createdAt: `${input.date}T00:00:00.000Z` },
    title: w.title,
    sample: input.sample ? w.sample : null,
    company: input.company,
    facts,
    sections,
    page: w.page,
    fileName: `${w.file}-${input.number}-${input.language}.pdf`,
  }
}

/** The text the version fingerprint is taken of: everything the report says but its date and the preview banner. */
export function ncrReportFingerprintText(report: EightDReport): string {
  return JSON.stringify({ language: report.language, title: report.title, company: report.company, facts: report.facts.slice(0, -1), sections: report.sections })
}
