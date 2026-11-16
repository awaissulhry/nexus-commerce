import PDFDocument from 'pdfkit'
import { inSheetOrder, sheetTotals, type ManifestSheet } from '@nexus/factory-domain/shipping/manifest/rules'
import { parseDecimal, ZERO } from '@nexus/factory-domain/tax/decimal'
import { PDF_CREATOR } from '../../documents/pdf'
// B-W2b-GF2 (G076): embedded fonts, so every European letter prints (the standard fonts printed "?").
import { FONT, printableText, useFonts } from '../../documents/fonts'

/**
 * The day's sheet for a carrier laid out (B-W2b-395; LOG-049; design warehouse.shipments "End-of-day manifest PDF": the driver
 * signs the paper): an A4 page (more when the shipments run over) with the company, the site and its address, the carrier and
 * the day; one row per shipment handed over (its number, the consignee and where, parcels, weight, tracking numbers, DDT);
 * the totals; and the boxes the driver signs (name, signature, the time the goods were taken) and the dock signs. Italian and
 * English headings side by side (the driver's and the office's). A preview says PREVIEW across the top and names no closing
 * time; a sheet closed by the system says so. No price, no person of ours. The sheet is composed in factory-domain
 * shipping/manifest/rules.ts; here it becomes a PDF (stored by modules/shipping/manifest, printed on the site's A4 printer).
 */

const MM = 72 / 25.4
const PAGE = { width: 210 * MM, height: 297 * MM, margin: 14 * MM }
const ROW = 15
const HEAD = 9

/** The columns: their headings and width shares of the inner width. */
const COLUMNS = [
  { key: 'n', heading: '#', share: 0.04 },
  { key: 'number', heading: 'Spedizione / Shipment', share: 0.15 },
  { key: 'consignee', heading: 'Destinatario / Consignee', share: 0.27 },
  { key: 'parcels', heading: 'Colli', share: 0.07 },
  { key: 'weight', heading: 'Kg', share: 0.09 },
  { key: 'tracking', heading: 'Tracking', share: 0.26 },
  { key: 'ddt', heading: 'DDT', share: 0.12 },
] as const

/** Fits a text to a width in points at the font set now (an ellipsis when it runs over). */
function fit(pdf: PDFKit.PDFDocument, text: string, width: number): string {
  const clean = printableText(text)
  if (pdf.widthOfString(clean) <= width) return clean
  let cut = clean
  while (cut.length > 1 && pdf.widthOfString(`${cut}...`) > width) cut = cut.slice(0, -1)
  return `${cut}...`
}

/** The sheet as a PDF (bytes). */
export async function manifestPdf(sheet: ManifestSheet): Promise<Buffer> {
  const pdf = new PDFDocument({
    size: 'A4',
    margin: 0,
    autoFirstPage: false,
    compress: true,
    lang: 'it',
    info: { Title: printableText(`Distinta ${sheet.carrier.name} ${sheet.day}`), Creator: PDF_CREATOR, Producer: PDF_CREATOR, CreationDate: new Date(0) },
  })
  useFonts(pdf)
  const chunks: Buffer[] = []
  pdf.on('data', (chunk: Buffer) => chunks.push(chunk))
  const ended = new Promise<void>((resolve, reject) => {
    pdf.on('end', () => resolve())
    pdf.on('error', reject)
  })
  const inner = PAGE.width - 2 * PAGE.margin
  const left = PAGE.margin
  const text = (value: string, x: number, y: number, width: number, size: number, bold = false, colour = '#111111') => {
    pdf.font(bold ? FONT.bold : FONT.regular).fontSize(size).fillColor(colour)
    pdf.text(fit(pdf, value, width), x, y, { width, lineBreak: false, height: size * 1.3 })
  }
  let page = 0
  const rows = inSheetOrder(sheet.shipments)
  const totals = sheetTotals(rows)

  const header = (): number => {
    pdf.addPage({ size: 'A4', margin: 0 })
    page++
    let y = PAGE.margin
    if (sheet.preview) {
      pdf.rect(left, y, inner, 18).fill('#111111')
      text('ANTEPRIMA - NON CHIUSA / PREVIEW - NOT CLOSED', left + 6, y + 4, inner - 12, 10, true, '#ffffff')
      y += 26
    }
    text('Distinta di consegna al vettore / Carrier manifest', left, y, inner, 15, true)
    y += 22
    text(sheet.companyName, left, y, inner * 0.6, 10, true)
    text(`${sheet.site.code} - ${sheet.site.name}`, left, y + 13, inner * 0.6, 9)
    sheet.site.address.slice(0, 3).forEach((line, index) => text(line, left, y + 25 + index * 11, inner * 0.6, 8, false, '#555555'))
    const right = left + inner * 0.62
    const facts: [string, string][] = [
      ['Vettore / Carrier', `${sheet.carrier.name} (${sheet.carrier.code})`],
      ['Giorno / Day', sheet.day],
      ['Distinta / Sheet', sheet.sheetId ? sheet.sheetId.slice(-12).toUpperCase() : '-'],
      ['Chiusa / Closed', sheet.closedAt ? `${sheet.closedAt}${sheet.closedBySystem ? ' (sistema / system)' : ''}` : '-'],
    ]
    facts.forEach(([label, value], index) => {
      text(label, right, y + index * 13, inner * 0.16, 8, false, '#555555')
      text(value, right + inner * 0.16, y + index * 13, inner * 0.22, 8.5, true)
    })
    y += 62
    text(`Pagina / Page ${page}`, left, PAGE.height - PAGE.margin + 2, inner, 7, false, '#555555')
    // The table's heading row.
    pdf.rect(left, y, inner, ROW).fill('#ececec')
    let x = left
    for (const column of COLUMNS) {
      text(column.heading, x + 3, y + 4, column.share * inner - 6, 7.5, true)
      x += column.share * inner
    }
    return y + ROW
  }

  let y = header()
  const bottom = PAGE.height - PAGE.margin - 8
  if (rows.length === 0) {
    text('Nessuna spedizione consegnata al vettore / Nothing handed over to the carrier.', left + 3, y + 5, inner - 6, 9)
    y += ROW + 6
  }
  rows.forEach((row, index) => {
    const lines = Math.max(1, Math.ceil(row.trackingNumbers.length / 2))
    const height = HEAD + lines * 10
    if (y + height > bottom - 150) y = header()
    let x = left
    const cells: Record<(typeof COLUMNS)[number]['key'], string[]> = {
      n: [String(index + 1)],
      number: [row.number],
      consignee: [row.consignee, `${row.city} (${row.country})`],
      parcels: [String(row.parcels)],
      weight: [(parseDecimal(row.weightKg) ?? ZERO).toFixed(2)],
      tracking: row.trackingNumbers.length === 0 ? ['-'] : Array.from({ length: lines }, (_, line) => row.trackingNumbers.slice(line * 2, line * 2 + 2).join('  ')),
      ddt: [row.ddtNumber ?? '-'],
    }
    for (const column of COLUMNS) {
      cells[column.key].forEach((value, line) => text(value, x + 3, y + 3 + line * 10, column.share * inner - 6, 8, column.key === 'number', line > 0 && column.key === 'consignee' ? '#555555' : '#111111'))
      x += column.share * inner
    }
    y += Math.max(height, 2 * 10 + 4)
    pdf.moveTo(left, y).lineTo(left + inner, y).lineWidth(0.4).strokeColor('#9a9a9a').stroke()
  })

  // Totals and the signatures (on the last page, a new one when there is no room).
  if (y > bottom - 150) y = header()
  y += 8
  text(`Spedizioni / Shipments: ${totals.shipments}    Colli / Parcels: ${totals.parcels}    Peso / Weight: ${(parseDecimal(totals.weightKg) ?? ZERO).toFixed(2)} kg`, left, y, inner, 10, true)
  y += 30
  const box = (label: string, x: number, width: number) => {
    pdf.rect(x, y, width, 60).lineWidth(0.6).strokeColor('#111111').stroke()
    text(label, x + 5, y + 4, width - 10, 7.5, false, '#555555')
  }
  const third = (inner - 12) / 3
  box("Autista (nome) / Driver's name", left, third)
  box('Firma autista / Driver signature', left + third + 6, third)
  box('Ora del ritiro / Time collected', left + 2 * (third + 6), third)
  y += 70
  box('Per il mittente / For the sender', left, third)
  y += 70
  text('I colli elencati sono stati consegnati al vettore integri. / The parcels listed were handed over to the carrier intact.', left, y, inner, 8, false, '#555555')
  pdf.end()
  await ended
  return Buffer.concat(chunks)
}
