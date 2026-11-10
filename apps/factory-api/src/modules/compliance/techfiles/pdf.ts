import PDFDocument from 'pdfkit'
import type { PackPaper, PaperTable } from '@nexus/factory-domain/compliance/techfiles/paper'
import { PDF_CREATOR, winAnsi } from '../../../platform/documents/pdf'

/**
 * The evidence pack's PDF on A4 (B-W2b-251; PRD-299), painted from factory-domain compliance/techfiles/paper's words with
 * pdfkit's standard fonts (the documents platform's WinAnsi rule: a character the fonts lack prints as "?"). The same paper
 * gives the same bytes (no clock read here: the creation date is the pack's build time). The company and its art. 2250 c.c.
 * lines at the top, the title on the right, the cover facts in two columns, then the contents and the chosen sections with
 * their tables (the header repeats on a new page), the legal footer and the page on every page.
 */

const REGULAR = 'Helvetica'
const BOLD = 'Helvetica-Bold'
const TEXT = '#111111'
const MUTED = '#555555'
const RULE = '#9a9a9a'
const SHADE = '#ececec'
const MARGIN = { top: 40, bottom: 60, left: 42, right: 42 } as const
const FOOTER_TOP = 50

/** The pack's PDF. */
export async function renderPackPdf(paper: PackPaper): Promise<Buffer> {
  const pdf = new PDFDocument({
    size: 'A4',
    margins: MARGIN,
    bufferPages: true,
    compress: true,
    lang: paper.language,
    displayTitle: true,
    info: { Title: winAnsi(paper.meta.title), Subject: winAnsi(paper.meta.subject), Creator: PDF_CREATOR, Producer: PDF_CREATOR, CreationDate: new Date(paper.meta.createdAt) },
  })
  const chunks: Buffer[] = []
  pdf.on('data', (chunk: Buffer) => chunks.push(chunk))
  const ended = new Promise<void>((resolve, reject) => {
    pdf.on('end', () => resolve())
    pdf.on('error', reject)
  })
  paint(pdf, paper)
  pdf.end()
  await ended
  return Buffer.concat(chunks)
}

function paint(pdf: PDFKit.PDFDocument, paper: PackPaper): void {
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
    return text(`${paper.company.name} · ${paper.title}`, left, MARGIN.top, { size: 8, color: MUTED, width }) + 8
  }

  // The company and its lines on the left, the title on the right.
  const companyWidth = Math.round(width * 0.55)
  let y: number = MARGIN.top
  y = text(paper.company.name, left, y, { font: BOLD, size: 12, width: companyWidth })
  for (const line of paper.company.lines) y = text(line, left, y + 0.5, { size: 7.5, color: MUTED, width: companyWidth })
  const titleLeft = left + companyWidth + 12
  const titleY = text(paper.title, titleLeft, MARGIN.top, { font: BOLD, size: 14, width: right - titleLeft, align: 'right' })
  y = Math.max(y, titleY) + 10

  // The cover facts: label → value, one per line (the fingerprint is long).
  for (const fact of paper.facts) {
    if (y + 14 > bottom()) y = newPage()
    if (fact.label === '') {
      y = text(fact.value, left, y + 2, { font: BOLD, size: 9, width }) + 2
      continue
    }
    const labelWidth = width * 0.28
    text(fact.label, left, y, { size: 8, color: MUTED, width: labelWidth })
    const end = Math.max(y + heightOf(fact.label, labelWidth, REGULAR, 8), text(fact.value, left + labelWidth + 6, y, { font: BOLD, size: 8.5, width: width - labelWidth - 6 }))
    y = end + 2
  }
  y += 10

  const table = (at: number, spec: PaperTable): number => {
    const columns = spec.columns.map((entry) => ({ ...entry, width: width * entry.width }))
    const header = (top: number): number => {
      const height = Math.max(...columns.map((entry) => heightOf(entry.label, entry.width - 6, BOLD, 7.5))) + 6
      pdf.save().rect(left, top, width, height).fillColor(SHADE).fill().restore()
      let x = left
      for (const entry of columns) {
        text(entry.label, x + 3, top + 3, { font: BOLD, size: 7.5, width: entry.width - 6, align: entry.align })
        x += entry.width
      }
      return top + height
    }
    let cursor = header(at)
    for (const row of spec.rows) {
      const height = Math.max(...columns.map((entry, index) => heightOf(row[index] ?? '', entry.width - 6, REGULAR, 7.5))) + 6
      if (cursor + height > bottom()) cursor = header(newPage())
      let x = left
      for (const [index, entry] of columns.entries()) {
        text(row[index] ?? '', x + 3, cursor + 3, { size: 7.5, width: entry.width - 6, align: entry.align })
        x += entry.width
      }
      cursor += height
      pdf.save().moveTo(left, cursor).lineTo(right, cursor).lineWidth(0.4).strokeColor(RULE).stroke().restore()
    }
    return cursor
  }

  for (const section of paper.sections) {
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

  const range = pdf.bufferedPageRange()
  for (let index = range.start; index < range.start + range.count; index++) {
    pdf.switchToPage(index)
    const savedBottom = pdf.page.margins.bottom
    pdf.page.margins.bottom = 0
    const top = pdf.page.height - FOOTER_TOP
    pdf.save().moveTo(left, top).lineTo(right, top).lineWidth(0.4).strokeColor(RULE).stroke().restore()
    text(paper.company.legal, left, top + 4, { size: 6.5, color: MUTED, width: width - 90 })
    text(paper.page(index - range.start + 1, range.count), right - 86, top + 4, { size: 7.5, color: MUTED, width: 86, align: 'right' })
    pdf.page.margins.bottom = savedBottom
  }
}
