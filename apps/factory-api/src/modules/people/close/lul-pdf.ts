import PDFDocument from 'pdfkit'
import { pageLabel } from '@nexus/factory-domain/documents/compose'
import type { LulCalendar, LulRow } from '@nexus/factory-domain/people/close/lul'
import { PDF_CREATOR, winAnsi } from '../../../platform/documents/pdf'

/**
 * The LUL attendance calendar's PDF (B-W2b-48; design people.attendance new tab "LUL calendar (PDF)"): A4 landscape, one block
 * per person, a column per day of the month and the sum. What it says is decided by factory-domain people/close/lul; the
 * metadata comes from the calendar only (the creation date is the close), so the same calendar gives the same bytes and
 * the seal can be checked. The standard fonts only (as every document here).
 */

const MARGIN = { top: 30, bottom: 44, left: 24, right: 24 } as const
const TEXT = '#111111'
const MUTED = '#555555'
const RULE = '#9a9a9a'
const SHADE = '#ececec'
const LABEL_WIDTH = 86
const SUM_WIDTH = 34
const ROW_HEIGHT = 12
const HEAD_HEIGHT = 18

export async function renderLulPdf(calendar: LulCalendar): Promise<Buffer> {
  const pdf = new PDFDocument({
    size: 'A4',
    layout: 'landscape',
    margins: MARGIN,
    bufferPages: true,
    compress: true,
    lang: 'it',
    displayTitle: true,
    info: { Title: winAnsi(`${calendar.title} ${calendar.heading}`), Creator: PDF_CREATOR, Producer: PDF_CREATOR, CreationDate: calendar.createdAt },
  })
  const chunks: Buffer[] = []
  pdf.on('data', (chunk: Buffer) => chunks.push(chunk))
  const ended = new Promise<void>((resolve, reject) => {
    pdf.on('end', () => resolve())
    pdf.on('error', reject)
  })
  const left = MARGIN.left
  const width = pdf.page.width - MARGIN.left - MARGIN.right
  const bottom = pdf.page.height - MARGIN.bottom
  const dayWidth = (width - LABEL_WIDTH - SUM_WIDTH) / Math.max(calendar.days.length, 1)
  const text = (value: string, x: number, y: number, options: PDFKit.Mixins.TextOptions & { font?: string; size?: number; color?: string } = {}): number => {
    const { font = 'Helvetica', size = 6.5, color = TEXT, ...rest } = options
    pdf.font(font).fontSize(size).fillColor(color).text(winAnsi(value), x, y, { lineBreak: rest.width !== undefined, ...rest })
    return pdf.y
  }
  const cell = (x: number, y: number, cellWidth: number, height: number): void => {
    pdf.save().rect(x, y, cellWidth, height).lineWidth(0.3).strokeColor(RULE).stroke().restore()
  }
  const dayHead = (y: number): number => {
    pdf.save().rect(left, y, width, HEAD_HEIGHT).fillColor(SHADE).fill().restore()
    let x = left + LABEL_WIDTH
    for (const day of calendar.days) {
      text(day.day, x, y + 2, { font: 'Helvetica-Bold', width: dayWidth, align: 'center' })
      text(day.weekday, x, y + 10, { size: 5.5, color: MUTED, width: dayWidth, align: 'center' })
      x += dayWidth
    }
    text('Tot.', x, y + 6, { font: 'Helvetica-Bold', width: SUM_WIDTH, align: 'center' })
    return y + HEAD_HEIGHT
  }
  const line = (row: LulRow, y: number): number => {
    cell(left, y, LABEL_WIDTH, ROW_HEIGHT)
    text(row.label, left + 3, y + 3, { width: LABEL_WIDTH - 4, height: ROW_HEIGHT - 2, ellipsis: true })
    let x = left + LABEL_WIDTH
    for (const value of row.cells) {
      cell(x, y, dayWidth, ROW_HEIGHT)
      if (value) text(value, x, y + 3, { size: 5.8, width: dayWidth, align: 'center' })
      x += dayWidth
    }
    cell(x, y, SUM_WIDTH, ROW_HEIGHT)
    if (row.sum) text(row.sum, x, y + 3, { font: 'Helvetica-Bold', width: SUM_WIDTH, align: 'center' })
    return y + ROW_HEIGHT
  }

  let y = text(calendar.title, left, MARGIN.top, { size: 10, color: MUTED, width })
  y = text(calendar.heading, left, y + 1, { font: 'Helvetica-Bold', size: 14, width })
  y = text(calendar.facts.join('   ·   '), left, y + 3, { size: 8, color: MUTED, width })
  y = text(calendar.legend, left, y + 2, { size: 7, color: MUTED, width }) + 6
  if (calendar.blocks.length === 0) text('Nessuna persona in questo mese.', left, y + 12, { size: 12, width })
  for (const block of calendar.blocks) {
    const height = 14 + HEAD_HEIGHT + block.rows.length * ROW_HEIGHT + 6
    if (y + height > bottom) {
      pdf.addPage()
      y = MARGIN.top
    }
    text(`${block.title}${block.note ? ` - ${block.note}` : ''}`, left, y + 2, { font: 'Helvetica-Bold', size: 8.5, width })
    y = dayHead(y + 14)
    for (const row of block.rows) y = line(row, y)
    y += 6
  }
  const range = pdf.bufferedPageRange()
  for (let index = range.start; index < range.start + range.count; index++) {
    pdf.switchToPage(index)
    const savedBottom = pdf.page.margins.bottom
    pdf.page.margins.bottom = 0
    const top = pdf.page.height - 30
    pdf.save().moveTo(left, top).lineTo(left + width, top).lineWidth(0.4).strokeColor(RULE).stroke().restore()
    text(calendar.foot, left, top + 4, { size: 6.5, color: MUTED, width: width - 110 })
    text(pageLabel(calendar.pageLabel, index - range.start + 1, range.count), left + width - 100, top + 4, { size: 7, color: MUTED, width: 100, align: 'right' })
    pdf.page.margins.bottom = savedBottom
  }
  pdf.end()
  await ended
  return Buffer.concat(chunks)
}
