import PDFDocument from 'pdfkit'
import { pageLabel } from '@nexus/factory-domain/documents/compose'
import type { PayrollSummary, SummaryRow } from '@nexus/factory-domain/people/payroll/summary'
import { PDF_CREATOR, winAnsi } from '../../../platform/documents/pdf'

/**
 * The export summary's PDF (B-W2b-54; design people.payroll new tab "Export summary (PDF)": totals per employee for the consultant's
 * check): A4 upright, one block per employee code, then the company's sums. What it says is factory-domain people/payroll/summary;
 * the metadata comes from the summary only, so the same summary gives the same bytes. The standard fonts only.
 */

const MARGIN = { top: 36, bottom: 48, left: 36, right: 36 } as const
const TEXT = '#111111'
const MUTED = '#555555'
const RULE = '#9a9a9a'
const SHADE = '#ececec'
const ROW_HEIGHT = 13
const COLUMNS = [
  { label: 'Voce', width: 74, key: 'voice', align: 'left' },
  { label: 'Codice', width: 74, key: 'code', align: 'left' },
  { label: 'Descrizione', width: 195, key: 'words', align: 'left' },
  { label: 'Quantità', width: 80, key: 'quantity', align: 'right' },
  { label: 'Importo', width: 100, key: 'amount', align: 'right' },
] as const

export async function renderSummaryPdf(summary: PayrollSummary): Promise<Buffer> {
  const pdf = new PDFDocument({ size: 'A4', margins: MARGIN, bufferPages: true, compress: true, lang: 'it', displayTitle: true, info: { Title: winAnsi(`${summary.title} ${summary.heading}`), Creator: PDF_CREATOR, Producer: PDF_CREATOR, CreationDate: summary.createdAt } })
  const chunks: Buffer[] = []
  pdf.on('data', (chunk: Buffer) => chunks.push(chunk))
  const ended = new Promise<void>((resolve, reject) => {
    pdf.on('end', () => resolve())
    pdf.on('error', reject)
  })
  const left = MARGIN.left
  const width = pdf.page.width - MARGIN.left - MARGIN.right
  const bottom = pdf.page.height - MARGIN.bottom
  const text = (value: string, x: number, y: number, options: PDFKit.Mixins.TextOptions & { font?: string; size?: number; color?: string } = {}): number => {
    const { font = 'Helvetica', size = 8, color = TEXT, ...rest } = options
    pdf.font(font).fontSize(size).fillColor(color).text(winAnsi(value), x, y, { lineBreak: rest.width !== undefined, ...rest })
    return pdf.y
  }
  const head = (y: number, cells: readonly { readonly label: string; readonly width: number; readonly align: 'left' | 'right' }[]): number => {
    pdf.save().rect(left, y, width, ROW_HEIGHT).fillColor(SHADE).fill().restore()
    let x = left
    for (const cell of cells) {
      text(cell.label, x + 3, y + 3, { font: 'Helvetica-Bold', width: cell.width - 6, align: cell.align })
      x += cell.width
    }
    return y + ROW_HEIGHT
  }
  const line = (y: number, cells: readonly { readonly value: string; readonly width: number; readonly align: 'left' | 'right' }[]): number => {
    pdf.save().moveTo(left, y + ROW_HEIGHT).lineTo(left + width, y + ROW_HEIGHT).lineWidth(0.3).strokeColor(RULE).stroke().restore()
    let x = left
    for (const cell of cells) {
      if (cell.value) text(cell.value, x + 3, y + 3, { width: cell.width - 6, height: ROW_HEIGHT - 2, align: cell.align, ellipsis: true })
      x += cell.width
    }
    return y + ROW_HEIGHT
  }
  const rowCells = (row: SummaryRow) => COLUMNS.map((column) => ({ value: row[column.key], width: column.width, align: column.align }))
  /** A new page when the next lines do not fit. */
  const room = (y: number, height: number): number => {
    if (y + height <= bottom) return y
    pdf.addPage()
    return MARGIN.top
  }

  let y = text(summary.title, left, MARGIN.top, { size: 10, color: MUTED, width })
  y = text(summary.heading, left, y + 1, { font: 'Helvetica-Bold', size: 14, width })
  y = text(summary.facts.join('   ·   '), left, y + 3, { size: 8, color: MUTED, width })
  for (const note of summary.notes) y = text(note, left, y + 2, { size: 8, width })
  y += 8

  if (summary.changes.length > 0) {
    const columns = [
      { label: 'Matricola', width: 80, align: 'left' },
      { label: 'Voce', width: 183, align: 'left' },
      { label: 'Da', width: 130, align: 'right' },
      { label: 'A', width: 130, align: 'right' },
    ] as const
    y = room(y, 14 + ROW_HEIGHT * 2)
    y = text('Variazioni rispetto alla versione precedente', left, y, { font: 'Helvetica-Bold', size: 9, width }) + 3
    y = head(y, columns)
    for (const change of summary.changes) {
      if (y + ROW_HEIGHT > bottom) {
        y = room(y, ROW_HEIGHT * 2)
        y = head(y, columns)
      }
      y = line(y, [change.employeeCode, change.words, change.from, change.to].map((value, index) => ({ value, width: columns[index]!.width, align: columns[index]!.align })))
    }
    y += 10
  }

  if (summary.blocks.length === 0) text('Nessuna persona in questo mese.', left, y + 12, { size: 12, width })
  for (const block of summary.blocks) {
    y = room(y, 14 + ROW_HEIGHT * (block.rows.length + 1) + 8)
    text(`${block.title}${block.note ? ` - ${block.note}` : ''}`, left, y, { font: 'Helvetica-Bold', size: 9, width })
    y = head(y + 13, COLUMNS)
    for (const row of block.rows) {
      if (y + ROW_HEIGHT > bottom) {
        y = room(y, ROW_HEIGHT * 2)
        y = head(y, COLUMNS)
      }
      y = line(y, rowCells(row))
    }
    y += 8
  }

  if (summary.totals.length > 0) {
    y = room(y, 14 + ROW_HEIGHT * (summary.totals.length + 1))
    text('Totali della società', left, y, { font: 'Helvetica-Bold', size: 9, width })
    y = head(y + 13, COLUMNS)
    for (const row of summary.totals) y = line(y, rowCells(row))
  }

  const range = pdf.bufferedPageRange()
  for (let index = range.start; index < range.start + range.count; index++) {
    pdf.switchToPage(index)
    const savedBottom = pdf.page.margins.bottom
    pdf.page.margins.bottom = 0
    const top = pdf.page.height - 34
    pdf.save().moveTo(left, top).lineTo(left + width, top).lineWidth(0.4).strokeColor(RULE).stroke().restore()
    text(summary.foot, left, top + 4, { size: 7, color: MUTED, width: width - 110 })
    text(pageLabel(summary.pageLabel, index - range.start + 1, range.count), left + width - 100, top + 4, { size: 7, color: MUTED, width: 100, align: 'right' })
    pdf.page.margins.bottom = savedBottom
  }
  pdf.end()
  await ended
  return Buffer.concat(chunks)
}
