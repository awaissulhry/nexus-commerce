import PDFDocument from 'pdfkit'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { pageLabel } from '@nexus/factory-domain/documents/compose'
import { dispatchPaper, type DispatchPaper, type PaperFacts, type PaperLanguage, type PaperSection } from '@nexus/factory-domain/production/dispatch/paper'
import { PRODUCTION_DISPATCH_VIEW } from '@nexus/factory-domain/production/dispatch/permissions'
import type { CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { PDF_CREATOR, winAnsi } from '../../../platform/documents/pdf'
import { contextOf, may, readerOf } from './access'
import { sortCards } from './board'
import { lineMinutesOf, stationOperators } from './facts'
import { shiftLabelAt } from '@nexus/factory-domain/production/dispatch/handover'
import { lineRowOf, siteRowOf, stationOf, workerNames, type Reader } from './store'
import { dispatchWorld, dueOf, materialFlags, type DayCard, type DispatchWorld } from './world'

/**
 * The printed dispatch list (B-W2b-49; MES-032; design production.dispatch "Print dispatch list (primary)" and the new tab
 * "Dispatch list per station or line (print)": paper for the line at shift start), per line or station, for a day:
 *
 *   GET /production/dispatch/print/paper?lineId|stationId&date&language   what the paper says (the print window)
 *   GET /production/dispatch/print?lineId|stationId&date&language         the same as a PDF, A4 landscape, inline
 *
 * production.dispatch.view: the office over the site, the team leader's tablet at its own. Composed by factory-domain
 * production/dispatch/paper; made on request, stored nowhere. An operator's name stands beside their station only on the
 * office's copy and only where the site's floor records name workers, as on the board; no figure per person, no customer, no
 * money.
 */

export interface PrintQuery {
  readonly lineId?: string | undefined
  readonly stationId?: string | undefined
  readonly date?: BusinessDate | undefined
  readonly language?: PaperLanguage | undefined
}

async function paperFacts(caller: CommandCaller, query: PrintQuery): Promise<PaperFacts> {
  const context = contextOf(caller)
  if ((query.lineId ? 1 : 0) + (query.stationId ? 1 : 0) !== 1) throw new ValidationError('Name one line or one station.', [{ path: 'querystring', message: 'Give exactly one of lineId and stationId.' }])
  const now = serverClock.now()
  return readerOf(caller, context).withClient(async (db: Reader) => {
    const line = query.lineId ? await lineRowOf(db, query.lineId) : null
    const station = query.stationId ? await stationOf(db, query.stationId) : null
    const siteId = line?.siteId ?? station?.siteId
    const site = siteId ? await siteRowOf(db, siteId) : null
    if (!site || !may(context, PRODUCTION_DISPATCH_VIEW, { companyId: site.companyId, siteId: site.id })) throw new NotFoundError(query.lineId ? 'Line not found.' : 'Station not found.')
    const day = query.date ?? businessDate(now, site.timezone)
    const world = await dispatchWorld(db, site, day, now)
    const stations = station ? [station] : world.stations.filter((row) => row.lineId === line!.id)
    const flags = await materialFlags(db, site, world.cards.map((card) => card.workOrder.id))
    // The floor's copy names nobody (Owner answer F2: per station only calls, machine down and nobody signed in).
    const namesWorkers = world.subject === 'WORKER' && context.audience === 'office'
    const names = await workerNames(db, namesWorkers ? world.rows.map((row) => row.workerId) : [])
    const paperCard = (card: DayCard, index: number) => ({
      order: index + 1,
      rush: card.workOrder.rush,
      workOrder: card.workOrder.number,
      style: `${card.workOrder.style.code} ${card.workOrder.style.name}`,
      operation: { seq: card.operation.seq, name: card.operation.name },
      bundles: card.bundleIds.map((id) => world.bundles.get(id)?.code ?? ''),
      pieces: card.pieces,
      minutes: card.minutes,
      dueDate: dueOf(card),
      material: flags.of(card.workOrder.id, card.operation.id)?.state ?? null,
      held: card.state === 'ON_HOLD',
    })
    const sectionOf = (row: { readonly id: string; readonly code: string; readonly name: string }, world: DispatchWorld): PaperSection => ({
      station: { code: row.code, name: row.name },
      operators: namesWorkers ? [...new Set([...stationOperators(world, row.id), ...world.cards.filter((card) => card.stationId === row.id).flatMap((card) => card.rows)].flatMap((own) => (own.workerId ? [names.get(own.workerId) ?? '—'] : [])))] : [],
      cards: sortCards(world.cards.filter((card) => card.stationId === row.id)).map(paperCard),
    })
    const sections: PaperSection[] = stations.map((row) => sectionOf(row, world))
    if (line) sections.push({ station: null, operators: [], cards: sortCards(world.cards.filter((card) => card.stationId === null && card.lineId === line.id)).map(paperCard) })
    const lineRow = line ?? (station?.lineId ? await lineRowOf(db, station.lineId) : null)
    const minutes = lineRow ? await lineMinutesOf(db, world, [lineRow]) : new Map()
    const target = line ? { kind: 'LINE' as const, code: line.code, name: line.name } : { kind: 'STATION' as const, code: station!.code, name: station!.name }
    const shifts = lineRow ? (minutes.get(lineRow.id)?.shifts ?? []) : []
    return { site: { code: site.code, name: site.name }, target, day, shift: shifts.length > 0 ? shiftLabelAt(shifts, now) : null, version: world.plan?.number ?? null, printedAt: now, timeZone: site.timezone, sections }
  })
}

/** GET …/print/paper. */
export async function printedPaper(caller: CommandCaller, query: PrintQuery): Promise<DispatchPaper> {
  return dispatchPaper(await paperFacts(caller, query), query.language ?? 'it')
}

const MARGIN = { top: 36, bottom: 48, left: 30, right: 30 } as const
const TEXT = '#111111'
const MUTED = '#555555'
const RULE = '#9a9a9a'
const SHADE = '#ececec'
const RUSH = '#b00020'
/** Column widths, shares of the page's width (they follow the paper's ten columns). */
const SHARES = [0.04, 0.13, 0.17, 0.17, 0.17, 0.06, 0.07, 0.08, 0.07, 0.04] as const

/** GET …/print: the PDF, one table per station, starting a new page when a row would not fit. */
export async function printedPdf(caller: CommandCaller, query: PrintQuery): Promise<{ pdf: Buffer; fileName: string }> {
  const paper = await printedPaper(caller, query)
  return { pdf: await render(paper), fileName: paper.fileName }
}

export async function render(paper: DispatchPaper): Promise<Buffer> {
  const pdf = new PDFDocument({ size: 'A4', layout: 'landscape', margins: MARGIN, bufferPages: true, compress: true, lang: paper.language, displayTitle: true, info: { Title: winAnsi(`${paper.title} ${paper.heading}`), Creator: PDF_CREATOR, Producer: PDF_CREATOR } })
  const chunks: Buffer[] = []
  pdf.on('data', (chunk: Buffer) => chunks.push(chunk))
  const ended = new Promise<void>((resolve, reject) => {
    pdf.on('end', () => resolve())
    pdf.on('error', reject)
  })
  const left = MARGIN.left
  const width = pdf.page.width - MARGIN.left - MARGIN.right
  const bottom = pdf.page.height - MARGIN.bottom
  const widths = SHARES.map((share) => share * width)
  const text = (value: string, x: number, y: number, options: PDFKit.Mixins.TextOptions & { font?: string; size?: number; color?: string } = {}): number => {
    const { font = 'Helvetica', size = 8, color = TEXT, ...rest } = options
    pdf.font(font).fontSize(size).fillColor(color).text(winAnsi(value), x, y, { lineGap: 1, ...rest })
    return pdf.y
  }
  const heightOf = (cells: readonly string[]): number => Math.max(...cells.map((cell, index) => pdf.font('Helvetica').fontSize(8).heightOfString(winAnsi(cell || ' '), { width: widths[index]! - 6, lineGap: 1 }))) + 6
  const tableHead = (y: number): number => {
    pdf.save().rect(left, y, width, 15).fillColor(SHADE).fill().restore()
    let x = left
    paper.columns.forEach((column, index) => {
      text(column, x + 3, y + 4, { font: 'Helvetica-Bold', size: 7, width: widths[index]! - 6 })
      x += widths[index]!
    })
    return y + 15
  }
  let y = text(paper.title, left, MARGIN.top, { size: 10, color: MUTED, width })
  y = text(paper.heading, left, y + 1, { font: 'Helvetica-Bold', size: 16, width })
  y = text(paper.facts.map((fact) => `${fact.label}: ${fact.value}`).join('   ·   '), left, y + 3, { size: 8.5, color: MUTED, width }) + 8
  if (paper.empty) text(paper.empty, left, y + 12, { size: 12, width })
  for (const section of paper.sections) {
    if (y + 60 > bottom) {
      pdf.addPage()
      y = MARGIN.top
    }
    y = text(section.title, left, y + 4, { font: 'Helvetica-Bold', size: 10.5, width })
    if (section.operators) y = text(section.operators, left, y + 1, { size: 8.5, width })
    y = tableHead(y + 4)
    for (const row of section.rows) {
      const height = heightOf(row.cells)
      if (y + height > bottom) {
        pdf.addPage()
        y = tableHead(MARGIN.top)
      }
      let x = left
      row.cells.forEach((cell, index) => {
        pdf.save().rect(x, y, widths[index]!, height).lineWidth(0.4).strokeColor(RULE).stroke().restore()
        text(cell, x + 3, y + 3, { size: 8, color: row.rush && index === 1 ? RUSH : TEXT, width: widths[index]! - 6 })
        x += widths[index]!
      })
      y += height
    }
    y = text(section.footer, left, y + 3, { font: 'Helvetica-Bold', size: 8.5, width, align: 'right' }) + 8
  }
  const range = pdf.bufferedPageRange()
  for (let index = range.start; index < range.start + range.count; index++) {
    pdf.switchToPage(index)
    const savedBottom = pdf.page.margins.bottom
    pdf.page.margins.bottom = 0
    const top = pdf.page.height - 34
    pdf.save().moveTo(left, top).lineTo(left + width, top).lineWidth(0.4).strokeColor(RULE).stroke().restore()
    text(paper.foot, left, top + 4, { size: 7, color: MUTED, width: width - 110 })
    text(pageLabel(paper.pageLabel, index - range.start + 1, range.count), left + width - 100, top + 4, { size: 7.5, color: MUTED, width: 100, align: 'right' })
    pdf.page.margins.bottom = savedBottom
  }
  pdf.end()
  await ended
  return Buffer.concat(chunks)
}
