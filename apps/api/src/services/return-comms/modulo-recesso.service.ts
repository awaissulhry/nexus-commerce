/**
 * R6.3 — Modulo di Recesso PDF generator.
 *
 * Italian consumer law (D.Lgs. 21/2014, recepito Direttiva
 * 2011/83/UE) requires the seller to make a withdrawal-form
 * template available to the buyer. The standardized text is in
 * Allegato I parte B. We render that text with the buyer's order
 * details pre-filled (date, item list, channel order id) so the
 * customer doesn't have to retype.
 *
 * The form is a single A4 page in Italian; we add an English
 * translation line under each Italian section because Xavia's
 * Shopify DTC funnel takes orders worldwide.
 *
 * Output: PDF Buffer. The route at /returns/:id/modulo-recesso.pdf
 * streams it with Content-Type: application/pdf so the browser
 * download flow works without an intermediate file write.
 *
 * The pdfkit dependency was already in the API package (used by
 * label-generation flows). No new dep.
 */

import PDFDocument from 'pdfkit'

export interface ModuloRecessoInput {
  rmaNumber: string | null
  channelOrderId: string | null
  customerName: string | null
  customerEmail: string | null
  shippingAddress: Record<string, unknown> | null
  items: Array<{ sku: string; quantity: number; productName?: string | null }>
  orderDate: Date | null
  /** When the customer received the goods (drives the 14-day window). */
  deliveredAt: Date | null
}

const FOOTER_TEXT_IT =
  'Modulo di recesso ai sensi dell’art. 49 del D.Lgs. 21/2014. ' +
  'Il diritto di recesso può essere esercitato entro 14 giorni dalla ' +
  'consegna senza fornire alcuna motivazione.'

const FOOTER_TEXT_EN =
  'Withdrawal form per Art. 49 D.Lgs. 21/2014 (EU Directive 2011/83/EU). ' +
  'The right of withdrawal may be exercised within 14 days of receipt of the goods, ' +
  'without giving any reason.'

function formatAddress(addr: Record<string, unknown> | null): string {
  if (!addr) return '—'
  const a = addr as any
  const parts = [
    a.AddressLine1 ?? a.addressLine1 ?? a.street,
    a.AddressLine2 ?? a.addressLine2,
    [a.PostalCode ?? a.postalCode, a.City ?? a.city].filter(Boolean).join(' '),
    a.StateOrRegion ?? a.stateOrProvince ?? a.state,
    a.CountryCode ?? a.countryCode ?? a.country,
  ].filter(Boolean)
  return parts.join(', ')
}

/**
 * Generate the Modulo as a PDF buffer. Returns once the document
 * is fully serialized — pdfkit's `end()` triggers the 'end' event
 * after streams finalize.
 */
export function buildModuloRecessoPdf(input: ModuloRecessoInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margin: 56,
        info: {
          Title: `Modulo di Recesso ${input.rmaNumber ?? input.channelOrderId ?? ''}`.trim(),
          Author: 'Xavia',
          Subject: 'Modulo di Recesso / Withdrawal Form',
          Keywords: 'recesso withdrawal return EU consumer rights',
        },
      })
      const chunks: Buffer[] = []
      doc.on('data', (c) => chunks.push(c))
      doc.on('end', () => resolve(Buffer.concat(chunks)))
      doc.on('error', reject)

      // Header
      doc
        .fontSize(20)
        .fillColor('#0f172a')
        .text('Modulo di Recesso', { align: 'center' })
        .moveDown(0.2)
        .fontSize(11)
        .fillColor('#475569')
        .text('Withdrawal Form', { align: 'center' })
        .moveDown(0.5)

      // Recipient block (always Xavia for now — when multi-tenant,
      // pull from BrandSettings).
      doc
        .fontSize(10)
        .fillColor('#0f172a')
        .text('Destinatario / Recipient:', { continued: false })
        .moveDown(0.2)
        .fontSize(11)
        .text('Xavia S.r.l.')
        .text('Via Esempio 1')
        .text('47838 Riccione (RN), Italia')
        .text('Email: support@xavia.it')
        .moveDown(0.8)

      // Order context
      const orderDateStr = input.orderDate
        ? input.orderDate.toLocaleDateString('it-IT', { year: 'numeric', month: 'long', day: 'numeric' })
        : '—'
      const deliveredStr = input.deliveredAt
        ? input.deliveredAt.toLocaleDateString('it-IT', { year: 'numeric', month: 'long', day: 'numeric' })
        : '—'
      doc
        .fontSize(10)
        .fillColor('#0f172a')
        .text('Riferimenti ordine / Order references:', { continued: false })
        .moveDown(0.2)
        .fontSize(11)
        .text(`Numero RMA: ${input.rmaNumber ?? '—'}`)
        .text(`ID ordine canale / Channel order id: ${input.channelOrderId ?? '—'}`)
        .text(`Data ordine / Order date: ${orderDateStr}`)
        .text(`Data ricezione / Date received: ${deliveredStr}`)
        .moveDown(0.8)

      // Withdrawal statement (legal text)
      doc
        .fontSize(11)
        .fillColor('#0f172a')
        .text(
          'Con la presente io / noi sottoscritti notifichiamo il recesso dal nostro contratto di vendita dei seguenti beni:',
          { align: 'left' },
        )
        .moveDown(0.2)
        .fontSize(10)
        .fillColor('#64748b')
        .text(
          'I hereby give notice that I/we withdraw from my/our contract of sale of the following goods:',
          { align: 'left' },
        )
        .moveDown(0.6)

      // Item table
      doc.fontSize(11).fillColor('#0f172a')
      const tableTop = doc.y
      doc.font('Helvetica-Bold')
      doc.text('SKU', 56, tableTop, { width: 130 })
      doc.text('Articolo / Item', 200, tableTop, { width: 240 })
      doc.text('Qtà / Qty', 460, tableTop, { width: 60, align: 'right' })
      doc.font('Helvetica')
      doc.moveTo(56, tableTop + 18).lineTo(540, tableTop + 18).strokeColor('#e2e8f0').stroke()
      let y = tableTop + 24
      for (const it of input.items) {
        doc.fontSize(10).fillColor('#0f172a')
        doc.text(it.sku, 56, y, { width: 130 })
        doc.text(it.productName ?? it.sku, 200, y, { width: 240 })
        doc.text(String(it.quantity), 460, y, { width: 60, align: 'right' })
        y += 18
      }
      doc.moveDown(2)
      doc.y = Math.max(doc.y, y + 16)

      // Customer block
      doc
        .fontSize(10)
        .fillColor('#0f172a')
        .text('Consumatore / Consumer:', { continued: false })
        .moveDown(0.2)
        .fontSize(11)
        .text(`Nome / Name: ${input.customerName ?? '—'}`)
        .text(`Email: ${input.customerEmail ?? '—'}`)
        .text(`Indirizzo / Address: ${formatAddress(input.shippingAddress)}`)
        .moveDown(1.2)

      // Signature line
      const sigY = doc.y
      doc.moveTo(56, sigY + 24).lineTo(290, sigY + 24).strokeColor('#94a3b8').stroke()
      doc.moveTo(310, sigY + 24).lineTo(540, sigY + 24).strokeColor('#94a3b8').stroke()
      doc.fontSize(9).fillColor('#64748b')
      doc.text('Firma del consumatore / Consumer signature', 56, sigY + 28, { width: 234 })
      doc.text('Data / Date', 310, sigY + 28, { width: 234 })

      // Footer (legal disclaimer)
      doc
        .fontSize(8)
        .fillColor('#94a3b8')
        .text(FOOTER_TEXT_IT, 56, 760, { width: 484, align: 'center' })
        .moveDown(0.2)
        .text(FOOTER_TEXT_EN, 56, undefined, { width: 484, align: 'center' })

      doc.end()
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
}
