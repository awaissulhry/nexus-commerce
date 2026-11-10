import PDFDocument from 'pdfkit'
import { create as createQr } from 'qrcode'
import type { PackPaper } from '@nexus/factory-domain/compliance/declarations/pack'
import { PDF_CREATOR, winAnsi } from '../../../platform/documents/pdf'

/**
 * The DoC generator's two papers (B-W2b-257), painted on A4 portrait with pdfkit's standard fonts (the documents platform's
 * WinAnsi rule: a character the standard fonts lack prints as "?"):
 *
 *   renderDeclaration  a generated DoC draft as it would print: the title and number in its language, the nine Annex IX
 *                      points, and across every page the draft words of GATE-PPE-TEXTS (never a signature field: a generated
 *                      DoC is not signed here). Painted on demand, never kept: a draft's PDF is a preview.
 *   renderPack         a shipment's compliance pack summary: the facts, the contents with each file's SHA-256, per style its
 *                      documents, the certificate in summary and the batches with the QR of their public DoC address.
 */

const REGULAR = 'Helvetica'
const BOLD = 'Helvetica-Bold'
const TEXT = '#111111'
const MUTED = '#555555'
const RULE = '#9a9a9a'
const BAND = '#1f2937'
const MARGIN = { top: 56, bottom: 60, left: 48, right: 48 } as const
const FOOTER_TOP = 46

type TextOptions = PDFKit.Mixins.TextOptions & { font?: string; size?: number; color?: string }

function open(meta: { title: string; subject: string; language: string; createdAt: Date }) {
  const pdf = new PDFDocument({
    size: 'A4',
    margins: MARGIN,
    bufferPages: true,
    compress: true,
    lang: meta.language,
    displayTitle: true,
    info: { Title: winAnsi(meta.title), Subject: winAnsi(meta.subject), Creator: PDF_CREATOR, Producer: PDF_CREATOR, CreationDate: meta.createdAt },
  })
  const chunks: Buffer[] = []
  pdf.on('data', (chunk: Buffer) => chunks.push(chunk))
  const ended = new Promise<void>((resolve, reject) => {
    pdf.on('end', () => resolve())
    pdf.on('error', reject)
  })
  const text = (value: string, x: number, y: number, options: TextOptions = {}): number => {
    const { font = REGULAR, size = 10, color = TEXT, ...rest } = options
    pdf.font(font).fontSize(size).fillColor(color).text(winAnsi(value), x, y, { lineGap: 1.5, ...rest })
    return pdf.y
  }
  const heightOf = (value: string, width: number, font = REGULAR, size = 10): number => pdf.font(font).fontSize(size).heightOfString(winAnsi(value), { width, lineGap: 1.5 })
  const finish = async (): Promise<Buffer> => {
    pdf.end()
    await ended
    return Buffer.concat(chunks)
  }
  return { pdf, text, heightOf, finish, left: MARGIN.left, width: pdf.page.width - MARGIN.left - MARGIN.right, bottom: () => pdf.page.height - MARGIN.bottom }
}

/** The page footer of every page: the words on the left, "page x of n" on the right. */
function footers(pdf: PDFKit.PDFDocument, words: string, pageWords: (page: number, pages: number) => string): void {
  const range = pdf.bufferedPageRange()
  for (let index = range.start; index < range.start + range.count; index++) {
    pdf.switchToPage(index)
    const left = MARGIN.left
    const right = pdf.page.width - MARGIN.right
    const savedBottom = pdf.page.margins.bottom
    pdf.page.margins.bottom = 0
    const top = pdf.page.height - FOOTER_TOP
    pdf.save().moveTo(left, top).lineTo(right, top).lineWidth(0.4).strokeColor(RULE).stroke().restore()
    pdf.font(REGULAR).fontSize(7).fillColor(MUTED).text(winAnsi(words), left, top + 5, { width: right - left - 100, lineGap: 1 })
    pdf.font(REGULAR).fontSize(7.5).fillColor(MUTED).text(winAnsi(pageWords(index - range.start + 1, range.count)), right - 96, top + 5, { width: 96, align: 'right' })
    pdf.page.margins.bottom = savedBottom
  }
}

/** The QR code of `value` at (x, y), `size` points wide with its quiet zone (no image, no font). */
function qrCode(pdf: PDFKit.PDFDocument, value: string, x: number, y: number, size: number): void {
  const { modules } = createQr(value, { errorCorrectionLevel: 'M' })
  const count = modules.size
  const unit = size / (count + 8)
  pdf.save().rect(x, y, size, size).fillColor('#ffffff').fill()
  for (let row = 0; row < count; row++) {
    for (let column = 0; column < count; column++) {
      if (modules.get(row, column)) pdf.rect(x + (column + 4) * unit, y + (row + 4) * unit, unit, unit)
    }
  }
  pdf.fillColor('#000000').fill().restore()
}

export interface DeclarationPaper {
  readonly language: string
  readonly title: string
  readonly number: string | null
  readonly banner: string
  readonly points: readonly { readonly point: string; readonly text: string }[]
  readonly footer: string
  readonly createdAt: Date
}

/** A generated DoC draft's PDF. */
export async function renderDeclaration(paper: DeclarationPaper): Promise<Buffer> {
  const doc = open({ title: `${paper.title}${paper.number ? ` ${paper.number}` : ''}`, subject: paper.banner, language: paper.language, createdAt: paper.createdAt })
  const { pdf, text, heightOf, left, width, bottom } = doc
  const banner = (): void => {
    const height = heightOf(paper.banner, width - 12, BOLD, 9) + 10
    pdf.save().rect(left, MARGIN.top - 36, width, height).fillColor('#fde8e8').fill().restore()
    text(paper.banner, left + 6, MARGIN.top - 31, { font: BOLD, size: 9, color: '#a40000', width: width - 12, align: 'center' })
    pdf.font(REGULAR).fontSize(10).fillColor(TEXT)
    pdf.x = left
    pdf.y = MARGIN.top - 36 + height + 10
  }
  pdf.on('pageAdded', banner)
  banner()
  let y = pdf.y + 8
  y = text(paper.title.toUpperCase(), left, y, { font: BOLD, size: 15, width, align: 'center' })
  if (paper.number) y = text(paper.number, left, y + 2, { size: 11, width, align: 'center', color: MUTED })
  y += 16
  for (const point of paper.points) {
    const height = heightOf(point.text, width - 26, REGULAR, 10.5)
    if (y + Math.min(height, 120) > bottom()) {
      pdf.addPage()
      y = pdf.y
    }
    text(`${point.point}.`, left, y, { font: BOLD, size: 10.5, width: 22 })
    y = text(point.text, left + 26, y, { size: 10.5, width: width - 26 }) + 9
  }
  footers(pdf, paper.footer, (page, pages) => `${page} / ${pages}`)
  return doc.finish()
}

/** A shipment compliance pack's summary PDF. */
export async function renderPack(paper: PackPaper, meta: { readonly language: string; readonly createdAt: Date; readonly pageWords: string }): Promise<Buffer> {
  const doc = open({ title: paper.title, subject: paper.subtitle, language: meta.language, createdAt: meta.createdAt })
  const { pdf, text, left, width, bottom } = doc
  const room = (needed: number, y: number): number => {
    if (y + needed <= bottom()) return y
    pdf.addPage()
    return MARGIN.top
  }
  let y: number = MARGIN.top
  y = text(paper.title, left, y, { font: BOLD, size: 16, width })
  y = text(paper.subtitle, left, y + 3, { size: 9, color: MUTED, width }) + 8
  for (const fact of paper.facts) {
    y = room(14, y)
    text(fact.label, left, y, { font: BOLD, size: 9, width: 110 })
    y = Math.max(text(fact.value, left + 115, y, { size: 9, width: width - 115 }), y + 12)
  }
  y += 10
  y = room(40, y)
  pdf.save().rect(left, y, width, 17).fillColor(BAND).fill().restore()
  text(paper.contentsHeading, left + 6, y + 4, { font: BOLD, size: 9.5, color: '#ffffff', width: width - 12 })
  y += 23
  for (const entry of paper.contents) {
    y = room(26, y)
    y = text(entry.title, left, y, { size: 9, width })
    y = text(entry.sha256, left + 10, y, { size: 7, color: MUTED, width: width - 10 }) + 4
  }
  for (const style of paper.styles) {
    y = room(90, y + 8)
    pdf.save().rect(left, y, width, 17).fillColor(BAND).fill().restore()
    text(style.heading, left + 6, y + 4, { font: BOLD, size: 9.5, color: '#ffffff', width: width - 12, height: 12, ellipsis: true })
    y += 23
    for (const line of style.lines) {
      y = room(14, y)
      y = text(line, left, y, { size: 9, width })
    }
    y += 4
    for (const line of style.certificate) {
      y = room(14, y)
      y = text(line, left, y, { size: 9, width })
    }
    y += 6
    y = room(30, y)
    y = text(style.batchesHeading, left, y, { font: BOLD, size: 9, width })
    const QR = 46
    for (const batch of style.batches) {
      y = room(QR + 6, y + 4)
      qrCode(pdf, batch.address, left, y, QR)
      text(batch.line, left + QR + 8, y + 6, { font: BOLD, size: 9, width: width - QR - 8 })
      text(`${batch.address}  (${batch.code})`, left + QR + 8, y + 20, { size: 8, color: MUTED, width: width - QR - 8 })
      y += QR + 2
    }
  }
  y = room(30, y + 14)
  y = text(paper.fingerprintLabel, left, y, { size: 7.5, color: MUTED, width })
  text(paper.footer, left, y + 2, { size: 7.5, color: MUTED, width })
  footers(pdf, paper.title, (page, pages) => meta.pageWords.replace('{page}', String(page)).replace('{pages}', String(pages)))
  return doc.finish()
}
