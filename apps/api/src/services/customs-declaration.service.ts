/**
 * F1.8 — UPU CN22 / CN23 customs declaration.
 *
 * Required for postal shipments outside the EU customs union. UPU
 * (Universal Postal Union) format threshold:
 *   • CN22 — value < SDR 300 (~€350) AND total weight ≤ 2 kg
 *   • CN23 — value ≥ SDR 300 OR weight > 2 kg
 *
 * Sendcloud auto-generates customs documents from the parcel_items
 * payload (hs_code + origin_country + value already captured in the
 * outbound print-label call). This service exists for two operator
 * scenarios:
 *   1. Non-Sendcloud carriers (manual handover at Italian Post) where
 *      the operator must physically attach a printed CN22/CN23 form.
 *   2. Sendcloud audit trail / customs broker request — re-print the
 *      declaration that was submitted with the parcel.
 *
 * Returns printable HTML (browser print dialog → PDF) — same pattern
 * as fiscal-pdf.service.ts to avoid pulling in pdfkit / playwright.
 *
 * Form is bilingual (English / French) per UPU rules — postal
 * authorities reject single-language forms in destination countries
 * that don't speak the sender's language.
 */

import prisma from '../db.js'
import { logger } from '../utils/logger.js'

// EU customs union — duplicates the inline set in
// fulfillment.routes.ts /shipments/:id/customs-preflight. Kept local
// to avoid an export cycle; if a third caller needs it, lift to a
// shared module.
const EU_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE',
  'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT',
  'RO', 'SK', 'SI', 'ES', 'SE',
])

const ISSUER = {
  name: process.env.NEXUS_ISSUER_NAME ?? 'Xavia S.r.l.',
  vatNumber: process.env.NEXUS_ISSUER_VAT ?? 'IT00000000000',
  address: process.env.NEXUS_ISSUER_ADDRESS ?? 'Via Esempio 1',
  city: process.env.NEXUS_ISSUER_CITY ?? 'Milano',
  postalCode: process.env.NEXUS_ISSUER_POSTAL ?? '20100',
  country: process.env.NEXUS_ISSUER_COUNTRY ?? 'IT',
  phone: process.env.NEXUS_ISSUER_PHONE ?? '',
  email: process.env.NEXUS_ISSUER_EMAIL ?? 'info@xavia.example',
}

// SDR threshold from UPU; €350 is the practical Italian Post
// floor that flips CN22 → CN23 (rounded up from SDR 300).
const CN22_VALUE_LIMIT_EUR = 350
const CN22_WEIGHT_LIMIT_GRAMS = 2000

type CustomsCategory =
  | 'GIFT'
  | 'SAMPLE'
  | 'COMMERCIAL'
  | 'DOCUMENT'
  | 'RETURNED_GOODS'
  | 'OTHER'

const UNIT_TO_GRAMS: Record<string, number> = {
  g: 1,
  kg: 1000,
  oz: 28.3495,
  lb: 453.592,
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

export interface CustomsDeclarationResult {
  html: string
  formType: 'CN22' | 'CN23'
  totalValueEur: number
  totalWeightGrams: number
  destinationCountry: string
}

/**
 * Generate a CN22/CN23 declaration HTML for a shipment. Throws when
 * the destination is intra-EU (no declaration needed).
 */
export async function customsDeclarationHtml(
  shipmentId: string,
  opts: { category?: CustomsCategory } = {},
): Promise<CustomsDeclarationResult> {
  const shipment = await prisma.shipment.findUnique({
    where: { id: shipmentId },
    include: {
      order: {
        include: {
          items: {
            include: {
              product: {
                select: {
                  sku: true,
                  hsCode: true,
                  countryOfOrigin: true,
                  weightValue: true,
                  weightUnit: true,
                },
              },
            },
          },
        },
      },
      warehouse: { select: { code: true, name: true } },
    },
  })
  if (!shipment) throw new Error(`Shipment ${shipmentId} not found`)
  if (!shipment.order) throw new Error(`Shipment ${shipmentId} has no order`)

  const ship = shipment.order.shippingAddress as any
  const destCountry = (
    ship?.CountryCode ?? ship?.countryCode ?? ship?.country ?? ''
  )
    .toString()
    .toUpperCase()
  if (!destCountry) {
    throw new Error('Destination country missing on shipping address')
  }
  if (EU_COUNTRIES.has(destCountry)) {
    throw new Error(
      `Destination ${destCountry} is intra-EU — no customs declaration required.`,
    )
  }

  // Aggregate weight: prefer operator-declared shipment.weightGrams,
  // fall back to summed master weights, fall back to 1500g (matches
  // outbound print-label baseline).
  let weightGrams = shipment.weightGrams ?? 0
  if (!weightGrams) {
    let summed = 0
    for (const it of shipment.order.items) {
      const v = it.product?.weightValue
      const u = (it.product?.weightUnit ?? '').toLowerCase()
      if (v != null && UNIT_TO_GRAMS[u]) {
        summed += Number(v) * UNIT_TO_GRAMS[u] * it.quantity
      }
    }
    weightGrams = summed > 0 ? Math.round(summed) : 1500
  }

  const totalValueEur = shipment.order.items.reduce(
    (sum, it) => sum + Number(it.price) * it.quantity,
    0,
  )

  const isLargeForm =
    totalValueEur >= CN22_VALUE_LIMIT_EUR ||
    weightGrams > CN22_WEIGHT_LIMIT_GRAMS
  const formType: 'CN22' | 'CN23' = isLargeForm ? 'CN23' : 'CN22'

  // Default to COMMERCIAL — Xavia sells gear, not gifts. Operator
  // can pass category=RETURNED_GOODS for a returns-related shipment.
  const category: CustomsCategory = opts.category ?? 'COMMERCIAL'

  const lines = shipment.order.items.map((it) => {
    const v = it.product?.weightValue
    const u = (it.product?.weightUnit ?? '').toLowerCase()
    const lineWeight =
      v != null && UNIT_TO_GRAMS[u]
        ? Number(v) * UNIT_TO_GRAMS[u] * it.quantity
        : null
    return {
      sku: it.product?.sku ?? it.sku,
      description: it.product?.sku ?? it.sku,
      quantity: it.quantity,
      hsCode: it.product?.hsCode ?? null,
      originCountry: it.product?.countryOfOrigin ?? null,
      unitValueEur: Number(it.price),
      lineValueEur: Number(it.price) * it.quantity,
      lineWeightGrams: lineWeight != null ? Math.round(lineWeight) : null,
    }
  })

  const recipient = {
    name: shipment.order.customerName || 'Customer',
    address1: ship?.AddressLine1 ?? ship?.addressLine1 ?? ship?.street ?? '',
    address2: ship?.AddressLine2 ?? ship?.addressLine2 ?? '',
    city: ship?.City ?? ship?.city ?? '',
    state:
      ship?.StateOrRegion ?? ship?.stateOrProvince ?? ship?.state ?? '',
    postalCode: ship?.PostalCode ?? ship?.postalCode ?? '',
    country: destCountry,
    phone: ship?.Phone ?? ship?.phone ?? '',
    email: shipment.order.customerEmail || '',
  }

  const html = renderHtml({
    formType,
    category,
    issuer: ISSUER,
    recipient,
    lines,
    totalValueEur,
    weightGrams,
    currency: shipment.order.currencyCode ?? 'EUR',
    shipmentId: shipment.id,
    trackingNumber: shipment.trackingNumber,
    issuedAt: new Date(),
  })

  logger.info('customs-declaration: rendered', {
    shipmentId,
    formType,
    destCountry,
    totalValueEur,
    weightGrams,
  })

  return {
    html,
    formType,
    totalValueEur,
    totalWeightGrams: weightGrams,
    destinationCountry: destCountry,
  }
}

interface RenderInput {
  formType: 'CN22' | 'CN23'
  category: CustomsCategory
  issuer: typeof ISSUER
  recipient: {
    name: string
    address1: string
    address2: string
    city: string
    state: string
    postalCode: string
    country: string
    phone: string
    email: string
  }
  lines: Array<{
    sku: string
    description: string
    quantity: number
    hsCode: string | null
    originCountry: string | null
    unitValueEur: number
    lineValueEur: number
    lineWeightGrams: number | null
  }>
  totalValueEur: number
  weightGrams: number
  currency: string
  shipmentId: string
  trackingNumber: string | null
  issuedAt: Date
}

const CATEGORY_LABEL: Record<CustomsCategory, { en: string; fr: string }> = {
  GIFT: { en: 'Gift', fr: 'Cadeau' },
  SAMPLE: { en: 'Commercial sample', fr: 'Échantillon commercial' },
  COMMERCIAL: { en: 'Sale of goods', fr: 'Vente de marchandises' },
  DOCUMENT: { en: 'Documents', fr: 'Documents' },
  RETURNED_GOODS: { en: 'Returned goods', fr: 'Retour de marchandises' },
  OTHER: { en: 'Other', fr: 'Autre' },
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function renderHtml(args: RenderInput): string {
  const { formType, category, issuer, recipient, lines, totalValueEur, weightGrams, currency, shipmentId, trackingNumber, issuedAt } = args
  const cat = CATEGORY_LABEL[category]
  const lineRows = lines
    .map(
      (l) => `
    <tr>
      <td>${escapeHtml(l.description)}</td>
      <td class="num">${l.quantity}</td>
      <td>${escapeHtml(l.hsCode ?? '—')}</td>
      <td>${escapeHtml(l.originCountry ?? '—')}</td>
      <td class="num">${l.lineWeightGrams != null ? `${l.lineWeightGrams} g` : '—'}</td>
      <td class="num">${l.lineValueEur.toFixed(2)} ${escapeHtml(currency)}</td>
    </tr>`,
    )
    .join('\n')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${formType} customs declaration · ${escapeHtml(shipmentId)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Helvetica', sans-serif; font-size: 11px; color: #111; margin: 18px; }
  h1 { font-size: 18px; margin: 0 0 4px; letter-spacing: 0.5px; }
  h1 .sub { font-size: 11px; color: #666; font-weight: normal; }
  .meta { color: #666; font-size: 10px; margin-bottom: 12px; }
  .panels { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 10px; }
  .panel { border: 1px solid #999; padding: 8px; }
  .panel h3 { font-size: 10px; text-transform: uppercase; letter-spacing: 1px; margin: 0 0 4px; color: #666; }
  .panel .line { line-height: 1.4; }
  .category { border: 1px solid #999; padding: 6px 8px; margin-bottom: 10px; }
  .category strong { display: inline-block; min-width: 90px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 10px; }
  th, td { border: 1px solid #999; padding: 4px 6px; text-align: left; vertical-align: top; }
  th { background: #f5f5f5; text-transform: uppercase; font-size: 9px; letter-spacing: 0.5px; }
  td.num, th.num { text-align: right; }
  .totals { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .totals .panel strong { font-size: 14px; display: block; margin-top: 2px; }
  .declaration { border: 1px solid #999; padding: 10px; margin-top: 12px; font-size: 10px; line-height: 1.5; }
  .signature { margin-top: 20px; display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; align-items: end; }
  .signature .field { border-top: 1px solid #333; padding-top: 4px; font-size: 9px; text-transform: uppercase; letter-spacing: 0.5px; color: #666; }
  .footnote { margin-top: 18px; font-size: 9px; color: #999; }
  @media print { body { margin: 0; padding: 12mm; } }
</style>
</head>
<body>
  <h1>${formType} <span class="sub">— Customs declaration / Déclaration en douane</span></h1>
  <div class="meta">
    Shipment: ${escapeHtml(shipmentId)}${trackingNumber ? ` · Tracking: ${escapeHtml(trackingNumber)}` : ''} · Date: ${escapeHtml(fmtDate(issuedAt))}
  </div>

  <div class="panels">
    <div class="panel">
      <h3>From / Expéditeur</h3>
      <div class="line">${escapeHtml(issuer.name)}</div>
      <div class="line">${escapeHtml(issuer.address)}</div>
      <div class="line">${escapeHtml(issuer.postalCode)} ${escapeHtml(issuer.city)}</div>
      <div class="line">${escapeHtml(issuer.country)}</div>
      ${issuer.phone ? `<div class="line">Tel: ${escapeHtml(issuer.phone)}</div>` : ''}
      <div class="line">VAT/IVA: ${escapeHtml(issuer.vatNumber)}</div>
    </div>
    <div class="panel">
      <h3>To / Destinataire</h3>
      <div class="line">${escapeHtml(recipient.name)}</div>
      <div class="line">${escapeHtml(recipient.address1)}</div>
      ${recipient.address2 ? `<div class="line">${escapeHtml(recipient.address2)}</div>` : ''}
      <div class="line">${escapeHtml(recipient.postalCode)} ${escapeHtml(recipient.city)}${recipient.state ? ', ' + escapeHtml(recipient.state) : ''}</div>
      <div class="line">${escapeHtml(recipient.country)}</div>
      ${recipient.phone ? `<div class="line">Tel: ${escapeHtml(recipient.phone)}</div>` : ''}
      ${recipient.email ? `<div class="line">${escapeHtml(recipient.email)}</div>` : ''}
    </div>
  </div>

  <div class="category">
    <strong>Category:</strong> ${escapeHtml(cat.en)} / ${escapeHtml(cat.fr)}
  </div>

  <table>
    <thead>
      <tr>
        <th>Description / Désignation</th>
        <th class="num">Qty / Qté</th>
        <th>HS code / Code SH</th>
        <th>Origin / Origine</th>
        <th class="num">Weight / Poids</th>
        <th class="num">Value / Valeur</th>
      </tr>
    </thead>
    <tbody>
${lineRows}
    </tbody>
  </table>

  <div class="totals">
    <div class="panel">
      <h3>Total weight / Poids total</h3>
      <strong>${weightGrams} g (${(weightGrams / 1000).toFixed(2)} kg)</strong>
    </div>
    <div class="panel">
      <h3>Total value / Valeur totale</h3>
      <strong>${totalValueEur.toFixed(2)} ${escapeHtml(currency)}</strong>
    </div>
  </div>

  <div class="declaration">
    <strong>Declaration / Déclaration:</strong>
    I, the undersigned, whose name and address are given on the item, certify that the particulars given in this declaration are correct and that this item does not contain any dangerous article or articles prohibited by legislation or by postal or customs regulations.<br />
    <br />
    Je, soussigné, dont le nom et l'adresse figurent sur l'envoi, certifie que les renseignements donnés dans cette déclaration sont exacts et que cet envoi ne contient aucun objet dangereux ou interdit par la législation ou par la réglementation postale ou douanière.
  </div>

  <div class="signature">
    <div class="field">Date</div>
    <div class="field">Signature</div>
    <div class="field">Place / Lieu</div>
  </div>

  <div class="footnote">
    ${formType === 'CN22'
      ? 'CN22 — for postal items with value &lt; SDR 300 (~€350) AND total weight ≤ 2 kg.'
      : 'CN23 — for postal items with value ≥ SDR 300 OR total weight &gt; 2 kg. Affix together with the address label.'}
  </div>

  <script>
    if (window.location.hash !== '#noprint') {
      window.addEventListener('load', () => setTimeout(() => window.print(), 250))
    }
  </script>
</body>
</html>`
}
