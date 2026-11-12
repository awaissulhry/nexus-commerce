import PDFDocument from 'pdfkit'
import { ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { legalFooter, legalLines, legalName } from '@nexus/factory-domain/documents/legal'
import { INVENTORY_TRACE_REPORT } from '@nexus/factory-domain/inventory/lots-depth/permissions'
import {
  composeTraceReport,
  requestProblems,
  traceReportCsv,
  type ReportNode,
  type ReportTrace,
  type TraceReport,
  type TraceReportAudience,
  type TraceReportFormat,
  type TraceReportLanguage,
} from '@nexus/factory-domain/inventory/lots-depth/trace-report'
import { INVENTORY_STOCK_VIEW } from '@nexus/factory-domain/inventory/permissions'
import { TRACE_NODE_KINDS, type TraceDirection, type TraceStartKind } from '@nexus/factory-domain/inventory/trace/rules'
import { command, type CommandCaller } from '../../../core/command'
import { serverClock, type Clock } from '../../../core/time'
import { companyLegalOf } from '../../../platform/documents/documents'
import { PDF_CREATOR, winAnsi } from '../../../platform/documents/pdf'
import { putGeneratedFile, recordGeneratedFile } from '../../../platform/files/files'
import { processFiles } from '../../../platform/files/service'
import { mayAt, officeContextOf } from '../ledger/access'
import { readStart, type StartRecord } from './load'
import { traceFrom } from './trace'

/**
 * The dated trace report (B-W2b-313; SCM-242; design warehouse.lots lt-report "direction · as of date · for (customer /
 * notified body / authority) · PDF or CSV", "Create report (opens in a new tab)", tab lt-tab-report; Reg. (EU) 2016/425
 * art. 8-10). Office, inventory.trace.report on the start's company and site (and inventory.stock.view, the trace's own).
 *
 *   POST /inventory/trace/report    {kind, id, direction, audience, recipient, reference?, requestedOn, asOf?, format,
 *                                   language, note?}: B-W2a-27's trace of the start as the caller may see it (parties'
 *                                   names only with parties.view), with the lots split from a lot and the hides a hide
 *                                   became (B-W2b-313's splits: the W2a trace does not follow them yet), composed by
 *                                   factory-domain inventory/lots-depth trace-report.ts, painted as an A4 PDF (pdfkit,
 *                                   the documents platform's fonts) or written as CSV, put in the file store (outside any
 *                                   transaction), then ONE command records the file (a DOCUMENT of the record traced,
 *                                   office only, kept ten years: the evidence of what was answered), the audit row
 *                                   `inventory.traceReport` on the record (what was asked, by whom, when; the counts) and
 *                                   `lot.trace_report_made`. The answer names the file: the screen opens GET
 *                                   /files/:fileId/download in a new tab.
 *   GET  /inventory/trace/reports?kind=&id=   the reports made for a record, newest first (inventory.stock.view).
 */

let clock: Clock = serverClock
/** Test only: the report's clock (default the server clock). */
export function useTraceReportClock(next: Clock | undefined): void {
  clock = next ?? serverClock
}

/** The model a start kind's record is (the report's file belongs to it). */
export const RECORD_TYPE_OF: Readonly<Record<TraceStartKind, string>> = Object.freeze({ LOT: 'Lot', HIDE: 'Hide', BUNDLE: 'Bundle', WORK_ORDER: 'WorkOrder', SERIAL: 'GarmentSerial', SHIPMENT: 'Shipment' })
const LABEL: Readonly<Record<TraceStartKind, string>> = { LOT: 'Lot', HIDE: 'Hide', BUNDLE: 'Bundle', WORK_ORDER: 'Work order', SERIAL: 'Serial', SHIPMENT: 'Shipment' }
/** Ten years (Reg. (EU) 2016/425 art. 8(3), 10(3)): the answer given is kept as long as the PPE's documentation. */
const RETENTION_YEARS = 10
const MAX_HOPS = 10

export interface TraceReportBody {
  readonly kind: TraceStartKind
  readonly id: string
  readonly direction: TraceDirection
  readonly audience: TraceReportAudience
  readonly recipient: string
  readonly reference?: string | null | undefined
  readonly requestedOn: BusinessDate
  readonly asOf?: BusinessDate | null | undefined
  readonly format: TraceReportFormat
  readonly language: TraceReportLanguage
  readonly note?: string | null | undefined
}

type Trace = Awaited<ReturnType<typeof traceFrom>>
interface Include {
  readonly kind: TraceStartKind
  readonly id: string
  readonly code: string
  /** The node it hangs under, and the link. */
  readonly from: string
  readonly link: 'LOT_SPLIT' | 'HIDE_RELOTTED'
}

/** What the start became through the splits: the lots split from a lot, the hides a hide became (audit links, in order). */
async function includesOf(caller: CommandCaller, start: StartRecord): Promise<Include[]> {
  return caller.withClient(async (client) => {
    if (start.kind === 'LOT') {
      const children = await client.lot.findMany({ where: { parentLotId: start.id }, select: { id: true, code: true }, orderBy: [{ code: 'asc' }, { id: 'asc' }] })
      return children.map((child) => ({ kind: 'LOT' as const, id: child.id, code: child.code, from: `LOT:${start.id}`, link: 'LOT_SPLIT' as const }))
    }
    if (start.kind !== 'HIDE') return []
    const found: Include[] = []
    let current = start.id
    for (let hop = 0; hop < MAX_HOPS; hop++) {
      const row = await client.auditLog.findFirst({ where: { recordType: 'Hide', recordId: current, action: 'inventory.hideRelotted' }, orderBy: [{ at: 'desc' }, { id: 'desc' }], select: { before: true, after: true } })
      const before = (row?.before ?? {}) as { hideId?: string }
      const after = (row?.after ?? {}) as { hideId?: string; code?: string }
      if (!row || before.hideId !== current || !after.hideId || !isUuid(after.hideId)) break
      found.push({ kind: 'HIDE', id: after.hideId, code: after.code ?? after.hideId, from: `HIDE:${current}`, link: 'HIDE_RELOTTED' })
      current = after.hideId
    }
    return found
  })
}

/** The traces of the start and of what it became, as one: nodes once (EXACT wins), edges once, levels and counts again. */
export function mergeTraces(main: Trace, others: readonly { readonly include: Include; readonly trace: Trace | null }[]): ReportTrace {
  type Node = Trace['nodes'][number]
  const nodes = new Map<string, Node & { sides: string[] }>()
  const add = (node: Node) => {
    const seen = nodes.get(node.key)
    if (!seen) nodes.set(node.key, { ...node, sides: [...node.sides] })
    else nodes.set(node.key, { ...seen, reach: seen.reach === 'EXACT' || node.reach === 'EXACT' ? 'EXACT' : 'POSSIBLE', sides: [...new Set([...seen.sides, ...node.sides])] })
  }
  const edges = new Map<string, { from: string; to: string; link: string }>()
  const edge = (from: string, to: string, link: string) => edges.set(`${from}|${to}|${link}`, { from, to, link })
  const gaps = new Map<string, Trace['gaps'][number]>()
  const restricted = new Map<string, number>()
  for (const trace of [main, ...others.map((other) => other.trace).filter((trace): trace is Trace => trace !== null)]) {
    for (const node of trace.nodes) add(node)
    for (const entry of trace.edges) edge(entry.from, entry.to, entry.link)
    for (const gap of trace.gaps) gaps.set(`${gap.code}|${gap.at}`, gap)
    for (const entry of trace.restricted) restricted.set(entry.permission, (restricted.get(entry.permission) ?? 0) + entry.nodes)
  }
  for (const { include } of others) {
    const key = `${include.kind}:${include.id}`
    if (nodes.has(key)) edge(include.from, key, include.link)
  }
  const list = [...nodes.values()]
  const levels = TRACE_NODE_KINDS.map((kind) => ({ kind, exact: list.filter((node) => node.kind === kind && node.reach === 'EXACT').length, possible: list.filter((node) => node.kind === kind && node.reach === 'POSSIBLE').length })).filter((level) => level.exact + level.possible > 0)
  const customers = list.filter((node) => node.kind === 'CUSTOMER' && (node as { received?: boolean }).received === true)
  return {
    start: main.start,
    direction: main.direction,
    asOf: main.asOf,
    nodes: list as unknown as ReportNode[],
    edges: [...edges.values()],
    levels,
    gaps: [...gaps.values()],
    customersReceived: { exact: customers.filter((node) => node.reach === 'EXACT').length, possible: customers.filter((node) => node.reach === 'POSSIBLE').length },
    restricted: [...restricted].map(([permission, count]) => ({ permission, nodes: count })).sort((a, b) => a.permission.localeCompare(b.permission)),
  }
}

// ---- the PDF -------------------------------------------------------------------------------------------------------------

const REGULAR = 'Helvetica'
const BOLD = 'Helvetica-Bold'
const TEXT = '#111111'
const MUTED = '#555555'
const RULE = '#9a9a9a'
const SHADE = '#ececec'
const MARGIN = { top: 40, bottom: 60, left: 42, right: 42 } as const
const FOOTER_TOP = 50

/** The report's PDF on A4 (the same report gives the same bytes). */
export async function renderTraceReport(report: TraceReport, madeAt: Date): Promise<Buffer> {
  const pdf = new PDFDocument({
    size: 'A4',
    margins: MARGIN,
    bufferPages: true,
    compress: true,
    lang: report.language,
    displayTitle: true,
    info: { Title: winAnsi(report.title), Subject: winAnsi(report.title), Creator: PDF_CREATOR, Producer: PDF_CREATOR, CreationDate: madeAt },
  })
  const chunks: Buffer[] = []
  pdf.on('data', (chunk: Buffer) => chunks.push(chunk))
  const ended = new Promise<void>((resolve, reject) => {
    pdf.on('end', () => resolve())
    pdf.on('error', reject)
  })
  paint(pdf, report)
  pdf.end()
  await ended
  return Buffer.concat(chunks)
}

function paint(pdf: PDFKit.PDFDocument, report: TraceReport): void {
  const left = MARGIN.left
  const right = pdf.page.width - MARGIN.right
  const width = right - left
  const bottom = (): number => pdf.page.height - MARGIN.bottom
  const text = (value: string, x: number, y: number, options: PDFKit.Mixins.TextOptions & { font?: string; size?: number; color?: string } = {}): number => {
    const { font = REGULAR, size = 9, color = TEXT, ...rest } = options
    pdf.font(font).fontSize(size).fillColor(color).text(winAnsi(value), x, y, { lineGap: 1, ...rest })
    return pdf.y
  }
  const heightOf = (value: string, w: number, font = REGULAR, size = 9): number => pdf.font(font).fontSize(size).heightOfString(winAnsi(value), { width: w, lineGap: 1 })
  const newPage = (): number => {
    pdf.addPage()
    return text(`${report.company.name} · ${report.title}`, left, MARGIN.top, { size: 8, color: MUTED, width }) + 8
  }

  // Our company and its art. 2250 lines; the title on the right.
  const companyWidth = Math.round(width * 0.55)
  let y: number = MARGIN.top
  y = text(report.company.name, left, y, { font: BOLD, size: 12, width: companyWidth })
  for (const line of report.company.lines) y = text(line, left, y + 0.5, { size: 7.5, color: MUTED, width: companyWidth })
  const titleLeft = left + companyWidth + 12
  const titleY = text(report.title, titleLeft, MARGIN.top, { font: BOLD, size: 13, width: right - titleLeft, align: 'right' })
  y = Math.max(y, titleY) + 12

  // What was asked and when.
  const labelWidth = width * 0.22
  for (const fact of report.facts) {
    const height = Math.max(heightOf(fact.label, labelWidth, REGULAR, 8), heightOf(fact.value, width - labelWidth - 8, BOLD, 9))
    if (y + height > bottom()) y = newPage()
    text(fact.label, left, y, { size: 8, color: MUTED, width: labelWidth })
    text(fact.value, left + labelWidth + 8, y, { font: BOLD, size: 9, width: width - labelWidth - 8 })
    y += height + 3
  }
  y += 6
  for (const line of report.summary) y = text(line, left, y, { size: 9, width }) + 2
  y += 8

  const columns = report.columns.map((column) => ({ ...column, width: width * column.width }))
  const header = (at: number): number => {
    const height = Math.max(...columns.map((column) => heightOf(column.label, column.width - 6, BOLD, 8))) + 6
    pdf.save().rect(left, at, width, height).fillColor(SHADE).fill().restore()
    let x = left
    for (const column of columns) {
      text(column.label, x + 3, at + 3, { font: BOLD, size: 8, width: column.width - 6, align: column.align })
      x += column.width
    }
    return at + height
  }
  if (y + 40 > bottom()) y = newPage()
  y = header(y)
  for (const row of report.rows) {
    const height = Math.max(...columns.map((column) => heightOf(row[column.key], column.width - 6, REGULAR, 8))) + 6
    if (y + height > bottom()) y = header(newPage())
    let x = left
    for (const column of columns) {
      text(row[column.key], x + 3, y + 3, { size: 8, width: column.width - 6, align: column.align })
      x += column.width
    }
    y += height
    pdf.save().moveTo(left, y).lineTo(right, y).lineWidth(0.4).strokeColor(RULE).stroke().restore()
  }
  y += 12
  if (y + 30 > bottom()) y = newPage()
  y = text(report.gapsTitle, left, y, { font: BOLD, size: 9, width }) + 2
  for (const gap of report.gaps) {
    if (y + heightOf(gap, width, REGULAR, 8.5) > bottom()) y = newPage()
    y = text(`· ${gap}`, left, y, { size: 8.5, width }) + 1
  }
  y += 10
  if (y + heightOf(report.closing, width, REGULAR, 8.5) > bottom()) y = newPage()
  text(report.closing, left, y, { size: 8.5, color: MUTED, width })

  const range = pdf.bufferedPageRange()
  for (let index = range.start; index < range.start + range.count; index++) {
    pdf.switchToPage(index)
    const savedBottom = pdf.page.margins.bottom
    pdf.page.margins.bottom = 0
    const top = pdf.page.height - FOOTER_TOP
    pdf.save().moveTo(left, top).lineTo(right, top).lineWidth(0.4).strokeColor(RULE).stroke().restore()
    text(report.company.legal, left, top + 4, { size: 6.5, color: MUTED, width: width - 90 })
    text(report.page(index - range.start + 1, range.count), right - 86, top + 4, { size: 7.5, color: MUTED, width: 86, align: 'right' })
    pdf.page.margins.bottom = savedBottom
  }
}

// ---- the routes' work --------------------------------------------------------------------------------------------------

/** The start as the caller may report it: seen with inventory.stock.view (else not found), reported with inventory.trace.report. */
async function startFor(caller: CommandCaller, kind: TraceStartKind, id: string): Promise<StartRecord> {
  const context = officeContextOf(caller)
  const start = isUuid(id) ? await caller.withClient((client) => readStart(client, kind, id)) : null
  if (!start || !mayAt(context, INVENTORY_STOCK_VIEW, start)) throw new NotFoundError(`${LABEL[kind]} not found.`)
  return start
}

/** POST /inventory/trace/report. */
export async function makeTraceReport(caller: CommandCaller, body: TraceReportBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const start = await startFor(caller, body.kind, body.id)
  if (!mayAt(context, INVENTORY_TRACE_REPORT, start)) throw new ForbiddenError()
  const madeAt = clock.now()
  const today = businessDate(madeAt)
  const problems = requestProblems(body, today)
  if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'The report is not valid.', problems.map((problem) => ({ ...problem, path: `body/${problem.path}` })))
  const asOf = body.asOf ?? today

  // The trace as the caller may see it, and what the start became through splits.
  const main = await traceFrom(caller, { kind: body.kind, id: body.id, direction: body.direction })
  const includes = await includesOf(caller, start)
  const others = await Promise.all(
    includes.map(async (include) => {
      try {
        return { include, trace: await traceFrom(caller, { kind: include.kind, id: include.id, direction: body.direction }) }
      } catch (error) {
        // A part at a site the caller may not see is left out of the merge (its node, if any, stays restricted).
        if (error instanceof NotFoundError) return { include, trace: null }
        throw error
      }
    }),
  )
  const trace = mergeTraces(main, others)
  const company = await companyLegalOf(caller, start.companyId)
  const madeBy = await caller.withClient(async (client) => (await client.user.findUnique({ where: { id: context.actorId }, select: { displayName: true } }))?.displayName ?? '—')
  const report = composeTraceReport(trace, { ...body, asOf }, { language: body.language, company: { name: legalName(company, body.language), lines: legalLines(company, body.language), legal: legalFooter(company, body.language) }, madeAt, madeBy }, body.format)
  const bytes = body.format === 'PDF' ? await renderTraceReport(report, madeAt) : Buffer.from(traceReportCsv(report), 'utf8')
  const recordType = RECORD_TYPE_OF[start.kind]
  const retainUntil = new Date(madeAt)
  retainUntil.setUTCFullYear(retainUntil.getUTCFullYear() + RETENTION_YEARS)
  const prepared = await putGeneratedFile(processFiles(), caller, {
    companyId: start.companyId,
    recordType,
    recordId: start.id,
    kind: 'DOCUMENT',
    originalName: report.fileName,
    contentType: body.format === 'PDF' ? 'application/pdf' : 'text/csv',
    body: bytes,
    visibility: ['OFFICE'],
    retainUntil,
  })
  const asked = {
    audience: body.audience,
    recipient: body.recipient.trim(),
    reference: body.reference?.trim() || null,
    requestedOn: body.requestedOn,
    asOf,
    direction: body.direction,
    format: body.format,
    language: body.language,
    note: body.note?.trim() || null,
  }
  const { result } = await command(caller, { name: 'inventory.traceReport', idempotencyKey, input: body }, async (tools) => {
    const file = await recordGeneratedFile(tools, prepared, { details: { documentType: 'TRACE_REPORT', number: start.code, language: body.language } })
    tools.audit({
      action: 'inventory.traceReport',
      recordType,
      recordId: start.id,
      companyId: start.companyId,
      siteId: start.siteId,
      after: { ...asked, fileId: file.id, startCode: start.code, madeAt: toUtcIso(madeAt), includes: includes.map((include) => ({ kind: include.kind, id: include.id, code: include.code })), counts: report.counts },
    })
    tools.emit({
      type: 'lot.trace_report_made',
      subject: start.id,
      companyId: start.companyId,
      siteId: start.siteId,
      payload: { recordType, recordId: start.id, fileId: file.id, audience: body.audience, format: body.format, direction: body.direction, asOf, nodes: report.counts.nodes },
    })
    return {
      report: { recordType, recordId: start.id, start: { kind: start.kind, id: start.id, code: start.code }, madeAt: toUtcIso(madeAt), asOf, format: body.format, includes: includes.map((include) => ({ kind: include.kind, id: include.id, code: include.code })), counts: report.counts },
      file: { id: file.id, name: prepared.originalName, contentType: prepared.contentType, sizeBytes: prepared.sizeBytes },
    }
  })
  return result
}

/** GET /inventory/trace/reports?kind=&id=: the reports made for a record, newest first (what was asked, when, by whom). */
export async function listTraceReports(caller: CommandCaller, query: { readonly kind: TraceStartKind; readonly id: string }) {
  const start = await startFor(caller, query.kind, query.id)
  return caller.withClient(async (client) => {
    const rows = await client.auditLog.findMany({
      where: { recordType: RECORD_TYPE_OF[start.kind], recordId: start.id, action: 'inventory.traceReport' },
      orderBy: [{ at: 'desc' }, { id: 'desc' }],
      select: { at: true, actorId: true, after: true },
      take: 100,
    })
    const people = new Map((await client.user.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.actorId))] } }, select: { id: true, displayName: true } })).map((row) => [row.id, row.displayName]))
    return {
      reports: rows.map((row) => {
        const after = (row.after ?? {}) as Record<string, string | null>
        return {
          at: toUtcIso(row.at),
          madeBy: people.has(row.actorId) ? { id: row.actorId, name: people.get(row.actorId)! } : null,
          fileId: after.fileId && isUuid(after.fileId) ? after.fileId : null,
          audience: after.audience as TraceReportAudience,
          recipient: after.recipient ?? '',
          reference: after.reference ?? null,
          requestedOn: after.requestedOn as BusinessDate,
          asOf: after.asOf as BusinessDate,
          direction: after.direction as TraceDirection,
          format: after.format as TraceReportFormat,
        }
      }),
    }
  })
}
