import PDFDocument from 'pdfkit'
import { PDF_CREATOR, winAnsi } from '../../../platform/documents/pdf'

/**
 * A generated leaflet's paper (B-W2b-258), painted on A4 portrait with pdfkit's standard fonts (the documents platform's
 * WinAnsi rule: a character the standard fonts lack prints as "?"): across every page the draft words of GATE-PPE-TEXTS,
 * then each section in the template's order — the first (the product) in bold as the leaflet's heading, each section's own
 * words naming what it is about. Painted on demand, never kept: a draft's PDF is a preview (the kept leaflet stays W1's
 * signed upload until a PPE consultant has checked the texts).
 */

const REGULAR = 'Helvetica'
const BOLD = 'Helvetica-Bold'
const TEXT = '#111111'
const MUTED = '#555555'
const RULE = '#9a9a9a'
const MARGIN = { top: 56, bottom: 60, left: 48, right: 48 } as const
const FOOTER_TOP = 46

export interface LeafletPaper {
  readonly language: string
  readonly title: string
  readonly banner: string
  readonly sections: readonly { readonly key: string; readonly text: string }[]
  readonly footer: string
  readonly createdAt: Date
}

/** A generated leaflet draft's PDF. */
export async function renderLeaflet(paper: LeafletPaper): Promise<Buffer> {
  const pdf = new PDFDocument({
    size: 'A4',
    margins: MARGIN,
    bufferPages: true,
    compress: true,
    lang: paper.language,
    displayTitle: true,
    info: { Title: winAnsi(paper.title), Subject: winAnsi(paper.banner), Creator: PDF_CREATOR, Producer: PDF_CREATOR, CreationDate: paper.createdAt },
  })
  const chunks: Buffer[] = []
  pdf.on('data', (chunk: Buffer) => chunks.push(chunk))
  const ended = new Promise<void>((resolve, reject) => {
    pdf.on('end', () => resolve())
    pdf.on('error', reject)
  })
  const left = MARGIN.left
  const width = pdf.page.width - MARGIN.left - MARGIN.right
  const heightOf = (value: string, font: string, size: number, at = width): number => pdf.font(font).fontSize(size).heightOfString(winAnsi(value), { width: at, lineGap: 1.5 })

  const banner = (): void => {
    const height = heightOf(paper.banner, BOLD, 9, width - 12) + 10
    pdf.save().rect(left, MARGIN.top - 36, width, height).fillColor('#fde8e8').fill().restore()
    pdf.font(BOLD).fontSize(9).fillColor('#a40000').text(winAnsi(paper.banner), left + 6, MARGIN.top - 31, { width: width - 12, align: 'center', lineGap: 1.5 })
    pdf.font(REGULAR).fontSize(10).fillColor(TEXT)
    pdf.x = left
    pdf.y = MARGIN.top - 36 + height + 10
  }
  pdf.on('pageAdded', banner)
  banner()

  let y = pdf.y + 6
  paper.sections.forEach((section, index) => {
    const heading = index === 0
    const font = heading ? BOLD : REGULAR
    const size = heading ? 12 : 10.5
    for (const paragraph of section.text.split('\n').filter((line) => line.trim() !== '')) {
      const height = heightOf(paragraph, font, size)
      if (y + Math.min(height, 120) > pdf.page.height - MARGIN.bottom) {
        pdf.addPage()
        y = pdf.y
      }
      pdf.font(font).fontSize(size).fillColor(TEXT).text(winAnsi(paragraph), left, y, { width, lineGap: 1.5 })
      y = pdf.y + 4
    }
    y += heading ? 10 : 6
  })

  const range = pdf.bufferedPageRange()
  for (let page = range.start; page < range.start + range.count; page++) {
    pdf.switchToPage(page)
    const right = pdf.page.width - MARGIN.right
    const savedBottom = pdf.page.margins.bottom
    pdf.page.margins.bottom = 0
    const top = pdf.page.height - FOOTER_TOP
    pdf.save().moveTo(left, top).lineTo(right, top).lineWidth(0.4).strokeColor(RULE).stroke().restore()
    pdf.font(REGULAR).fontSize(7).fillColor(MUTED).text(winAnsi(paper.footer), left, top + 5, { width: right - left - 100, lineGap: 1 })
    pdf.font(REGULAR).fontSize(7.5).fillColor(MUTED).text(`${page - range.start + 1} / ${range.count}`, right - 96, top + 5, { width: 96, align: 'right' })
    pdf.page.margins.bottom = savedBottom
  }
  pdf.end()
  await ended
  return Buffer.concat(chunks)
}
