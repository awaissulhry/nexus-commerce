import PDFDocument from 'pdfkit'
import type { RenderedLabel } from '@nexus/factory-domain/compliance/labels/render'
import { hundredthsOf, LAYOUT_PRESETS } from '@nexus/factory-domain/compliance/labels/rules'
import { barHeight, blockPositions, graphicHeight } from '@nexus/factory-domain/compliance/labels/zpl'
import { code128Bars } from '@nexus/factory-domain/labels/code128'
import { PDF_CREATOR, winAnsi } from '../../../platform/documents/pdf'

/**
 * The garment label as a PDF page of the label's size (B-W1-19; the browser's fallback and the proof on paper, design 02
 * `lb-sheet`), in the geometry of factory-domain compliance/labels/zpl.ts (hundredths of a millimetre): the CE mark, the
 * pictogram's box with the standard and the class, the care symbols' boxes (stand-ins until the licensed artwork, W2b),
 * the batch number or serial as Code 128 bars (a preview's empty bar row as a box), the text lines, and a sample's black SAMPLE band across the middle. pdfkit's standard fonts, a fixed creation date:
 * the same label gives the same bytes. Stored nowhere.
 */

/** Hundredths of a millimetre → PDF points (1 inch = 72 points = 2540 hundredths). */
const pt = (hundredths: number): number => (hundredths * 72) / 2540

export async function renderGarmentLabelPdf(label: RenderedLabel): Promise<Buffer> {
  const width = label.fit ? hundredthsOf(label.fit.widthMm) : null
  const height = label.fit ? hundredthsOf(label.fit.heightMm) : null
  if (width === null || height === null) throw new RangeError('The label has no readable size.')
  const size: [number, number] = [pt(width), pt(height)]
  const pdf = new PDFDocument({
    size,
    margin: 0,
    autoFirstPage: false,
    compress: true,
    lang: label.languages[0] ?? 'it',
    info: { Title: winAnsi(`${label.template.code} r${label.template.revision}${label.sample ? ' SAMPLE' : ''}`), Creator: PDF_CREATOR, Producer: PDF_CREATOR, CreationDate: new Date(0) },
  })
  const chunks: Buffer[] = []
  pdf.on('data', (chunk: Buffer) => chunks.push(chunk))
  const ended = new Promise<void>((resolve, reject) => {
    pdf.on('end', () => resolve())
    pdf.on('error', reject)
  })

  const preset = LAYOUT_PRESETS[label.preset]
  const inner = pt(width - 2 * preset.margin)
  const write = (value: string, x: number, y: number, hundredths: number, options: { bold?: boolean; colour?: string; width?: number } = {}): void => {
    pdf.font(options.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(pt(hundredths)).fillColor(options.colour ?? '#000000')
    pdf.text(winAnsi(value), pt(x), pt(y), { width: options.width ?? inner, lineBreak: false, height: pt(hundredths) * 1.2 })
  }

  pdf.addPage({ size, margin: 0 })
  const positions = blockPositions(label)
  label.blocks.forEach((block, index) => {
    const { x, y } = positions[index]!
    const graphic = block.graphic
    if (graphic?.kind === 'CE') {
      write('CE', x, y, preset.ce, { bold: true })
      if (graphic.notifiedBodyNumber) write(graphic.notifiedBodyNumber, x + Math.round(preset.ce * 1.5), y + Math.round(preset.ce * 0.4), Math.round(preset.ce * 0.55), { bold: true })
    } else if (graphic?.kind === 'PICTOGRAM') {
      const side = preset.pictogram
      pdf.lineWidth(pt(20)).rect(pt(x), pt(y), pt(side), pt(side)).stroke('#000000')
      write(graphic.standardCode ?? '', x + 60, y + 60, Math.round(side * 0.16), { width: pt(side - 120) })
      if (graphic.ppeClass) write(graphic.ppeClass, x + 80, y + Math.round(side * 0.42), Math.round(side * 0.45), { bold: true, width: pt(side - 160) })
    } else if (graphic?.kind === 'CARE') {
      const side = preset.care
      graphic.symbols.forEach((symbol, at) => {
        const left = x + at * (side + 80)
        pdf.lineWidth(pt(20)).rect(pt(left), pt(y), pt(side), pt(side)).stroke('#000000')
        write(symbol.mark, left + 40, y + Math.round(side * 0.3), Math.round(side * 0.4), { width: pt(side - 60) })
      })
    } else if (graphic?.kind === 'BARCODE') {
      const span = width - 2 * preset.margin
      if (graphic.value === null) pdf.lineWidth(pt(20)).rect(pt(x), pt(y), pt(span), pt(barHeight(preset))).stroke('#000000')
      else {
        // 0.25 mm modules, narrower when the symbol would not fit between the margins (as the scan labels' PDF).
        const symbol = code128Bars(graphic.value)
        const module = Math.min(pt(25), pt(span) / symbol.modules)
        for (const bar of symbol.bars) pdf.rect(pt(x) + bar.x * module, pt(y), bar.width * module, pt(barHeight(preset))).fill('#000000')
      }
    }
    let lineY = y + graphicHeight(block, preset)
    for (const line of block.lines) {
      write(line.text, x, lineY, preset.text)
      lineY += preset.line
    }
  })

  if (label.banner.length > 0) {
    const band = label.banner.length * preset.line + 2 * preset.gap + 100
    const top = Math.max(0, Math.round((height - band) / 2))
    pdf.rect(0, pt(top), pt(width), pt(band)).fill('#000000')
    label.banner.forEach((line, at) => write(line, preset.margin, top + preset.gap + 50 + at * preset.line, preset.text, { bold: true, colour: '#FFFFFF' }))
  }
  pdf.end()
  await ended
  return Buffer.concat(chunks)
}
