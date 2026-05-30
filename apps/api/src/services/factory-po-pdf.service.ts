/**
 * F.6.3 — Factory PO PDF renderer.
 *
 * Takes a fully-resolved PO + items + supplier + brand settings and
 * produces a letter-sized PDF buffer ready to email/download. Layout:
 *
 *   ┌─────────────────────────────────────────────────────────┐
 *   │  [LOGO]              Xavia Racing s.r.l.                │
 *   │                      Via Aurelia 123, 00165 Roma        │
 *   │                      P.IVA: IT12345678901               │
 *   │                                                         │
 *   │  PURCHASE ORDER                          PO #PO-2026-0042│
 *   │  Supplier: Acme Fabrics                  Date: 2026-05-05│
 *   │  Expected: 2026-05-30                                   │
 *   ├─────────────────────────────────────────────────────────┤
 *   │  Item 1: Aether Riding Jacket                            │
 *   │  [thumb]  Brand: Xavia · Type: OUTERWEAR_MESH            │
 *   │           ┌──────┬──────┬──────┐                        │
 *   │           │      │ Black│ Red  │                        │
 *   │           │  M   │  20  │  10  │                        │
 *   │           │  L   │  30  │  15  │                        │
 *   │           └──────┴──────┴──────┘                        │
 *   │           Total: 75 units                                │
 *   │                                                         │
 *   │  Item 2: Generic Helmet (no variants)                    │
 *   │  [thumb]  SKU: XAV-HEL-A1   Qty: 50                      │
 *   ├─────────────────────────────────────────────────────────┤
 *   │  Total units: 125                                        │
 *   │                                                         │
 *   │  Notes: …                                                │
 *   ├─────────────────────────────────────────────────────────┤
 *   │  Authorized by: Awais Sulhry / Procurement              │
 *   │  Signature: ________________________  Date: ___________ │
 *   └─────────────────────────────────────────────────────────┘
 *
 * The renderer is pure — it takes a fully-resolved input shape and
 * returns a Buffer. The caller (route handler) does the data fetching.
 * That keeps testing trivial: pass synthetic data in, inspect bytes out.
 *
 * Image embedding: pdfkit can embed JPG / PNG by URL or local path. For
 * Cloudinary-hosted images we fetch the bytes ourselves with a 5s
 * timeout — failures fall back to a "[image unavailable]" placeholder
 * rather than crashing the render.
 */

import PDFDocument from 'pdfkit'
import { logger } from '../utils/logger.js'

export interface FactoryPoBrand {
  companyName: string | null
  addressLines: string[]
  taxId: string | null
  contactEmail: string | null
  contactPhone: string | null
  websiteUrl: string | null
  logoUrl: string | null
  signatureBlockText: string | null
  defaultPoNotes: string | null
  // PO.12 — Italian fiscal fields. Threaded from BrandSettings so the
  // PDF can render the imponibile / IVA / totale block + the reverse-
  // charge note for non-IT EU suppliers. Absent (null) on non-IT
  // operators; the fiscal block silently no-ops.
  piva?: string | null
  codiceFiscale?: string | null
  sdiCode?: string | null
  vatScheme?: string | null
}

export interface FactoryPoSupplier {
  id: string
  name: string
  contactName?: string | null
  email?: string | null
  phone?: string | null
  addressLines?: string[]
}

export interface FactoryPoVariantLine {
  sku: string
  quantity: number
  /** Free-form variation attributes — { Size: "M", Color: "Black" }. The
   *  matrix builder picks "Size" + "Color" automatically; other axes get
   *  a flat list. */
  variationAttributes?: Record<string, string> | null
  /** Per-line note (defect requirements, special instructions). */
  notes?: string | null
  /** PD.1 — per-line factory size (e.g. the factory's own size code). */
  factorySize?: string | null
}

export interface FactoryPoProductGroup {
  productId: string
  productName: string
  productType?: string | null
  brand?: string | null
  imageUrl?: string | null
  /** PD.1 — factory-facing product name. When set, the factory sees THIS
   *  prominently (they often can't read our master name/language); our
   *  product name renders as a subtitle. */
  factoryName?: string | null
  /** When length === 1, renders as a simple line; > 1 renders the
   *  Size × Color matrix when both axes exist, else a flat list. */
  lines: FactoryPoVariantLine[]
}

export interface FactoryPoInput {
  poNumber: string
  status: string
  expectedDeliveryDate: Date | null
  notes: string | null
  createdAt: Date
  brand: FactoryPoBrand
  supplier: FactoryPoSupplier | null
  groups: FactoryPoProductGroup[]
  /** Pre-computed total units across every group's lines. Caller computes
   *  to keep this service stateless. */
  totalUnits: number
  /** PO.12 — Localization. 'it' renders Italian fiscal-compliant
   *  labels; 'zh' renders simplified Chinese for Asian suppliers
   *  (factory floors in Guangdong, Zhejiang, etc.); 'en' default. */
  locale?: 'en' | 'it' | 'zh'
  // PO.12 — fiscal context. When brand.piva is set the PDF renders the
  // imponibile/IVA/totale strip. The caller computes both since the
  // service is intentionally stateless. Currency stays in PO ccy;
  // multi-currency POs to Italian buyers are rare in Xavia's flow.
  currencyCode?: string
  totalNetCents?: number
  ivaRateBp?: number // 2200 = 22%
  ivaCents?: number
  totalGrossCents?: number
  /** When true, IVA is zero on the PDF and the inversione-contabile
   *  note is rendered. Caller decides (typically: brand IT + supplier
   *  in EU but not IT). */
  reverseCharge?: boolean
  /** Country code of the supplier (IT, DE, FR, CN, …). Surfaces in
   *  the fiscal block ("Fornitore UE" / "Fornitore extra-UE") and
   *  drives the locale fallback when not explicitly set. */
  supplierCountry?: string | null
}

// W9.7 — Italian fiscal PO labels. Italian operations expect a PO
// titled "Ordine d'acquisto" (or "Conferma d'ordine") with the
// localized field captions an Italian supplier reads cleanly. The
// existing letterhead already carries P.IVA from BrandSettings; this
// table translates the static chrome.
type PoLabelKey =
  | 'title'
  | 'supplier'
  | 'supplierNotAssigned'
  | 'orderDate'
  | 'expectedDelivery'
  | 'status'
  | 'totalUnits'
  | 'notes'
  // PO.12 — fiscal block label keys
  | 'imponibile'
  | 'iva'
  | 'totale'
  | 'reverseCharge'
  | 'reverseChargeNote'
  | 'pivaLabel'
  | 'codiceFiscaleLabel'
const PO_LABELS: Record<'en' | 'it' | 'zh', Record<PoLabelKey, string>> = {
  en: {
    title: 'PURCHASE ORDER',
    supplier: 'Supplier',
    supplierNotAssigned: 'Supplier: not assigned',
    orderDate: 'Order date',
    expectedDelivery: 'Expected delivery',
    status: 'Status',
    totalUnits: 'Total units',
    notes: 'Notes',
    imponibile: 'Net (excl. VAT)',
    iva: 'VAT',
    totale: 'Total (incl. VAT)',
    reverseCharge: 'Reverse charge',
    reverseChargeNote:
      'Reverse charge — supplier accounts for VAT under Art. 17(6) of DPR 633/72. No VAT charged on this invoice.',
    pivaLabel: 'VAT no.',
    codiceFiscaleLabel: 'Tax ID',
  },
  it: {
    title: "Ordine d'acquisto",
    supplier: 'Fornitore',
    supplierNotAssigned: 'Fornitore: non assegnato',
    orderDate: 'Data ordine',
    expectedDelivery: 'Consegna prevista',
    status: 'Stato',
    totalUnits: 'Unità totali',
    notes: 'Note',
    imponibile: 'Imponibile',
    iva: 'IVA',
    totale: 'Totale',
    reverseCharge: 'Inversione contabile',
    reverseChargeNote:
      "Inversione contabile — art. 17 c. 6 DPR 633/72. L'IVA è assolta dal committente in regime di reverse charge.",
    pivaLabel: 'P.IVA',
    codiceFiscaleLabel: 'C.F.',
  },
  zh: {
    title: '采购订单',
    supplier: '供应商',
    supplierNotAssigned: '供应商：未指定',
    orderDate: '订单日期',
    expectedDelivery: '预计交货',
    status: '状态',
    totalUnits: '总数量',
    notes: '备注',
    imponibile: '不含税金额',
    iva: '增值税',
    totale: '含税总额',
    reverseCharge: '反向征税',
    reverseChargeNote:
      'Reverse charge — VAT accounted by buyer under EU Art. 17(6) of DPR 633/72.',
    pivaLabel: 'VAT no.',
    codiceFiscaleLabel: 'Tax ID',
  },
}
function poLabel(input: FactoryPoInput, key: PoLabelKey): string {
  return PO_LABELS[input.locale ?? 'en'][key]
}

const PAGE_MARGIN = 50
const LINE_GAP = 4
const HEADER_DARK = '#0f172a'
const TEXT_GREY = '#475569'
const RULE_GREY = '#cbd5e1'

/**
 * Render a factory PO into a PDF buffer.
 */
export async function renderFactoryPoPdf(input: FactoryPoInput): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'LETTER',
    margins: {
      top: PAGE_MARGIN,
      bottom: PAGE_MARGIN,
      left: PAGE_MARGIN,
      right: PAGE_MARGIN,
    },
    info: {
      Title: `Factory PO ${input.poNumber}`,
      Creator: 'Nexus Commerce',
      Producer: 'Nexus Commerce',
    },
  })

  const chunks: Buffer[] = []
  doc.on('data', (c: Buffer) => chunks.push(c))
  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)
  })

  // Pre-fetch images so render flow doesn't have async gaps in the middle
  // of pdfkit's text cursor manipulation. Failures become null.
  const logoBuffer = input.brand.logoUrl
    ? await fetchImageBuffer(input.brand.logoUrl)
    : null
  const productImages: Map<string, Buffer | null> = new Map()
  await Promise.all(
    input.groups.map(async (g) => {
      if (g.imageUrl) {
        productImages.set(g.productId, await fetchImageBuffer(g.imageUrl))
      }
    }),
  )

  // ── Letterhead ───────────────────────────────────────────────────
  await renderLetterhead(doc, input.brand, logoBuffer)

  // ── PO meta (number, date, supplier, expected) ──────────────────
  doc.moveDown(1.5)
  renderPoMeta(doc, input)

  // ── Items ───────────────────────────────────────────────────────
  doc.moveDown(1)
  for (const group of input.groups) {
    renderProductGroup(doc, group, productImages.get(group.productId) ?? null)
    doc.moveDown(0.5)
  }

  // ── Totals + notes ─────────────────────────────────────────────
  drawHorizontalRule(doc)
  doc.moveDown(0.5)
  doc
    .fontSize(11)
    .fillColor(HEADER_DARK)
    .font('Helvetica-Bold')
    .text(`${poLabel(input, 'totalUnits')}: ${input.totalUnits}`)

  // PO.12 — Italian fiscal block. Only renders when brand.piva is set
  // (i.e. operator has filled out Italian fiscal context). Reverse-
  // charge flag zeroes the IVA + prints the legal note.
  if (input.brand.piva && input.currencyCode && input.totalNetCents != null) {
    renderFiscalBlock(doc, input)
  }

  if (input.notes && input.notes.trim().length > 0) {
    doc.moveDown(0.5)
    doc
      .fontSize(10)
      .font('Helvetica')
      .fillColor(TEXT_GREY)
      .text(`${poLabel(input, 'notes')}: ${input.notes.trim()}`)
  }
  if (
    input.brand.defaultPoNotes &&
    input.brand.defaultPoNotes.trim().length > 0
  ) {
    doc.moveDown(0.5)
    doc
      .fontSize(9)
      .font('Helvetica')
      .fillColor(TEXT_GREY)
      .text(input.brand.defaultPoNotes.trim(), {
        lineGap: LINE_GAP,
      })
  }

  // ── Signature block ─────────────────────────────────────────────
  doc.moveDown(2)
  drawHorizontalRule(doc)
  doc.moveDown(0.8)
  if (input.brand.signatureBlockText) {
    doc
      .fontSize(10)
      .fillColor(HEADER_DARK)
      .font('Helvetica')
      .text(input.brand.signatureBlockText)
    doc.moveDown(0.5)
  }
  doc
    .fontSize(10)
    .fillColor(TEXT_GREY)
    .font('Helvetica')
    .text('Signature: ___________________________     Date: __________')

  doc.end()
  return finished
}

/* ───────────────────────────────────────────────────────────────────
 * Letterhead
 * ─────────────────────────────────────────────────────────────────── */

async function renderLetterhead(
  doc: PDFKit.PDFDocument,
  brand: FactoryPoBrand,
  logoBuffer: Buffer | null,
): Promise<void> {
  const startY = doc.y
  const pageWidth = doc.page.width - PAGE_MARGIN * 2

  // Logo on the left, company info on the right.
  const logoWidth = 110
  const logoHeight = 50
  if (logoBuffer) {
    try {
      doc.image(logoBuffer, PAGE_MARGIN, startY, {
        fit: [logoWidth, logoHeight],
      })
    } catch (err) {
      logger.warn('factory-po-pdf: logo embed failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // Right-aligned company text block.
  const textX = PAGE_MARGIN + logoWidth + 20
  const textWidth = pageWidth - logoWidth - 20
  doc.fontSize(14).font('Helvetica-Bold').fillColor(HEADER_DARK).text(
    brand.companyName ?? 'Your Company',
    textX,
    startY,
    { width: textWidth, align: 'right' },
  )
  doc.fontSize(9).font('Helvetica').fillColor(TEXT_GREY)
  for (const line of brand.addressLines) {
    doc.text(line, { width: textWidth, align: 'right' })
  }
  // PO.12 — prefer Italian-style P.IVA / C.F. line when those fields
  // are populated; otherwise fall back to the legacy taxId line.
  if (brand.piva || brand.codiceFiscale) {
    const fiscalParts: string[] = []
    if (brand.piva) fiscalParts.push(`P.IVA ${brand.piva}`)
    if (brand.codiceFiscale) fiscalParts.push(`C.F. ${brand.codiceFiscale}`)
    if (brand.sdiCode) fiscalParts.push(`SDI ${brand.sdiCode}`)
    doc.text(fiscalParts.join(' · '), { width: textWidth, align: 'right' })
  } else if (brand.taxId) {
    doc.text(`Tax ID: ${brand.taxId}`, { width: textWidth, align: 'right' })
  }
  const contact: string[] = []
  if (brand.contactEmail) contact.push(brand.contactEmail)
  if (brand.contactPhone) contact.push(brand.contactPhone)
  if (brand.websiteUrl) contact.push(brand.websiteUrl)
  if (contact.length > 0) {
    doc.text(contact.join(' · '), { width: textWidth, align: 'right' })
  }

  // Move cursor back to left margin and below the taller of (logo, text)
  const blockEndY = Math.max(doc.y, startY + logoHeight + 4)
  doc.y = blockEndY
  doc.x = PAGE_MARGIN
  doc.moveDown(0.5)
  drawHorizontalRule(doc)
}

/* ───────────────────────────────────────────────────────────────────
 * PO.12 — Italian fiscal block (Imponibile / IVA / Totale + reverse-
 * charge banner). Caller already computed the cents; we just render.
 * ─────────────────────────────────────────────────────────────────── */

function formatFiscalMoney(cents: number, code: string): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: code,
      maximumFractionDigits: 2,
    }).format(cents / 100)
  } catch {
    return `${(cents / 100).toFixed(2)} ${code}`
  }
}

function renderFiscalBlock(doc: PDFKit.PDFDocument, input: FactoryPoInput): void {
  const ccy = input.currencyCode ?? 'EUR'
  const net = input.totalNetCents ?? 0
  const rateBp = input.ivaRateBp ?? 2200
  const reverseCharge = !!input.reverseCharge
  const iva = reverseCharge ? 0 : input.ivaCents ?? Math.round((net * rateBp) / 10000)
  const gross = input.totalGrossCents ?? net + iva

  doc.moveDown(0.6)

  // Right-aligned three-line totals strip.
  const pageWidth = doc.page.width - PAGE_MARGIN * 2
  const labelW = 140
  const valueW = 110
  const startX = PAGE_MARGIN + pageWidth - (labelW + valueW)

  const writeRow = (label: string, value: string, bold = false) => {
    const y = doc.y
    doc
      .font(bold ? 'Helvetica-Bold' : 'Helvetica')
      .fontSize(bold ? 11 : 10)
      .fillColor(bold ? HEADER_DARK : TEXT_GREY)
      .text(label, startX, y, { width: labelW, align: 'right' })
    doc.text(value, startX + labelW, y, {
      width: valueW,
      align: 'right',
    })
    doc.moveDown(0.2)
  }

  writeRow(`${poLabel(input, 'imponibile')}:`, formatFiscalMoney(net, ccy))

  if (reverseCharge) {
    writeRow(`${poLabel(input, 'iva')} (${poLabel(input, 'reverseCharge')}):`, '—')
  } else {
    writeRow(`${poLabel(input, 'iva')} ${(rateBp / 100).toFixed(0)}%:`, formatFiscalMoney(iva, ccy))
  }

  writeRow(`${poLabel(input, 'totale')}:`, formatFiscalMoney(gross, ccy), true)

  doc.moveDown(0.3)

  if (reverseCharge) {
    doc
      .font('Helvetica-Oblique')
      .fontSize(9)
      .fillColor(TEXT_GREY)
      .text(poLabel(input, 'reverseChargeNote'), PAGE_MARGIN, doc.y, {
        width: pageWidth,
        lineGap: LINE_GAP,
      })
    doc.moveDown(0.3)
  }
}

/* ───────────────────────────────────────────────────────────────────
 * PO meta header
 * ─────────────────────────────────────────────────────────────────── */

function renderPoMeta(doc: PDFKit.PDFDocument, input: FactoryPoInput): void {
  const y = doc.y
  const pageWidth = doc.page.width - PAGE_MARGIN * 2

  doc
    .fontSize(20)
    .font('Helvetica-Bold')
    .fillColor(HEADER_DARK)
    .text(poLabel(input, 'title'), PAGE_MARGIN, y)
  doc
    .fontSize(11)
    .font('Helvetica-Bold')
    .fillColor(HEADER_DARK)
    .text(input.poNumber, PAGE_MARGIN, y, {
      width: pageWidth,
      align: 'right',
    })

  doc.moveDown(0.5)

  doc.fontSize(10).font('Helvetica').fillColor(TEXT_GREY)
  const lineY = doc.y

  // Two-column: supplier on left, dates on right.
  const colWidth = (pageWidth - 20) / 2

  // Left: supplier
  if (input.supplier) {
    doc
      .font('Helvetica-Bold')
      .fillColor(HEADER_DARK)
      .text(poLabel(input, 'supplier'), PAGE_MARGIN, lineY, { width: colWidth })
      .font('Helvetica')
      .fillColor(TEXT_GREY)
      .text(input.supplier.name, PAGE_MARGIN, doc.y, { width: colWidth })
    if (input.supplier.contactName) {
      doc.text(input.supplier.contactName, { width: colWidth })
    }
    if (input.supplier.email) {
      doc.text(input.supplier.email, { width: colWidth })
    }
    if (input.supplier.phone) {
      doc.text(input.supplier.phone, { width: colWidth })
    }
  } else {
    doc
      .font('Helvetica-Bold')
      .fillColor('#b45309') // amber
      .text(poLabel(input, 'supplierNotAssigned'), PAGE_MARGIN, lineY, { width: colWidth })
  }
  const leftEndY = doc.y

  // Right: dates
  const dateX = PAGE_MARGIN + colWidth + 20
  doc
    .font('Helvetica-Bold')
    .fillColor(HEADER_DARK)
    .text(poLabel(input, 'orderDate'), dateX, lineY, { width: colWidth })
    .font('Helvetica')
    .fillColor(TEXT_GREY)
    .text(input.createdAt.toISOString().slice(0, 10), dateX, doc.y, {
      width: colWidth,
    })

  if (input.expectedDeliveryDate) {
    doc.moveDown(0.3)
    doc
      .font('Helvetica-Bold')
      .fillColor(HEADER_DARK)
      .text(poLabel(input, 'expectedDelivery'), dateX, doc.y, { width: colWidth })
      .font('Helvetica')
      .fillColor(TEXT_GREY)
      .text(input.expectedDeliveryDate.toISOString().slice(0, 10), dateX, doc.y, {
        width: colWidth,
      })
  }
  doc.moveDown(0.3)
  doc
    .font('Helvetica-Bold')
    .fillColor(HEADER_DARK)
    .text(poLabel(input, 'status'), dateX, doc.y, { width: colWidth })
    .font('Helvetica')
    .fillColor(TEXT_GREY)
    .text(input.status, dateX, doc.y, { width: colWidth })

  // Reset cursor to whichever column was taller.
  doc.y = Math.max(leftEndY, doc.y)
  doc.x = PAGE_MARGIN
  doc.moveDown(0.5)
  drawHorizontalRule(doc)
}

/* ───────────────────────────────────────────────────────────────────
 * Per-product group renderer
 * ─────────────────────────────────────────────────────────────────── */

const THUMB_SIZE = 60

function renderProductGroup(
  doc: PDFKit.PDFDocument,
  group: FactoryPoProductGroup,
  imageBuffer: Buffer | null,
): void {
  const startY = doc.y
  const pageWidth = doc.page.width - PAGE_MARGIN * 2

  // Image on the left
  if (imageBuffer) {
    try {
      doc.image(imageBuffer, PAGE_MARGIN, startY, {
        fit: [THUMB_SIZE, THUMB_SIZE],
      })
    } catch (err) {
      // unembeddable — fall through to no-image layout
    }
  } else {
    // Placeholder rectangle so layout stays consistent
    doc
      .save()
      .strokeColor(RULE_GREY)
      .lineWidth(0.5)
      .rect(PAGE_MARGIN, startY, THUMB_SIZE, THUMB_SIZE)
      .stroke()
      .fontSize(8)
      .fillColor(TEXT_GREY)
      .text('no image', PAGE_MARGIN, startY + THUMB_SIZE / 2 - 4, {
        width: THUMB_SIZE,
        align: 'center',
      })
      .restore()
  }

  const textX = PAGE_MARGIN + THUMB_SIZE + 12
  const textWidth = pageWidth - THUMB_SIZE - 12

  // PD.1 — when a factory name is set, the factory sees THAT prominently
  // (they often can't read our master name/language); our product name
  // drops to a subtitle so we stay oriented internally.
  if (group.factoryName) {
    doc
      .fontSize(13)
      .font('Helvetica-Bold')
      .fillColor(HEADER_DARK)
      .text(group.factoryName, textX, startY, { width: textWidth })
    doc
      .fontSize(8)
      .font('Helvetica')
      .fillColor(TEXT_GREY)
      .text(`(${group.productName})`, textX, doc.y, { width: textWidth })
  } else {
    doc
      .fontSize(12)
      .font('Helvetica-Bold')
      .fillColor(HEADER_DARK)
      .text(group.productName, textX, startY, { width: textWidth })
  }

  doc.fontSize(9).font('Helvetica').fillColor(TEXT_GREY)
  const meta: string[] = []
  if (group.brand) meta.push(`Brand: ${group.brand}`)
  if (group.productType) meta.push(`Type: ${group.productType}`)
  if (meta.length > 0) {
    doc.text(meta.join(' · '), textX, doc.y, { width: textWidth })
  }

  doc.moveDown(0.3)

  // Single line — render flat row
  if (group.lines.length === 1) {
    const line = group.lines[0]
    const attrs = formatVariationAttrs(line.variationAttributes)
    const factorySizePart = line.factorySize ? `    Factory size ${line.factorySize}` : ''
    doc
      .fontSize(10)
      .fillColor(HEADER_DARK)
      .text(`SKU ${line.sku}    Qty ${line.quantity}${attrs ? `    ${attrs}` : ''}${factorySizePart}`, textX, doc.y, { width: textWidth })
    if (line.notes) {
      doc
        .fontSize(9)
        .fillColor(TEXT_GREY)
        .text(line.notes, textX, doc.y, { width: textWidth })
    }
    doc.y = Math.max(doc.y, startY + THUMB_SIZE + 4)
    return
  }

  // Multi-line: try to render Size × Color matrix; fall back to a list.
  const matrix = buildSizeColorMatrix(group.lines)
  if (matrix) {
    renderMatrix(doc, matrix, textX, doc.y, textWidth)
  } else {
    renderFlatLines(doc, group.lines, textX, doc.y, textWidth)
  }
  doc.y = Math.max(doc.y, startY + THUMB_SIZE + 4)
}

function formatVariationAttrs(
  attrs?: Record<string, string> | null,
): string | null {
  if (!attrs || Object.keys(attrs).length === 0) return null
  return Object.entries(attrs)
    .map(([k, v]) => `${k}: ${v}`)
    .join(' · ')
}

interface SizeColorMatrix {
  sizes: string[] // row labels
  colors: string[] // column labels
  cells: Map<string, { qty: number; sku: string }> // key = "size|color"
  groupTotal: number
}

function buildSizeColorMatrix(
  lines: FactoryPoVariantLine[],
): SizeColorMatrix | null {
  // Need both Size and Color on every line for the matrix to be valid.
  const sizesSet = new Set<string>()
  const colorsSet = new Set<string>()
  const cells = new Map<string, { qty: number; sku: string }>()
  let total = 0
  for (const line of lines) {
    const a = line.variationAttributes ?? {}
    const size = a.Size ?? a.size ?? a.SIZE ?? null
    const color = a.Color ?? a.color ?? a.COLOR ?? null
    if (!size || !color) return null
    sizesSet.add(size)
    colorsSet.add(color)
    cells.set(`${size}|${color}`, { qty: line.quantity, sku: line.sku })
    total += line.quantity
  }
  if (sizesSet.size === 0 || colorsSet.size === 0) return null
  return {
    sizes: [...sizesSet].sort(sortBySizeOrder),
    colors: [...colorsSet].sort(),
    cells,
    groupTotal: total,
  }
}

const SIZE_ORDER = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', '3XL', '4XL']
function sortBySizeOrder(a: string, b: string): number {
  const ia = SIZE_ORDER.indexOf(a.toUpperCase())
  const ib = SIZE_ORDER.indexOf(b.toUpperCase())
  if (ia !== -1 && ib !== -1) return ia - ib
  if (ia !== -1) return -1
  if (ib !== -1) return 1
  return a.localeCompare(b, undefined, { numeric: true })
}

function renderMatrix(
  doc: PDFKit.PDFDocument,
  matrix: SizeColorMatrix,
  x: number,
  y: number,
  width: number,
): void {
  const rowH = 18
  const labelColW = 60
  const colCount = matrix.colors.length
  const totalColW = 60
  const dataColW = Math.max(
    40,
    Math.floor((width - labelColW - totalColW - 4) / colCount),
  )
  const tableW = labelColW + dataColW * colCount + totalColW + 4

  let cursorY = y

  // Header row: empty corner, color labels, "Total"
  doc.fontSize(9).fillColor(HEADER_DARK).font('Helvetica-Bold')
  doc
    .save()
    .strokeColor(RULE_GREY)
    .lineWidth(0.5)
    .rect(x, cursorY, tableW, rowH)
    .stroke()
    .restore()
  // Cell separators
  let cx = x + labelColW
  for (let i = 0; i < colCount; i++) {
    doc
      .save()
      .strokeColor(RULE_GREY)
      .lineWidth(0.3)
      .moveTo(cx, cursorY)
      .lineTo(cx, cursorY + rowH)
      .stroke()
      .restore()
    doc.text(matrix.colors[i], cx, cursorY + 4, {
      width: dataColW,
      align: 'center',
    })
    cx += dataColW
  }
  // Total separator
  doc
    .save()
    .strokeColor(RULE_GREY)
    .lineWidth(0.3)
    .moveTo(cx, cursorY)
    .lineTo(cx, cursorY + rowH)
    .stroke()
    .restore()
  doc.text('Total', cx, cursorY + 4, { width: totalColW, align: 'center' })

  cursorY += rowH

  // Data rows
  doc.font('Helvetica').fillColor(HEADER_DARK)
  for (const size of matrix.sizes) {
    let rowTotal = 0
    doc
      .save()
      .strokeColor(RULE_GREY)
      .lineWidth(0.5)
      .rect(x, cursorY, tableW, rowH)
      .stroke()
      .restore()
    doc
      .font('Helvetica-Bold')
      .text(size, x + 4, cursorY + 4, { width: labelColW - 8 })
    cx = x + labelColW
    for (const color of matrix.colors) {
      const cell = matrix.cells.get(`${size}|${color}`)
      doc
        .save()
        .strokeColor(RULE_GREY)
        .lineWidth(0.3)
        .moveTo(cx, cursorY)
        .lineTo(cx, cursorY + rowH)
        .stroke()
        .restore()
      doc.font('Helvetica').fillColor(cell ? HEADER_DARK : TEXT_GREY)
      doc.text(cell ? String(cell.qty) : '—', cx, cursorY + 4, {
        width: dataColW,
        align: 'center',
      })
      if (cell) rowTotal += cell.qty
      cx += dataColW
    }
    doc
      .save()
      .strokeColor(RULE_GREY)
      .lineWidth(0.3)
      .moveTo(cx, cursorY)
      .lineTo(cx, cursorY + rowH)
      .stroke()
      .restore()
    doc.font('Helvetica-Bold').fillColor(HEADER_DARK)
    doc.text(String(rowTotal), cx, cursorY + 4, {
      width: totalColW,
      align: 'center',
    })
    cursorY += rowH
  }

  // Bottom totals row
  doc
    .save()
    .strokeColor(RULE_GREY)
    .lineWidth(0.5)
    .rect(x, cursorY, tableW, rowH)
    .fillAndStroke('#f1f5f9', RULE_GREY)
    .restore()
  doc.fontSize(9).font('Helvetica-Bold').fillColor(HEADER_DARK)
  doc.text('Total', x + 4, cursorY + 4, { width: labelColW - 8 })
  cx = x + labelColW
  for (const color of matrix.colors) {
    let colSum = 0
    for (const size of matrix.sizes) {
      const cell = matrix.cells.get(`${size}|${color}`)
      if (cell) colSum += cell.qty
    }
    doc.text(String(colSum), cx, cursorY + 4, {
      width: dataColW,
      align: 'center',
    })
    cx += dataColW
  }
  doc.text(String(matrix.groupTotal), cx, cursorY + 4, {
    width: totalColW,
    align: 'center',
  })
  cursorY += rowH

  doc.y = cursorY
  doc.x = PAGE_MARGIN
}

function renderFlatLines(
  doc: PDFKit.PDFDocument,
  lines: FactoryPoVariantLine[],
  x: number,
  y: number,
  width: number,
): void {
  doc.fontSize(9).font('Helvetica').fillColor(HEADER_DARK)
  doc.y = y
  for (const line of lines) {
    const attrs = formatVariationAttrs(line.variationAttributes)
    doc.text(
      `${line.sku}    Qty ${line.quantity}${attrs ? `    ${attrs}` : ''}`,
      x,
      doc.y,
      { width },
    )
  }
  doc.x = PAGE_MARGIN
}

/* ───────────────────────────────────────────────────────────────────
 * Helpers
 * ─────────────────────────────────────────────────────────────────── */

function drawHorizontalRule(doc: PDFKit.PDFDocument): void {
  const y = doc.y
  doc
    .save()
    .strokeColor(RULE_GREY)
    .lineWidth(0.5)
    .moveTo(PAGE_MARGIN, y)
    .lineTo(doc.page.width - PAGE_MARGIN, y)
    .stroke()
    .restore()
}

async function fetchImageBuffer(url: string): Promise<Buffer | null> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    const res = await fetch(url, { signal: controller.signal })
    clearTimeout(timer)
    if (!res.ok) {
      logger.warn('factory-po-pdf: image fetch non-OK', {
        url,
        status: res.status,
      })
      return null
    }
    const arr = new Uint8Array(await res.arrayBuffer())
    return Buffer.from(arr)
  } catch (err) {
    logger.warn('factory-po-pdf: image fetch failed', {
      url,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}
