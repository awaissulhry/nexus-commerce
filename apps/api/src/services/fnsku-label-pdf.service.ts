/**
 * FNSKU label PDF generator — pdfkit-based, strict layout budgeting.
 *
 * Every element has a pre-calculated height allocation. The entire label is
 * wrapped in a clip path so nothing can visually escape the boundary even if
 * calculations are off. Font sizes are capped to never exceed their allocated
 * space. No element position relies on doc.y — all coordinates are absolute.
 *
 * Two modes:
 *   'label' — one label per page, page = label dimensions (thermal printers)
 *   'a4'    — labels tiled on A4 pages (5mm margin, 2mm gap, auto cols×rows)
 */

import PDFDocument from 'pdfkit'

// ── Types (mirrors frontend types.ts) ────────────────────────────────────────

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
  fnsku?: string | null
  asin?: string | null
  productName?: string | null
  listingTitle?: string | null
  variationAttributes?: Record<string, string>
  imageUrl?: string | null
}

// ── CODE128B encoder ──────────────────────────────────────────────────────────

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

// ── Helpers ───────────────────────────────────────────────────────────────────

const MM_TO_PT = 2.8346
function mm(n: number) { return n * MM_TO_PT }

function applyTextTransform(s: string, tx?: string): string {
  if (!s) return s
  if (tx === 'uppercase')  return s.toUpperCase()
  if (tx === 'capitalize') return s.charAt(0).toUpperCase() + s.slice(1)
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
    case 'asin':   return item.asin ?? ''
    case 'custom': return row.customValue
    default: return ''
  }
}

function resolveFont(family?: string, bold = false): string {
  const f = (family ?? 'Arial').toLowerCase()
  if (f.includes('mono') || f.includes('courier')) return bold ? 'Courier-Bold' : 'Courier'
  if (f.includes('georgia') || f.includes('times')) return bold ? 'Times-Bold'   : 'Times-Roman'
  return bold ? 'Helvetica-Bold' : 'Helvetica'
}

/**
 * Auto-shrink font size until text fits within maxWidth.
 * Uses pdfkit's widthOfString() which is font-metric accurate.
 * Returns the fitted font size; also leaves doc in that font/size state.
 */
function fitTextSize(
  doc: InstanceType<typeof PDFDocument>,
  text: string,
  font: string,
  startSize: number,
  maxWidth: number,
  minSize = mm(2),
): number {
  let fs = Math.max(minSize, startSize)
  doc.font(font).fontSize(fs)
  while (fs > minSize && doc.widthOfString(text) > maxWidth) {
    fs = Math.max(minSize, fs - 0.4)
    doc.font(font).fontSize(fs)
  }
  return fs
}

// Image fetch with 4-second timeout and per-process cache
const imageCache = new Map<string, Buffer | null>()
async function fetchImageBuffer(url: string): Promise<Buffer | null> {
  if (imageCache.has(url)) return imageCache.get(url)!
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) })
    if (!res.ok) { imageCache.set(url, null); return null }
    const buf = Buffer.from(await res.arrayBuffer())
    imageCache.set(url, buf)
    return buf
  } catch {
    imageCache.set(url, null); return null
  }
}

// ── Label renderer — strict layout budgeting + clipping ──────────────────────

async function drawLabel(
  doc: InstanceType<typeof PDFDocument>,
  xPt: number,
  yPt: number,
  wPt: number,
  hPt: number,
  item: LabelItem,
  template: TemplateConfig,
) {
  const rightPct  = Math.max(15, Math.min(55, template.columnSplitPct ?? 38)) / 100
  const rightW    = wPt * rightPct
  const leftW     = wPt - rightW
  const padPt     = mm(template.paddingMm ?? 2)
  const innerH    = hPt - 2 * padPt          // usable height in both columns

  const badgeScale = template.badgeFontScale ?? 1
  const valueScale = template.valueFontScale ?? 1
  const fontBase   = resolveFont(template.fontFamily)
  const fontBold   = resolveFont(template.fontFamily, true)
  const activeRows = (template.rows ?? []).filter(r => r.show)

  const attrs  = item.variationAttributes ?? {}
  const sizeVal = attrs['Size'] ?? attrs['size'] ?? ''

  // ── CLIP everything to label boundary ────────────────────────────────────
  doc.save()
  doc.rect(xPt, yPt, wPt, hPt).clip()

  // Thin border (drawn inside clip so it's always visible)
  doc.rect(xPt, yPt, wPt, hPt).stroke('#bbbbbb')

  // ── LEFT COLUMN ───────────────────────────────────────────────────────────
  const lx = xPt + padPt

  // ---- Logo ----------------------------------------------------------------
  let logoH = 0
  if (template.showLogo && template.logoUrl) {
    logoH = Math.min(hPt * 0.20, innerH * 0.25)
    const buf = await fetchImageBuffer(template.logoUrl)
    if (buf) {
      try {
        doc.image(buf, lx, yPt + padPt, { fit: [leftW - padPt * 2, logoH] })
      } catch { /* unsupported format — skip silently */ }
    }
  }

  // ---- Field rows ----------------------------------------------------------
  const rowsStartY = yPt + padPt + (logoH > 0 ? logoH + padPt * 0.5 : 0)
  const rowsH      = (yPt + hPt - padPt) - rowsStartY
  const rowCount   = activeRows.length
  const rowH       = rowCount > 0 ? rowsH / rowCount : 0

  activeRows.forEach((row, i) => {
    const isFirst  = i === 0
    const badgeFs  = Math.min(hPt * 0.07  * badgeScale, rowH * 0.42)
    const valueFs  = Math.min(
      hPt * (isFirst ? 0.12 : 0.09) * valueScale * (row.fontScale ?? 1),
      rowH * (isFirst ? 0.62 : 0.52),
    )
    const badgePadH = badgeFs * 0.28
    const badgePadW = badgeFs * 0.45
    const badgeH    = badgeFs + badgePadH * 2

    // Vertical centre within this row
    const rowTopY  = rowsStartY + i * rowH
    const rowMidY  = rowTopY + rowH / 2

    // Badge width — measure text then ensure minimum
    doc.font(fontBold).fontSize(badgeFs)
    const badgeLabel = (row.badgeText || '—').toUpperCase()
    const measuredW  = doc.widthOfString(badgeLabel)
    const badgeMinW  = hPt * 0.42 * badgeScale
    const badgeW     = Math.max(badgeMinW, measuredW + badgePadW * 2)

    const badgeX = lx
    const badgeY = rowMidY - badgeH / 2

    // Draw badge (black fill, white text)
    doc.rect(badgeX, badgeY, badgeW, badgeH).fill('#111111')
    doc.font(fontBold).fontSize(badgeFs).fillColor('#ffffff')
       .text(badgeLabel, badgeX, badgeY + badgePadH,
             { width: badgeW, align: 'center', lineBreak: false })

    // Value text — auto-shrink to fit available width
    const tx     = row.textTransform ?? 'uppercase'
    const value  = applyTextTransform(getRowValue(row, item), tx) || '—'
    const vFont  = row.boldValue !== false ? fontBold : fontBase
    const valueX = lx + badgeW + mm(1.5)
    const valueW = Math.max(mm(5), leftW - padPt - badgeW - mm(1.5))
    const fittedValueFs = fitTextSize(doc, value, vFont, valueFs, valueW)
    const valueY = rowMidY - fittedValueFs / 2

    doc.font(vFont).fontSize(fittedValueFs).fillColor('#000000')
       .text(value, valueX, valueY, { width: valueW, lineBreak: false })
  })

  // Divider line
  if (template.showColumnDivider !== false) {
    doc.moveTo(xPt + leftW, yPt + padPt)
       .lineTo(xPt + leftW, yPt + hPt - padPt)
       .stroke('#dddddd')
  }

  // ── RIGHT COLUMN — budget height before drawing anything ──────────────────
  const rx = xPt + leftW + padPt
  const innerRightW = rightW - padPt * 2

  // --- Size box budget ------------------------------------------------------
  let sizeBoxH   = 0
  let sizeHeaderH = 0
  let sizeValFs  = 0

  if (template.showSizeBox) {
    sizeHeaderH = Math.min(hPt * 0.06, innerH * 0.10)
    sizeValFs   = Math.min(hPt * 0.17, Math.max(sizeHeaderH * 1.2, (innerH * 0.28) - sizeHeaderH))
    sizeBoxH    = sizeHeaderH + sizeValFs * 1.2 + mm(1.5)
  }

  // --- Barcode budget -------------------------------------------------------
  const barcodeHPct = Math.min(template.barcodeHeightPct ?? 32, 55)
  let barcodeHPt = Math.min(innerH * barcodeHPct / 100, innerH * 0.55)
  if (template.showSizeBox) barcodeHPt = Math.min(barcodeHPt, innerH - sizeBoxH - padPt * 0.5 - mm(8))

  // Width with quiet zone enforcement
  const barcodeWPct = template.barcodeWidthPct ?? 100
  const quietZonePt = mm(2)
  const rawBarcodeW = Math.max(mm(5), innerRightW * (barcodeWPct / 100))
  const effectiveBarcodeW = Math.max(mm(10), rawBarcodeW - 2 * quietZonePt)
  const bcX = rx + (innerRightW - effectiveBarcodeW) / 2

  // --- Info block budget (FNSKU text + listing title + condition) -----------
  const usedH   = sizeBoxH + (sizeBoxH > 0 ? padPt * 0.5 : 0) + barcodeHPt + mm(1.5)
  const infoH   = Math.max(0, innerH - usedH)

  const fnskuFs = item.fnsku ? Math.min(innerH * 0.06, Math.max(mm(2), infoH * 0.28)) : 0
  const fnskuH  = fnskuFs > 0 ? fnskuFs * 1.4 : 0

  const maxTitleLines = template.listingTitleLines ?? 2
  const titleFs = (template.showListingTitle && item.listingTitle)
    ? Math.min(innerH * 0.05, Math.max(mm(1.5), (infoH - fnskuH) * 0.5 / maxTitleLines))
    : 0
  const titleH  = titleFs > 0 ? titleFs * 1.35 * maxTitleLines + mm(0.5) : 0

  const condFs  = template.showCondition
    ? Math.min(titleFs > 0 ? titleFs : innerH * 0.05, Math.max(mm(1.5), infoH - fnskuH - titleH))
    : 0

  // --- Draw right column top-to-bottom (all positions are absolute) ---------
  let ry = yPt + padPt

  // Size box
  if (template.showSizeBox && sizeBoxH > 0) {
    const boxW    = innerRightW
    const sizeLabel = (template.sizeBoxLabel || 'SIZE').toUpperCase()

    // Border
    doc.rect(rx, ry, boxW, sizeBoxH).stroke('#111111')
    // Header strip
    doc.rect(rx, ry, boxW, sizeHeaderH).fill('#111111')
    const sizeHdrFs = fitTextSize(doc, sizeLabel, fontBold, sizeHeaderH * 0.65, boxW - mm(1))
    doc.font(fontBold).fontSize(sizeHdrFs).fillColor('#ffffff')
       .text(sizeLabel, rx, ry + (sizeHeaderH - sizeHdrFs) / 2, { width: boxW, align: 'center', lineBreak: false })
    // Size value — auto-shrink to always fit inside box width
    const sizeValY    = ry + sizeHeaderH + mm(0.5)
    const fittedValFs = fitTextSize(doc, sizeVal || '—', fontBold, sizeValFs, boxW - mm(1))
    doc.font(fontBold).fontSize(fittedValFs).fillColor('#000000')
       .text(sizeVal || '—', rx, sizeValY, { width: boxW, align: 'center', lineBreak: false })

    ry += sizeBoxH + padPt * 0.5
  }

  // Barcode
  if (item.fnsku && barcodeHPt > 0) {
    const { bars, totalUnits } = encodeBarcode(item.fnsku)
    if (totalUnits > 0) {
      const scale = effectiveBarcodeW / totalUnits
      // White background behind barcode for clean scan
      doc.rect(bcX - quietZonePt, ry, effectiveBarcodeW + 2 * quietZonePt, barcodeHPt).fill('#ffffff')
      for (const b of bars) {
        doc.rect(bcX + b.x * scale, ry, Math.max(0.1, b.w * scale), barcodeHPt).fill('#000000')
      }
    }
    ry += barcodeHPt + mm(1)

    // FNSKU text — fit to barcode width so it always aligns with the bars above
    if (fnskuFs > 0 && item.fnsku) {
      const fittedFnskuFs = fitTextSize(doc, item.fnsku, fontBase, fnskuFs, effectiveBarcodeW)
      doc.font(fontBase).fontSize(fittedFnskuFs).fillColor('#111111')
         .text(item.fnsku, rx, ry, { width: innerRightW, align: 'center', lineBreak: false })
      ry += fittedFnskuFs * 1.4
    }

    // Listing title — line-wrapped, height capped
    if (titleFs > 0 && item.listingTitle) {
      doc.font(fontBase).fontSize(titleFs).fillColor('#333333')
         .text(item.listingTitle, rx, ry, {
           width: innerRightW, align: 'center',
           lineBreak: true,
           height: titleFs * 1.35 * maxTitleLines,
         })
      ry += titleH
    }

    // Condition — fit to available width
    if (condFs > 0) {
      const condText = template.condition || 'New'
      const fittedCondFs = fitTextSize(doc, condText, fontBase, condFs, innerRightW - mm(1))
      doc.font(fontBase).fontSize(fittedCondFs).fillColor('#333333')
         .text(condText, rx, ry, { width: innerRightW, align: 'center', lineBreak: false })
    }
  } else if (!item.fnsku) {
    // No FNSKU placeholder
    const placeH = Math.min(barcodeHPt, innerH * 0.4)
    doc.rect(rx, ry, innerRightW, placeH).stroke('#cccccc')
    doc.font(fontBase).fontSize(Math.min(mm(4), placeH * 0.3)).fillColor('#aaaaaa')
       .text('No FNSKU', rx, ry + placeH / 2 - mm(2), { width: innerRightW, align: 'center', lineBreak: false })
  }

  // ── Restore (also removes clip) ───────────────────────────────────────────
  doc.restore()
}

// ── Sheet capacity helper (mirrors FnskuLabelDesigner.tsx calculation) ────────

export function labelsPerA4Sheet(widthMm: number, heightMm: number): { cols: number; rows: number; total: number } {
  const marginMm = 5
  const gapMm    = 2
  const cols = Math.max(1, Math.floor((210 - 2 * marginMm + gapMm) / (widthMm + gapMm)))
  const rows = Math.max(1, Math.floor((297 - 2 * marginMm + gapMm) / (heightMm + gapMm)))
  return { cols, rows, total: cols * rows }
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

  const chunks: Buffer[] = []

  if (mode === 'label') {
    const doc = new PDFDocument({ size: [wPt, hPt], margin: 0, autoFirstPage: false })
    doc.on('data', (c: Buffer) => chunks.push(c))
    const finished = new Promise<Buffer>((resolve, reject) => {
      doc.on('end',   () => resolve(Buffer.concat(chunks)))
      doc.on('error', reject)
    })
    for (const item of items) {
      doc.addPage({ size: [wPt, hPt], margin: 0 })
      await drawLabel(doc, 0, 0, wPt, hPt, item, template)
    }
    doc.end()
    return finished

  } else {
    const A4W      = mm(210)
    const A4H      = mm(297)
    const marginPt = mm(5)
    const gapPt    = mm(2)

    const { cols, rows } = labelsPerA4Sheet(widthMm, heightMm)

    const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: false })
    doc.on('data', (c: Buffer) => chunks.push(c))
    const finished = new Promise<Buffer>((resolve, reject) => {
      doc.on('end',   () => resolve(Buffer.concat(chunks)))
      doc.on('error', reject)
    })

    let col = 0, row = 0, pageOpen = false

    for (const item of items) {
      if (!pageOpen) { doc.addPage({ size: 'A4', margin: 0 }); pageOpen = true }

      const xPt = marginPt + col * (wPt + gapPt)
      const yPt = marginPt + row * (hPt + gapPt)
      await drawLabel(doc, xPt, yPt, wPt, hPt, item, template)

      col++
      if (col >= cols) { col = 0; row++ }
      if (row >= rows) { col = 0; row = 0; pageOpen = false }
    }

    doc.end()
    return finished
  }
}
