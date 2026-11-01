import PDFDocument from 'pdfkit'
import { create as createQr } from 'qrcode'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { businessDate } from '@nexus/factory-domain/core/time'
import { pageLabel } from '@nexus/factory-domain/documents/compose'
import type { DocumentLanguage } from '@nexus/factory-domain/documents/model'
import { WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import { travellerPaper, type TravellerPaper, type TravellerTable } from '@nexus/factory-domain/production/work-orders/traveller'
import type { CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { PDF_CREATOR, winAnsi } from '../../../platform/documents/pdf'
import { assertMay, officeContextOf } from './access'
import { readBasics } from './facts'
import { readWorkOrder, type Header, type Reader } from './store'
import { workOrderView } from './views'

/**
 * The work order traveller (B-W2b-51; MES-014 "Printable traveller (paper fallback)"; design production.workorders tab
 * wo-tab-traveller "Traveller PDF with QR", h.more "Print travellers (W2b)", the record's Documents tab): composed by
 * factory-domain production/work-orders/traveller and painted here on A4 portrait with pdfkit's standard fonts (the
 * documents platform's WinAnsi rule), the QR code drawn from the `qrcode` package's modules (no image, no font).
 *
 *   GET /production/work-orders/:id/traveller?language=it|en     workorders.view: one work order's traveller
 *   GET /production/work-orders/travellers?ids=a,b,…&language=   workorders.view: several in one PDF, in the order asked
 *                                                                (each starts on a new page and counts its own pages);
 *                                                                one the caller may not see → 404, nothing printed
 *
 * Made on request, stored nowhere (application/pdf, inline): the record is the truth and a new print is always current.
 * Per work order, operation and station: no person, no customer name, no money.
 */

const REGULAR = 'Helvetica'
const BOLD = 'Helvetica-Bold'
const TEXT = '#111111'
const MUTED = '#555555'
const RULE = '#9a9a9a'
const SHADE = '#ececec'
const RUSH = '#b00020'
const MARGIN = { top: 36, bottom: 54, left: 36, right: 36 } as const
const FOOTER_TOP = 44
const QR_SIZE = 92

/** A `Content-Disposition` that opens the PDF in the browser, with an ASCII and a UTF-8 name. */
export function inlineDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
}

/** What one work order's traveller prints, read with one reader (the record's own view: the spec, cells, genealogy). */
async function paperOf(db: Reader, row: Header, language: DocumentLanguage, now: Date): Promise<TravellerPaper> {
  const basics = await readBasics(db, row)
  const view = await workOrderView(db, row, businessDate(now), basics)
  const site = await db.site.findUniqueOrThrow({ where: { id: row.siteId }, select: { timezone: true } })
  const colourway = (code: string, name: string) => (name && name !== code ? `${code} · ${name}` : code)
  return travellerPaper(
    {
      number: view.number,
      batchNumber: view.batchNumber,
      status: view.status,
      kind: view.kind,
      rush: view.rush,
      priority: view.priority,
      dueDate: view.dueDate,
      site: { code: view.site.code, name: view.site.name },
      style: { code: view.style.code, name: view.style.name },
      revision: view.revision?.revision ?? null,
      orders: view.orders.map((order) => order.number),
      splitFrom: view.splitFrom?.number ?? null,
      note: view.note,
      holdReason: view.hold?.reason ?? null,
      releasedAt: row.releasedAt,
      sizes: view.style.sizes,
      cells: view.cells.map((cell) => ({ colourway: colourway(cell.colourwayCode, cell.colourwayName), size: cell.size, quantity: cell.quantity })),
      frozen: view.spec.frozen,
      operations: view.spec.operations.map((op) => ({ seq: op.seq, code: op.code, name: op.name, workCentre: op.workCentreCode, standardMinutes: op.standardMinutes, scanRequired: op.scanRequired })),
      materials: view.spec.materials.map((material) => ({ code: material.itemCode, name: material.itemName, colour: material.colourCode, planned: material.planned, uom: material.baseUom })),
      printedAt: now,
      timeZone: site.timezone,
    },
    language,
  )
}

/** GET …/:id/traveller: one work order's traveller. */
export async function travellerPdf(caller: CommandCaller, workOrderId: string, language: DocumentLanguage = 'it'): Promise<{ pdf: Buffer; fileName: string }> {
  return travellersPdf(caller, [workOrderId], language)
}

/** GET …/travellers?ids=: the travellers of several work orders in one PDF, each one the caller may see (else 404). */
export async function travellersPdf(caller: CommandCaller, workOrderIds: readonly string[], language: DocumentLanguage = 'it'): Promise<{ pdf: Buffer; fileName: string }> {
  const context = officeContextOf(caller)
  const now = serverClock.now()
  const papers = await caller.withClient(async (client) => {
    const out: TravellerPaper[] = []
    for (const workOrderId of workOrderIds) {
      const row = await readWorkOrder(client, workOrderId)
      try {
        assertMay(context, WORKORDERS_VIEW, row)
      } catch (error) {
        if (error instanceof NotFoundError && workOrderIds.length > 1) throw new NotFoundError(`Work order ${workOrderId} not found.`)
        throw error
      }
      out.push(await paperOf(client, row!, language, now))
    }
    return out
  })
  const fileName = papers.length === 1 ? `${papers[0]!.meta.title}.pdf` : `${papers[0]!.title} (${papers.length}).pdf`
  return { pdf: await renderTravellers(papers), fileName }
}

/** The PDF of one or more travellers (each from a new page; page numbers count per traveller). */
export async function renderTravellers(papers: readonly TravellerPaper[]): Promise<Buffer> {
  const first = papers[0]!
  const pdf = new PDFDocument({
    size: 'A4',
    margins: MARGIN,
    bufferPages: true,
    compress: true,
    lang: first.language,
    displayTitle: true,
    info: {
      Title: winAnsi(papers.length === 1 ? first.meta.title : `${first.title} (${papers.length})`),
      Subject: winAnsi(papers.map((paper) => paper.number).join(', ')),
      Creator: PDF_CREATOR,
      Producer: PDF_CREATOR,
      CreationDate: new Date(first.meta.createdAt),
    },
  })
  const chunks: Buffer[] = []
  pdf.on('data', (chunk: Buffer) => chunks.push(chunk))
  const ended = new Promise<void>((resolve, reject) => {
    pdf.on('end', () => resolve())
    pdf.on('error', reject)
  })
  const ranges: { paper: TravellerPaper; start: number; end: number }[] = []
  papers.forEach((paper, index) => {
    if (index > 0) pdf.addPage()
    const start = pdf.bufferedPageRange().start + pdf.bufferedPageRange().count - 1
    paint(pdf, paper)
    ranges.push({ paper, start, end: pdf.bufferedPageRange().start + pdf.bufferedPageRange().count - 1 })
  })
  for (const range of ranges) footers(pdf, range.paper, range.start, range.end)
  pdf.end()
  await ended
  return Buffer.concat(chunks)
}

type TextOptions = PDFKit.Mixins.TextOptions & { font?: string; size?: number; color?: string }

function writer(pdf: PDFKit.PDFDocument) {
  const text = (value: string, x: number, y: number, options: TextOptions = {}): number => {
    const { font = REGULAR, size = 8.5, color = TEXT, ...rest } = options
    pdf.font(font).fontSize(size).fillColor(color).text(winAnsi(value), x, y, { lineGap: 1, ...rest })
    return pdf.y
  }
  const heightOf = (value: string, width: number, font = REGULAR, size = 8.5): number => pdf.font(font).fontSize(size).heightOfString(winAnsi(value), { width, lineGap: 1 })
  return { text, heightOf }
}

/** The QR code of `value` at (x, y), `size` points wide with its quiet zone (4 modules each side), black on white. */
function qrCode(pdf: PDFKit.PDFDocument, value: string, x: number, y: number, size: number): void {
  const { modules } = createQr(value, { errorCorrectionLevel: 'M' })
  const count = modules.size
  const unit = size / (count + 8)
  pdf.save().rect(x, y, size, size).fillColor('#ffffff').fill()
  for (let row = 0; row < count; row++) {
    for (let column = 0; column < count; column++) {
      if (modules.get(row, column)) pdf.rect(x + (column + 4) * unit, y + (row + 4) * unit, unit, unit)
    }
  }
  pdf.fillColor('#000000').fill().restore()
}

function paint(pdf: PDFKit.PDFDocument, paper: TravellerPaper): void {
  const { text, heightOf } = writer(pdf)
  const left = MARGIN.left
  const right = pdf.page.width - MARGIN.right
  const width = right - left
  const bottom = (): number => pdf.page.height - MARGIN.bottom

  // The header: title, number, batch and the rush box on the left; the QR code and its number on the right.
  const headWidth = width - QR_SIZE - 16
  let y: number = MARGIN.top
  y = text(paper.title, left, y, { size: 10, color: MUTED, width: headWidth })
  y = text(paper.number, left, y + 1, { font: BOLD, size: 24, width: headWidth })
  if (paper.batch) y = text(paper.batch, left, y + 1, { font: BOLD, size: 11, width: headWidth })
  if (paper.rush) {
    const boxWidth = pdf.font(BOLD).fontSize(14).widthOfString(winAnsi(paper.rush)) + 20
    pdf.save().rect(left, y + 6, boxWidth, 22).fillColor(RUSH).fill().restore()
    text(paper.rush, left, y + 11, { font: BOLD, size: 14, color: '#ffffff', width: boxWidth, align: 'center' })
    y += 32
  }
  const qrLeft = right - QR_SIZE
  qrCode(pdf, paper.qr, qrLeft, MARGIN.top, QR_SIZE)
  const qrBottom = text(paper.qr, qrLeft, MARGIN.top + QR_SIZE + 2, { size: 8, color: MUTED, width: QR_SIZE, align: 'center' })
  y = Math.max(y, qrBottom) + 8

  if (paper.banner) {
    const height = heightOf(paper.banner, width - 12, BOLD, 10) + 10
    pdf.save().rect(left, y, width, height).fillColor('#fde8e8').fill().restore()
    text(paper.banner, left + 6, y + 5, { font: BOLD, size: 10, color: '#a40000', width: width - 12, align: 'center' })
    y += height + 6
  }

  // The facts, three per row.
  const perRow = 3
  const cellWidth = width / perRow
  for (let start = 0; start < paper.facts.length; start += perRow) {
    const row = paper.facts.slice(start, start + perRow)
    const height = Math.max(...row.map((fact) => heightOf(fact.label, cellWidth - 8, REGULAR, 7) + heightOf(fact.value || ' ', cellWidth - 8, BOLD, 9.5))) + 7
    row.forEach((fact, index) => {
      const x = left + index * cellWidth
      pdf.save().rect(x, y, cellWidth, height).lineWidth(0.4).strokeColor(RULE).stroke().restore()
      const valueTop = text(fact.label, x + 4, y + 3, { size: 7, color: MUTED, width: cellWidth - 8 })
      text(fact.value, x + 4, valueTop + 1, { font: BOLD, size: 9.5, width: cellWidth - 8 })
    })
    y += height
  }
  y += 10

  const newPage = (): number => {
    pdf.addPage()
    return text(`${paper.title} ${paper.number} (${paper.footer.continued})`, left, MARGIN.top, { size: 8, color: MUTED, width }) + 6
  }
  for (const table of paper.tables) y = paintTable(pdf, table, y, { left, width, bottom, newPage }) + 10

  for (const note of paper.notes) {
    if (y + heightOf(note, width, REGULAR, 8) > bottom()) y = newPage()
    y = text(note, left, y, { size: 8, color: MUTED, width }) + 4
  }
}

/** One table: its title, a shaded header (again on each new page), the rows ruled; room to write by hand in empty cells. */
function paintTable(pdf: PDFKit.PDFDocument, table: TravellerTable, top: number, frame: { left: number; width: number; bottom: () => number; newPage: () => number }): number {
  const { text, heightOf } = writer(pdf)
  const { left, width, bottom, newPage } = frame
  const right = left + width
  const columns = table.columns.map((column) => ({ ...column, width: (width * column.width) / 1000 }))
  const headerHeight = Math.max(...columns.map((column) => heightOf(column.label || ' ', column.width - 6, BOLD, 7.5))) + 6
  let y = top
  if (y + 14 + headerHeight + 18 > bottom()) y = newPage()
  y = text(table.title, left, y, { font: BOLD, size: 11, width }) + 3
  const header = (at: number): number => {
    pdf.save().rect(left, at, width, headerHeight).fillColor(SHADE).fill().restore()
    let x = left
    for (const column of columns) {
      text(column.label, x + 3, at + 3, { font: BOLD, size: 7.5, width: column.width - 6, align: column.align })
      x += column.width
    }
    return at + headerHeight
  }
  y = header(y)
  if (table.rows.length === 0) return text(table.empty, left + 3, y + 4, { size: 8, color: MUTED, width: width - 6 })
  const rows = [...table.rows.map((cells) => ({ cells, strong: false })), ...(table.total ? [{ cells: table.total, strong: true }] : [])]
  for (const row of rows) {
    const font = row.strong ? BOLD : REGULAR
    // Room to write by hand: at least 16 points a row.
    const height = Math.max(16, ...row.cells.map((cell, index) => heightOf(cell || ' ', columns[index]!.width - 6, font, 8.5))) + 4
    if (y + height > bottom()) y = header(newPage())
    let x = left
    row.cells.forEach((cell, index) => {
      const column = columns[index]!
      pdf.save().moveTo(x, y).lineTo(x, y + height).lineWidth(0.3).strokeColor(RULE).stroke().restore()
      text(cell, x + 3, y + 4, { font, size: 8.5, width: column.width - 6, align: column.align })
      x += column.width
    })
    pdf.save().moveTo(right, y).lineTo(right, y + height).lineWidth(0.3).strokeColor(RULE).stroke().restore()
    y += height
    pdf.save().moveTo(left, y).lineTo(right, y).lineWidth(0.4).strokeColor(RULE).stroke().restore()
  }
  return y
}

/** Each page of a traveller: the printing time, the number and "Page n of m" (its own pages). */
function footers(pdf: PDFKit.PDFDocument, paper: TravellerPaper, start: number, end: number): void {
  const { text } = writer(pdf)
  const left = MARGIN.left
  for (let index = start; index <= end; index++) {
    pdf.switchToPage(index)
    const right = pdf.page.width - MARGIN.right
    const width = right - left
    const savedBottom = pdf.page.margins.bottom
    pdf.page.margins.bottom = 0
    const top = pdf.page.height - FOOTER_TOP
    pdf.save().moveTo(left, top).lineTo(right, top).lineWidth(0.4).strokeColor(RULE).stroke().restore()
    text(`${paper.footer.printed} · ${paper.title} ${paper.number}`, left, top + 4, { size: 7, color: MUTED, width: width - 100 })
    text(pageLabel(paper.footer.page, index - start + 1, end - start + 1), right - 96, top + 4, { size: 7.5, color: MUTED, width: 96, align: 'right' })
    pdf.page.margins.bottom = savedBottom
  }
}
