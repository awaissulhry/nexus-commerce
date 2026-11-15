import PDFDocument from 'pdfkit'
import { businessDayStart, BUSINESS_TIME_ZONE } from '@nexus/factory-domain/core/time'
import { formatDate, formatDecimal, formatMoney } from '@nexus/factory-domain/documents/format'
import { EXPORT_REASONS } from '@nexus/factory-domain/shipping/customs/rules'
import { parcelValueMinor, POSTAL_FORM_LAYOUT, POSTAL_FORM_WORDS, type PostalFormDocument, type PostalParcel, type PostalFormWords } from '@nexus/factory-domain/shipping/customs/postal-forms'
import { PDF_CREATOR, winAnsi } from '../../documents/pdf'

/**
 * The CN 22 and CN 23 laid out (B-W2b-409; LOG-087; factory-domain shipping/customs/postal-forms.ts composes them): one page
 * per parcel, for any printer (the browser prints the PDF at 100 %), stored as the shipment's GeneratedDocument CN22 or CN23.
 *
 *   CN 22   a 100 × 150 mm page (the label stock of the packing station; it goes on the parcel): the title with the UPU's
 *           French words, the parcel and shipment, the category boxes, per item its description, quantity, net weight and
 *           value with its HS code and origin, the totals, the sender's EORI, the declaration, the date and the signature line
 *   CN 23   an A4 page: the sender (with its EORI, the customs reference) and the addressee in full, the category boxes, the
 *           items in columns (description, quantity, net weight, value, HS code, origin), the totals, the invoice's number,
 *           the comments, the declaration, the date and the signature line
 *
 * Text goes through winAnsi (the standard fonts); the PDF's dates are the document's day, so the same form gives the same
 * bytes.
 */

const REGULAR = 'Helvetica'
const BOLD = 'Helvetica-Bold'
const MM = 72 / 25.4

/** The CN 22's page (points): 100 × 150 mm. */
export const CN22_PAGE = Object.freeze({ width: 100 * MM, height: 150 * MM })

type Pdf = PDFKit.PDFDocument

/** The form as one PDF, a page per parcel. */
export async function renderPostalFormPdf(document: PostalFormDocument): Promise<Buffer> {
  const words = POSTAL_FORM_WORDS[document.language]
  const pdf = new PDFDocument({
    size: document.form === 'CN22' ? [CN22_PAGE.width, CN22_PAGE.height] : 'A4',
    margin: 0,
    autoFirstPage: false,
    compress: true,
    lang: document.language,
    info: {
      Title: winAnsi(`${document.form} ${document.number}`),
      Subject: POSTAL_FORM_LAYOUT[document.form],
      Creator: PDF_CREATOR,
      Producer: PDF_CREATOR,
      CreationDate: businessDayStart(document.date, BUSINESS_TIME_ZONE),
    },
  })
  const chunks: Buffer[] = []
  pdf.on('data', (chunk: Buffer) => chunks.push(chunk))
  const ended = new Promise<void>((resolve, reject) => {
    pdf.on('end', () => resolve())
    pdf.on('error', reject)
  })
  for (const parcel of document.parcels) {
    if (document.form === 'CN22') paintCn22(pdf, document, parcel, words)
    else paintCn23(pdf, document, parcel, words)
  }
  pdf.end()
  await ended
  return Buffer.concat(chunks)
}

const kg = (value: string, document: PostalFormDocument): string => formatDecimal(value, document.language, 0, 3)
const money = (minor: number, document: PostalFormDocument): string => formatMoney(minor, document.currency, document.language)

/** The category boxes, the chosen one ticked; returns the y below them. */
function categories(pdf: Pdf, document: PostalFormDocument, words: PostalFormWords, x: number, y: number, width: number, size: number, columns: number): number {
  pdf.font(BOLD).fontSize(size).text(winAnsi(words.category), x, y, { width })
  let at = y + size + 3
  const column = width / columns
  EXPORT_REASONS.forEach((reason, index) => {
    const cx = x + (index % columns) * column
    const cy = at + Math.floor(index / columns) * (size + 4)
    pdf.lineWidth(0.6).rect(cx, cy, size, size).stroke()
    if (reason === document.reason) pdf.font(BOLD).fontSize(size).text('X', cx + size * 0.2, cy + size * 0.05, { width: size, lineBreak: false })
    pdf.font(REGULAR).fontSize(size).text(winAnsi(words.reasons[reason]), cx + size + 3, cy + 0.5, { width: column - size - 4, lineBreak: false })
  })
  at += Math.ceil(EXPORT_REASONS.length / columns) * (size + 4)
  if (document.reason === 'OTHER' && document.reasonText) {
    pdf.font(REGULAR).fontSize(size).text(winAnsi(`${words.explanation}: ${document.reasonText}`), x, at, { width })
    at = pdf.y + 2
  }
  return at + 2
}

function rule(pdf: Pdf, x: number, y: number, width: number): void {
  pdf.lineWidth(0.5).moveTo(x, y).lineTo(x + width, y).stroke()
}

function paintCn22(pdf: Pdf, document: PostalFormDocument, parcel: PostalParcel, words: PostalFormWords): void {
  pdf.addPage({ size: [CN22_PAGE.width, CN22_PAGE.height], margin: 0 })
  const x = 8
  const width = CN22_PAGE.width - 16
  let y = 8
  pdf.fillColor('#000000').font(BOLD).fontSize(7.5).text(winAnsi(words.title.CN22), x, y, { width })
  y = pdf.y + 2
  pdf.font(REGULAR).fontSize(6.5).text(winAnsi(`${words.parcel(parcel.seq, document.parcels.length)} · ${words.shipment} ${document.number} · ${formatDate(document.date, document.language)}`), x, y, { width })
  y = pdf.y + 3
  pdf.font(REGULAR).fontSize(6.5).text(winAnsi(`${words.eori}: ${document.sender.eori}`), x, y, { width })
  y = pdf.y + 3
  rule(pdf, x, y, width)
  y = categories(pdf, document, words, x, y + 3, width, 6, 2)
  rule(pdf, x, y, width)
  // The items: description (with HS code and origin), quantity, net weight, value.
  const cols = { description: width * 0.52, quantity: width * 0.12, net: width * 0.16, value: width * 0.2 }
  y += 3
  pdf.font(BOLD).fontSize(5.8)
  pdf.text(winAnsi(words.description), x, y, { width: cols.description - 2 })
  pdf.text(winAnsi(words.quantity), x + cols.description, y, { width: cols.quantity - 2, align: 'right' })
  pdf.text(winAnsi(words.netWeight), x + cols.description + cols.quantity, y, { width: cols.net - 2, align: 'right' })
  pdf.text(winAnsi(`${words.value} (${document.currency})`), x + cols.description + cols.quantity + cols.net, y, { width: cols.value, align: 'right' })
  y += 16
  for (const item of parcel.items) {
    const top = y
    pdf.font(REGULAR).fontSize(6).text(winAnsi(item.description), x, top, { width: cols.description - 2 })
    const after = pdf.y
    pdf.font(REGULAR).fontSize(5.5).text(winAnsi(`${words.hsCode} ${item.hsCode} · ${words.origin} ${item.originCountry}`), x, after, { width: cols.description - 2 })
    const bottom = pdf.y
    pdf.font(REGULAR).fontSize(6)
    pdf.text(String(item.quantity), x + cols.description, top, { width: cols.quantity - 2, align: 'right' })
    pdf.text(winAnsi(kg(item.netKg, document)), x + cols.description + cols.quantity, top, { width: cols.net - 2, align: 'right' })
    pdf.text(winAnsi(money(item.valueMinor, document)), x + cols.description + cols.quantity + cols.net, top, { width: cols.value, align: 'right' })
    y = bottom + 3
  }
  rule(pdf, x, y, width)
  y += 3
  pdf.font(BOLD).fontSize(6.5).text(winAnsi(`${words.totalGross}: ${kg(parcel.grossKg, document)}`), x, y, { width: width / 2 - 2 })
  pdf.text(winAnsi(`${words.totalValue}: ${money(parcelValueMinor(parcel), document)}`), x + width / 2, y, { width: width / 2, align: 'right' })
  y = pdf.y + 4
  rule(pdf, x, y, width)
  pdf.font(REGULAR).fontSize(5.5).text(winAnsi(words.declaration), x, y + 3, { width })
  y = pdf.y + 10
  pdf.font(REGULAR).fontSize(6).text(winAnsi(`${words.dateSignature}: ${formatDate(document.date, document.language)}`), x, y, { width })
  rule(pdf, x, pdf.y + 12, width * 0.7)
}

function partyBox(pdf: Pdf, heading: string, lines: readonly string[], x: number, y: number, width: number): number {
  pdf.font(BOLD).fontSize(8).text(winAnsi(heading), x + 4, y + 4, { width: width - 8 })
  pdf.font(REGULAR).fontSize(9)
  for (const line of lines) pdf.text(winAnsi(line), x + 4, pdf.y + 1, { width: width - 8 })
  const bottom = pdf.y + 4
  pdf.lineWidth(0.6).rect(x, y, width, bottom - y).stroke()
  return bottom
}

function paintCn23(pdf: Pdf, document: PostalFormDocument, parcel: PostalParcel, words: PostalFormWords): void {
  pdf.addPage({ size: 'A4', margin: 0 })
  const x = 36
  const width = 595.28 - 72
  let y = 36
  pdf.fillColor('#000000').font(BOLD).fontSize(12).text(winAnsi(words.title.CN23), x, y, { width })
  y = pdf.y + 2
  pdf.font(REGULAR).fontSize(9).text(winAnsi(`${words.parcel(parcel.seq, document.parcels.length)} · ${words.shipment} ${document.number} · ${formatDate(document.date, document.language)}`), x, y, { width })
  y = pdf.y + 8
  const half = (width - 8) / 2
  const left = partyBox(pdf, words.sender, [document.sender.name, ...document.sender.lines, `${words.eori}: ${document.sender.eori}`], x, y, half)
  const right = partyBox(pdf, words.addressee, [document.addressee.name, ...document.addressee.lines], x + half + 8, y, half)
  y = Math.max(left, right) + 8
  y = categories(pdf, document, words, x, y, width, 8, 3)
  rule(pdf, x, y, width)
  const cols = { description: width * 0.38, quantity: width * 0.08, net: width * 0.12, value: width * 0.14, hs: width * 0.16, origin: width * 0.12 }
  const at = (key: keyof typeof cols): number => x + (Object.keys(cols) as (keyof typeof cols)[]).slice(0, (Object.keys(cols) as (keyof typeof cols)[]).indexOf(key)).reduce((sum, name) => sum + cols[name], 0)
  y += 4
  pdf.font(BOLD).fontSize(7.5)
  pdf.text(winAnsi(words.description), at('description'), y, { width: cols.description - 4 })
  pdf.text(winAnsi(words.quantity), at('quantity'), y, { width: cols.quantity - 4, align: 'right' })
  pdf.text(winAnsi(words.netWeight), at('net'), y, { width: cols.net - 4, align: 'right' })
  pdf.text(winAnsi(`${words.value} (${document.currency})`), at('value'), y, { width: cols.value - 4, align: 'right' })
  pdf.text(winAnsi(words.hsCode), at('hs'), y, { width: cols.hs - 4 })
  pdf.text(winAnsi(words.origin), at('origin'), y, { width: cols.origin })
  y += 20
  for (const item of parcel.items) {
    const top = y
    pdf.font(REGULAR).fontSize(8.5).text(winAnsi(item.description), at('description'), top, { width: cols.description - 4 })
    const bottom = pdf.y
    pdf.text(String(item.quantity), at('quantity'), top, { width: cols.quantity - 4, align: 'right' })
    pdf.text(winAnsi(kg(item.netKg, document)), at('net'), top, { width: cols.net - 4, align: 'right' })
    pdf.text(winAnsi(money(item.valueMinor, document)), at('value'), top, { width: cols.value - 4, align: 'right' })
    pdf.text(winAnsi(item.hsCode), at('hs'), top, { width: cols.hs - 4 })
    pdf.text(winAnsi(item.originCountry), at('origin'), top, { width: cols.origin })
    y = Math.max(bottom, pdf.y) + 4
  }
  rule(pdf, x, y, width)
  y += 6
  pdf.font(BOLD).fontSize(9).text(winAnsi(`${words.totalGross}: ${kg(parcel.grossKg, document)}`), x, y, { width: half })
  pdf.text(winAnsi(`${words.totalValue}: ${money(parcelValueMinor(parcel), document)}`), x + half + 8, y, { width: half, align: 'right' })
  y = pdf.y + 8
  pdf.font(REGULAR).fontSize(9)
  if (document.invoiceNumber) {
    pdf.text(winAnsi(`${words.invoice} ${document.invoiceNumber}`), x, y, { width })
    y = pdf.y + 4
  }
  if (document.comments) {
    pdf.text(winAnsi(`${words.comments}: ${document.comments}`), x, y, { width })
    y = pdf.y + 4
  }
  rule(pdf, x, y + 4, width)
  pdf.font(REGULAR).fontSize(8).text(winAnsi(words.declaration), x, y + 10, { width })
  y = pdf.y + 18
  pdf.font(REGULAR).fontSize(9).text(winAnsi(`${words.dateSignature}: ${formatDate(document.date, document.language)}`), x, y, { width })
  rule(pdf, x, pdf.y + 24, width * 0.5)
}
