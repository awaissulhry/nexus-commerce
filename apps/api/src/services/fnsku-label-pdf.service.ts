/**
 * FNSKU Label PDF — pdfkit renderer.
 *
 * All layout constants are IDENTICAL to LabelPreview.tsx so the PDF matches
 * the screen preview pixel-for-pixel. Vertical centering of rows and the
 * barcode stack mirrors CSS flexbox justifyContent:'center'.
 *
 * Two modes:
 *   'label' — one label per page, page = label dimensions (thermal printers)
 *   'a4'    — labels tiled on A4 with configurable margin/gap/columns
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
  sheetCols?: number
  sheetMarginMm?: number
  sheetGapMm?: number
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

// ── Layout constants — MUST match LabelPreview.tsx exactly ───────────────────
// These are ratios of label height H (or width W where noted).

const L = {
  LOGO_H:         0.22,   // logo area height / H
  LOGO_GAP:       0.025,  // gap after logo / H  (= padPx in preview marginBottom)
  BADGE_FS:       0.07,   // badge font size / H
  BADGE_PAD_V:    0.02,   // badge vertical padding / H
  BADGE_PAD_H:    0.03,   // badge horizontal padding / H
  BADGE_MIN_W:    0.45,   // badge min width / H
  VAL_FS_1:       0.13,   // first-row value font / H
  VAL_FS_N:       0.10,   // other-row value font / H
  ROW_GAP:        0.025,  // gap between rows / H
  COL_GAP_W:      0.015,  // badge-to-value gap / W (label WIDTH)
  SIZE_BOX_PAD:   0.01,   // size-box inner v-padding / H
  SIZE_HDR_FS:    0.06,   // size header font / H
  SIZE_HDR_PAD:   0.005,  // size header inner v-padding / H
  SIZE_VAL_FS:    0.19,   // size value font / H
  SIZE_VAL_MT:    0.01,   // size value margin-top / H
  SIZE_MB:        0.025,  // size box margin-bottom (= padPx) / H
  BARCODE_FS:     0.063,  // FNSKU text max font / H
  BARCODE_MT:     0.004,  // FNSKU text margin-top / H (≈ 2px at 288px)
  TITLE_FS:       0.052,  // listing title font / H
  TITLE_MT:       0.010,  // listing title margin-top / H (≈ 3px at 288px)
  TITLE_LH:       1.25,   // listing title line height
  COND_FS:        0.052,  // condition font / H
  COND_MT:        0.007,  // condition margin-top / H (≈ 2px at 288px)
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
  if (f.includes('mono') || f.includes('courier')) return bold ? 'Courier-Bold'  : 'Courier'
  if (f.includes('georgia') || f.includes('times')) return bold ? 'Times-Bold'   : 'Times-Roman'
  return bold ? 'Helvetica-Bold' : 'Helvetica'
}

/** Auto-shrink font size so text fits within maxWidth (using actual font metrics). */
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
  // Derived dimensions
  const rightPct   = Math.max(15, Math.min(55, template.columnSplitPct ?? 38)) / 100
  const rightW     = wPt * rightPct
  const leftW      = wPt - rightW
  const padPt      = mm(template.paddingMm ?? 2)
  const badgeScale = template.badgeFontScale ?? 1
  const valueScale = template.valueFontScale ?? 1
  const fontBase   = resolveFont(template.fontFamily)
  const fontBold   = resolveFont(template.fontFamily, true)
  const activeRows = (template.rows ?? []).filter(r => r.show)
  const attrs      = item.variationAttributes ?? {}
  const sizeVal    = attrs['Size'] ?? attrs['size'] ?? ''

  // ── Clip everything to label boundary ────────────────────────────────────
  doc.save()
  doc.rect(xPt, yPt, wPt, hPt).clip()

  // Label border (matches preview '1px solid #999')
  doc.lineWidth(0.5).rect(xPt, yPt, wPt, hPt).stroke('#999999')

  // ═══════════════════════════════════════════════════════════════════
  // LEFT COLUMN
  // ═══════════════════════════════════════════════════════════════════
  const lx = xPt + padPt
  const leftInnerW = leftW - padPt * 2

  // ── Logo ─────────────────────────────────────────────────────────
  // Matches preview: showLogo shows logo area (with or without URL)
  let logoAreaH = 0
  if (template.showLogo) {
    logoAreaH = hPt * L.LOGO_H

    if (template.logoUrl) {
      const buf = await fetchImageBuffer(template.logoUrl)
      if (buf) {
        try { doc.image(buf, lx, yPt + padPt, { fit: [leftInnerW, logoAreaH] }) }
        catch { /* unsupported format */ }
      }
    } else {
      // Placeholder box — matches preview's black "LOGO" badge
      const placeH = logoAreaH * 0.5
      const placeW = Math.min(mm(25), leftInnerW * 0.55)
      const placeX = lx
      const placeY = yPt + padPt + (logoAreaH - placeH) / 2
      const logoFs = fitTextSize(doc, 'LOGO', fontBold, placeH * 0.5, placeW - mm(2))
      doc.rect(placeX, placeY, placeW, placeH).fill('#000000')
      doc.font(fontBold).fontSize(logoFs).fillColor('#ffffff')
         .text('LOGO', placeX, placeY + (placeH - logoFs) / 2, { width: placeW, align: 'center', lineBreak: false })
    }
  }

  // ── Field rows — centred vertically in remaining left-col space ───
  // Mirrors CSS: flex column, justifyContent:'center', gap: hPt*L.ROW_GAP
  const logoGapPt   = logoAreaH > 0 ? padPt : 0   // matches preview marginBottom: padPx
  const rowsTopY    = yPt + padPt + logoAreaH + logoGapPt
  const rowsAvailH  = yPt + hPt - padPt - rowsTopY

  // Pre-compute each row's natural height to enable vertical centering
  const rowHeights = activeRows.map((row, i) => {
    const badgeFs  = hPt * L.BADGE_FS * badgeScale
    const badgeH   = badgeFs + 2 * hPt * L.BADGE_PAD_V
    const valueFs  = hPt * (i === 0 ? L.VAL_FS_1 : L.VAL_FS_N) * valueScale * (row.fontScale ?? 1)
    return Math.max(badgeH, valueFs)
  })

  const rowGap      = hPt * L.ROW_GAP
  const N           = rowHeights.length
  const totalGroupH = rowHeights.reduce((s, h) => s + h, 0) + (N > 1 ? (N - 1) * rowGap : 0)
  // Center the group: matches justifyContent:'center'
  const groupStartY = rowsTopY + Math.max(0, (rowsAvailH - totalGroupH) / 2)

  let curRowY = groupStartY
  activeRows.forEach((row, i) => {
    const rowH    = rowHeights[i]
    const rowMidY = curRowY + rowH / 2

    const badgeFs  = hPt * L.BADGE_FS * badgeScale
    const badgePadV = hPt * L.BADGE_PAD_V
    const badgePadH = hPt * L.BADGE_PAD_H
    const badgeH   = badgeFs + 2 * badgePadV
    const badgeLabel = (row.badgeText || '—').toUpperCase()

    // Measure badge width (identical to preview's minWidth: hPx * 0.45 * scale)
    doc.font(fontBold).fontSize(badgeFs)
    const measuredBadge = doc.widthOfString(badgeLabel)
    const badgeMinW     = hPt * L.BADGE_MIN_W * badgeScale
    const badgeW        = Math.max(badgeMinW, measuredBadge + badgePadH * 2)
    const badgeY        = rowMidY - badgeH / 2

    // Draw badge (black fill, white text)
    doc.rect(lx, badgeY, badgeW, badgeH).fill('#111111')
    doc.font(fontBold).fontSize(badgeFs).fillColor('#ffffff')
       .text(badgeLabel, lx, badgeY + badgePadV, { width: badgeW, align: 'center', lineBreak: false })

    // Value text — gap from badge matches preview wPx * 0.015
    const tx       = row.textTransform ?? 'uppercase'
    const rawValue = getRowValue(row, item)
    const value    = applyTextTransform(rawValue, tx) || '—'
    const vFont    = row.boldValue !== false ? fontBold : fontBase
    const valueFs  = hPt * (i === 0 ? L.VAL_FS_1 : L.VAL_FS_N) * valueScale * (row.fontScale ?? 1)
    const colGap   = wPt * L.COL_GAP_W
    const valueX   = lx + badgeW + colGap
    const valueW   = Math.max(mm(4), leftInnerW - badgeW - colGap)
    const fitted   = fitTextSize(doc, value, vFont, valueFs, valueW)
    const valueY   = rowMidY - fitted / 2

    doc.font(vFont).fontSize(fitted).fillColor('#000000')
       .text(value, valueX, valueY, { width: valueW, lineBreak: false })

    curRowY += rowH + (i < N - 1 ? rowGap : 0)
  })

  // Divider line
  if (template.showColumnDivider !== false) {
    doc.lineWidth(0.5)
       .moveTo(xPt + leftW, yPt + padPt)
       .lineTo(xPt + leftW, yPt + hPt - padPt)
       .stroke('#dddddd')
  }

  // ═══════════════════════════════════════════════════════════════════
  // RIGHT COLUMN
  // Pre-calculate all heights before drawing, then centre barcode stack
  // ═══════════════════════════════════════════════════════════════════
  const rx          = xPt + leftW + padPt
  const innerRightW = rightW - padPt * 2

  // ── Size box ─────────────────────────────────────────────────────
  // Dimensions mirror CSS: border + inner padding + header + marginTop + value
  let sizeBoxTotalH = 0
  let sizeHdrH      = 0
  let sizeValFsBase = 0

  if (template.showSizeBox) {
    sizeHdrH      = hPt * L.SIZE_HDR_FS + 2 * hPt * L.SIZE_HDR_PAD
    sizeValFsBase = hPt * L.SIZE_VAL_FS
    sizeBoxTotalH = 2 * hPt * L.SIZE_BOX_PAD + sizeHdrH + hPt * L.SIZE_VAL_MT + sizeValFsBase
  }
  const sizeBoxMB = template.showSizeBox ? hPt * L.SIZE_MB : 0

  // ── Barcode + info stack dimensions ──────────────────────────────
  const barcodeHPct  = Math.min(template.barcodeHeightPct ?? 32, 55)
  const barcodeHPt   = hPt * barcodeHPct / 100
  const quietZonePt  = mm(2)
  const rawBarcodeW  = Math.max(mm(5), innerRightW * ((template.barcodeWidthPct ?? 100) / 100))
  const effBarcodeW  = Math.max(mm(10), rawBarcodeW - 2 * quietZonePt)
  const bcX          = rx + (innerRightW - effBarcodeW) / 2

  const isMono = /mono|courier/i.test(template.fontFamily ?? '')
  const charWR = isMono ? 0.62 : 0.58

  // Font sizes for info stack (same ratios as preview)
  const fnskuFsRaw   = item.fnsku ? Math.min(hPt * L.BARCODE_FS, effBarcodeW / (item.fnsku.length * charWR + 2)) : 0
  const maxTitleLines = template.listingTitleLines ?? 2
  const titleFsRaw   = (template.showListingTitle && item.listingTitle) ? hPt * L.TITLE_FS : 0
  const condFsRaw    = template.showCondition ? hPt * L.COND_FS : 0

  // Stack height: barcode + gap + FNSKU text + title + condition
  // Matches preview flex column with margins
  const fnskuH  = fnskuFsRaw > 0 ? fnskuFsRaw + hPt * L.BARCODE_MT : 0
  const titleH  = titleFsRaw > 0 ? titleFsRaw * L.TITLE_LH * maxTitleLines + hPt * L.TITLE_MT : 0
  const condH   = condFsRaw  > 0 ? condFsRaw + hPt * L.COND_MT : 0
  const stackH  = barcodeHPt + mm(1) + fnskuH + titleH + condH

  // Remaining right-col height after size box — centre stack in it (CSS justifyContent:'center')
  const rightUsedBySize = sizeBoxTotalH + sizeBoxMB
  const rightRemaining  = hPt - 2 * padPt - rightUsedBySize
  const stackOffsetY    = Math.max(0, (rightRemaining - stackH) / 2)

  // ── Draw right column ─────────────────────────────────────────────
  let ry = yPt + padPt

  // Size box
  if (template.showSizeBox && sizeBoxTotalH > 0) {
    const boxW     = innerRightW
    const sizeLabel = (template.sizeBoxLabel || 'SIZE').toUpperCase()
    const border   = 1.5  // pt, matches CSS 2px

    doc.lineWidth(border).rect(rx, ry, boxW, sizeBoxTotalH).stroke('#111111')

    // Header strip
    const hdrY  = ry + hPt * L.SIZE_BOX_PAD
    const hdrFs = fitTextSize(doc, sizeLabel, fontBold, hPt * L.SIZE_HDR_FS, boxW - mm(2))
    doc.rect(rx, hdrY, boxW, sizeHdrH).fill('#111111')
    doc.font(fontBold).fontSize(hdrFs).fillColor('#ffffff')
       .text(sizeLabel, rx, hdrY + hPt * L.SIZE_HDR_PAD, { width: boxW, align: 'center', lineBreak: false })

    // Size value
    const valY  = hdrY + sizeHdrH + hPt * L.SIZE_VAL_MT
    const valFs = fitTextSize(doc, sizeVal || '—', fontBold, sizeValFsBase, boxW - mm(2))
    doc.font(fontBold).fontSize(valFs).fillColor('#000000')
       .text(sizeVal || '—', rx, valY, { width: boxW, align: 'center', lineBreak: false })

    ry += sizeBoxTotalH + sizeBoxMB
  }

  // Barcode stack — centred in remaining space
  ry += stackOffsetY

  if (item.fnsku) {
    // White quiet-zone background
    doc.rect(bcX - quietZonePt, ry, effBarcodeW + 2 * quietZonePt, barcodeHPt).fill('#ffffff')

    // Barcode bars
    const { bars, totalUnits } = encodeBarcode(item.fnsku)
    if (totalUnits > 0) {
      const scale = effBarcodeW / totalUnits
      for (const b of bars) {
        doc.rect(bcX + b.x * scale, ry, Math.max(0.1, b.w * scale), barcodeHPt).fill('#000000')
      }
    }
    ry += barcodeHPt + mm(1)

    // FNSKU text (centred under barcode)
    if (fnskuFsRaw > 0) {
      const fnskuFs = fitTextSize(doc, item.fnsku, fontBase, fnskuFsRaw, effBarcodeW)
      doc.font(fontBase).fontSize(fnskuFs).fillColor('#111111')
         .text(item.fnsku, rx, ry, { width: innerRightW, align: 'center', lineBreak: false })
      ry += fnskuH
    }

    // Listing title
    if (titleFsRaw > 0 && item.listingTitle) {
      ry += hPt * L.TITLE_MT
      doc.font(fontBase).fontSize(titleFsRaw).fillColor('#333333')
         .text(item.listingTitle, rx, ry, {
           width: innerRightW, align: 'center',
           lineBreak: true,
           height: titleFsRaw * L.TITLE_LH * maxTitleLines,
         })
      ry += titleFsRaw * L.TITLE_LH * maxTitleLines
    }

    // Condition
    if (condFsRaw > 0) {
      ry += hPt * L.COND_MT
      const condText = template.condition || 'New'
      const condFs   = fitTextSize(doc, condText, fontBase, condFsRaw, innerRightW - mm(1))
      doc.font(fontBase).fontSize(condFs).fillColor('#333333')
         .text(condText, rx, ry, { width: innerRightW, align: 'center', lineBreak: false })
    }

  } else {
    // No FNSKU placeholder (matches preview dashed border)
    const placeH = barcodeHPt
    doc.lineWidth(0.5).rect(rx, ry, innerRightW, placeH)
       .dash(3, { space: 3 }).stroke('#cccccc').undash()
    const noFs = fitTextSize(doc, 'No FNSKU', fontBase, mm(4), innerRightW - mm(2))
    doc.font(fontBase).fontSize(noFs).fillColor('#bbbbbb')
       .text('No FNSKU', rx, ry + placeH / 2 - noFs / 2, { width: innerRightW, align: 'center', lineBreak: false })
  }

  // Remove clip
  doc.restore()
}

// ── Sheet layout helpers ──────────────────────────────────────────────────────

export interface SheetLayout {
  cols: number
  rows: number
  total: number
  marginMm: number
  gapMm: number
  effectiveLabelW: number  // mm (may differ from configured if cols override applied)
}

export function computeSheetLayout(widthMm: number, heightMm: number, template: TemplateConfig): SheetLayout {
  const marginMm = template.sheetMarginMm ?? 5
  const gapMm    = template.sheetGapMm    ?? 2
  const userCols = template.sheetCols

  // Auto-calculate or use override
  const autoCols = Math.max(1, Math.floor((210 - 2 * marginMm + gapMm) / (widthMm + gapMm)))
  const cols     = userCols && userCols > 0 ? userCols : autoCols

  // When user specifies cols, compute the effective label width to fill that many columns
  const effectiveLabelW = userCols && userCols > 0
    ? (210 - 2 * marginMm - (cols - 1) * gapMm) / cols
    : widthMm

  const rows = Math.max(1, Math.floor((297 - 2 * marginMm + gapMm) / (heightMm + gapMm)))

  return { cols, rows, total: cols * rows, marginMm, gapMm, effectiveLabelW }
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
    const done = new Promise<Buffer>((res, rej) => {
      doc.on('end', () => res(Buffer.concat(chunks)))
      doc.on('error', rej)
    })
    for (const item of items) {
      doc.addPage({ size: [wPt, hPt], margin: 0 })
      await drawLabel(doc, 0, 0, wPt, hPt, item, template)
    }
    doc.end()
    return done

  } else {
    const { cols, rows, marginMm, gapMm, effectiveLabelW } = computeSheetLayout(widthMm, heightMm, template)
    const marginPt = mm(marginMm)
    const gapPt    = mm(gapMm)
    const effWPt   = mm(effectiveLabelW)

    const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: false })
    doc.on('data', (c: Buffer) => chunks.push(c))
    const done = new Promise<Buffer>((res, rej) => {
      doc.on('end', () => res(Buffer.concat(chunks)))
      doc.on('error', rej)
    })

    let col = 0, row = 0, pageOpen = false

    for (const item of items) {
      if (!pageOpen) { doc.addPage({ size: 'A4', margin: 0 }); pageOpen = true }
      const xPt = marginPt + col * (effWPt + gapPt)
      const yPt = marginPt + row * (hPt    + gapPt)
      await drawLabel(doc, xPt, yPt, effWPt, hPt, item, template)
      col++
      if (col >= cols) { col = 0; row++ }
      if (row >= rows) { col = 0; row = 0; pageOpen = false }
    }

    doc.end()
    return done
  }
}
