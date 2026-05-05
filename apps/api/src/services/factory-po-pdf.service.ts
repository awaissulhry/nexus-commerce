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
}

export interface FactoryPoProductGroup {
  productId: string
  productName: string
  productType?: string | null
  brand?: string | null
  imageUrl?: string | null
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
    .text(`Total units: ${input.totalUnits}`)
  if (input.notes && input.notes.trim().length > 0) {
    doc.moveDown(0.5)
    doc
      .fontSize(10)
      .font('Helvetica')
      .fillColor(TEXT_GREY)
      .text(`Notes: ${input.notes.trim()}`)
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
  if (brand.taxId) {
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
 * PO meta header
 * ─────────────────────────────────────────────────────────────────── */

function renderPoMeta(doc: PDFKit.PDFDocument, input: FactoryPoInput): void {
  const y = doc.y
  const pageWidth = doc.page.width - PAGE_MARGIN * 2

  doc
    .fontSize(20)
    .font('Helvetica-Bold')
    .fillColor(HEADER_DARK)
    .text('PURCHASE ORDER', PAGE_MARGIN, y)
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
      .text('Supplier', PAGE_MARGIN, lineY, { width: colWidth })
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
      .text('Supplier: not assigned', PAGE_MARGIN, lineY, { width: colWidth })
  }
  const leftEndY = doc.y

  // Right: dates
  const dateX = PAGE_MARGIN + colWidth + 20
  doc
    .font('Helvetica-Bold')
    .fillColor(HEADER_DARK)
    .text('Order date', dateX, lineY, { width: colWidth })
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
      .text('Expected delivery', dateX, doc.y, { width: colWidth })
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
    .text('Status', dateX, doc.y, { width: colWidth })
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

  doc
    .fontSize(12)
    .font('Helvetica-Bold')
    .fillColor(HEADER_DARK)
    .text(group.productName, textX, startY, { width: textWidth })

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
    doc
      .fontSize(10)
      .fillColor(HEADER_DARK)
      .text(`SKU ${line.sku}    Qty ${line.quantity}${attrs ? `    ${attrs}` : ''}`, textX, doc.y, { width: textWidth })
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
