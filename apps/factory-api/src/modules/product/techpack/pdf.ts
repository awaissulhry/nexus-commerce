import PDFDocument from 'pdfkit'
import { create as createQr } from 'qrcode'
import { pageLabel } from '@nexus/factory-domain/documents/compose'
import type { PaperBlock, PaperFact, PaperPicture, PaperTable, TechPackPaper } from '@nexus/factory-domain/product/techpack/paper'
import { PDF_CREATOR, winAnsi } from '../../../platform/documents/pdf'

/**
 * The tech pack PDF's painter (B-W2b-230; PRD-131, PRD-138): the paper composed by factory-domain product/techpack paper.ts,
 * painted on A4 portrait with pdfkit's standard fonts (the documents platform's WinAnsi rule), as the work order traveller
 * is. Every page carries the header with the QR to the current version and its code (PRD-138); pictures are drawn from the
 * bytes the caller read (JPEG and PNG), their numbered callouts on top; a picture without bytes prints its caption and why.
 */

const REGULAR = 'Helvetica'
const BOLD = 'Helvetica-Bold'
const TEXT = '#111111'
const MUTED = '#555555'
const RULE = '#9a9a9a'
const SHADE = '#ececec'
const BAND = '#1f2937'
const HEADER_TOP = 30
const QR_SIZE = 64
/** The content starts below the header band; a page pdfkit adds by itself (a long text) still gets its header (pageAdded). */
const CONTENT_TOP = HEADER_TOP + QR_SIZE + 22
const MARGIN = { top: CONTENT_TOP, bottom: 54, left: 36, right: 36 } as const
const FOOTER_TOP = 44
const PICTURE_HEIGHT = 200
/** A note is printed in pieces of at most this many characters (cut at a space), so no piece is taller than a page. */
const NOTE_PIECE = 1200

type TextOptions = PDFKit.Mixins.TextOptions & { font?: string; size?: number; color?: string }

function writer(pdf: PDFKit.PDFDocument) {
  const text = (value: string, x: number, y: number, options: TextOptions = {}): number => {
    const { font = REGULAR, size = 8.5, color = TEXT, ...rest } = options
    pdf.font(font).fontSize(size).fillColor(color).text(winAnsi(value), x, y, { lineGap: 1, ...rest })
    return pdf.y
  }
  const heightOf = (value: string, width: number, font = REGULAR, size = 8.5): number => pdf.font(font).fontSize(size).heightOfString(winAnsi(value), { width, lineGap: 1 })
  return { text, heightOf }
}

/** The QR code of `value` at (x, y), `size` points wide with its quiet zone, black on white (no image, no font). */
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

interface Frame {
  readonly left: number
  readonly width: number
  readonly bottom: () => number
  readonly newPage: () => number
}

/** The PDF of one tech pack version. `pictures`: the bytes of the pictures it prints, by file id (others print their caption). */
export async function renderTechPack(paper: TechPackPaper, pictures: ReadonlyMap<string, Buffer>): Promise<Buffer> {
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
  const { text, heightOf } = writer(pdf)
  const left = MARGIN.left
  const width = pdf.page.width - MARGIN.left - MARGIN.right
  const bottom = (): number => pdf.page.height - MARGIN.bottom

  /** The header of every page, above the content: the words on the left, the QR to the current version and its code on the right. */
  const header = (): void => {
    const right = left + width
    const textWidth = width - QR_SIZE - 12
    let y: number = HEADER_TOP
    y = text(paper.title, left, y, { size: 9, color: MUTED, width: textWidth })
    y = text(paper.styleLine, left, y + 1, { font: BOLD, size: 14, width: textWidth, height: 18, ellipsis: true })
    y = text(paper.versionLine, left, y + 1, { size: 9.5, width: textWidth, height: 12, ellipsis: true })
    text(paper.audienceLine, left, y + 1, { font: BOLD, size: 9.5, color: MUTED, width: textWidth, height: 12, ellipsis: true })
    qrCode(pdf, paper.qr, right - QR_SIZE, HEADER_TOP - 4, QR_SIZE)
    text(paper.code, right - QR_SIZE - 20, HEADER_TOP + QR_SIZE - 2, { size: 7, color: MUTED, width: QR_SIZE + 20, align: 'center' })
    const rule = CONTENT_TOP - 8
    pdf.save().moveTo(left, rule).lineTo(right, rule).lineWidth(0.6).strokeColor(RULE).stroke().restore()
    // What a text pdfkit carried over to this page goes on in the body's font, at the content's top.
    pdf.font(REGULAR).fontSize(8.5).fillColor(TEXT)
    pdf.x = left
    pdf.y = CONTENT_TOP
  }
  pdf.on('pageAdded', header)
  const newPage = (): number => {
    pdf.addPage()
    return CONTENT_TOP
  }
  const frame: Frame = { left, width, bottom, newPage }

  header()
  let y: number = CONTENT_TOP
  if (paper.banner) {
    const height = heightOf(paper.banner, width - 12, BOLD, 10) + 10
    pdf.save().rect(left, y, width, height).fillColor('#fde8e8').fill().restore()
    text(paper.banner, left + 6, y + 5, { font: BOLD, size: 10, color: '#a40000', width: width - 12, align: 'center' })
    y += height + 8
  }
  for (const section of paper.sections) {
    if (y + 60 > bottom()) y = newPage()
    pdf.save().rect(left, y, width, 18).fillColor(BAND).fill().restore()
    text(section.title, left + 6, y + 4, { font: BOLD, size: 10.5, color: '#ffffff', width: width - 12 })
    y += 24
    for (const block of section.blocks) y = paintBlock(pdf, block, y, frame, pictures) + 8
    y += 6
  }
  footers(pdf, paper)
  pdf.end()
  await ended
  return Buffer.concat(chunks)
}

function paintBlock(pdf: PDFKit.PDFDocument, block: PaperBlock, top: number, frame: Frame, pictures: ReadonlyMap<string, Buffer>): number {
  switch (block.kind) {
    case 'facts':
      return paintFacts(pdf, block.facts, top, frame)
    case 'table':
      return paintTable(pdf, block.table, top, frame)
    case 'notes':
      return paintNotes(pdf, block.title, block.notes, top, frame)
    case 'pictures':
      return paintPictures(pdf, block.pictures, block.missing, top, frame, pictures)
  }
}

function paintFacts(pdf: PDFKit.PDFDocument, facts: readonly PaperFact[], top: number, frame: Frame): number {
  const { text, heightOf } = writer(pdf)
  const perRow = 3
  const cellWidth = frame.width / perRow
  let y = top
  for (let start = 0; start < facts.length; start += perRow) {
    const row = facts.slice(start, start + perRow)
    const height = Math.max(...row.map((fact) => heightOf(fact.label, cellWidth - 8, REGULAR, 7) + heightOf(fact.value || ' ', cellWidth - 8, BOLD, 9))) + 7
    if (y + height > frame.bottom()) y = frame.newPage()
    row.forEach((fact, index) => {
      const x = frame.left + index * cellWidth
      pdf.save().rect(x, y, cellWidth, height).lineWidth(0.4).strokeColor(RULE).stroke().restore()
      const valueTop = text(fact.label, x + 4, y + 3, { size: 7, color: MUTED, width: cellWidth - 8 })
      text(fact.value, x + 4, valueTop + 1, { font: BOLD, size: 9, width: cellWidth - 8 })
    })
    y += height
  }
  return y
}

function paintNotes(pdf: PDFKit.PDFDocument, title: string | null, notes: readonly string[], top: number, frame: Frame): number {
  const { text, heightOf } = writer(pdf)
  let y = top
  if (title) {
    if (y + 30 > frame.bottom()) y = frame.newPage()
    y = text(title, frame.left, y, { font: BOLD, size: 9.5, width: frame.width }) + 2
  }
  for (const piece of notes.flatMap(piecesOf)) {
    if (y + heightOf(piece, frame.width, REGULAR, 8.5) > frame.bottom()) y = frame.newPage()
    y = text(piece, frame.left, y, { size: 8.5, width: frame.width }) + 3
  }
  return y
}

/** A note's paragraphs, each cut at spaces into pieces of at most NOTE_PIECE characters. */
function piecesOf(note: string): string[] {
  return note.split(/\r?\n/).flatMap((paragraph) => {
    const out: string[] = []
    let rest = paragraph
    while (rest.length > NOTE_PIECE) {
      const cut = rest.lastIndexOf(' ', NOTE_PIECE)
      const at = cut > NOTE_PIECE / 2 ? cut : NOTE_PIECE
      out.push(rest.slice(0, at))
      rest = rest.slice(at).trimStart()
    }
    out.push(rest)
    return out
  })
}

/** One table: its title, a shaded header (again on each new page), the rows ruled. */
function paintTable(pdf: PDFKit.PDFDocument, table: PaperTable, top: number, frame: Frame): number {
  const { text, heightOf } = writer(pdf)
  const { left, width, bottom, newPage } = frame
  const right = left + width
  const columns = table.columns.map((column) => ({ ...column, width: (width * column.width) / 1000 }))
  const headerHeight = Math.max(...columns.map((column) => heightOf(column.label || ' ', column.width - 6, BOLD, 7.5))) + 6
  let y = top
  if (y + (table.title ? 14 : 0) + headerHeight + 16 > bottom()) y = newPage()
  if (table.title) y = text(table.title, left, y, { font: BOLD, size: 9.5, width }) + 3
  const head = (at: number): number => {
    pdf.save().rect(left, at, width, headerHeight).fillColor(SHADE).fill().restore()
    let x = left
    for (const column of columns) {
      text(column.label, x + 3, at + 3, { font: BOLD, size: 7.5, width: column.width - 6, align: column.align })
      x += column.width
    }
    return at + headerHeight
  }
  y = head(y)
  if (table.rows.length === 0) return text(table.empty, left + 3, y + 4, { size: 8, color: MUTED, width: width - 6 })
  for (const row of table.rows) {
    const height = Math.max(14, ...row.map((cell, index) => heightOf(cell || ' ', columns[index]!.width - 6, REGULAR, 8))) + 4
    if (y + height > bottom()) y = head(newPage())
    let x = left
    row.forEach((cell, index) => {
      const column = columns[index]!
      pdf.save().moveTo(x, y).lineTo(x, y + height).lineWidth(0.3).strokeColor(RULE).stroke().restore()
      text(cell, x + 3, y + 3, { size: 8, width: column.width - 6, align: column.align })
      x += column.width
    })
    pdf.save().moveTo(right, y).lineTo(right, y + height).lineWidth(0.3).strokeColor(RULE).stroke().restore()
    y += height
    pdf.save().moveTo(left, y).lineTo(right, y).lineWidth(0.4).strokeColor(RULE).stroke().restore()
  }
  return y
}

interface OpenedImage {
  readonly width: number
  readonly height: number
}

/** Two pictures a row: each fitted in its box, its numbered callouts drawn on it, its caption and callout words below. */
function paintPictures(pdf: PDFKit.PDFDocument, list: readonly PaperPicture[], missing: string, top: number, frame: Frame, bytes: ReadonlyMap<string, Buffer>): number {
  const { text, heightOf } = writer(pdf)
  const gap = 12
  const boxWidth = (frame.width - gap) / 2
  let y = top
  for (let start = 0; start < list.length; start += 2) {
    const row = list.slice(start, start + 2)
    const below = Math.max(...row.map((picture) => heightOf(picture.caption || ' ', boxWidth, BOLD, 8) + picture.callouts.reduce((sum, callout) => sum + heightOf(`${callout.n}. ${callout.text}`, boxWidth, REGULAR, 7.5), 0)))
    if (y + PICTURE_HEIGHT + below + 8 > frame.bottom()) y = frame.newPage()
    row.forEach((picture, index) => {
      const x = frame.left + index * (boxWidth + gap)
      pdf.save().rect(x, y, boxWidth, PICTURE_HEIGHT).lineWidth(0.4).strokeColor(RULE).stroke().restore()
      const body = bytes.get(picture.fileId)
      let drawn = false
      if (body) {
        try {
          const image = (pdf as unknown as { openImage(source: Buffer): OpenedImage }).openImage(body)
          const scale = Math.min((boxWidth - 8) / image.width, (PICTURE_HEIGHT - 8) / image.height)
          const w = image.width * scale
          const h = image.height * scale
          const x0 = x + (boxWidth - w) / 2
          const y0 = y + (PICTURE_HEIGHT - h) / 2
          pdf.image(body, x0, y0, { width: w, height: h })
          for (const callout of picture.callouts) {
            const cx = x0 + Number(callout.x) * w
            const cy = y0 + Number(callout.y) * h
            pdf.save().circle(cx, cy, 6).fillColor('#b00020').fill().restore()
            text(String(callout.n), cx - 6, cy - 3.5, { font: BOLD, size: 6.5, color: '#ffffff', width: 12, align: 'center' })
          }
          drawn = true
        } catch {
          drawn = false
        }
      }
      if (!drawn) text(missing, x + 8, y + PICTURE_HEIGHT / 2 - 8, { size: 8, color: MUTED, width: boxWidth - 16, align: 'center' })
      let at = text(picture.caption || ' ', x, y + PICTURE_HEIGHT + 3, { font: BOLD, size: 8, width: boxWidth })
      for (const callout of picture.callouts) at = text(`${callout.n}. ${callout.text}`, x, at, { size: 7.5, width: boxWidth })
    })
    y += PICTURE_HEIGHT + below + 10
  }
  return y
}

/** Each page: the printing time and the scan words, "Page n of m". */
function footers(pdf: PDFKit.PDFDocument, paper: TechPackPaper): void {
  const { text } = writer(pdf)
  const range = pdf.bufferedPageRange()
  for (let index = range.start; index < range.start + range.count; index++) {
    pdf.switchToPage(index)
    const left = MARGIN.left
    const right = pdf.page.width - MARGIN.right
    const width = right - left
    const savedBottom = pdf.page.margins.bottom
    pdf.page.margins.bottom = 0
    const top = pdf.page.height - FOOTER_TOP
    pdf.save().moveTo(left, top).lineTo(right, top).lineWidth(0.4).strokeColor(RULE).stroke().restore()
    text(`${paper.footer.printed} · ${paper.meta.title}`, left, top + 4, { size: 7, color: MUTED, width: width - 100 })
    text(paper.footer.scan, left, top + 14, { size: 7, color: MUTED, width: width - 100 })
    text(pageLabel(paper.footer.page, index - range.start + 1, range.count), right - 96, top + 4, { size: 7.5, color: MUTED, width: 96, align: 'right' })
    pdf.page.margins.bottom = savedBottom
  }
}
