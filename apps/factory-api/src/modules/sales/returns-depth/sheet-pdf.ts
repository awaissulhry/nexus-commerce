import PDFDocument from 'pdfkit'
import { code128Bars } from '@nexus/factory-domain/labels/code128'
import type { PapersTable, RmaPapers } from '@nexus/factory-domain/sales/returns-depth/papers'
import { PDF_CREATOR, winAnsi } from '../../../platform/documents/pdf'

/**
 * The RMA papers on A4 (B-W2b-341; SAL-346), painted from factory-domain sales/returns-depth/papers' words with pdfkit's
 * standard fonts (the documents platform's WinAnsi rule): our company at the top left, the title and number at the top
 * right with the scan code as a Code 128 barcode (factory-domain labels/code128, a 10-module quiet zone) and as text, the
 * facts in two columns, what comes back, where it goes, the transport, the conditions (and a consumer's withdrawal words),
 * then the box label at the foot behind a dashed cut line, with the barcode again. The same papers give the same bytes
 * (the creation date is the papers' date).
 */

const REGULAR = 'Helvetica'
const BOLD = 'Helvetica-Bold'
const TEXT = '#111111'
const MUTED = '#555555'
const RULE = '#9a9a9a'
const SHADE = '#ececec'
const MARGIN = { top: 40, bottom: 60, left: 42, right: 42 } as const
const FOOTER_TOP = 50
/** The box label's height (points), at the foot of the last page. */
const LABEL_HEIGHT = 190

export async function renderRmaPapers(papers: RmaPapers): Promise<Buffer> {
  const pdf = new PDFDocument({
    size: 'A4',
    margins: MARGIN,
    bufferPages: true,
    compress: true,
    lang: papers.language,
    displayTitle: true,
    info: { Title: winAnsi(papers.meta.title), Subject: winAnsi(papers.meta.subject), Creator: PDF_CREATOR, Producer: PDF_CREATOR, CreationDate: new Date(papers.meta.createdAt) },
  })
  const chunks: Buffer[] = []
  pdf.on('data', (chunk: Buffer) => chunks.push(chunk))
  const ended = new Promise<void>((resolve, reject) => {
    pdf.on('end', () => resolve())
    pdf.on('error', reject)
  })
  paint(pdf, papers)
  pdf.end()
  await ended
  return Buffer.concat(chunks)
}

function paint(pdf: PDFKit.PDFDocument, papers: RmaPapers): void {
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
  /** The scan code as bars (height in points) with the code under it, centred in [x, x + w]; answers the bottom. */
  const barcode = (x: number, y: number, w: number, height: number, codeSize: number): number => {
    const symbol = code128Bars(papers.scanCode)
    // 10 modules of quiet zone each side; at most 1 point per module.
    const module = Math.min(1, w / (symbol.modules + 20))
    const start = x + (w - symbol.modules * module) / 2
    for (const bar of symbol.bars) pdf.rect(start + bar.x * module, y, bar.width * module, height).fill('#000000')
    return text(papers.scanCode, x, y + height + 3, { font: BOLD, size: codeSize, width: w, align: 'center' })
  }
  const newPage = (): number => {
    pdf.addPage()
    return text(`${papers.company.name} · ${papers.title} ${papers.number}`, left, MARGIN.top, { size: 8, color: MUTED, width }) + 8
  }

  // Our company on the left; the title, number and the barcode on the right.
  const companyWidth = Math.round(width * 0.5)
  let y: number = MARGIN.top
  y = text(papers.company.name, left, y, { font: BOLD, size: 12, width: companyWidth })
  for (const line of papers.company.lines) y = text(line, left, y + 0.5, { size: 7.5, color: MUTED, width: companyWidth })
  const titleLeft = left + companyWidth + 12
  const titleWidth = right - titleLeft
  let ty = text(papers.title, titleLeft, MARGIN.top, { font: BOLD, size: 14, width: titleWidth, align: 'right' })
  ty = text(papers.number, titleLeft, ty + 1, { font: BOLD, size: 11, width: titleWidth, align: 'right' }) + 6
  ty = barcode(titleLeft, ty, titleWidth, 42, 10)
  ty = text(papers.scanHint, titleLeft, ty + 1, { size: 7, color: MUTED, width: titleWidth, align: 'center' })
  y = Math.max(y, ty) + 12

  // The facts, two columns of label → value.
  const half = (width - 16) / 2
  for (let index = 0; index < papers.facts.length; index += 2) {
    let rowBottom = y
    for (const offset of [0, 1]) {
      const fact = papers.facts[index + offset]
      if (!fact) continue
      const x = left + offset * (half + 16)
      text(fact.label, x, y, { size: 7.5, color: MUTED, width: half * 0.34 })
      rowBottom = Math.max(rowBottom, y + heightOf(fact.label, half * 0.34, REGULAR, 7.5), text(fact.value, x + half * 0.36, y, { font: BOLD, size: 8.5, width: half * 0.64 }))
    }
    y = rowBottom + 3
  }
  y += 8

  const table = (at: number, spec: PapersTable): number => {
    const columns = spec.columns.map((entry) => ({ ...entry, width: width * entry.width }))
    const header = (top: number): number => {
      const height = Math.max(...columns.map((entry) => heightOf(entry.label, entry.width - 6, BOLD, 8))) + 6
      pdf.save().rect(left, top, width, height).fillColor(SHADE).fill().restore()
      let x = left
      for (const entry of columns) {
        text(entry.label, x + 3, top + 3, { font: BOLD, size: 8, width: entry.width - 6, align: entry.align })
        x += entry.width
      }
      return top + height
    }
    let cursor = header(at)
    for (const row of spec.rows) {
      const height = Math.max(...columns.map((entry, index) => heightOf(row[index] ?? '', entry.width - 6, REGULAR, 8.5))) + 6
      if (cursor + height > bottom()) cursor = header(newPage())
      let x = left
      for (const [index, entry] of columns.entries()) {
        text(row[index] ?? '', x + 3, cursor + 3, { size: 8.5, width: entry.width - 6, align: entry.align })
        x += entry.width
      }
      cursor += height
      pdf.save().moveTo(left, cursor).lineTo(right, cursor).lineWidth(0.4).strokeColor(RULE).stroke().restore()
    }
    return cursor
  }

  for (const section of papers.sections) {
    if (y + heightOf(section.heading, width, BOLD, 10.5) + 24 > bottom()) y = newPage()
    y = text(section.heading, left, y, { font: BOLD, size: 10.5, width })
    pdf.save().moveTo(left, y + 1).lineTo(right, y + 1).lineWidth(0.6).strokeColor(RULE).stroke().restore()
    y += 5
    for (const line of section.lines) {
      if (y + heightOf(line, width, REGULAR, 9) > bottom()) y = newPage()
      y = text(line, left, y, { size: 9, width }) + 2
    }
    if (section.table) y = table(y, section.table) + 2
    y += 10
  }

  // The box label at the foot of the last page (a new page when it does not fit), behind a dashed cut line.
  if (y + LABEL_HEIGHT + 14 > bottom()) newPage()
  const top = bottom() - LABEL_HEIGHT
  pdf.save().moveTo(left, top - 8).lineTo(right, top - 8).lineWidth(0.6).dash(4, { space: 3 }).strokeColor(MUTED).stroke().undash().restore()
  text(papers.label.cut, left, top - 18, { size: 7, color: MUTED, width, align: 'right' })
  pdf.save().rect(left, top, width, LABEL_HEIGHT).lineWidth(1).strokeColor('#000000').stroke().restore()
  const inner = width - 24
  let ly = text(papers.label.heading, left + 12, top + 10, { font: BOLD, size: 11, width: inner })
  ly = barcode(left + 12, ly + 6, inner, 60, 14) + 6
  for (const line of papers.label.lines) ly = text(line, left + 12, ly, { font: line === papers.label.lines[0] ? BOLD : REGULAR, size: line === papers.label.lines[0] ? 12 : 9.5, width: inner }) + 1

  const range = pdf.bufferedPageRange()
  for (let index = range.start; index < range.start + range.count; index++) {
    pdf.switchToPage(index)
    const savedBottom = pdf.page.margins.bottom
    pdf.page.margins.bottom = 0
    const footer = pdf.page.height - FOOTER_TOP
    pdf.save().moveTo(left, footer).lineTo(right, footer).lineWidth(0.4).strokeColor(RULE).stroke().restore()
    text(papers.company.legal, left, footer + 5, { size: 7, color: MUTED, width: width * 0.75 })
    text(papers.page(index - range.start + 1, range.count), left + width * 0.75, footer + 5, { size: 7, color: MUTED, width: width * 0.25, align: 'right' })
    pdf.page.margins.bottom = savedBottom
  }
}
