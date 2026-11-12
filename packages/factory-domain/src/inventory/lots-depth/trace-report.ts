import type { Issue } from '../../core/errors'
import { businessDate, isBusinessDate, type BusinessDate } from '../../core/time'
import { csvText } from '../../views/exports'

/**
 * The dated trace report (B-W2b-313; SCM-242 "Export a dated trace report (PDF or CSV) for a customer, notified body or
 * authority"; design warehouse.lots lt-report "direction (backward / forward / both) · as of date · for (customer / notified
 * body / authority) · PDF or CSV", tab lt-tab-report "a dated document handed to an authority or a customer"; Reg. (EU)
 * 2016/425 art. 8-10: who supplied the goods and to whom). Pure: it composes the words, the facts and the rows from the
 * trace the API read (B-W2a-27's GET /inventory/trace answer) and the request; the API paints the PDF and stores the file.
 *
 * What was asked and when: who asked (for whom: a customer, a notified body, an authority; their name and reference), the
 * day they asked, what (the start's kind and code, the direction) and the day the answer speaks for (as of); when it was
 * made and by whom. The trace is read when the report is made; a shipment that left after the day asked is listed but not
 * counted as reaching its customer by that day (the ledger keeps when each shipment left). POSSIBLE rows are the ones the
 * records know only for a whole work order or size: a recall counts them too.
 */

export const TRACE_REPORT_AUDIENCES = ['CUSTOMER', 'NOTIFIED_BODY', 'AUTHORITY'] as const
export type TraceReportAudience = (typeof TRACE_REPORT_AUDIENCES)[number]

export const TRACE_REPORT_FORMATS = ['PDF', 'CSV'] as const
export type TraceReportFormat = (typeof TRACE_REPORT_FORMATS)[number]

export const TRACE_REPORT_LANGUAGES = ['it', 'en'] as const
export type TraceReportLanguage = (typeof TRACE_REPORT_LANGUAGES)[number]

export const TRACE_REPORT_LIMITS = Object.freeze({ recipient: 200, reference: 100, note: 1000 })

/** The request as the person typed it. */
export interface TraceReportRequest {
  readonly audience: TraceReportAudience
  readonly recipient: string
  readonly reference?: string | null | undefined
  /** The day they asked. */
  readonly requestedOn: BusinessDate
  /** The day the answer speaks for (default today). */
  readonly asOf?: BusinessDate | null | undefined
  readonly note?: string | null | undefined
}

/** Why the request is not valid (at `body/<field>`), against today (Europe/Rome). */
export function requestProblems(request: TraceReportRequest, today: BusinessDate): Issue[] {
  const problems: Issue[] = []
  const recipient = request.recipient.trim()
  if (recipient === '') problems.push({ path: 'recipient', message: 'Name who asked: the customer, the notified body or the authority.' })
  if (recipient.length > TRACE_REPORT_LIMITS.recipient) problems.push({ path: 'recipient', message: `At most ${TRACE_REPORT_LIMITS.recipient} characters.` })
  if ((request.reference?.trim().length ?? 0) > TRACE_REPORT_LIMITS.reference) problems.push({ path: 'reference', message: `At most ${TRACE_REPORT_LIMITS.reference} characters.` })
  if ((request.note?.trim().length ?? 0) > TRACE_REPORT_LIMITS.note) problems.push({ path: 'note', message: `At most ${TRACE_REPORT_LIMITS.note} characters.` })
  if (!isBusinessDate(request.requestedOn)) problems.push({ path: 'requestedOn', message: 'The day they asked, as YYYY-MM-DD.' })
  else if (request.requestedOn > today) problems.push({ path: 'requestedOn', message: `The day they asked is not after today (${today}).` })
  const asOf = request.asOf ?? today
  if (!isBusinessDate(asOf)) problems.push({ path: 'asOf', message: 'The day the report speaks for, as YYYY-MM-DD.' })
  else if (asOf > today) problems.push({ path: 'asOf', message: `The report speaks for today (${today}) or an earlier day, never a later one.` })
  return problems
}

// ---- the trace as the API answered it (the parts the report prints) --------------------------------------------------------

export interface ReportNode {
  readonly key: string
  readonly kind: string
  readonly id: string
  readonly code: string | null
  readonly reach: 'EXACT' | 'POSSIBLE'
  readonly sides: readonly string[]
  readonly restricted: readonly string[]
  readonly holds: readonly { readonly reasonCode: string; readonly placedAt: string }[]
  readonly party?: { readonly code: string; readonly name: string } | null
  readonly lot?: { readonly qualityStatus?: string; readonly item?: { readonly code: string; readonly name: string }; readonly colourCode?: string | null; readonly supplierLotRef?: string | null; readonly dyeBatch?: string | null; readonly receivedAt?: string | null } | undefined
  readonly hide?: { readonly state?: string } | undefined
  readonly receipt?: { readonly receivedAt?: string; readonly supplierDdtNumber?: string | null; readonly supplierDdtDate?: string | null } | undefined
  readonly workOrder?: { readonly batchNumber?: string | null; readonly styleCode?: string; readonly status?: string } | undefined
  readonly shipment?: { readonly status?: string; readonly shippedAt?: string | null; readonly deliveredAt?: string | null; readonly ddtNumbers?: readonly string[]; readonly left?: boolean } | undefined
  readonly serial?: { readonly status?: string } | undefined
  readonly received?: boolean
}

export interface ReportEdge {
  readonly from: string
  readonly to: string
  readonly link: string
}

export interface ReportTrace {
  readonly start: { readonly key: string; readonly kind: string; readonly id: string; readonly code: string }
  readonly direction: 'BACKWARD' | 'FORWARD' | 'BOTH'
  readonly asOf: string
  readonly nodes: readonly ReportNode[]
  readonly edges: readonly ReportEdge[]
  readonly levels: readonly { readonly kind: string; readonly exact: number; readonly possible: number }[]
  readonly gaps: readonly { readonly code: string; readonly severity: string; readonly count: number; readonly message: string }[]
  readonly customersReceived: { readonly exact: number; readonly possible: number }
  readonly restricted: readonly { readonly permission: string; readonly nodes: number }[]
}

export interface ReportCompany {
  readonly name: string
  readonly lines: readonly string[]
  readonly legal: string
}

export interface ReportContext {
  readonly language: TraceReportLanguage
  readonly company: ReportCompany
  /** When it was made (the command's time) and by whom (the office user's name). */
  readonly madeAt: Date
  readonly madeBy: string
}

const WORDS = {
  it: {
    title: 'Rapporto di tracciabilità',
    for: { CUSTOMER: 'Cliente', NOTIFIED_BODY: 'Organismo notificato', AUTHORITY: 'Autorità' },
    direction: { BACKWARD: 'All’indietro (fino al fornitore)', FORWARD: 'In avanti (fino al cliente)', BOTH: 'In entrambe le direzioni' },
    facts: { recipient: 'Richiesto da', audience: 'Per', reference: 'Riferimento', requestedOn: 'Richiesto il', start: 'Oggetto', direction: 'Direzione', asOf: 'Situazione al', madeAt: 'Redatto il', madeBy: 'Redatto da', note: 'Nota' },
    kinds: { SUPPLIER: 'Fornitore', RECEIPT: 'Ricevimento', LOT: 'Lotto', HIDE: 'Pelle', SUBCONTRACT: 'Conto lavoro', WORK_ORDER: 'Ordine di produzione', CELL: 'Taglia', BUNDLE: 'Fascio', SERIAL: 'Matricola', SHIPMENT: 'Spedizione', CUSTOMER: 'Cliente' } as Record<string, string>,
    reach: { EXACT: 'Certo', POSSIBLE: 'Possibile' },
    side: { BACKWARD: 'Indietro', FORWARD: 'Avanti', START: 'Partenza' } as Record<string, string>,
    columns: { level: 'Livello', code: 'Codice', reach: 'Collegamento', side: 'Lato', details: 'Dettagli', byAsOf: 'Entro la data' },
    yes: 'sì',
    no: 'no',
    hidden: 'non visibile a chi ha redatto il rapporto',
    held: 'bloccato',
    summary: (levels: string, exact: number, possible: number) => `Livelli: ${levels}. Clienti raggiunti: ${exact} certi, ${possible} possibili.`,
    byAsOf: (day: string, exact: number, possible: number) => `Clienti raggiunti entro il ${day}: ${exact} certi, ${possible} possibili.`,
    gaps: 'Lacune dei dati',
    noGaps: 'Nessuna lacuna nei dati registrati.',
    restricted: (count: number) => `${count} voci non sono mostrate a chi ha redatto il rapporto (permessi).`,
    closing: (made: string) =>
      `Dati letti dal sistema il ${made}. "Certo": un collegamento registrato; "Possibile": i dati lo collegano solo all’intero ordine di produzione o alla taglia; un richiamo considera entrambi.`,
    page: (n: number, of: number) => `Pagina ${n} di ${of}`,
    start: (kind: string, code: string) => `${kind} ${code}`,
    shipped: 'spedita',
    delivered: 'consegnata',
    ddt: 'DDT',
    received: 'ricevuto',
    lotQuality: 'qualità',
    batch: 'lotto di produzione',
    style: 'modello',
    supplierLot: 'lotto fornitore',
    dyeBatch: 'bagno',
  },
  en: {
    title: 'Trace report',
    for: { CUSTOMER: 'Customer', NOTIFIED_BODY: 'Notified body', AUTHORITY: 'Authority' },
    direction: { BACKWARD: 'Backward (to the supplier)', FORWARD: 'Forward (to the customer)', BOTH: 'Both ways' },
    facts: { recipient: 'Asked by', audience: 'For', reference: 'Reference', requestedOn: 'Asked on', start: 'Subject', direction: 'Direction', asOf: 'As of', madeAt: 'Made on', madeBy: 'Made by', note: 'Note' },
    kinds: { SUPPLIER: 'Supplier', RECEIPT: 'Receipt', LOT: 'Lot', HIDE: 'Hide', SUBCONTRACT: 'Subcontract', WORK_ORDER: 'Work order', CELL: 'Size', BUNDLE: 'Bundle', SERIAL: 'Serial', SHIPMENT: 'Shipment', CUSTOMER: 'Customer' } as Record<string, string>,
    reach: { EXACT: 'Exact', POSSIBLE: 'Possible' },
    side: { BACKWARD: 'Backward', FORWARD: 'Forward', START: 'Start' } as Record<string, string>,
    columns: { level: 'Level', code: 'Code', reach: 'Link', side: 'Side', details: 'Details', byAsOf: 'By the day' },
    yes: 'yes',
    no: 'no',
    hidden: 'not visible to the person who made the report',
    held: 'on hold',
    summary: (levels: string, exact: number, possible: number) => `Levels: ${levels}. Customers reached: ${exact} exact, ${possible} possible.`,
    byAsOf: (day: string, exact: number, possible: number) => `Customers reached by ${day}: ${exact} exact, ${possible} possible.`,
    gaps: 'Gaps in the records',
    noGaps: 'No gap in the recorded links.',
    restricted: (count: number) => `${count} entries are not shown to the person who made the report (permissions).`,
    closing: (made: string) =>
      `Records read on ${made}. "Exact": a recorded link; "Possible": the records link it only to the whole work order or size; a recall counts both.`,
    page: (n: number, of: number) => `Page ${n} of ${of}`,
    start: (kind: string, code: string) => `${kind} ${code}`,
    shipped: 'shipped',
    delivered: 'delivered',
    ddt: 'DDT',
    received: 'received',
    lotQuality: 'quality',
    batch: 'batch',
    style: 'style',
    supplierLot: 'supplier lot',
    dyeBatch: 'dye batch',
  },
} as const

export interface ReportRow {
  readonly level: string
  readonly code: string
  readonly reach: string
  readonly side: string
  readonly details: string
  /** Shipments and customers: reached by the day asked ("yes" / "no"); others empty. */
  readonly byAsOf: string
}

export interface TraceReport {
  readonly language: TraceReportLanguage
  readonly title: string
  readonly fileName: string
  readonly company: ReportCompany
  readonly facts: readonly { readonly label: string; readonly value: string }[]
  readonly summary: readonly string[]
  readonly columns: readonly { readonly key: keyof ReportRow; readonly label: string; readonly width: number; readonly align: 'left' | 'right' }[]
  readonly rows: readonly ReportRow[]
  readonly gapsTitle: string
  readonly gaps: readonly string[]
  readonly closing: string
  readonly page: (n: number, of: number) => string
  /** What the audit row and the event record (no person, no party name). */
  readonly counts: { readonly nodes: number; readonly customersExact: number; readonly customersPossible: number; readonly customersByAsOfExact: number; readonly customersByAsOfPossible: number; readonly gaps: number }
}

/** "12/11/2026 10:42" in Rome time (it) or "2026-11-12 10:42" (en). */
function stamp(at: Date, language: TraceReportLanguage): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  ) as Record<string, string>
  return language === 'it' ? `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}` : `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`
}

const day = (value: BusinessDate, language: TraceReportLanguage): string => (language === 'it' ? `${value.slice(8, 10)}/${value.slice(5, 7)}/${value.slice(0, 4)}` : value)
const dayOf = (iso: string | null | undefined): BusinessDate | null => (iso ? businessDate(new Date(iso)) : null)

/** The shipments that left by the end of the day asked, and the customers they reached. */
function reachedBy(trace: ReportTrace, asOf: BusinessDate): { readonly shipments: Set<string>; readonly customers: Set<string> } {
  const nodes = new Map(trace.nodes.map((node) => [node.key, node]))
  const shipments = new Set(
    trace.nodes
      .filter((node) => node.kind === 'SHIPMENT' && node.shipment?.left === true)
      .filter((node) => {
        const left = dayOf(node.shipment?.shippedAt ?? null)
        return left !== null && left <= asOf
      })
      .map((node) => node.key),
  )
  const customers = new Set(trace.edges.filter((edge) => shipments.has(edge.from) && nodes.get(edge.to)?.kind === 'CUSTOMER').map((edge) => edge.to))
  return { shipments, customers }
}

function detailsOf(node: ReportNode, words: (typeof WORDS)[TraceReportLanguage], language: TraceReportLanguage): string {
  if (node.restricted.length > 0) return words.hidden
  const parts: string[] = []
  switch (node.kind) {
    case 'SUPPLIER':
    case 'CUSTOMER':
      if (node.party) parts.push(node.party.name)
      if (node.kind === 'CUSTOMER' && node.received) parts.push(words.received)
      break
    case 'RECEIPT':
      if (node.receipt?.receivedAt) parts.push(day(dayOf(node.receipt.receivedAt)!, language))
      if (node.receipt?.supplierDdtNumber) parts.push(`${words.ddt} ${node.receipt.supplierDdtNumber}${node.receipt.supplierDdtDate ? ` ${day(node.receipt.supplierDdtDate, language)}` : ''}`)
      break
    case 'LOT':
      if (node.lot?.item) parts.push(`${node.lot.item.code} ${node.lot.item.name}${node.lot.colourCode ? ` ${node.lot.colourCode}` : ''}`)
      if (node.lot?.supplierLotRef) parts.push(`${words.supplierLot} ${node.lot.supplierLotRef}`)
      if (node.lot?.dyeBatch) parts.push(`${words.dyeBatch} ${node.lot.dyeBatch}`)
      if (node.lot?.qualityStatus) parts.push(`${words.lotQuality} ${node.lot.qualityStatus}`)
      break
    case 'HIDE':
      if (node.hide?.state) parts.push(node.hide.state)
      break
    case 'WORK_ORDER':
      if (node.workOrder?.batchNumber) parts.push(`${words.batch} ${node.workOrder.batchNumber}`)
      if (node.workOrder?.styleCode) parts.push(`${words.style} ${node.workOrder.styleCode}`)
      if (node.workOrder?.status) parts.push(node.workOrder.status)
      break
    case 'SHIPMENT':
      if (node.shipment?.shippedAt) parts.push(`${words.shipped} ${day(dayOf(node.shipment.shippedAt)!, language)}`)
      if (node.shipment?.deliveredAt) parts.push(`${words.delivered} ${day(dayOf(node.shipment.deliveredAt)!, language)}`)
      if (node.shipment?.ddtNumbers && node.shipment.ddtNumbers.length > 0) parts.push(`${words.ddt} ${node.shipment.ddtNumbers.join(', ')}`)
      if (node.shipment?.status) parts.push(node.shipment.status)
      break
    case 'SERIAL':
      if (node.serial?.status) parts.push(node.serial.status)
      break
  }
  if (node.holds.length > 0) parts.push(`${words.held} (${node.holds.map((hold) => hold.reasonCode).join(', ')})`)
  return parts.join(' · ')
}

/** The file's name: trace-report-<start code>-<day>.<pdf|csv>, letters, digits and hyphens only. */
export function reportFileName(startCode: string, madeOn: BusinessDate, format: TraceReportFormat): string {
  const slug = startCode.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'trace'
  return `trace-report-${slug}-${madeOn}.${format === 'PDF' ? 'pdf' : 'csv'}`
}

/** The report's words, facts and rows. */
export function composeTraceReport(trace: ReportTrace, request: TraceReportRequest, context: ReportContext, format: TraceReportFormat): TraceReport {
  const { language } = context
  const words = WORDS[language]
  const madeOn = businessDate(context.madeAt)
  const asOf = request.asOf ?? madeOn
  const reached = reachedBy(trace, asOf)
  const sideOf = (node: ReportNode): string => (node.key === trace.start.key ? (words.side.START ?? 'START') : node.sides.map((side) => words.side[side] ?? side).join(', '))
  const order = new Map(trace.levels.map((level, index) => [level.kind, index]))
  const rows: ReportRow[] = [...trace.nodes]
    .sort((a, b) => (order.get(a.kind) ?? 99) - (order.get(b.kind) ?? 99) || (a.code ?? '').localeCompare(b.code ?? '') || a.key.localeCompare(b.key))
    .map((node) => ({
      level: words.kinds[node.kind] ?? node.kind,
      code: node.code ?? '—',
      reach: words.reach[node.reach],
      side: sideOf(node),
      details: detailsOf(node, words, language),
      byAsOf: node.kind === 'SHIPMENT' || node.kind === 'CUSTOMER' ? (reached.shipments.has(node.key) || reached.customers.has(node.key) ? words.yes : words.no) : '',
    }))
  const customers = trace.nodes.filter((node) => node.kind === 'CUSTOMER' && reached.customers.has(node.key))
  const byAsOfExact = customers.filter((node) => node.reach === 'EXACT').length
  const startKind = words.kinds[trace.start.kind] ?? trace.start.kind
  const facts = [
    { label: words.facts.recipient, value: request.recipient.trim() },
    { label: words.facts.audience, value: words.for[request.audience] },
    ...(request.reference?.trim() ? [{ label: words.facts.reference, value: request.reference.trim() }] : []),
    { label: words.facts.requestedOn, value: day(request.requestedOn, language) },
    { label: words.facts.start, value: words.start(startKind, trace.start.code) },
    { label: words.facts.direction, value: words.direction[trace.direction] },
    { label: words.facts.asOf, value: day(asOf, language) },
    { label: words.facts.madeAt, value: stamp(context.madeAt, language) },
    { label: words.facts.madeBy, value: context.madeBy },
    ...(request.note?.trim() ? [{ label: words.facts.note, value: request.note.trim() }] : []),
  ]
  const levels = trace.levels.map((level) => `${words.kinds[level.kind] ?? level.kind} ${level.exact + level.possible}`).join(', ')
  const hiddenCount = trace.restricted.reduce((total, entry) => total + entry.nodes, 0)
  const summary = [
    words.summary(levels, trace.customersReceived.exact, trace.customersReceived.possible),
    words.byAsOf(day(asOf, language), byAsOfExact, customers.length - byAsOfExact),
    ...(hiddenCount > 0 ? [words.restricted(hiddenCount)] : []),
  ]
  return {
    language,
    title: `${words.title} · ${startKind} ${trace.start.code}`,
    fileName: reportFileName(trace.start.code, madeOn, format),
    company: context.company,
    facts,
    summary,
    columns: [
      { key: 'level', label: words.columns.level, width: 0.14, align: 'left' },
      { key: 'code', label: words.columns.code, width: 0.18, align: 'left' },
      { key: 'reach', label: words.columns.reach, width: 0.1, align: 'left' },
      { key: 'side', label: words.columns.side, width: 0.1, align: 'left' },
      { key: 'details', label: words.columns.details, width: 0.38, align: 'left' },
      { key: 'byAsOf', label: words.columns.byAsOf, width: 0.1, align: 'left' },
    ],
    rows,
    gapsTitle: words.gaps,
    gaps: trace.gaps.length > 0 ? trace.gaps.map((gap) => `${gap.severity} · ${gap.message}`) : [words.noGaps],
    closing: words.closing(stamp(context.madeAt, language)),
    page: words.page,
    counts: {
      nodes: trace.nodes.length,
      customersExact: trace.customersReceived.exact,
      customersPossible: trace.customersReceived.possible,
      customersByAsOfExact: byAsOfExact,
      customersByAsOfPossible: customers.length - byAsOfExact,
      gaps: trace.gaps.length,
    },
  }
}

/** The report as CSV: the request in the first line (what was asked and when), then one row per record. */
export function traceReportCsv(report: TraceReport): string {
  const note = [report.title, ...report.facts.map((fact) => `${fact.label}: ${fact.value}`), ...report.summary, `${report.gapsTitle}: ${report.gaps.join('; ')}`, report.closing].join(' | ')
  return csvText({ locale: report.language, note, header: report.columns.map((column) => column.label), rows: report.rows.map((row) => report.columns.map((column) => row[column.key])) })
}
