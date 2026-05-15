/**
 * FNSKU label PDF generator using pdfkit.
 *
 * Two modes:
 *   'label' — one label per page, page size = label dimensions. Ideal for
 *             thermal label printers (Zebra, Dymo, Brother, etc.).
 *   'a4'    — labels tiled on A4 pages with 5mm margins and 2mm gaps.
 *             Print on a regular printer, then cut.
 *
 * All coordinates are in points (pt). 1mm = 2.8346pt.
 * Barcode is rendered as filled black rectangles (CODE128B, uniform scale).
 * Fonts use pdfkit built-ins: Helvetica, Courier, Times-Roman.
 */

import PDFDocument from 'pdfkit'

// ── Types (mirrors frontend types.ts — kept local to avoid cross-workspace dep) ──

interface TemplateRow {
  id: string
  badgeText: string
  valueSource: string
  customValue: string
  show: boolean
  fontScale?: number
  textTransform?: string
  boldValue?: boolean
}

interface TemplateConfig {
  labelSize: { widthMm: number; heightMm: number }
  columnSplitPct?: number
  paddingMm?: number
  showColumnDivider?: boolean
  logoUrl?: string
  showLogo?: boolean
  showSizeBox?: boolean
  sizeBoxLabel?: string
  barcodeHeightPct?: number
  barcodeWidthPct?: number
  showListingTitle?: boolean
  listingTitleLines?: number
  showCondition?: boolean
  condition?: string
  fontFamily?: string
  badgeFontScale?: number
  valueFontScale?: number
  rows: TemplateRow[]
}

interface LabelItem {
  sku: string
  fnsku: string
  productName?: string | null
  listingTitle?: string | null
  variationAttributes?: Record<string, string>
  imageUrl?: string | null
}

// ── CODE128B encoder ─────────────────────────────────────────────────────────

const PATTERNS: readonly string[] = [
  '212222','222122','222221','121223','121322','131222','122213','122312',
  '132212','221213','221312','231212','112232','122132','122231','113222',
  '123122','123221','223211','221132','221231','213212','223112','312131',
  '311222','321122','321221','312212','322112','322211','212123','212321',
  '232121','111323','131123','131321','112313','132113','132311','211313',
  '231113','231311','112133','112331','132131','113123','113321','133121',
  '313121','211331','231131','213113','213311','213131','311123','311321',
  '331121','312113','312311','332111','314111','221411','431111','111224',
  '111422','121124','121421','141122','141221','112214','112412','122114',
  '122411','142112','142211','241211','221114','413111','241112','134111',
  '111242','121142','121241','114212','124112','124211','411212','421112',
  '421211','212141','214121','412121','111143','111341','131141','114113',
  '114311','411113','411311','113141','114131','311141','411131','211412',
  '211214','211232','2331112',
]
const START_B = 104
const STOP    = 106

function encodeBarcode(value: string): { bars: { x: number; w: number }[]; totalUnits: number } {
  const safe  = String(value ?? '').replace(/[^\x20-\x7E]/g, '?')
  const codes: number[] = []
  for (const ch of safe) {
    const v = ch.charCodeAt(0) - 32
    codes.push(v >= 0 && v <= 95 ? v : '?'.charCodeAt(0) - 32)
  }
  const checksum = (START_B + codes.reduce((acc, c, i) => acc + c * (i + 1), 0)) % 103
  const sequence = [START_B, ...codes, checksum, STOP]

  const bars: { x: number; w: number }[] = []
  let cursor = 0
  for (const sym of sequence) {
    const pat = PATTERNS[sym]
    if (!pat) continue
    let isBar = true
    for (const ch of pat) {
      const w = parseInt(ch, 10)
      if (isBar) bars.push({ x: cursor, w })
      cursor += w
      isBar = !isBar
    }
  }
  return { bars, totalUnits: cursor }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const MM = 2.8346 // 1mm in points

function mm(n: number) { return n * MM }

function applyTextTransform(s: string, tx?: string): string {
  if (!s) return s
  if (tx === 'uppercase') return s.toUpperCase()
  if (tx === 'capitalize') return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()
  return s
}

function getRowValue(row: TemplateRow, item: LabelItem): string {
  const attrs = item.variationAttributes ?? {}
  switch (row.valueSource) {
    case 'productName': return item.productName ?? ''
    case 'color':  return attrs['Color']  ?? attrs['color']  ?? ''
    case 'size':   return attrs['Size']   ?? attrs['size']   ?? ''
    case 'gender': return attrs['Gender'] ?? attrs['gender'] ?? ''
    case 'sku':    return item.sku
    case 'custom': return row.customValue
    default: return ''
  }
}

// Map template fontFamily to pdfkit built-in font names
function resolveFont(family?: string, bold = false): string {
  const f = (family ?? 'Arial').toLowerCase()
  if (f.includes('mono') || f.includes('courier')) return bold ? 'Courier-Bold' : 'Courier'
  if (f.includes('georgia') || f.includes('times')) return bold ? 'Times-Bold' : 'Times-Roman'
  return bold ? 'Helvetica-Bold' : 'Helvetica'
}

// Fetch an image URL as a Buffer. Returns null on any error.
const imageCache = new Map<string, Buffer | null>()

async function fetchImageBuffer(url: string): Promise<Buffer | null> {
  if (imageCache.has(url)) return imageCache.get(url)!
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) })
    if (!res.ok) { imageCache.set(url, null); return null }
    const ab  = await res.arrayBuffer()
    const buf = Buffer.from(ab)
    imageCache.set(url, buf)
    return buf
  } catch {
    imageCache.set(url, null)
    return null
  }
}

// ── Label renderer ────────────────────────────────────────────────────────────

async function drawLabel(
  doc: InstanceType<typeof PDFDocument>,
  xPt: number,
  yPt: number,
  wPt: number,
  hPt: number,
  item: LabelItem,
  template: TemplateConfig,
) {
  const rightPct    = Math.max(15, Math.min(55, template.columnSplitPct ?? 38)) / 100
  const rightW      = wPt * rightPct
  const leftW       = wPt - rightW
  const padPt       = mm(template.paddingMm ?? 2)
  const barcodeHPt  = hPt * ((template.barcodeHeightPct ?? 32) / 100)
  const innerW      = rightW - padPt * 2
  const barcodeWPt  = Math.max(mm(5), innerW * ((template.barcodeWidthPct ?? 100) / 100))

  const badgeScale  = template.badgeFontScale  ?? 1
  const valueScale  = template.valueFontScale  ?? 1
  const fontBase    = resolveFont(template.fontFamily)
  const fontBold    = resolveFont(template.fontFamily, true)
  const activeRows  = (template.rows ?? []).filter(r => r.show)

  const attrs = item.variationAttributes ?? {}
  const sizeVal = attrs['Size'] ?? attrs['size'] ?? ''

  // ── Thin label border ────────────────────────────────────────────────────
  doc.save().rect(xPt, yPt, wPt, hPt).stroke('#cccccc').restore()

  // ── Left column ──────────────────────────────────────────────────────────
  const lx = xPt + padPt
  let   ly = yPt + padPt

  // Divider
  if (template.showColumnDivider !== false) {
    doc.save()
      .moveTo(xPt + leftW, yPt + padPt)
      .lineTo(xPt + leftW, yPt + hPt - padPt)
      .stroke('#dddddd')
      .restore()
  }

  // Logo
  if (template.showLogo) {
    const logoH = hPt * 0.22
    if (template.logoUrl) {
      const buf = await fetchImageBuffer(template.logoUrl)
      if (buf) {
        try {
          doc.image(buf, lx, ly, { fit: [leftW - padPt * 2, logoH] })
        } catch { /* image format not supported — skip */ }
      }
    } else {
      // Placeholder black box "LOGO"
      doc.save()
        .rect(lx, ly, mm(20), logoH * 0.6).fill('#111111')
        .fillColor('white').font(fontBold).fontSize(logoH * 0.28)
        .text('LOGO', lx + mm(1), ly + logoH * 0.16, { width: mm(18), align: 'center' })
        .restore()
    }
    ly += logoH + padPt
  }

  // Field rows — vertically centred in remaining left-col height
  const rowsAvailH = yPt + hPt - padPt - ly
  const rowCount   = activeRows.length
  const rowH       = rowCount > 0 ? rowsAvailH / rowCount : 0

  activeRows.forEach((row, i) => {
    const isFirst   = i === 0
    const baseFs    = isFirst ? hPt * 0.13 : hPt * 0.10
    const fs        = baseFs * valueScale * (row.fontScale ?? 1)
    const badgeFs   = hPt * 0.07 * badgeScale
    const badgeMinW = hPt * 0.45 * badgeScale
    const rowY      = ly + i * rowH + (rowH - Math.max(badgeFs, fs)) / 2

    const value = applyTextTransform(getRowValue(row, item), row.textTransform ?? 'uppercase')
    const badge = (row.badgeText || '—').toUpperCase()

    // Badge (black pill)
    const badgePadH = badgeFs * 0.3
    const badgePadW = badgeFs * 0.5
    const badgeW    = Math.max(badgeMinW, doc.font(fontBold).fontSize(badgeFs).widthOfString(badge) + badgePadW * 2)
    const badgeH    = badgeFs + badgePadH * 2

    doc.save()
      .rect(lx, rowY, badgeW, badgeH).fill('#111111')
      .fillColor('white').font(fontBold).fontSize(badgeFs)
      .text(badge, lx, rowY + badgePadH, { width: badgeW, align: 'center', lineBreak: false })
      .restore()

    // Value text
    const vFont = row.boldValue !== false ? fontBold : fontBase
    const vfw   = row.boldValue !== false ? (isFirst ? 900 : 700) : 400 // unused by pdfkit but harmless
    void vfw
    const valueX = lx + badgeW + mm(2)
    const valueW = leftW - padPt - badgeW - mm(2)
    const valueStr = value || '—'

    doc.save()
      .fillColor('#000000').font(vFont).fontSize(fs)
      .text(valueStr, valueX, rowY + (badgeH - fs) / 2, { width: valueW, lineBreak: false, ellipsis: true })
      .restore()
  })

  // ── Right column ─────────────────────────────────────────────────────────
  const rx = xPt + leftW + padPt
  let   ry = yPt + padPt

  // Size box
  if (template.showSizeBox) {
    const sizeLabel = (template.sizeBoxLabel || 'SIZE').toUpperCase()
    const boxW      = rightW - padPt * 2
    const labelFs   = hPt * 0.06
    const labelH    = labelFs * 1.5
    const valFs     = hPt * 0.19
    const valH      = valFs * 1.1
    const boxH      = labelH + valH + mm(1)

    // Border
    doc.save().rect(rx, ry, boxW, boxH).stroke('#111111').restore()
    // Header strip
    doc.save().rect(rx, ry, boxW, labelH).fill('#111111')
      .fillColor('white').font(fontBold).fontSize(labelFs)
      .text(sizeLabel, rx, ry + (labelH - labelFs) / 2, { width: boxW, align: 'center', lineBreak: false })
      .restore()
    // Size value
    doc.save()
      .fillColor('#000000').font(fontBold).fontSize(valFs)
      .text(sizeVal || '—', rx, ry + labelH + mm(0.5), { width: boxW, align: 'center', lineBreak: false })
      .restore()

    ry += boxH + padPt
  }

  // Barcode
  if (item.fnsku) {
    const { bars, totalUnits } = encodeBarcode(item.fnsku)
    const scale = barcodeWPt / totalUnits
    // Centre barcode horizontally in the right inner column
    const bcX = rx + (innerW - barcodeWPt) / 2

    doc.save()
    for (const b of bars) {
      doc.rect(bcX + b.x * scale, ry, b.w * scale, barcodeHPt).fill('#000000')
    }
    doc.restore()

    ry += barcodeHPt + mm(1)

    // FNSKU text
    const fnskuFs = Math.min(hPt * 0.063, barcodeWPt / (item.fnsku.length * 0.6 + 2))
    doc.save()
      .fillColor('#111111').font('Courier').fontSize(fnskuFs)
      .text(item.fnsku, rx, ry, { width: innerW, align: 'center', lineBreak: false })
      .restore()
    ry += fnskuFs + mm(0.8)

    // Listing title
    if (template.showListingTitle && item.listingTitle) {
      const maxLines = template.listingTitleLines ?? 2
      const titleFs  = hPt * 0.052
      doc.save()
        .fillColor('#333333').font(fontBase).fontSize(titleFs)
        .text(item.listingTitle, rx, ry, {
          width: innerW, align: 'center',
          height: titleFs * 1.3 * maxLines,
          lineBreak: true,
        })
        .restore()
      ry += titleFs * 1.3 * maxLines + mm(0.5)
    }

    // Condition
    if (template.showCondition) {
      const condFs = hPt * 0.052
      doc.save()
        .fillColor('#333333').font(fontBase).fontSize(condFs)
        .text(template.condition || 'New', rx, ry, { width: innerW, align: 'center', lineBreak: false })
        .restore()
    }
  } else {
    // No FNSKU placeholder
    doc.save()
      .rect(rx, ry, innerW, barcodeHPt).stroke('#cccccc')
      .fillColor('#bbbbbb').font(fontBase).fontSize(hPt * 0.06)
      .text('No FNSKU', rx, ry + barcodeHPt / 2 - hPt * 0.03, { width: innerW, align: 'center', lineBreak: false })
      .restore()
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function renderFnskuLabelPdf(
  items: LabelItem[],
  template: TemplateConfig,
  mode: 'label' | 'a4' = 'label',
): Promise<Buffer> {
  const { widthMm, heightMm } = template.labelSize
  const wPt = mm(widthMm)
  const hPt = mm(heightMm)

  if (mode === 'label') {
    // One label per page, page = label dimensions
    const doc = new PDFDocument({ size: [wPt, hPt], margin: 0, autoFirstPage: false })
    const chunks: Buffer[] = []
    doc.on('data', (c: Buffer) => chunks.push(c))
    const finished = new Promise<Buffer>((resolve, reject) => {
      doc.on('end', () => resolve(Buffer.concat(chunks)))
      doc.on('error', reject)
    })

    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      doc.addPage({ size: [wPt, hPt], margin: 0 })
      await drawLabel(doc, 0, 0, wPt, hPt, item, template)
    }

    doc.end()
    return finished

  } else {
    // A4 tiled layout
    const A4W = mm(210)
    const A4H = mm(297)
    const marginPt = mm(5)
    const gapPt    = mm(2)

    const cols = Math.max(1, Math.floor((A4W - 2 * marginPt + gapPt) / (wPt + gapPt)))
    const rows = Math.max(1, Math.floor((A4H - 2 * marginPt + gapPt) / (hPt + gapPt)))

    const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: false })
    const chunks: Buffer[] = []
    doc.on('data', (c: Buffer) => chunks.push(c))
    const finished = new Promise<Buffer>((resolve, reject) => {
      doc.on('end', () => resolve(Buffer.concat(chunks)))
      doc.on('error', reject)
    })

    let col = 0, row = 0
    let pageStarted = false

    const ensurePage = () => {
      if (!pageStarted) { doc.addPage({ size: 'A4', margin: 0 }); pageStarted = true }
    }
    const nextCell = () => {
      col++
      if (col >= cols) { col = 0; row++ }
      if (row >= rows) { col = 0; row = 0; pageStarted = false }
    }

    for (const item of items) {
      ensurePage()
      const xPt = marginPt + col * (wPt + gapPt)
      const yPt = marginPt + row * (hPt + gapPt)
      await drawLabel(doc, xPt, yPt, wPt, hPt, item, template)
      nextCell()
    }

    doc.end()
    return finished
  }
}
