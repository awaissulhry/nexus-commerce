import PDFDocument from 'pdfkit'
import type { AnswerReport, ReportTable } from '@nexus/factory-domain/purchasing/questionnaire/report'
import { PDF_CREATOR, winAnsi } from '../../../platform/documents/pdf'

/**
 * The questionnaire's two PDFs on A4 (B-W2b-172), painted from factory-domain purchasing/questionnaire/report's words with
 * pdfkit's standard fonts (the documents platform's WinAnsi rule: a character the fonts lack prints as "?"). The same
 * words give the same bytes (the creation date is the answer's time, never the clock). No money anywhere.
 */

const REGULAR = 'Helvetica'
const BOLD = 'Helvetica-Bold'
const TEXT = '#111111'
const MUTED = '#555555'
const RULE = '#9a9a9a'
const SHADE = '#ececec'
const MARGIN = { top: 40, bottom: 60, left: 42, right: 42 } as const
const FOOTER_TOP = 50

async function painted(info: { title: string; language: string; createdAt: Date }, paint: (pdf: PDFKit.PDFDocument) => void): Promise<Buffer> {
  const pdf = new PDFDocument({
    size: 'A4',
    margins: MARGIN,
    bufferPages: true,
    compress: true,
    lang: info.language,
    displayTitle: true,
    info: { Title: winAnsi(info.title), Creator: PDF_CREATOR, Producer: PDF_CREATOR, CreationDate: info.createdAt },
  })
  const chunks: Buffer[] = []
  pdf.on('data', (chunk: Buffer) => chunks.push(chunk))
  const ended = new Promise<void>((resolve, reject) => {
    pdf.on('end', () => resolve())
    pdf.on('error', reject)
  })
  paint(pdf)
  pdf.end()
  await ended
  return Buffer.concat(chunks)
}

/** Helpers over one document: text that returns where it ended, its height, a new page with the running head. */
function painter(pdf: PDFKit.PDFDocument, head: string) {
  const left = MARGIN.left
  const right = pdf.page.width - MARGIN.right
  const width = right - left
  const bottom = (): number => pdf.page.height - MARGIN.bottom
  const lines = (value: string): string[] => value.split(/\r?\n/)
  const text = (value: string, x: number, y: number, options: PDFKit.Mixins.TextOptions & { font?: string; size?: number; color?: string } = {}): number => {
    const { font = REGULAR, size = 9, color = TEXT, ...rest } = options
    let at = y
    for (const line of lines(value)) {
      pdf.font(font).fontSize(size).fillColor(color).text(winAnsi(line === '' ? ' ' : line), x, at, { lineGap: 1, ...rest })
      at = pdf.y
    }
    return at
  }
  const heightOf = (value: string, w: number, font = REGULAR, size = 9): number => lines(value).reduce((sum, line) => sum + pdf.font(font).fontSize(size).heightOfString(winAnsi(line === '' ? ' ' : line), { width: w, lineGap: 1 }), 0)
  const newPage = (): number => {
    pdf.addPage()
    return text(head, left, MARGIN.top, { size: 8, color: MUTED, width }) + 8
  }
  const rule = (y: number, weight = 0.4) => pdf.save().moveTo(left, y).lineTo(right, y).lineWidth(weight).strokeColor(RULE).stroke().restore()
  const footer = (words: string) => {
    const range = pdf.bufferedPageRange()
    for (let index = range.start; index < range.start + range.count; index++) {
      pdf.switchToPage(index)
      const savedBottom = pdf.page.margins.bottom
      pdf.page.margins.bottom = 0
      const top = pdf.page.height - FOOTER_TOP
      rule(top)
      text(words, left, top + 6, { size: 7.5, color: MUTED, width: width - 60 })
      text(`${index + 1} / ${range.count}`, right - 60, top + 6, { size: 7.5, color: MUTED, width: 60, align: 'right' })
      pdf.page.margins.bottom = savedBottom
    }
  }
  return { left, right, width, bottom, text, heightOf, newPage, rule, footer }
}

/** The supplier's answer, as kept on its files. */
export async function renderAnswerPdf(report: AnswerReport): Promise<Buffer> {
  return painted({ title: report.title, language: report.language, createdAt: new Date(report.createdAt) }, (pdf) => {
    const p = painter(pdf, `${report.company} · ${report.title}`)
    let y: number = MARGIN.top
    y = p.text(report.company, p.left, y, { font: BOLD, size: 12, width: p.width * 0.55 })
    const titleY = p.text(report.title, p.left + p.width * 0.55 + 12, MARGIN.top, { font: BOLD, size: 13, width: p.width * 0.45 - 12, align: 'right' })
    y = Math.max(y, titleY) + 12
    for (const fact of report.facts) {
      const end = Math.max(p.text(fact.label, p.left, y, { size: 8, color: MUTED, width: p.width * 0.22 }), p.text(fact.value, p.left + p.width * 0.24, y, { font: BOLD, size: 9, width: p.width * 0.76 }))
      y = end + 2
    }
    y += 10

    const table = (at: number, spec: ReportTable): number => {
      let cursor = at
      if (cursor + 40 > p.bottom()) cursor = p.newPage()
      cursor = p.text(spec.heading, p.left, cursor, { font: BOLD, size: 9, width: p.width }) + 3
      const share = [0.36, 0.1, 0.22, 0.32]
      const columns = spec.columns.map((label, index) => ({ label, width: p.width * (share[index] ?? 0.25) }))
      const header = (top: number): number => {
        const height = Math.max(...columns.map((entry) => p.heightOf(entry.label, entry.width - 6, BOLD, 8))) + 6
        pdf.save().rect(p.left, top, p.width, height).fillColor(SHADE).fill().restore()
        let x = p.left
        for (const entry of columns) {
          p.text(entry.label, x + 3, top + 3, { font: BOLD, size: 8, width: entry.width - 6 })
          x += entry.width
        }
        return top + height
      }
      cursor = header(cursor)
      if (spec.rows.length === 0) return p.text('—', p.left + 3, cursor + 3, { size: 8.5, width: p.width - 6 }) + 4
      for (const row of spec.rows) {
        const height = Math.max(...columns.map((entry, index) => p.heightOf(row[index] ?? '', entry.width - 6, REGULAR, 8.5))) + 6
        if (cursor + height > p.bottom()) cursor = header(p.newPage())
        let x = p.left
        for (const [index, entry] of columns.entries()) {
          p.text(row[index] ?? '', x + 3, cursor + 3, { size: 8.5, width: entry.width - 6 })
          x += entry.width
        }
        cursor += height
        p.rule(cursor)
      }
      return cursor + 4
    }

    for (const section of report.sections) {
      if (y + 40 > p.bottom()) y = p.newPage()
      y = p.text(section.heading, p.left, y, { font: BOLD, size: 10.5, width: p.width })
      p.rule(y + 1, 0.6)
      y += 6
      for (const row of section.rows) {
        const questionWidth = p.width * 0.48
        const answerWidth = p.width * 0.5
        const height = Math.max(p.heightOf(row.question, questionWidth, REGULAR, 8.5), p.heightOf(row.answer, answerWidth, BOLD, 8.5) + (row.words ? p.heightOf(row.words, answerWidth, REGULAR, 8.5) + 2 : 0)) + 4
        if (y + height > p.bottom()) y = p.newPage()
        p.text(row.question, p.left, y, { size: 8.5, color: MUTED, width: questionWidth })
        let end = p.text(row.answer, p.left + p.width * 0.5, y, { font: BOLD, size: 8.5, width: answerWidth })
        if (row.words) end = p.text(row.words, p.left + p.width * 0.5, end + 2, { size: 8.5, width: answerWidth })
        y = Math.max(y + height, end + 4)
      }
      for (const spec of section.tables) y = table(y, spec) + 2
      y += 8
    }

    if (y + 70 > p.bottom()) y = p.newPage()
    y = p.text(report.statement.heading, p.left, y, { font: BOLD, size: 10.5, width: p.width })
    p.rule(y + 1, 0.6)
    y = p.text(report.statement.text, p.left, y + 6, { size: 9.5, width: p.width })
    p.text(report.statement.signed, p.left, y + 6, { font: BOLD, size: 9.5, width: p.width })
    p.footer(report.footer)
  })
}

/** The code of conduct to read before signing. */
export async function renderCodePdf(code: { readonly title: string; readonly company: string; readonly paragraphs: readonly string[]; readonly language: string }, createdAt: Date): Promise<Buffer> {
  return painted({ title: code.title, language: code.language, createdAt }, (pdf) => {
    const p = painter(pdf, `${code.company} · ${code.title}`)
    let y = p.text(code.company, p.left, MARGIN.top, { font: BOLD, size: 12, width: p.width })
    y = p.text(code.title, p.left, y + 6, { font: BOLD, size: 15, width: p.width }) + 12
    for (const paragraph of code.paragraphs) {
      if (y + p.heightOf(paragraph, p.width, REGULAR, 10) > p.bottom()) y = p.newPage()
      y = p.text(paragraph, p.left, y, { size: 10, width: p.width, align: 'justify' }) + 8
    }
    p.footer(`${code.company} · ${code.title}`)
  })
}
