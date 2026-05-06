/**
 * H.17 — Inbound discrepancy report PDF.
 *
 * Renders a one-page (often) PDF summarizing every discrepancy on a
 * single inbound shipment. Designed to be downloaded by the operator
 * and emailed to the supplier as a formal record of "what was wrong"
 * — short, clear, dated, with quantity + cost impact totals.
 *
 * Email automation isn't in scope this commit (no email infra in
 * Nexus yet — TECH_DEBT entry). The endpoint streams the PDF
 * directly so the operator can download and forward.
 *
 * Layout:
 *   ┌─────────────────────────────────────────────────────────┐
 *   │  [LOGO]              Xavia Racing s.r.l.                │
 *   │                                                         │
 *   │  INBOUND DISCREPANCY REPORT       Shipment: PO-2026-042 │
 *   │  Supplier: Acme Fabrics           Issued: 2026-05-06    │
 *   │  Reference: …                     Status: RECEIVING     │
 *   ├─────────────────────────────────────────────────────────┤
 *   │  3 discrepancies recorded                               │
 *   │                                                         │
 *   │  1. SHORT_SHIP   ·   2026-05-04 · Open                   │
 *   │     SKU XAV-JKT-001 (Aether Riding Jacket)              │
 *   │     Expected: 50 · Actual: 35  · Impact: -15 units       │
 *   │     Notes: 5 cartons short on receive                    │
 *   │                                                         │
 *   │  2. DAMAGED      ·   2026-05-04 · Acknowledged           │
 *   │     SKU XAV-HEL-A1 (Stratos Helmet)                     │
 *   │     Cost impact: €120.00                                 │
 *   │     Notes: 4 helmets with shell damage                   │
 *   ├─────────────────────────────────────────────────────────┤
 *   │  Totals: -15 units · €120.00 cost impact                │
 *   │                                                         │
 *   │  Sign: __________________   Date: __________            │
 *   └─────────────────────────────────────────────────────────┘
 */

import PDFDocument from 'pdfkit'

const PAGE_MARGIN = 50
const LINE_GAP = 4
const HEADER_DARK = '#0f172a'
const TEXT_GREY = '#475569'
const RULE_GREY = '#cbd5e1'
const REASON_TONE: Record<string, string> = {
  SHORT_SHIP: '#b91c1c',
  OVER_SHIP: '#92400e',
  WRONG_ITEM: '#b91c1c',
  DAMAGED: '#b91c1c',
  QUALITY_ISSUE: '#b91c1c',
  LATE_ARRIVAL: '#9a3412',
  COST_VARIANCE: '#854d0e',
  OTHER: '#475569',
}

export interface DiscrepancyPdfInput {
  brand: {
    name: string
    addressLines?: string[]
    logoUrl?: string | null
  }
  shipment: {
    id: string
    reference: string | null
    type: string
    status: string
    expectedAt: Date | null
    arrivedAt: Date | null
    supplierName?: string | null
  }
  discrepancies: Array<{
    reasonCode: string
    status: string
    reportedAt: Date
    reportedBy: string | null
    description: string | null
    expectedValue: string | null
    actualValue: string | null
    quantityImpact: number | null
    costImpactCents: number | null
    sku: string | null
    productName: string | null
  }>
  currencyCode: string
}

/** Render the report to a PDF buffer. */
export async function renderInboundDiscrepancyPdf(input: DiscrepancyPdfInput): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: PAGE_MARGIN, bottom: PAGE_MARGIN, left: PAGE_MARGIN, right: PAGE_MARGIN },
    info: {
      Title: `Inbound Discrepancy Report — ${input.shipment.reference ?? input.shipment.id}`,
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

  // ── Letterhead ────────────────────────────────────────────────
  doc
    .fontSize(14)
    .fillColor(HEADER_DARK)
    .font('Helvetica-Bold')
    .text(input.brand.name)
  if (input.brand.addressLines && input.brand.addressLines.length > 0) {
    for (const line of input.brand.addressLines) {
      doc
        .fontSize(9)
        .fillColor(TEXT_GREY)
        .font('Helvetica')
        .text(line)
    }
  }
  doc.moveDown(1.5)

  // ── Title + meta ──────────────────────────────────────────────
  doc
    .fontSize(16)
    .fillColor(HEADER_DARK)
    .font('Helvetica-Bold')
    .text('INBOUND DISCREPANCY REPORT')
  doc.moveDown(0.5)

  drawMetaRow(doc, [
    ['Shipment', input.shipment.reference ?? input.shipment.id],
    ['Issued', new Date().toLocaleDateString('en-GB')],
  ])
  drawMetaRow(doc, [
    ['Type', input.shipment.type],
    ['Status', input.shipment.status],
  ])
  if (input.shipment.supplierName) {
    drawMetaRow(doc, [
      ['Supplier', input.shipment.supplierName],
      ['Expected', input.shipment.expectedAt ? input.shipment.expectedAt.toLocaleDateString('en-GB') : '—'],
    ])
  }

  doc.moveDown(0.8)
  drawHorizontalRule(doc)
  doc.moveDown(0.6)

  // ── Discrepancy count ─────────────────────────────────────────
  if (input.discrepancies.length === 0) {
    doc
      .fontSize(11)
      .fillColor(TEXT_GREY)
      .font('Helvetica-Oblique')
      .text('No discrepancies recorded on this shipment.')
  } else {
    doc
      .fontSize(11)
      .fillColor(HEADER_DARK)
      .font('Helvetica-Bold')
      .text(`${input.discrepancies.length} discrepancy${input.discrepancies.length === 1 ? '' : 'ies'} recorded`)
    doc.moveDown(0.6)

    // ── Items ────────────────────────────────────────────────
    let totalQtyImpact = 0
    let totalCostImpactCents = 0
    input.discrepancies.forEach((d, i) => {
      if (d.quantityImpact != null) totalQtyImpact += d.quantityImpact
      if (d.costImpactCents != null) totalCostImpactCents += d.costImpactCents

      const tone = REASON_TONE[d.reasonCode] ?? TEXT_GREY
      doc
        .fontSize(11)
        .fillColor(tone)
        .font('Helvetica-Bold')
        .text(`${i + 1}. ${d.reasonCode}`, { continued: true })
      doc
        .fillColor(TEXT_GREY)
        .font('Helvetica')
        .text(`   ·   ${d.reportedAt.toLocaleDateString('en-GB')}   ·   ${d.status}`, { continued: false })

      if (d.sku) {
        doc
          .fontSize(10)
          .fillColor(HEADER_DARK)
          .font('Helvetica')
          .text(`SKU ${d.sku}${d.productName ? ` — ${d.productName}` : ''}`, { indent: 10 })
      }

      const detailParts: string[] = []
      if (d.expectedValue != null) detailParts.push(`Expected: ${d.expectedValue}`)
      if (d.actualValue != null) detailParts.push(`Actual: ${d.actualValue}`)
      if (d.quantityImpact != null) detailParts.push(`Impact: ${d.quantityImpact > 0 ? '+' : ''}${d.quantityImpact} units`)
      if (d.costImpactCents != null) detailParts.push(`Cost impact: ${(d.costImpactCents / 100).toFixed(2)} ${input.currencyCode}`)
      if (detailParts.length > 0) {
        doc
          .fontSize(10)
          .fillColor(TEXT_GREY)
          .font('Helvetica')
          .text(detailParts.join('  ·  '), { indent: 10 })
      }
      if (d.description && d.description.trim()) {
        doc
          .fontSize(10)
          .fillColor(TEXT_GREY)
          .font('Helvetica-Oblique')
          .text(`Notes: ${d.description.trim()}`, { indent: 10, lineGap: LINE_GAP })
      }
      doc.moveDown(0.6)
    })

    // ── Totals ────────────────────────────────────────────────
    drawHorizontalRule(doc)
    doc.moveDown(0.4)
    const totalParts: string[] = []
    if (totalQtyImpact !== 0) totalParts.push(`${totalQtyImpact > 0 ? '+' : ''}${totalQtyImpact} units`)
    if (totalCostImpactCents !== 0) totalParts.push(`${(totalCostImpactCents / 100).toFixed(2)} ${input.currencyCode} cost impact`)
    doc
      .fontSize(11)
      .fillColor(HEADER_DARK)
      .font('Helvetica-Bold')
      .text(totalParts.length > 0 ? `Totals: ${totalParts.join(' · ')}` : 'No quantitative impact recorded')
  }

  // ── Signature block ───────────────────────────────────────────
  doc.moveDown(2)
  drawHorizontalRule(doc)
  doc.moveDown(0.8)
  doc
    .fontSize(10)
    .fillColor(TEXT_GREY)
    .font('Helvetica')
    .text('Acknowledged by supplier: ___________________________     Date: __________')

  doc.end()
  return finished
}

function drawMetaRow(doc: PDFKit.PDFDocument, pairs: Array<[string, string]>): void {
  const startY = doc.y
  const colWidth = (doc.page.width - PAGE_MARGIN * 2) / pairs.length
  pairs.forEach(([label, value], i) => {
    const x = PAGE_MARGIN + colWidth * i
    doc
      .fontSize(8)
      .fillColor(TEXT_GREY)
      .font('Helvetica')
      .text(label.toUpperCase(), x, startY, { width: colWidth, continued: false })
    doc
      .fontSize(11)
      .fillColor(HEADER_DARK)
      .font('Helvetica-Bold')
      .text(value, x, startY + 10, { width: colWidth })
  })
  doc.y = startY + 28
  doc.x = PAGE_MARGIN
}

function drawHorizontalRule(doc: PDFKit.PDFDocument): void {
  const y = doc.y
  doc
    .strokeColor(RULE_GREY)
    .lineWidth(0.5)
    .moveTo(PAGE_MARGIN, y)
    .lineTo(doc.page.width - PAGE_MARGIN, y)
    .stroke()
}
