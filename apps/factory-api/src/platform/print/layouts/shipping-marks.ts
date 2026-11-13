import PDFDocument from 'pdfkit'
import type { Issue } from '@nexus/factory-domain/core/errors'
import { code128Bars } from '@nexus/factory-domain/labels/code128'
import { dotsOf, fitText, LABEL_DPIS, MAX_LABEL_COPIES, MAX_LABEL_MM, MIN_LABEL_WIDTH_MM, zplText, type LabelStock } from '@nexus/factory-domain/labels/zpl'
import type { CartonMarks } from '@nexus/factory-domain/shipping/cartons/marks'
import { PDF_CREATOR, winAnsi } from '../../documents/pdf'

/**
 * A carton's shipping marks laid out (B-W2b-384; LOG-013; design floor.pack "Close carton … prints its marks"): the heading
 * ("Collo · <maker>"), the big "Collo 2 di 3", the carton's code as Code 128 bars and as text, then each field of the
 * customer's template as a row across the whole width — its label, then its lines (an address takes several). The marks are
 * composed in factory-domain shipping/cartons/marks.ts; here they become
 *
 *   marksZpl     ZPL for a label printer of the shipment's site (the carton routes queue it as a print job of the Parcel,
 *                label kind CARTON), the stock as tall as the marks need (marksStockProblems says when it is not)
 *   marksPdf     the marks of one or more cartons as one PDF for any printer (the browser prints it at 100 %), each page
 *                MARKS_PAGE_WIDTH_MM wide and as tall as its marks; stored nowhere
 *
 * The geometry is in hundredths of a millimetre, as factory-domain labels/zpl's LABEL_LAYOUT; text goes through ^FH, so a
 * value never starts a ZPL command.
 */

export const MARKS_LAYOUT = Object.freeze({
  margin: 250,
  heading: { y: 250, size: 250 },
  title: { y: 600, size: 500 },
  barcode: { y: 1250, height: 1000, module: 25 },
  code: { y: 2350, size: 300 },
  rows: { y: 2900, labelSize: 200, valueSize: 320, valueStep: 380, labelGap: 230, after: 150 },
})

/** The width of a marks PDF page (a 100 mm label). */
export const MARKS_PAGE_WIDTH_MM = 100

/** The height the marks take, in hundredths of a millimetre (the rows and a bottom margin). */
function marksHeight(marks: CartonMarks): number {
  const L = MARKS_LAYOUT
  return marks.rows.reduce((y, row) => y + L.rows.labelGap + row.lines.length * L.rows.valueStep + L.rows.after, L.rows.y) + L.margin
}

/** The smallest stock height the marks fit, in whole millimetres. */
export const marksHeightMm = (marks: CartonMarks): number => Math.ceil(marksHeight(marks) / 100)

/** What is wrong with a label printer's stock for these marks (empty when they fit). */
export function marksStockProblems(marks: CartonMarks, stock: LabelStock, at = 'body/printerId'): Issue[] {
  const problems: Issue[] = []
  if (!(LABEL_DPIS as readonly number[]).includes(stock.dpi)) problems.push({ path: at, message: `A label printer prints at ${LABEL_DPIS.join(', ')} dpi.` })
  const needed = marksHeightMm(marks)
  if (stock.widthMm < MIN_LABEL_WIDTH_MM || stock.widthMm > MAX_LABEL_MM || stock.heightMm < needed || stock.heightMm > MAX_LABEL_MM) {
    problems.push({ path: at, message: `These marks need a label at least ${MIN_LABEL_WIDTH_MM} mm wide and ${needed} mm high: choose a printer with such labels, or print the PDF.` })
  }
  return problems
}

/** Each row's label and value lines, with their tops, in hundredths of a millimetre. */
function rowsLaidOut(marks: CartonMarks): { label: { text: string; y: number }; values: { text: string; y: number }[] }[] {
  const L = MARKS_LAYOUT.rows
  let y = L.y
  return marks.rows.map((row) => {
    const laid = { label: { text: row.label, y }, values: row.lines.map((line, index) => ({ text: line, y: y + L.labelGap + index * L.valueStep })) }
    y += L.labelGap + row.lines.length * L.valueStep + L.after
    return laid
  })
}

/**
 * The ZPL of a carton's marks on the stock, `copies` times. Throws a RangeError for a stock the marks do not fit or a copy
 * count out of range (the carton routes check both first).
 */
export function marksZpl(marks: CartonMarks, stock: LabelStock, copies = 1): string {
  const problems = marksStockProblems(marks, stock)
  if (problems.length > 0) throw new RangeError(problems.map((problem) => problem.message).join(' '))
  if (!Number.isSafeInteger(copies) || copies < 1 || copies > MAX_LABEL_COPIES) throw new RangeError(`Marks are printed 1 to ${MAX_LABEL_COPIES} times.`)
  const L = MARKS_LAYOUT
  const dots = (hundredths: number): number => dotsOf(hundredths, stock.dpi)
  const width = dots(stock.widthMm * 100)
  const margin = dots(L.margin)
  const inner = width - 2 * margin
  const module = Math.max(2, dots(L.barcode.module))
  const barHeight = dots(L.barcode.height)
  const text = (y: number, size: number, value: string): string => {
    const height = dots(size)
    return `^FO${margin},${dots(y)}^A0N,${height},${height}^FH^FD${zplText(fitText(value, inner, height))}^FS`
  }
  const commands = [
    '^XA',
    '^CI28',
    `^PW${width}`,
    `^LL${dots(stock.heightMm * 100)}`,
    '^LH0,0',
    text(L.heading.y, L.heading.size, marks.heading),
    text(L.title.y, L.title.size, marks.title),
    `^FO${margin},${dots(L.barcode.y)}^BY${module},3,${barHeight}^BCN,${barHeight},N,N,N^FH^FD${zplText(marks.code)}^FS`,
    text(L.code.y, L.code.size, marks.code),
  ]
  for (const row of rowsLaidOut(marks)) {
    commands.push(text(row.label.y, L.rows.labelSize, row.label.text))
    for (const value of row.values) commands.push(text(value.y, L.rows.valueSize, value.text))
  }
  commands.push(`^PQ${copies}`, '^XZ')
  return `${commands.join('\n')}\n`
}

/** Hundredths of a millimetre → PDF points. */
const pt = (hundredths: number): number => (hundredths * 72) / 2540

/** The marks of the cartons as one PDF: each carton's copies, then the next; a page per copy, as tall as its marks. */
export async function marksPdf(all: readonly CartonMarks[], copies = 1): Promise<Buffer> {
  if (!Number.isSafeInteger(copies) || copies < 1 || copies > MAX_LABEL_COPIES) throw new RangeError(`Marks are printed 1 to ${MAX_LABEL_COPIES} times.`)
  const first = all[0]
  if (!first) throw new RangeError('A marks PDF needs the marks of at least one carton.')
  const pdf = new PDFDocument({
    margin: 0,
    autoFirstPage: false,
    compress: true,
    lang: first.language,
    info: { Title: winAnsi(`${first.title} ${first.code}`), Creator: PDF_CREATOR, Producer: PDF_CREATOR, CreationDate: new Date(0) },
  })
  const chunks: Buffer[] = []
  pdf.on('data', (chunk: Buffer) => chunks.push(chunk))
  const ended = new Promise<void>((resolve, reject) => {
    pdf.on('end', () => resolve())
    pdf.on('error', reject)
  })
  const L = MARKS_LAYOUT
  const width = pt(MARKS_PAGE_WIDTH_MM * 100)
  const margin = pt(L.margin)
  const inner = width - 2 * margin
  const line = (value: string, y: number, size: number, bold = false): void => {
    pdf.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(pt(size)).fillColor('#000000')
    pdf.text(winAnsi(fitText(value, Math.round(inner), Math.round(pt(size)))), margin, pt(y), { width: inner, lineBreak: false, height: pt(size) * 1.2 })
  }
  for (const marks of all) {
    const size: [number, number] = [width, pt(marksHeight(marks))]
    const symbol = code128Bars(marks.code)
    const module = Math.min(pt(L.barcode.module), inner / symbol.modules)
    for (let copy = 0; copy < copies; copy++) {
      pdf.addPage({ size, margin: 0 })
      line(marks.heading, L.heading.y, L.heading.size)
      line(marks.title, L.title.y, L.title.size, true)
      for (const bar of symbol.bars) pdf.rect(margin + bar.x * module, pt(L.barcode.y), bar.width * module, pt(L.barcode.height)).fill('#000000')
      line(marks.code, L.code.y, L.code.size, true)
      for (const row of rowsLaidOut(marks)) {
        line(row.label.text, row.label.y, L.rows.labelSize)
        for (const value of row.values) line(value.text, value.y, L.rows.valueSize, true)
      }
    }
  }
  pdf.end()
  await ended
  return Buffer.concat(chunks)
}
