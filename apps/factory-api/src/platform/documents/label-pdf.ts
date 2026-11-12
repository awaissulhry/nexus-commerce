import PDFDocument from 'pdfkit'
import { code128Bars } from '@nexus/factory-domain/labels/code128'
import { fitText, LABEL_LAYOUT, MAX_LABEL_COPIES, type LaidOutLabel } from '@nexus/factory-domain/labels/zpl'
import { PDF_CREATOR, winAnsi } from './pdf'

/**
 * A label as a PDF, for any printer (plan A1 §3.9 "bundle tickets and hide labels on any printer"; GAP-007's browser
 * fallback): one page the size of the label stock per copy, in the same geometry as the ZPL of factory-domain/labels
 * (LABEL_LAYOUT, hundredths of a millimetre), with the scannable id drawn as Code 128 bars (factory-domain
 * labels/code128.ts) inside a 10-module quiet zone, and as text. The browser prints it at 100 %; nothing is stored.
 */

export interface LabelPage {
  readonly widthMm: number
  readonly heightMm: number
}

/** Hundredths of a millimetre → PDF points (1 inch = 72 points = 2540 hundredths). */
const pt = (hundredths: number): number => (hundredths * 72) / 2540

// B-W2b-289: any label in the layout (a composed scan label, a bin label), or several one after another (the bin labels PDF:
// each label's copies, then the next label's).
export async function renderLabelPdf(given: LaidOutLabel | readonly LaidOutLabel[], page: LabelPage, copies = 1): Promise<Buffer> {
  if (!Number.isSafeInteger(copies) || copies < 1 || copies > MAX_LABEL_COPIES) throw new RangeError(`A label is printed 1 to ${MAX_LABEL_COPIES} times.`)
  const labels: readonly LaidOutLabel[] = Array.isArray(given) ? given : [given as LaidOutLabel]
  const first = labels[0]
  if (!first) throw new RangeError('A label PDF needs at least one label.')
  const size: [number, number] = [pt(page.widthMm * 100), pt(page.heightMm * 100)]
  const pdf = new PDFDocument({
    size,
    margin: 0,
    autoFirstPage: false,
    compress: true,
    lang: first.language,
    info: { Title: winAnsi(`${first.heading} ${first.scanId}`), Creator: PDF_CREATOR, Producer: PDF_CREATOR, CreationDate: new Date(0) },
  })
  const chunks: Buffer[] = []
  pdf.on('data', (chunk: Buffer) => chunks.push(chunk))
  const ended = new Promise<void>((resolve, reject) => {
    pdf.on('end', () => resolve())
    pdf.on('error', reject)
  })

  const L = LABEL_LAYOUT
  const margin = pt(L.margin)
  const inner = size[0] - 2 * margin
  const line = (value: string, x: number, y: number, height: number, width: number, bold = false): void => {
    // A character is about 0.55 of the font height wide, as for the printer's font 0 (fitText).
    pdf.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(height).fillColor('#000000')
    pdf.text(winAnsi(fitText(value, Math.round(width), Math.round(height))), x, y, { width, lineBreak: false, height: height * 1.2 })
  }

  for (const label of labels) {
    const symbol = code128Bars(label.scanId)
    // 0.25 mm modules (the margin is the 10-module quiet zone), narrower when the symbol would not fit between the margins.
    const module = Math.min(pt(L.barcode.module), inner / symbol.modules)
    for (let copy = 0; copy < copies; copy++) {
      pdf.addPage({ size, margin: 0 })
      line(label.heading, margin, pt(L.heading.y), pt(L.heading.size), inner)
      line(label.title, margin, pt(L.title.y), pt(L.title.size), inner, true)
      for (const bar of symbol.bars) pdf.rect(margin + bar.x * module, pt(L.barcode.y), bar.width * module, pt(L.barcode.height)).fill('#000000')
      line(label.scanId, margin, pt(L.code.y), pt(L.code.size), inner, true)
      const column = inner / L.fields.perRow
      label.fields.forEach((field, index) => {
        const x = margin + (index % L.fields.perRow) * column
        const y = pt(L.fields.y + Math.floor(index / L.fields.perRow) * L.fields.rowHeight)
        line(field.label, x, y, pt(L.fields.labelSize), column - margin)
        line(field.value, x, y + pt(L.fields.valueOffset), pt(L.fields.valueSize), column - margin, true)
      })
    }
  }
  pdf.end()
  await ended
  return Buffer.concat(chunks)
}
