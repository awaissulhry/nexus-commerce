/**
 * FNSKU Label ZPL — Zebra Programming Language II encoder.
 *
 * Industry standard for thermal label printers (Zebra, Honeywell, TSC, SATO).
 * Output is plain text; the printer parses it directly. No rasterization,
 * no PDF; the printer's own firmware drives the bars + glyphs. This produces
 * the sharpest, most reliable barcodes for warehouse workflows.
 *
 * v1 scope:
 *  - 203 / 300 dpi switchable (203 is the default — covers ~80% of installed base)
 *  - Logo URL not supported; falls back to a "LOGO" text placeholder
 *  - One ^XA / ^XZ pair per label; printers feed continuously
 *  - Code128 barcode via ^BC; ZPL handles quiet zones automatically
 *
 * Layout mirrors the PDF approximately but is not pixel-perfect — thermal
 * printers have their own optical characteristics and the goal is "looks
 * right at 4×3in" not "matches Acrobat byte-for-byte".
 */

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
  showListingTitle?: boolean
  listingTitleLines?: number
  showCondition?: boolean
  condition?: string
  rows: TemplateRow[]
}

interface LabelItem {
  sku: string
  fnsku?: string | null
  asin?: string | null
  productName?: string | null
  listingTitle?: string | null
  variationAttributes?: Record<string, string>
}

// Attribute aliases — English primary, Italian fallback (mirrors PDF service).
const ATTR_ALIASES: Record<'color' | 'size' | 'gender', string[]> = {
  color:  ['Color',  'color',  'Colore',  'colore'],
  size:   ['Size',   'size',   'Taglia',  'taglia'],
  gender: ['Gender', 'gender', 'Genere',  'genere'],
}

function pickAttr(attrs: Record<string, string>, kind: 'color' | 'size' | 'gender'): string {
  for (const k of ATTR_ALIASES[kind]) if (attrs[k]) return attrs[k]
  return ''
}

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
    case 'color':  return pickAttr(attrs, 'color')
    case 'size':   return pickAttr(attrs, 'size')
    case 'gender': return pickAttr(attrs, 'gender')
    case 'sku':    return item.sku
    case 'asin':   return item.asin ?? ''
    case 'custom': return row.customValue
    default: return ''
  }
}

/** mm → dots at the given dpi. Round-trip safe. */
function dots(mm: number, dpi: number): number {
  return Math.round(mm * (dpi / 25.4))
}

/**
 * ZPL ^FD field-data escape. ZPL parses `^`, `~`, and `_` as command starts;
 * raw occurrences in user data would break the parse. Replace with spaces
 * (lossy but safe — these characters shouldn't appear in product titles).
 */
function fdEscape(s: string): string {
  return s.replace(/[\^~_]/g, ' ')
}

function buildLabelZpl(item: LabelItem, template: TemplateConfig, dpi: number): string {
  const { widthMm, heightMm } = template.labelSize
  const W   = dots(widthMm, dpi)
  const H   = dots(heightMm, dpi)
  const pad = dots(template.paddingMm ?? 2, dpi)
  const rightPct = Math.max(0.15, Math.min(0.55, (template.columnSplitPct ?? 38) / 100))
  const rightW   = Math.round(W * rightPct)
  const leftW    = W - rightW

  const showDivider = template.showColumnDivider !== false
  const showLogo    = template.showLogo === true
  const showSizeBox = template.showSizeBox === true
  const showTitle   = template.showListingTitle === true
  const showCond    = template.showCondition === true

  const activeRows = (template.rows ?? []).filter(r => r.show)
  const attrs      = item.variationAttributes ?? {}
  const sizeVal    = pickAttr(attrs, 'size')

  const cmds: string[] = []
  cmds.push('^XA')           // start label
  cmds.push('^CI28')         // UTF-8 encoding
  cmds.push(`^PW${W}`)       // print width
  cmds.push(`^LL${H}`)       // label length
  cmds.push('^LH0,0')        // label home
  cmds.push('^LT0')          // label top offset
  cmds.push('^FWN')          // normal field orientation

  // Outer border — thin stroke
  cmds.push(`^FO0,0^GB${W},${H},2^FS`)

  // Column divider
  if (showDivider) {
    cmds.push(`^FO${leftW},${pad}^GB1,${H - 2 * pad},1,B^FS`)
  }

  // ── LEFT COLUMN ──────────────────────────────────────────────
  // Logo placeholder (no image support in v1)
  let leftY = pad
  if (showLogo) {
    const logoH = Math.round(H * 0.12)
    const logoFs = Math.round(logoH * 0.6)
    const logoTextW = Math.max(dots(8, dpi), logoFs * 4)  // "LOGO" ≈ 4 chars
    cmds.push(`^FO${pad},${leftY}^GB${logoTextW + 2 * Math.round(logoH * 0.3)},${logoH},${logoH},B,4^FS`)
    cmds.push(`^FO${pad + Math.round(logoH * 0.3)},${leftY + Math.round((logoH - logoFs) / 2)}^A0N,${logoFs},${logoFs}^FR^FDLOGO^FS`)
    leftY += logoH + pad
  }

  // Field rows — fixed-ratio sizing matches the PDF service constants so a
  // ZPL label looks like the PDF preview within thermal-printer tolerances.
  // Ratios: badge fs = H * 0.07, value fs (first) = H * 0.13, (other) = H * 0.10.
  const badgeFs    = Math.max(10, Math.round(H * 0.07))
  const badgeH     = badgeFs + Math.round(H * 0.04)  // ~ font + 2x padding-V
  const rowGap     = Math.round(H * 0.025)
  const badgeCappedW = Math.min(
    Math.round((leftW - 2 * pad) * 0.45),
    Math.max(Math.round(H * 0.30), Math.round(badgeFs * 4.5)),
  )
  const valueX     = pad + badgeCappedW + Math.round(W * 0.015)
  const valueAvailW = Math.max(dots(4, dpi), leftW - valueX - pad)

  // Compute row heights, centre group vertically in remaining space
  const rowHeights = activeRows.map((_row, i) => {
    const vFs = Math.round(H * (i === 0 ? 0.13 : 0.10))
    return Math.max(badgeH, vFs)
  })
  const rowsAvail   = H - pad - leftY
  const naturalH    = rowHeights.reduce((s, h) => s + h, 0) + Math.max(0, rowHeights.length - 1) * rowGap
  const groupStartY = leftY + Math.max(0, Math.floor((rowsAvail - naturalH) / 2))

  let curY = groupStartY
  activeRows.forEach((row, i) => {
    const rowH = rowHeights[i]
    const vFs  = Math.round(H * (i === 0 ? 0.13 : 0.10))
    const badgeY = curY + Math.round((rowH - badgeH) / 2)
    const valueY = curY + Math.round((rowH - vFs) / 2)

    const badgeText = (row.badgeText || '—').toUpperCase()
    // Badge: black filled rounded box, white reverse text
    cmds.push(`^FO${pad},${badgeY}^GB${badgeCappedW},${badgeH},${badgeH},B,3^FS`)
    const badgeTextX = pad + Math.round(badgeCappedW / 2 - badgeText.length * badgeFs * 0.28)
    cmds.push(`^FO${Math.max(pad + 2, badgeTextX)},${badgeY + Math.round((badgeH - badgeFs) / 2)}^A0N,${badgeFs},${badgeFs}^FR^FD${fdEscape(badgeText)}^FS`)

    // Value text — auto-truncate to fit available width.
    // Char width factor 0.55 is a conservative estimate for Helvetica-like ZPL font A0.
    const tx = row.textTransform ?? 'uppercase'
    const rawValue = getRowValue(row, item)
    let value = applyTextTransform(rawValue || '—', tx)
    const maxChars = Math.max(4, Math.floor(valueAvailW / (vFs * 0.55)))
    if (value.length > maxChars) value = value.slice(0, maxChars - 1) + '…'
    cmds.push(`^FO${valueX},${valueY}^A0N,${vFs},${vFs}^FD${fdEscape(value)}^FS`)

    curY += rowH + (i < activeRows.length - 1 ? rowGap : 0)
  })

  // ── RIGHT COLUMN ──────────────────────────────────────────────
  const rx = leftW + pad
  const innerRightW = rightW - 2 * pad
  let ry = pad

  // Size box
  if (showSizeBox) {
    const sbH      = Math.round(H * 0.30)
    const hdrH     = Math.round(sbH * 0.25)
    const hdrFs    = Math.round(hdrH * 0.7)
    const valBoxH  = sbH - hdrH
    const valFs    = Math.round(valBoxH * 0.7)
    const sizeLabel = (template.sizeBoxLabel || 'SIZE').toUpperCase()

    // Outer border
    cmds.push(`^FO${rx},${ry}^GB${innerRightW},${sbH},2^FS`)
    // Header strip — black with reverse text
    cmds.push(`^FO${rx + 2},${ry + 2}^GB${innerRightW - 4},${hdrH - 2},${hdrH - 2},B,2^FS`)
    cmds.push(`^FO${rx + Math.round(innerRightW / 2 - sizeLabel.length * hdrFs * 0.28)},${ry + Math.round((hdrH - hdrFs) / 2)}^A0N,${hdrFs},${hdrFs}^FR^FD${fdEscape(sizeLabel)}^FS`)
    // Value
    const sv = sizeVal || '—'
    cmds.push(`^FO${rx + Math.round(innerRightW / 2 - sv.length * valFs * 0.3)},${ry + hdrH + Math.round((valBoxH - valFs) / 2)}^A0N,${valFs},${valFs}^FD${fdEscape(sv)}^FS`)

    ry += sbH + Math.round(H * 0.025)
  }

  // Barcode + FNSKU text + title + condition
  const rightRem  = H - pad - ry
  const titleLines = template.listingTitleLines ?? 2
  const titleFs    = Math.round(H * 0.05)
  const titleH     = (showTitle && item.listingTitle) ? titleFs * titleLines + dots(1, dpi) : 0
  const condFs     = Math.round(H * 0.05)
  const condHeight = showCond ? condFs + dots(1, dpi) : 0
  const fnskuFs    = Math.round(H * 0.06)
  const fnskuH     = item.fnsku ? fnskuFs + dots(1, dpi) : 0
  const barcodeH   = Math.max(dots(8, dpi), rightRem - titleH - condHeight - fnskuH - dots(2, dpi))

  if (item.fnsku) {
    // Code128 — quiet zones handled by printer firmware automatically.
    // ^BY sets module width in dots; 2 is the printer default and renders
    // well at 203 dpi for 10-char FNSKU within ~30mm width.
    const moduleDots = Math.max(2, Math.round((innerRightW - dots(4, dpi)) / (item.fnsku.length * 11 + 35 + 20)))
    cmds.push(`^FO${rx + dots(2, dpi)},${ry}^BY${moduleDots},3,${barcodeH}^BCN,${barcodeH},N,N,N^FD>:${fdEscape(item.fnsku)}^FS`)
    ry += barcodeH + dots(0.5, dpi)

    // FNSKU human-readable text centred under bars
    const fnskuTextX = rx + Math.round(innerRightW / 2 - item.fnsku.length * fnskuFs * 0.28)
    cmds.push(`^FO${Math.max(rx, fnskuTextX)},${ry}^A0N,${fnskuFs},${fnskuFs}^FD${fdEscape(item.fnsku)}^FS`)
    ry += fnskuH
  }

  if (showTitle && item.listingTitle) {
    cmds.push(`^FO${rx},${ry}^A0N,${titleFs},${titleFs}^FB${innerRightW},${titleLines},0,C,0^FD${fdEscape(item.listingTitle)}^FS`)
    ry += titleH
  }

  if (showCond) {
    const condText = template.condition || 'New'
    const condX = rx + Math.round(innerRightW / 2 - condText.length * condFs * 0.28)
    cmds.push(`^FO${Math.max(rx, condX)},${ry}^A0N,${condFs},${condFs}^FD${fdEscape(condText)}^FS`)
  }

  cmds.push('^XZ')           // end label
  return cmds.join('\n')
}

/**
 * Render a multi-label ZPL stream. Each label is wrapped in ^XA / ^XZ;
 * the printer feeds continuously and slices between labels.
 *
 * @param dpi One of 203 (default) / 300. Other DPIs work but layout may need tuning.
 */
export function renderFnskuLabelsZpl(
  items: LabelItem[],
  template: TemplateConfig,
  dpi: 203 | 300 = 203,
): string {
  return items.map(item => buildLabelZpl(item, template, dpi)).join('\n\n')
}
