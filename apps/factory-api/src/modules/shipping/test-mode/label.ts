import PDFDocument from 'pdfkit'
import { fitText, zplText } from '@nexus/factory-domain/labels/zpl'
import type { CarrierLabel, CarrierLabelRequest, LabelDocument, LabelFormat } from '@nexus/factory-domain/ports/carrier'
import { testLabelOf, testLabelText, type TestLabelText } from '@nexus/factory-domain/shipping/test-mode/rules'
import { PDF_CREATOR, winAnsi } from '../../../platform/documents/pdf'

/**
 * The TEST carrier of test mode (B-W2b-390; LOG-035): makes a parcel's label in the process — no gateway call, no Sendcloud
 * connection, nothing sent, nothing charged (factory-domain shipping/test-mode testLabelOf) — and its files: a 100 × 150 mm
 * label as a PDF (any browser prints it) and as ZPL (203 dpi, the bench's label printer). Both say TEST in a large black
 * band, "TEST LABEL - NOT FOR SHIPPING" and that nothing was sent, then the shipment, parcel, tracking number, weight and the
 * two addresses as text. No barcode: no carrier's scanner reads a TEST label as a parcel.
 */

export interface TestCarrier {
  createLabel(request: CarrierLabelRequest): CarrierLabel
  labelDocument(request: CarrierLabelRequest, label: CarrierLabel, format: LabelFormat): Promise<LabelDocument>
}

/** The label stock both files are laid out for (a 4 × 6 inch label at 203 dpi). */
export const TEST_LABEL_STOCK = Object.freeze({ widthMm: 100, heightMm: 150, dpi: 203 })

const DOTS_PER_MM = TEST_LABEL_STOCK.dpi / 25.4
const dots = (mm: number): number => Math.round(mm * DOTS_PER_MM)
const pt = (mm: number): number => (mm * 72) / 25.4

/** The ZPL of a TEST label: a reversed TEST band, the title and notice, then the lines. */
export function testLabelZpl(text: TestLabelText): string {
  const width = dots(TEST_LABEL_STOCK.widthMm)
  const margin = dots(5)
  const inner = width - 2 * margin
  const line = (y: number, sizeMm: number, value: string): string => {
    const height = dots(sizeMm)
    return `^FO${margin},${dots(y)}^A0N,${height},${height}^FH^FD${zplText(fitText(value, inner, height))}^FS`
  }
  const commands = ['^XA', '^CI28', `^PW${width}`, `^LL${dots(TEST_LABEL_STOCK.heightMm)}`, '^LH0,0']
  // The band: a black box with the word reversed out of it.
  commands.push(`^FO${margin},${dots(5)}^GB${inner},${dots(28)},${dots(28)}^FS`, `^FO${margin},${dots(8)}^FR^A0N,${dots(24)},${dots(24)}^FB${inner},1,0,C^FD${text.banner}^FS`)
  commands.push(line(37, 5, text.title), line(44, 3.4, text.notice))
  let y = 54
  for (const value of text.lines) {
    commands.push(line(y, 3.6, value))
    y += 5.2
    if (y > TEST_LABEL_STOCK.heightMm - 8) break
  }
  commands.push(line(TEST_LABEL_STOCK.heightMm - 8, 4, text.title), '^PQ1', '^XZ')
  return `${commands.join('\n')}\n`
}

/** The PDF of a TEST label (one page, the label's size). Same input, same bytes (no dates). */
export async function testLabelPdf(text: TestLabelText): Promise<Buffer> {
  const width = pt(TEST_LABEL_STOCK.widthMm)
  const height = pt(TEST_LABEL_STOCK.heightMm)
  const margin = pt(5)
  const inner = width - 2 * margin
  const pdf = new PDFDocument({ size: [width, height], margin: 0, compress: true, info: { Title: winAnsi(text.title), Creator: PDF_CREATOR, Producer: PDF_CREATOR, CreationDate: new Date(0) } })
  const chunks: Buffer[] = []
  pdf.on('data', (chunk: Buffer) => chunks.push(chunk))
  const ended = new Promise<void>((resolve, reject) => {
    pdf.on('end', () => resolve())
    pdf.on('error', reject)
  })
  pdf.rect(margin, pt(5), inner, pt(28)).fill('#000000')
  pdf.font('Helvetica-Bold').fontSize(pt(22)).fillColor('#ffffff').text(text.banner, margin, pt(8), { width: inner, align: 'center', lineBreak: false })
  const line = (value: string, y: number, sizeMm: number, bold = false): void => {
    pdf.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(pt(sizeMm)).fillColor('#000000')
    pdf.text(winAnsi(value), margin, pt(y), { width: inner, lineBreak: false, ellipsis: true, height: pt(sizeMm) * 1.3 })
  }
  line(text.title, 37, 5, true)
  line(text.notice, 44, 3.2)
  let y = 54
  for (const value of text.lines) {
    line(value, y, 3.6)
    y += 5.2
    if (y > TEST_LABEL_STOCK.heightMm - 8) break
  }
  line(text.title, TEST_LABEL_STOCK.heightMm - 8, 4, true)
  pdf.end()
  await ended
  return Buffer.concat(chunks)
}

/** The TEST carrier (one per process; it keeps nothing). */
export const testCarrier: TestCarrier = Object.freeze({
  createLabel: (request: CarrierLabelRequest) => testLabelOf(request),
  async labelDocument(request: CarrierLabelRequest, label: CarrierLabel, format: LabelFormat): Promise<LabelDocument> {
    const text = testLabelText(request, label)
    return format === 'PDF' ? { format, body: new Uint8Array(await testLabelPdf(text)) } : { format, body: new TextEncoder().encode(testLabelZpl(text)) }
  },
})
