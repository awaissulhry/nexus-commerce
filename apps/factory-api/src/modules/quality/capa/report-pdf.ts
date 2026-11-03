import PDFDocument from 'pdfkit'
import type { EightDReport, EightDTable } from '@nexus/factory-domain/quality/capa/report'
import { PDF_CREATOR, winAnsi } from '../../../platform/documents/pdf'

/**
 * The 8D report on A4 (B-W2b-108; QHS-094), painted from factory-domain quality/capa/report's words with pdfkit's standard
 * fonts (the documents platform's WinAnsi rule: a character the fonts lack prints as "?"). The same report gives the same
 * bytes (no clock read here: the creation date is the report's date). Our company and its art. 2250 c.c. lines at the top,
 * the facts in two columns, the eight disciplines each with its heading, lines and table, the legal footer and the page on
 * every page.
 */

const REGULAR = 'Helvetica'
const BOLD = 'Helvetica-Bold'
const TEXT = '#111111'
const MUTED = '#555555'
const RULE = '#9a9a9a'
const SHADE = '#ececec'
const MARGIN = { top: 40, bottom: 60, left: 42, right: 42 } as const
const FOOTER_TOP = 50

/** The report's PDF. */
export async function renderEightD(report: EightDReport): Promise<Buffer> {
  const pdf = new PDFDocument({
    size: 'A4',
    margins: MARGIN,
    bufferPages: true,
    compress: true,
    lang: report.language,
    displayTitle: true,
    info: { Title: winAnsi(report.meta.title), Subject: winAnsi(report.meta.subject), Creator: PDF_CREATOR, Producer: PDF_CREATOR, CreationDate: new Date(report.meta.createdAt) },
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

function paint(pdf: PDFKit.PDFDocument, report: EightDReport): void {
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
    return text(`${report.company.name} · ${report.title} · ${report.facts[0]?.value ?? ''}`, left, MARGIN.top, { size: 8, color: MUTED, width }) + 8
  }

  // Our company and its lines on the left, the title on the right.
  const companyWidth = Math.round(width * 0.55)
  let y: number = MARGIN.top
  y = text(report.company.name, left, y, { font: BOLD, size: 12, width: companyWidth })
  for (const line of report.company.lines) y = text(line, left, y + 0.5, { size: 7.5, color: MUTED, width: companyWidth })
  const titleLeft = left + companyWidth + 12
  const titleY = text(report.title, titleLeft, MARGIN.top, { font: BOLD, size: 14, width: right - titleLeft, align: 'right' })
  y = Math.max(y, titleY) + 10

  if (report.sample) {
    const height = heightOf(report.sample, width - 12, BOLD, 10) + 10
    pdf.save().rect(left, y, width, height).fillColor('#fde8e8').fill().restore()
    text(report.sample, left + 6, y + 5, { font: BOLD, size: 10, color: '#a40000', width: width - 12, align: 'center' })
    y += height + 8
  }

  // The facts, two columns of label → value.
  const half = (width - 16) / 2
  const column = (index: number) => left + (index % 2) * (half + 16)
  for (let index = 0; index < report.facts.length; index += 2) {
    let rowBottom = y
    for (const offset of [0, 1]) {
      const fact = report.facts[index + offset]
      if (!fact) continue
      const x = column(offset)
      text(fact.label, x, y, { size: 7.5, color: MUTED, width: half * 0.34 })
      const end = Math.max(y + heightOf(fact.label, half * 0.34, REGULAR, 7.5), text(fact.value, x + half * 0.36, y, { font: BOLD, size: 8.5, width: half * 0.64 }))
      rowBottom = Math.max(rowBottom, end)
    }
    y = rowBottom + 3
  }
  y += 8

  const table = (at: number, spec: EightDTable): number => {
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

  for (const section of report.sections) {
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
    text(report.company.legal, left, top + 4, { size: 6.5, color: MUTED, width: width - 90 })
    text(report.page(index - range.start + 1, range.count), right - 86, top + 4, { size: 7.5, color: MUTED, width: 86, align: 'right' })
    pdf.page.margins.bottom = savedBottom
  }
}
