import PDFDocument from 'pdfkit'
import { plusDays } from '@nexus/factory-domain/calendars/dates'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { businessDate, businessDayStart, type BusinessDate } from '@nexus/factory-domain/core/time'
import { pageLabel } from '@nexus/factory-domain/documents/compose'
import { PLANNING_VIEW } from '@nexus/factory-domain/planning/permissions'
import { DAY_SHEET_LIMITS, daySheetPaper, type DaySheetPaper, type SheetFacts, type SheetLane, type SheetRow } from '@nexus/factory-domain/planning/schedule-log/day-sheet'
import { laneOfSlot } from '@nexus/factory-domain/planning/schedule/slots'
import { uniformBuckets } from '@nexus/factory-domain/planning/settings/buckets'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import type { CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { PDF_CREATOR, winAnsi } from '../../../platform/documents/pdf'
import { siteFor } from '../access'
import { capacityAnswer } from '../capacity/service'
import { dayOf, type Reader, type SiteRow } from '../store'
import { capacityWith, scheduleWorld, type ScheduleWorld } from '../schedule/service'
import { PLAN_COLUMNS, type PlanRow } from '../schedule/store'
import type { SheetQuery } from './contract'
import { floorStatusesOf } from './floor'
import type { FloorStatusView } from './floor-contract'
import { VERSION_SLOT_COLUMNS, type VersionSlotRow } from './version-board'

/**
 * Day sheets per line (B-W2b-329; PLN-154; design planning.board pop "Print day sheets": lines (MultiSelect), date, language →
 * "Open PDF (new tab)"; factory-domain planning/schedule-log/day-sheet for what a sheet says):
 *
 *   GET /planning/schedule/day-sheets/paper?siteId&date&lineIds&workCentreIds&plan&versionId&language   what the sheets say
 *   GET /planning/schedule/day-sheets?…                                                                    the same as a PDF
 *
 * planning.view over the site. One sheet (a new page) per line or work centre asked (default: every active line of the
 * site, by code). The plan printed: PUBLISHED (default) the version the floor works to that day (the highest number that
 * covers the day and starts before it ends), or the one named; WORKING the working plan, marked as not published. Each bar
 * reaching into the day with its state on the floor now (PLN-133) and the lane's load that day from the same plan. Made on
 * request, stored nowhere; A4 landscape. No person, no customer, no money.
 */

const splitIds = (value: string | undefined, path: string): string[] => {
  if (value === undefined || value.trim() === '') return []
  const ids = [...new Set(value.split(',').map((part) => part.trim()).filter((part) => part !== ''))]
  const bad = ids.find((part) => !isUuid(part))
  if (bad) throw new ValidationError(`"${bad}" is not an id.`, [{ path: `querystring/${path}`, message: 'Ids, comma separated.' }])
  return ids
}

/** The version the floor works to on a day: the highest number covering it that starts before the day ends. */
async function versionOnDay(db: Reader, site: SiteRow, day: BusinessDate): Promise<PlanRow | null> {
  const end = businessDayStart(plusDays(day, 1), site.timezone)
  const stored = new Date(`${day}T00:00:00.000Z`)
  return db.planVersion.findFirst({ where: { siteId: site.id, kind: 'PUBLISHED', coversFrom: { lte: stored }, coversTo: { gte: stored }, effectiveFrom: { lt: end } }, select: PLAN_COLUMNS, orderBy: { number: 'desc' } })
}

interface Lane {
  readonly kind: 'LINE' | 'WORK_CENTRE'
  readonly id: string
  readonly code: string
  readonly name: string
}

async function lanesAsked(db: Reader, site: SiteRow, query: SheetQuery): Promise<Lane[]> {
  const lineIds = splitIds(query.lineIds, 'lineIds')
  const centreIds = splitIds(query.workCentreIds, 'workCentreIds')
  if (lineIds.length + centreIds.length > DAY_SHEET_LIMITS.lanes) throw new ValidationError(`At most ${DAY_SHEET_LIMITS.lanes} lines and work centres at once.`, [{ path: 'querystring/lineIds', message: `At most ${DAY_SHEET_LIMITS.lanes} in all.` }])
  const asked = lineIds.length + centreIds.length > 0
  const lines = await db.line.findMany({ where: { siteId: site.id, ...(asked ? { id: { in: lineIds } } : { status: 'ACTIVE' }) }, select: { id: true, code: true, name: true }, orderBy: { code: 'asc' } })
  const centres = centreIds.length ? await db.workCentre.findMany({ where: { siteId: site.id, id: { in: centreIds } }, select: { id: true, code: true, name: true }, orderBy: { code: 'asc' } }) : []
  const missing = [...lineIds.filter((id) => !lines.some((line) => line.id === id)), ...centreIds.filter((id) => !centres.some((centre) => centre.id === id))]
  if (missing.length > 0) throw new NotFoundError(lineIds.includes(missing[0]!) ? 'Line not found on this site.' : 'Work centre not found on this site.')
  return [...lines.map((line) => ({ kind: 'LINE' as const, ...line })), ...centres.map((centre) => ({ kind: 'WORK_CENTRE' as const, ...centre }))]
}

/** What the sheets are made of, read for the person at the site. */
async function sheetFacts(caller: CommandCaller, query: SheetQuery): Promise<SheetFacts> {
  const site = await siteFor(caller, query.siteId, PLANNING_VIEW)
  const now = serverClock.now()
  return caller.withClient(async (db) => {
    const day = query.date ?? businessDate(now, site.timezone)
    const lanes = await lanesAsked(db, site, query)
    const world = await scheduleWorld(db, site, { from: day, to: day }, now)
    let version: PlanRow | null = null
    if (query.versionId) {
      version = await db.planVersion.findFirst({ where: { id: query.versionId, siteId: site.id, kind: 'PUBLISHED' }, select: PLAN_COLUMNS })
      if (!version) throw new NotFoundError('Published version not found on this site.')
    } else if (query.plan !== 'WORKING') {
      version = await versionOnDay(db, site, day)
      if (!version) throw new NotFoundError(`No published version covers ${day} at ${site.code}: publish the plan, or print the working plan.`)
    }
    const planId = version?.id ?? world.plan?.id ?? null
    const start = businessDayStart(day, site.timezone)
    const end = businessDayStart(plusDays(day, 1), site.timezone)
    const slots = planId ? await db.scheduleSlot.findMany({ where: { planVersionId: planId }, select: VERSION_SLOT_COLUMNS, orderBy: [{ startAt: 'asc' }, { id: 'asc' }] }) : []
    const onDay = slots.filter((slot) => slot.startAt < end && slot.endAt > start)
    const floor = await floorStatusesOf(db, world, onDay)
    // The load that day from the plan printed (a version: its own slots; the working plan: the board's).
    const capacity = version ? capacityWith(world, slots) : world.capacity
    const load = capacityAnswer(capacity, { from: day, to: day, buckets: uniformBuckets(day, day, 'DAY') })
    const floorNumber = version ? null : ((await versionOnDay(db, site, day))?.number ?? null)
    return {
      site: { code: site.code, name: site.name },
      day,
      plan: version ? { kind: 'PUBLISHED' as const, number: version.number!, publishedAt: version.publishedAt! } : { kind: 'WORKING' as const, floorNumber },
      printedAt: now,
      timeZone: site.timezone,
      lanes: lanes.map((lane): SheetLane => {
        const cell = load.lanes.find((entry) => entry.kind === lane.kind && entry.id === lane.id)?.cells[0] ?? null
        const rows = onDay.filter((slot) => {
          const at = laneOfSlot(slot)
          return at.kind === lane.kind && at.id === lane.id
        })
        return {
          kind: lane.kind,
          code: lane.code,
          name: lane.name,
          load: cell && Number(cell.availableMinutes) > 0 ? { availableMinutes: cell.availableMinutes, bookedMinutes: cell.bookedMinutes, loadPct: cell.loadPct, overMinutes: cell.overMinutes } : null,
          rows: rows.map((slot) => rowOf(world, slot, floor.get(slot.id) ?? null)),
        }
      }),
    }
  })
}

function rowOf(world: ScheduleWorld, slot: VersionSlotRow, floor: FloorStatusView | null): SheetRow {
  const workOrder = world.workOrders.find((candidate) => candidate.id === slot.workOrderId)
  const operation = slot.operation ? workOrder?.operations.find((candidate) => candidate.id === slot.operation!.id) : undefined
  const pieces = slot.operation ? (operation?.remaining ?? workOrder?.garments ?? 0) : (slot.pieces ?? workOrder?.garments ?? 0)
  return {
    startAt: slot.startAt,
    endAt: slot.endAt,
    rush: slot.workOrder.rush,
    workOrder: slot.workOrder.number,
    style: `${slot.workOrder.style.code} ${slot.workOrder.style.name}`,
    operation: slot.operation ? { seq: slot.operation.seq, name: slot.operation.name } : null,
    pieces,
    minutes: new Dec(slot.minutes.toString()).toFixed(1),
    dueDate: slot.workOrder.dueDate ? dayOf(slot.workOrder.dueDate) : null,
    floor: floor ? { state: floor.state, done: floor.done, of: floor.of } : null,
    pinned: slot.pinned,
    note: slot.note,
  }
}

/** GET …/day-sheets/paper. */
export async function daySheetsPaper(caller: CommandCaller, query: SheetQuery): Promise<DaySheetPaper> {
  return daySheetPaper(await sheetFacts(caller, query), query.language ?? 'it')
}

const MARGIN = { top: 36, bottom: 48, left: 30, right: 30 } as const
const TEXT = '#111111'
const MUTED = '#555555'
const RULE = '#9a9a9a'
const SHADE = '#ececec'
const RUSH = '#b00020'
/** Column widths, shares of the page's width (the sheet's ten columns). */
const SHARES = [0.07, 0.07, 0.13, 0.15, 0.22, 0.06, 0.07, 0.08, 0.1, 0.05] as const

/** GET …/day-sheets: the PDF, a page per lane, a new page when a row would not fit. */
export async function daySheetsPdf(caller: CommandCaller, query: SheetQuery): Promise<{ pdf: Buffer; fileName: string }> {
  const paper = await daySheetsPaper(caller, query)
  return { pdf: await render(paper), fileName: paper.fileName }
}

export async function render(paper: DaySheetPaper): Promise<Buffer> {
  const pdf = new PDFDocument({ size: 'A4', layout: 'landscape', margins: MARGIN, bufferPages: true, compress: true, lang: paper.language, displayTitle: true, autoFirstPage: false, info: { Title: winAnsi(paper.title), Creator: PDF_CREATOR, Producer: PDF_CREATOR } })
  const chunks: Buffer[] = []
  pdf.on('data', (chunk: Buffer) => chunks.push(chunk))
  const ended = new Promise<void>((resolve, reject) => {
    pdf.on('end', () => resolve())
    pdf.on('error', reject)
  })
  pdf.addPage()
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
  paper.sheets.forEach((sheet, sheetIndex) => {
    if (sheetIndex > 0) pdf.addPage()
    let y = text(paper.title, left, MARGIN.top, { size: 10, color: MUTED, width })
    y = text(sheet.heading, left, y + 1, { font: 'Helvetica-Bold', size: 16, width })
    y = text(sheet.facts.map((fact) => `${fact.label}: ${fact.value}`).join('   ·   '), left, y + 3, { size: 8.5, color: MUTED, width }) + 4
    if (sheet.banner) y = text(sheet.banner, left, y + 2, { font: 'Helvetica-Bold', size: 9, color: RUSH, width }) + 4
    if (sheet.empty) {
      text(sheet.empty, left, y + 12, { size: 12, width })
      return
    }
    y = tableHead(y + 4)
    for (const row of sheet.rows) {
      const height = heightOf(row.cells)
      if (y + height > bottom) {
        pdf.addPage()
        y = tableHead(MARGIN.top)
      }
      let x = left
      row.cells.forEach((cell, index) => {
        pdf.save().rect(x, y, widths[index]!, height).lineWidth(0.4).strokeColor(RULE).stroke().restore()
        text(cell, x + 3, y + 3, { size: 8, color: row.rush && index === 2 ? RUSH : TEXT, width: widths[index]! - 6 })
        x += widths[index]!
      })
      y += height
    }
    text(sheet.footer, left, y + 3, { font: 'Helvetica-Bold', size: 8.5, width, align: 'right' })
  })
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
