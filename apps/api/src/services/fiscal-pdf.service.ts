/**
 * F.3 — Italian invoice + packing slip rendering.
 *
 * Returns printable HTML strings (not raw PDF) that the operator
 * opens in a new tab and prints to PDF via the browser's built-in
 * print dialog. Tradeoffs:
 *
 *   + Zero new deps. pdfkit / playwright / react-pdf all add
 *     500KB–80MB to the API bundle. Browser print is "free".
 *   + Operator can preview in browser before printing — fewer
 *     "wait that wasn't the right invoice" moments.
 *   + Italian fiscal authorities accept "PDF generated via print
 *     dialog from a structured HTML template" — what matters for
 *     compliance is the data, not the renderer.
 *   - No fully-automated batch export-to-PDF (operator has to
 *     print each one). For Xavia volumes (small) this is fine; if
 *     batch export becomes a real ask, swap to pdfkit in a
 *     follow-up commit — call-site shape unchanged.
 *
 * What renders today:
 *   invoiceHtml(orderId)
 *     Italian B2B fattura format. Lazy-assigns the invoice number
 *     via fiscal-invoice.service when one isn't already issued.
 *     Sections: header (issuer + invoice #), bill-to (customer
 *     fiscal data: codice fiscale / partita IVA / address),
 *     line items with per-line VAT rate breakdown, VAT subtotal
 *     by rate, grand total. Italian copy.
 *   packingSlipHtml(orderId)
 *     Operator-facing pick/pack list. Simpler — no fiscal data,
 *     just SKU / qty / shipping address / order id. Both Italian
 *     and English copy (operators may bilingual; warehouse staff
 *     don't always read Italian).
 *
 * Italian invoice required fields per DPR 633/72:
 *   ✓ Issuer name + VAT number + registered address
 *   ✓ Invoice number + issue date
 *   ✓ Buyer name + codice fiscale OR partita IVA + address
 *   ✓ Per-line description + qty + unit price + VAT rate
 *   ✓ Subtotal + VAT total per rate + grand total
 *   - Codice destinatario (7-char SDI routing) — populated when
 *     present; B2C orders may omit
 */

import prisma from '../db.js'
import { assignInvoiceNumber, getInvoiceForOrder } from './fiscal-invoice.service.js'
import { logger } from '../utils/logger.js'

// Issuer (Xavia) details. In a multi-brand future these come from
// a brand-settings table per issuer; for single-tenant they're
// hardcoded with env-var override hooks.
const ISSUER = {
  name: process.env.NEXUS_ISSUER_NAME ?? 'Xavia S.r.l.',
  vatNumber: process.env.NEXUS_ISSUER_VAT ?? 'IT00000000000',
  fiscalCode: process.env.NEXUS_ISSUER_CF ?? '00000000000',
  address: process.env.NEXUS_ISSUER_ADDRESS ?? 'Via Esempio 1',
  city: process.env.NEXUS_ISSUER_CITY ?? 'Milano',
  postalCode: process.env.NEXUS_ISSUER_POSTAL ?? '20100',
  country: process.env.NEXUS_ISSUER_COUNTRY ?? 'IT',
  email: process.env.NEXUS_ISSUER_EMAIL ?? 'info@xavia.example',
  pec: process.env.NEXUS_ISSUER_PEC ?? '',
}

function escapeHtml(s: unknown): string {
  if (s == null) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function fmtEur(n: number): string {
  return new Intl.NumberFormat('it-IT', {
    style: 'currency',
    currency: 'EUR',
  }).format(n)
}

function fmtItDate(d: Date | string | null): string {
  if (!d) return ''
  const date = d instanceof Date ? d : new Date(d)
  return date.toLocaleDateString('it-IT', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  })
}

const PRINT_CSS = `
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         color: #1f2937; margin: 24px; font-size: 12px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em;
       color: #6b7280; margin: 16px 0 4px; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th, td { padding: 6px 8px; text-align: left; border-bottom: 1px solid #e5e7eb;
           vertical-align: top; }
  th { background: #f9fafb; font-size: 11px; text-transform: uppercase;
       letter-spacing: 0.05em; color: #4b5563; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .totals { margin-top: 12px; }
  .totals td { border: none; padding: 2px 8px; }
  .totals .grand { font-size: 14px; font-weight: 600; border-top: 2px solid #1f2937;
                   padding-top: 6px; }
  .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-top: 12px; }
  .badge { display: inline-block; padding: 1px 6px; border-radius: 3px;
           background: #fef3c7; color: #92400e; font-size: 10px; }
  @media print { body { margin: 16px; } }
`

interface InvoiceLine {
  sku: string
  description: string
  quantity: number
  unitPriceEur: number
  vatRatePct: number
  netEur: number
  vatEur: number
  totalEur: number
}

/**
 * Render the Italian fattura HTML for an order. Lazy-assigns the
 * fiscal invoice number when none has been issued yet (idempotent
 * via fiscal-invoice.service).
 */
export async function invoiceHtml(orderId: string): Promise<string> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      items: true,
    },
  })
  if (!order) throw new Error(`Order ${orderId} not found`)

  // Fetch-or-assign the invoice number. Only IT-marketplace orders
  // get a fiscal invoice; non-IT orders use a "Pro forma" header.
  const isItalianFiscal =
    order.marketplace === 'IT' || order.fiscalKind === 'B2B' || order.fiscalKind === 'B2C'
  let invoiceLabel = 'PRO FORMA'
  let invoiceNumber = ''
  let issuedAtItalian = fmtItDate(new Date())
  if (isItalianFiscal) {
    const inv = (await getInvoiceForOrder(orderId)) ?? (await assignInvoiceNumber(orderId))
    invoiceNumber = inv.invoiceNumber
    invoiceLabel = `Fattura n. ${inv.invoiceNumber}`
    issuedAtItalian = fmtItDate(inv.issuedAt)
  }

  // Compute per-line + totals. Default VAT 22% on Italian orders
  // when itVatRatePct is NULL (legacy).
  const lines: InvoiceLine[] = order.items.map((it) => {
    const unitPrice = Number(it.price)
    const qty = it.quantity
    const totalEur = unitPrice * qty
    const vatRatePct =
      it.itVatRatePct != null
        ? Number(it.itVatRatePct)
        : isItalianFiscal
          ? 22
          : 0
    // Prices on Order are gross (VAT-inclusive); decompose to net.
    const netEur = vatRatePct > 0 ? totalEur / (1 + vatRatePct / 100) : totalEur
    const vatEur = totalEur - netEur
    return {
      sku: it.sku,
      description: it.sku,
      quantity: qty,
      unitPriceEur: unitPrice,
      vatRatePct,
      netEur,
      vatEur,
      totalEur,
    }
  })

  // Group VAT subtotal by rate.
  const vatByRate = new Map<number, { net: number; vat: number }>()
  for (const l of lines) {
    const cur = vatByRate.get(l.vatRatePct) ?? { net: 0, vat: 0 }
    cur.net += l.netEur
    cur.vat += l.vatEur
    vatByRate.set(l.vatRatePct, cur)
  }
  const grandNet = lines.reduce((a, l) => a + l.netEur, 0)
  const grandVat = lines.reduce((a, l) => a + l.vatEur, 0)
  const grandTotal = grandNet + grandVat

  const ship = (order.shippingAddress ?? {}) as any
  const shipLine1 = ship.line1 ?? ship.AddressLine1 ?? ship.address1 ?? ship.street ?? ''
  const shipCity = ship.city ?? ship.City ?? ''
  const shipPostal = ship.postalCode ?? ship.PostalCode ?? ship.postal_code ?? ''
  const shipCountry = ship.countryCode ?? ship.CountryCode ?? ship.country_code ?? ship.country ?? ''

  return `<!doctype html><html lang="it"><head><meta charset="utf-8">
<title>${escapeHtml(invoiceLabel)} — ${escapeHtml(order.channelOrderId)}</title>
<style>${PRINT_CSS}</style></head><body>
<h1>${escapeHtml(invoiceLabel)}</h1>
<div class="meta">
  <div>
    <h2>Emittente</h2>
    <div><strong>${escapeHtml(ISSUER.name)}</strong></div>
    <div>${escapeHtml(ISSUER.address)}, ${escapeHtml(ISSUER.postalCode)} ${escapeHtml(ISSUER.city)} (${escapeHtml(ISSUER.country)})</div>
    <div>P. IVA: ${escapeHtml(ISSUER.vatNumber)} · C.F.: ${escapeHtml(ISSUER.fiscalCode)}</div>
    ${ISSUER.pec ? `<div>PEC: ${escapeHtml(ISSUER.pec)}</div>` : ''}
    <div>${escapeHtml(ISSUER.email)}</div>
  </div>
  <div>
    <h2>Cliente</h2>
    <div><strong>${escapeHtml(order.customerName)}</strong></div>
    <div>${escapeHtml(shipLine1)}</div>
    <div>${escapeHtml(shipPostal)} ${escapeHtml(shipCity)} (${escapeHtml(shipCountry)})</div>
    ${order.codiceFiscale ? `<div>C.F.: ${escapeHtml(order.codiceFiscale)}</div>` : ''}
    ${order.partitaIva ? `<div>P. IVA: ${escapeHtml(order.partitaIva)}</div>` : ''}
    ${order.codiceDestinatario ? `<div>Codice destinatario: ${escapeHtml(order.codiceDestinatario)}</div>` : ''}
    ${order.pecEmail ? `<div>PEC: ${escapeHtml(order.pecEmail)}</div>` : ''}
    <div>${escapeHtml(order.customerEmail)}</div>
  </div>
</div>

<h2>Dettaglio</h2>
<table>
  <thead>
    <tr>
      <th>SKU</th>
      <th>Descrizione</th>
      <th class="num">Qtà</th>
      <th class="num">Prezzo unit.</th>
      <th class="num">IVA %</th>
      <th class="num">Imponibile</th>
      <th class="num">IVA</th>
      <th class="num">Totale</th>
    </tr>
  </thead>
  <tbody>
    ${lines
      .map(
        (l) => `
      <tr>
        <td>${escapeHtml(l.sku)}</td>
        <td>${escapeHtml(l.description)}</td>
        <td class="num">${l.quantity}</td>
        <td class="num">${fmtEur(l.unitPriceEur)}</td>
        <td class="num">${l.vatRatePct}%</td>
        <td class="num">${fmtEur(l.netEur)}</td>
        <td class="num">${fmtEur(l.vatEur)}</td>
        <td class="num">${fmtEur(l.totalEur)}</td>
      </tr>`,
      )
      .join('')}
  </tbody>
</table>

<h2>Riepilogo IVA</h2>
<table>
  <thead>
    <tr>
      <th class="num">Aliquota</th>
      <th class="num">Imponibile</th>
      <th class="num">IVA</th>
    </tr>
  </thead>
  <tbody>
    ${[...vatByRate.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(
        ([rate, v]) => `
      <tr>
        <td class="num">${rate}%</td>
        <td class="num">${fmtEur(v.net)}</td>
        <td class="num">${fmtEur(v.vat)}</td>
      </tr>`,
      )
      .join('')}
  </tbody>
</table>

<table class="totals" style="width: 320px; margin-left: auto;">
  <tr><td>Imponibile</td><td class="num">${fmtEur(grandNet)}</td></tr>
  <tr><td>IVA totale</td><td class="num">${fmtEur(grandVat)}</td></tr>
  <tr class="grand"><td>Totale fattura</td><td class="num">${fmtEur(grandTotal)}</td></tr>
</table>

<p style="margin-top: 24px; font-size: 10px; color: #6b7280;">
  Documento generato il ${escapeHtml(issuedAtItalian)} ·
  Ordine ${escapeHtml(order.channel)} ${escapeHtml(order.channelOrderId)}
  ${invoiceNumber ? `· Fattura ${escapeHtml(invoiceNumber)}` : ''}
</p>

</body></html>`
}

/**
 * Render the operator-facing packing slip HTML. Bilingual
 * (Italian + English) since warehouse staff aren't always
 * fluent in Italian.
 */
export async function packingSlipHtml(orderId: string): Promise<string> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: true },
  })
  if (!order) throw new Error(`Order ${orderId} not found`)

  const ship = (order.shippingAddress ?? {}) as any
  const shipName = ship.name ?? ship.Name ?? order.customerName
  const shipLine1 = ship.line1 ?? ship.AddressLine1 ?? ship.address1 ?? ship.street ?? ''
  const shipCity = ship.city ?? ship.City ?? ''
  const shipPostal = ship.postalCode ?? ship.PostalCode ?? ship.postal_code ?? ''
  const shipCountry = ship.countryCode ?? ship.CountryCode ?? ship.country_code ?? ship.country ?? ''

  return `<!doctype html><html lang="it"><head><meta charset="utf-8">
<title>Packing slip — ${escapeHtml(order.channelOrderId)}</title>
<style>${PRINT_CSS}</style></head><body>
<h1>Documento di trasporto / Packing slip</h1>
<div class="meta">
  <div>
    <h2>Mittente · From</h2>
    <div><strong>${escapeHtml(ISSUER.name)}</strong></div>
    <div>${escapeHtml(ISSUER.address)}, ${escapeHtml(ISSUER.postalCode)} ${escapeHtml(ISSUER.city)} (${escapeHtml(ISSUER.country)})</div>
  </div>
  <div>
    <h2>Destinatario · Ship to</h2>
    <div><strong>${escapeHtml(shipName)}</strong></div>
    <div>${escapeHtml(shipLine1)}</div>
    <div>${escapeHtml(shipPostal)} ${escapeHtml(shipCity)} (${escapeHtml(shipCountry)})</div>
  </div>
</div>

<h2>Articoli · Items</h2>
<table>
  <thead>
    <tr>
      <th>SKU</th>
      <th>Descrizione · Description</th>
      <th class="num">Qtà · Qty</th>
    </tr>
  </thead>
  <tbody>
    ${order.items
      .map(
        (it) => `
      <tr>
        <td>${escapeHtml(it.sku)}</td>
        <td>${escapeHtml(it.sku)}</td>
        <td class="num">${it.quantity}</td>
      </tr>`,
      )
      .join('')}
  </tbody>
</table>

<p style="margin-top: 24px; font-size: 10px; color: #6b7280;">
  Ordine ${escapeHtml(order.channel)} ${escapeHtml(order.channelOrderId)} ·
  Generato il ${escapeHtml(fmtItDate(new Date()))}
</p>

</body></html>`
}

/**
 * Try-catch wrapper that logs errors at warn level. Used by
 * routes so a renderer failure doesn't 500 the operator's
 * print button — they get a small HTML error page instead.
 */
export async function safeRender(
  fn: () => Promise<string>,
  label: string,
): Promise<string> {
  try {
    return await fn()
  } catch (err) {
    logger.warn(`fiscal-pdf ${label} render failed`, {
      error: err instanceof Error ? err.message : String(err),
    })
    return `<!doctype html><html><body style="font-family:sans-serif;padding:24px">
      <h1>Errore di rendering</h1>
      <p>${escapeHtml(err instanceof Error ? err.message : String(err))}</p>
    </body></html>`
  }
}
