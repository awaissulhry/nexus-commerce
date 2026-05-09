/**
 * DO.41 — On-demand PDF export of the Command Center digest.
 *
 * Re-uses the digest data builder from dashboard-digest.service.ts
 * (DO.40) so the PDF and the email show the same numbers. PDFKit
 * doesn't render HTML — it's draw-primitive based — so the layout
 * is hand-laid using text + filled rects + spacing math. Letter
 * page; left/right margins; one section per concept (KPI tiles,
 * alerts, per-channel, top SKUs).
 *
 * Returned as a Buffer so the route handler can stream it back
 * with Content-Type application/pdf.
 *
 * Italian-first copy mirrors the email digest. Numbers format
 * with the same Intl.NumberFormat helpers so locale rendering
 * stays consistent across surfaces.
 */

import PDFDocument from 'pdfkit'
import {
  buildDigestData,
  type DigestFrequency,
} from './dashboard-digest.service.js'

const CHANNEL_LABEL: Record<string, string> = {
  AMAZON: 'Amazon',
  EBAY: 'eBay',
  SHOPIFY: 'Shopify',
  WOOCOMMERCE: 'WooCommerce',
  ETSY: 'Etsy',
}

function fmtCurrency(value: number, code: string): string {
  return new Intl.NumberFormat('it-IT', {
    style: 'currency',
    currency: code,
    maximumFractionDigits: 0,
  }).format(Math.round(value))
}

function fmtNumber(value: number): string {
  return new Intl.NumberFormat('it-IT').format(Math.round(value))
}

export async function buildDashboardPdf(opts: {
  frequency: DigestFrequency
  now?: Date
}): Promise<Buffer> {
  const data = await buildDigestData(opts.frequency, opts.now ?? new Date())
  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: 50, bottom: 50, left: 54, right: 54 },
    info: {
      Title: `Nexus Command Center · ${data.windowLabel}`,
      Author: 'Nexus Commerce',
      Subject: `${opts.frequency} digest`,
      CreationDate: new Date(),
    },
  })

  const chunks: Buffer[] = []
  doc.on('data', (b: Buffer) => chunks.push(b))
  const done = new Promise<Buffer>((resolve) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)))
  })

  // ── Header ────────────────────────────────────────────────────
  doc
    .fillColor('#64748b')
    .fontSize(9)
    .font('Helvetica-Bold')
    .text('NEXUS COMMAND CENTER', { characterSpacing: 0.8 })
  doc
    .moveDown(0.2)
    .fillColor('#0f172a')
    .fontSize(20)
    .font('Helvetica-Bold')
    .text(`Nexus · ${data.windowLabel}`)
  doc
    .moveDown(0.2)
    .fillColor('#64748b')
    .fontSize(10)
    .font('Helvetica')
    .text(
      `${data.rangeFrom.toLocaleDateString('it-IT')} → ${data.rangeTo.toLocaleDateString('it-IT')}  ·  ${opts.frequency}`,
    )

  drawDivider(doc)

  // ── KPI tiles row ────────────────────────────────────────────
  drawSectionHeader(doc, 'KPI principali')
  drawKpiRow(doc, [
    { label: 'Fatturato', value: fmtCurrency(data.revenue, data.primaryCurrency) },
    { label: 'Ordini', value: fmtNumber(data.orders) },
    { label: 'VMO', value: fmtCurrency(data.aov, data.primaryCurrency) },
    { label: 'Unità', value: fmtNumber(data.units) },
  ])

  doc.moveDown(0.8)

  // ── Operational alerts ───────────────────────────────────────
  drawSectionHeader(doc, 'Avvisi operativi')
  const alerts: Array<{ label: string; count: number; tone: 'rose' | 'amber' }> = []
  if (data.lateShipments > 0)
    alerts.push({
      label: 'Spedizioni in ritardo',
      count: data.lateShipments,
      tone: 'rose',
    })
  if (data.failedListings > 0)
    alerts.push({
      label: 'Annunci con errori',
      count: data.failedListings,
      tone: 'rose',
    })
  if (data.pendingShipments > 0)
    alerts.push({
      label: 'Spedizioni in attesa',
      count: data.pendingShipments,
      tone: 'amber',
    })
  if (data.outOfStock > 0)
    alerts.push({
      label: 'SKU esauriti',
      count: data.outOfStock,
      tone: 'amber',
    })

  if (alerts.length === 0) {
    doc
      .fillColor('#10b981')
      .fontSize(11)
      .font('Helvetica-Bold')
      .text('✓ Nessun avviso operativo.')
  } else {
    drawTable(doc, {
      columns: [
        { header: 'Avviso', width: 360 },
        { header: 'Quantità', width: 96, align: 'right' },
      ],
      rows: alerts.map((a) => [
        { text: a.label, color: a.tone === 'rose' ? '#b91c1c' : '#b45309', bold: true },
        { text: fmtNumber(a.count), align: 'right', bold: true },
      ]),
    })
  }

  doc.moveDown(0.8)

  // ── Per-channel ──────────────────────────────────────────────
  if (data.byChannel.length > 0) {
    drawSectionHeader(doc, 'Per canale')
    drawTable(doc, {
      columns: [
        { header: 'Canale', width: 220 },
        { header: 'Fatturato', width: 130, align: 'right' },
        { header: 'Ordini', width: 110, align: 'right' },
      ],
      rows: data.byChannel.map((c) => [
        { text: CHANNEL_LABEL[c.channel] ?? c.channel },
        {
          text: fmtCurrency(c.revenue, data.primaryCurrency),
          align: 'right',
          bold: true,
        },
        { text: fmtNumber(c.orders), align: 'right', color: '#64748b' },
      ]),
    })
    doc.moveDown(0.8)
  }

  // ── Top SKUs ─────────────────────────────────────────────────
  if (data.topSkus.length > 0) {
    drawSectionHeader(doc, 'Top SKU per fatturato')
    drawTable(doc, {
      columns: [
        { header: 'SKU', width: 220, font: 'Courier' },
        { header: 'Unità', width: 110, align: 'right' },
        { header: 'Fatturato', width: 130, align: 'right' },
      ],
      rows: data.topSkus.map((s) => [
        { text: s.sku },
        { text: `${fmtNumber(s.units)} un.`, align: 'right', color: '#64748b' },
        {
          text: fmtCurrency(s.revenue, data.primaryCurrency),
          align: 'right',
          bold: true,
        },
      ]),
    })
  }

  // Footer
  doc.moveDown(2)
  doc
    .fillColor('#94a3b8')
    .fontSize(8)
    .font('Helvetica')
    .text(
      `Generato il ${new Date().toLocaleString('it-IT')} · Nexus Commerce`,
      { align: 'center' },
    )

  doc.end()
  return done
}

// ── helpers ──────────────────────────────────────────────────────

function drawDivider(doc: InstanceType<typeof PDFDocument>): void {
  const y = doc.y + 8
  doc
    .moveTo(54, y)
    .lineTo(558, y)
    .lineWidth(0.5)
    .strokeColor('#e2e8f0')
    .stroke()
  doc.y = y + 12
}

function drawSectionHeader(
  doc: InstanceType<typeof PDFDocument>,
  text: string,
): void {
  doc
    .fillColor('#64748b')
    .fontSize(9)
    .font('Helvetica-Bold')
    .text(text.toUpperCase(), { characterSpacing: 0.6 })
  doc.moveDown(0.4)
}

function drawKpiRow(
  doc: InstanceType<typeof PDFDocument>,
  tiles: Array<{ label: string; value: string }>,
): void {
  // 4 tiles equally spaced. Letter page minus margins = 504pt.
  const pageWidth = 504
  const gap = 8
  const tileWidth = (pageWidth - gap * (tiles.length - 1)) / tiles.length
  const startX = 54
  const startY = doc.y
  const tileHeight = 56

  tiles.forEach((tile, i) => {
    const x = startX + i * (tileWidth + gap)
    doc
      .roundedRect(x, startY, tileWidth, tileHeight, 4)
      .fillColor('#f8fafc')
      .fill()
      .lineWidth(0.5)
      .strokeColor('#e2e8f0')
      .roundedRect(x, startY, tileWidth, tileHeight, 4)
      .stroke()
    doc
      .fillColor('#64748b')
      .fontSize(8)
      .font('Helvetica-Bold')
      .text(tile.label.toUpperCase(), x + 10, startY + 8, {
        characterSpacing: 0.6,
        width: tileWidth - 20,
      })
    doc
      .fillColor('#0f172a')
      .fontSize(16)
      .font('Helvetica-Bold')
      .text(tile.value, x + 10, startY + 24, {
        width: tileWidth - 20,
      })
  })

  doc.y = startY + tileHeight + 4
}

interface TableColumn {
  header: string
  width: number
  align?: 'left' | 'right'
  font?: 'Helvetica' | 'Courier'
}
interface TableCell {
  text: string
  align?: 'left' | 'right'
  color?: string
  bold?: boolean
}

function drawTable(
  doc: InstanceType<typeof PDFDocument>,
  spec: { columns: TableColumn[]; rows: TableCell[][] },
): void {
  const startX = 54
  let y = doc.y

  // Header row
  doc.font('Helvetica-Bold').fontSize(8).fillColor('#64748b')
  let x = startX
  for (const col of spec.columns) {
    doc.text(col.header.toUpperCase(), x + 4, y + 2, {
      width: col.width - 8,
      align: col.align ?? 'left',
      characterSpacing: 0.5,
    })
    x += col.width
  }
  y += 16
  doc
    .moveTo(startX, y - 2)
    .lineTo(startX + spec.columns.reduce((s, c) => s + c.width, 0), y - 2)
    .lineWidth(0.5)
    .strokeColor('#e2e8f0')
    .stroke()

  // Rows
  for (const row of spec.rows) {
    x = startX
    let rowHeight = 18
    for (let i = 0; i < spec.columns.length; i++) {
      const col = spec.columns[i]
      const cell = row[i]
      doc
        .font(cell.bold ? 'Helvetica-Bold' : col.font ?? 'Helvetica')
        .fontSize(10)
        .fillColor(cell.color ?? '#0f172a')
        .text(cell.text, x + 4, y + 4, {
          width: col.width - 8,
          align: cell.align ?? col.align ?? 'left',
        })
      x += col.width
    }
    y += rowHeight
    doc
      .moveTo(startX, y - 1)
      .lineTo(startX + spec.columns.reduce((s, c) => s + c.width, 0), y - 1)
      .lineWidth(0.3)
      .strokeColor('#f1f5f9')
      .stroke()
  }
  doc.y = y + 4
}
