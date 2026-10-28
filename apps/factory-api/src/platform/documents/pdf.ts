import PDFDocument from 'pdfkit'
import { pageLabel, type ComposedBlock, type ComposedDocument, type ComposedFact } from '@nexus/factory-domain/documents/compose'

/**
 * The shared PDF renderer (plan A1 §3.9; GAP-008): paints a composed document (factory-domain documents/compose.ts:
 * every word and number already decided) on A4 with pdfkit, in one fixed geometry for every type:
 *
 *   ┌───────────────────────────────────────────────────────────┐
 *   │ MITTENTE (CEDENTE)                       Documento di …    │  header: the company and its art. 2250 lines,
 *   │ Pelletteria Fittizia S.r.l.                  Numero: …     │  the title, number and date
 *   │ Sede legale: …  P. IVA …  REA …              Data: …       │
 *   │ [ banner of a sample ]                                     │
 *   │ ┌ Destinatario ┐ ┌ Luogo di destinazione ┐ ┌ Vettore ┐     │  the party and the other places
 *   │ facts, three per row (the DDT's transport, a quote's validity)│
 *   │ Codice | Descrizione                  | Q.tà | U.M. | …    │  the lines; the header repeats on every page
 *   │                                        Imponibile  € …     │  totals
 *   │ Note: …   [notice box]   [signature boxes]                 │
 *   │ legal line (art. 2250) · footer text           Pagina 1 di 2│  every page
 *   └───────────────────────────────────────────────────────────┘
 *
 * Fonts: the PDF standard fonts Helvetica and Helvetica-Bold (WinAnsi text; nothing embedded, nothing read at run time
 * but pdfkit's own metrics files, which stay in node_modules/pdfkit beside the external package in dist). A character
 * WinAnsi lacks is printed as "?". Metadata comes from the composition only (the creation date is the document's date),
 * so the same document gives the same bytes.
 */

export const PDF_CREATOR = 'Nexus Factory'
const REGULAR = 'Helvetica'
const BOLD = 'Helvetica-Bold'
const TEXT = '#111111'
const MUTED = '#555555'
const RULE = '#9a9a9a'
const SHADE = '#ececec'
const MARGIN = { top: 40, bottom: 60, left: 42, right: 42 } as const
const FOOTER_TOP = 50

// The characters 0x80-0x9F of WinAnsi, the encoding of the standard fonts; with Latin-1 they are what can be printed.
const WIN_ANSI_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ')

/** Text the standard fonts can print: printable Latin-1 and WinAnsi's extra characters; anything else becomes "?". */
export function winAnsi(text: string): string {
  let out = ''
  for (const char of text) {
    const code = char.codePointAt(0)!
    out += (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || WIN_ANSI_EXTRA.has(char) ? char : char === '\n' ? ' ' : '?'
  }
  return out
}

/** The PDF of a composed document. */
export async function renderDocumentPdf(document: ComposedDocument): Promise<Buffer> {
  const pdf = new PDFDocument({
    size: 'A4',
    margins: MARGIN,
    bufferPages: true,
    compress: true,
    lang: document.language,
    displayTitle: true,
    info: {
      Title: winAnsi(document.meta.title),
      Author: winAnsi(document.meta.author),
      Subject: winAnsi(document.meta.subject),
      Keywords: winAnsi(document.meta.keywords),
      Creator: PDF_CREATOR,
      Producer: PDF_CREATOR,
      CreationDate: new Date(document.meta.createdAt),
    },
  })
  const chunks: Buffer[] = []
  pdf.on('data', (chunk: Buffer) => chunks.push(chunk))
  const ended = new Promise<void>((resolve, reject) => {
    pdf.on('end', () => resolve())
    pdf.on('error', reject)
  })
  paint(pdf, document)
  pdf.end()
  await ended
  return Buffer.concat(chunks)
}

type Pdf = PDFKit.PDFDocument

function paint(pdf: Pdf, document: ComposedDocument): void {
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

  // Header: the company on the left, the title and identity on the right.
  const companyWidth = Math.round(width * 0.58)
  let y: number = MARGIN.top
  y = text(document.issuer.heading.toUpperCase(), left, y, { font: BOLD, size: 6.5, color: MUTED, width: companyWidth })
  y = text(document.issuer.name, left, y + 1, { font: BOLD, size: 13, width: companyWidth })
  for (const line of document.issuer.lines) y = text(line, left, y + 0.5, { size: 7.5, color: MUTED, width: companyWidth })
  const identityLeft = left + companyWidth + 12
  const identityWidth = right - identityLeft
  let identityY = text(document.title, identityLeft, MARGIN.top, { font: BOLD, size: 14, width: identityWidth, align: 'right' })
  for (const fact of document.identity) identityY = text(`${fact.label}: ${fact.value}`, identityLeft, identityY + 2, { size: 10, width: identityWidth, align: 'right' })
  y = Math.max(y, identityY) + 10

  if (document.banner) {
    const height = heightOf(document.banner, width - 12, BOLD, 11) + 10
    pdf.save().rect(left, y, width, height).fillColor('#fde8e8').fill().restore()
    text(document.banner, left + 6, y + 5, { font: BOLD, size: 11, color: '#a40000', width: width - 12, align: 'center' })
    y += height + 8
  }

  y = paintBlocks(pdf, document.blocks, left, y, width, text, heightOf) + 8
  y = paintFacts(pdf, document.facts, left, y, width, text, heightOf) + 10

  // The lines table: its header repeats on every new page, under a short reminder of the document.
  const columns = document.table.columns.map((column) => ({ ...column, width: (width * column.width) / 1000 }))
  const paintTableHeader = (at: number): number => {
    const height = Math.max(...columns.map((column) => heightOf(column.label, column.width - 6, BOLD, 7.5))) + 6
    pdf.save().rect(left, at, width, height).fillColor(SHADE).fill().restore()
    let x = left
    for (const column of columns) {
      text(column.label, x + 3, at + 3, { font: BOLD, size: 7.5, width: column.width - 6, align: column.align })
      x += column.width
    }
    return at + height
  }
  const newPage = (): number => {
    pdf.addPage()
    const top = text(`${document.issuer.name} · ${document.title} ${document.identity[0]?.value ?? ''} (${document.footer.continued})`, left, MARGIN.top, { size: 8, color: MUTED, width })
    return top + 8
  }
  y = paintTableHeader(y)
  for (const row of document.table.rows) {
    const height = Math.max(...row.map((cell, index) => heightOf(cell, columns[index]!.width - 6, REGULAR, 8.5))) + 6
    if (y + height > bottom()) y = paintTableHeader(newPage())
    let x = left
    row.forEach((cell, index) => {
      const column = columns[index]!
      text(cell, x + 3, y + 3, { size: 8.5, width: column.width - 6, align: column.align })
      x += column.width
    })
    y += height
    pdf.save().moveTo(left, y).lineTo(right, y).lineWidth(0.4).strokeColor(RULE).stroke().restore()
  }
  y += 8

  if (document.totals.length > 0) {
    const boxWidth = 240
    const boxLeft = right - boxWidth
    const needed = document.totals.length * 15
    if (y + needed > bottom()) y = newPage()
    for (const total of document.totals) {
      const font = total.strong ? BOLD : REGULAR
      text(total.label, boxLeft, y, { font, size: 9, width: boxWidth - 100 })
      text(total.value, boxLeft + boxWidth - 100, y, { font, size: 9, width: 100, align: 'right' })
      y += 15
      if (total.strong) pdf.save().moveTo(boxLeft, y - 2).lineTo(right, y - 2).lineWidth(0.4).strokeColor(RULE).stroke().restore()
    }
    y += 6
  }

  if (document.notes) {
    const value = `${document.notes.label}: ${document.notes.value}`
    if (y + heightOf(value, width, REGULAR, 8.5) > bottom()) y = newPage()
    y = text(value, left, y, { size: 8.5, width }) + 8
  }

  for (const notice of document.notices) {
    const height = heightOf(notice, width - 12, BOLD, 8.5) + 10
    if (y + height > bottom()) y = newPage()
    pdf.save().rect(left, y, width, height).lineWidth(0.8).strokeColor(TEXT).stroke().restore()
    text(notice, left + 6, y + 5, { font: BOLD, size: 8.5, width: width - 12 })
    y += height + 8
  }

  if (document.signatures.length > 0) {
    const gap = 12
    const boxWidth = (width - gap * (document.signatures.length - 1)) / document.signatures.length
    if (y + 60 > bottom()) y = newPage()
    document.signatures.forEach((caption, index) => {
      const x = left + index * (boxWidth + gap)
      pdf.save().moveTo(x, y + 40).lineTo(x + boxWidth, y + 40).lineWidth(0.6).strokeColor(TEXT).stroke().restore()
      text(caption, x, y + 44, { size: 7.5, color: MUTED, width: boxWidth, align: 'center' })
    })
    y += 60
  }

  // Every page's footer: the legal line (art. 2250 "on every document"), the company's own text, the page label.
  const range = pdf.bufferedPageRange()
  for (let index = range.start; index < range.start + range.count; index++) {
    pdf.switchToPage(index)
    const savedBottom = pdf.page.margins.bottom
    pdf.page.margins.bottom = 0
    const top = pdf.page.height - FOOTER_TOP
    pdf.save().moveTo(left, top).lineTo(right, top).lineWidth(0.4).strokeColor(RULE).stroke().restore()
    const footerWidth = width - 80
    const after = text(document.footer.legal, left, top + 4, { size: 6.5, color: MUTED, width: footerWidth })
    if (document.footer.text) text(document.footer.text, left, after + 1, { size: 6.5, color: MUTED, width: footerWidth })
    text(pageLabel(document.footer.page, index - range.start + 1, range.count), right - 76, top + 4, { size: 7.5, color: MUTED, width: 76, align: 'right' })
    pdf.page.margins.bottom = savedBottom
  }
}

type Text = (value: string, x: number, y: number, options?: PDFKit.Mixins.TextOptions & { font?: string; size?: number; color?: string }) => number
type HeightOf = (value: string, width: number, font?: string, size?: number) => number

/** The party and the other places side by side, each in a box; returns the y under them. */
function paintBlocks(pdf: Pdf, blocks: readonly ComposedBlock[], left: number, top: number, width: number, text: Text, heightOf: HeightOf): number {
  if (blocks.length === 0) return top
  const gap = 10
  const boxWidth = (width - gap * (blocks.length - 1)) / blocks.length
  const inner = boxWidth - 12
  const heights = blocks.map(
    (block) => heightOf(block.heading.toUpperCase(), inner, BOLD, 6.5) + 2 + block.lines.reduce((sum, line, index) => sum + heightOf(line, inner, index === 0 ? BOLD : REGULAR, 9), 0) + 12,
  )
  const height = Math.max(...heights)
  blocks.forEach((block, index) => {
    const x = left + index * (boxWidth + gap)
    pdf.save().rect(x, top, boxWidth, height).lineWidth(0.6).strokeColor(RULE).stroke().restore()
    let y = text(block.heading.toUpperCase(), x + 6, top + 6, { font: BOLD, size: 6.5, color: MUTED, width: inner }) + 2
    block.lines.forEach((line, lineIndex) => {
      y = text(line, x + 6, y, { font: lineIndex === 0 ? BOLD : REGULAR, size: 9, width: inner })
    })
  })
  return top + height
}

/** Label-and-value facts, three per row in a ruled grid; returns the y under them. */
function paintFacts(pdf: Pdf, facts: readonly ComposedFact[], left: number, top: number, width: number, text: Text, heightOf: HeightOf): number {
  if (facts.length === 0) return top
  const perRow = 3
  const cellWidth = width / perRow
  const inner = cellWidth - 8
  let y = top
  for (let start = 0; start < facts.length; start += perRow) {
    const row = facts.slice(start, start + perRow)
    const height = Math.max(...row.map((fact) => heightOf(fact.label, inner, REGULAR, 6.5) + heightOf(fact.value, inner, BOLD, 9))) + 8
    row.forEach((fact, index) => {
      const x = left + index * cellWidth
      pdf.save().rect(x, y, cellWidth, height).lineWidth(0.4).strokeColor(RULE).stroke().restore()
      const valueTop = text(fact.label, x + 4, y + 3, { size: 6.5, color: MUTED, width: inner })
      text(fact.value, x + 4, valueTop + 1, { font: BOLD, size: 9, width: inner })
    })
    y += height
  }
  return y
}
