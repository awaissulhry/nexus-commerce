/**
 * FU.5 — Italian B2C corrispettivi telematici (telematic receipts).
 *
 * Italian B2C sales don't use FatturaPA — that's B2B-only. B2C
 * sales must instead be submitted as corrispettivi telematici to
 * Agenzia delle Entrate, transmitted via a Registratore Telematico
 * (RT, electronic cash register, can be virtual for online sales).
 *
 * The submission is a DAILY summary, not per-transaction:
 *   - Aggregate all B2C sales for a given date
 *   - Group by VAT rate (22% / 10% / 4% / 0% with Natura)
 *   - Emit imponibile + imposta per group
 *   - Submit to RT before 12 days after sale date (legal window)
 *
 * Why XAVIA needs this even on Amazon:
 *   - Amazon handles VAT/MOSS on cross-EU B2C ("marketplace
 *     facilitator regime") so Amazon orders are out-of-scope
 *   - Shopify direct B2C IS Xavia's responsibility — Shopify
 *     isn't a marketplace facilitator under Italian law for IT
 *     domestic sales
 *   - eBay similar — facilitator for cross-EU but not domestic IT
 *
 * Scope of this commit:
 *   ✓ Aggregate B2C orders by date + VAT rate
 *   ✓ Generate the daily summary as XML (simplified tracciato;
 *     real Agenzia delle Entrate format requires RT vendor's
 *     specific schema variant — sandbox-test against the
 *     operator's chosen RT before flipping to production)
 *   ✓ Env-flag-gated dispatch stub
 *   ✓ Endpoint to download for manual upload to RT
 *
 * Out of scope (follow-up):
 *   - Real RT vendor integration (XML format varies per vendor —
 *     Custom, Olivetti, RCH, etc. all expose subtly different
 *     schemas; commercial integration is its own engagement)
 *   - Inbound ack handling (RT issues a "ricevuta" which Nexus
 *     should record on FiscalCorrispettivo.providerAckId)
 *   - Daily auto-dispatch cron (today operator triggers manually)
 *   - Closure-of-day (chiusura) workflow when RT requires explicit
 *     end-of-day stamping
 */

import prisma from '../db.js'
import { logger } from '../utils/logger.js'

const ENABLED = process.env.NEXUS_ENABLE_CORRISPETTIVI_DISPATCH === 'true'

export interface CorrispettiviDailyResult {
  date: string // YYYY-MM-DD
  xml: string
  filename: string
  orderCount: number
  byRate: Array<{ rate: number; imponibile: number; imposta: number }>
  totalImponibile: number
  totalImposta: number
  grandTotal: number
}

function fmtDecimal(n: number): string {
  return n.toFixed(2)
}

function escapeXml(s: unknown): string {
  if (s == null) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

const ISSUER = {
  vatNumber: process.env.NEXUS_ISSUER_VAT ?? 'IT00000000000',
  fiscalCode: process.env.NEXUS_ISSUER_CF ?? '00000000000',
  // RT identifier (matricola) — assigned by Agenzia delle Entrate
  // when the operator registers their virtual RT. NULL until the
  // operator wires it up via env.
  rtMatricola: process.env.NEXUS_RT_MATRICOLA ?? '',
}

/**
 * Aggregate B2C orders for a given date + emit the daily summary.
 *
 * Eligibility:
 *   - Order.fiscalKind === 'B2C'  OR  Order.marketplace === 'IT'
 *     AND Order.fiscalKind is NULL (B2C is the default for unmarked
 *     IT consumer orders — operators can flip individual orders
 *     to B2B via the customer-detail form to exclude)
 *   - Order.purchaseDate (or createdAt fallback) within the day
 *   - Order.status NOT IN [CANCELLED, REFUNDED]
 *   - Marketplace facilitator orders (Amazon all marketplaces, eBay
 *     cross-EU) are EXCLUDED — those are reported by the platform
 *     under the marketplace facilitator regime
 */
export async function generateCorrispettiviDaily(
  date: string, // YYYY-MM-DD
): Promise<CorrispettiviDailyResult> {
  const dayStart = new Date(`${date}T00:00:00Z`)
  const dayEnd = new Date(`${date}T23:59:59.999Z`)

  // Channels Xavia is responsible for direct VAT settlement on:
  //   SHOPIFY (always; not a facilitator under IT law for domestic)
  //   MANUAL  (offline sales operator entered)
  // Excluded:
  //   AMAZON  (marketplace facilitator regime)
  //   EBAY    (facilitator for cross-EU; we conservatively exclude
  //            all eBay since the per-marketplace gate isn't set on
  //            Order rows yet — operators can include manually)
  const RESPONSIBLE_CHANNELS = ['SHOPIFY', 'MANUAL'] as const

  const orders = await prisma.order.findMany({
    where: {
      channel: { in: [...RESPONSIBLE_CHANNELS] as any },
      status: { notIn: ['CANCELLED', 'REFUNDED'] },
      OR: [
        { fiscalKind: 'B2C' },
        // IT-marketplace orders without an explicit fiscalKind
        // default to B2C (B2B requires partita IVA which we'd have
        // captured via FU.3, flipping fiscalKind='B2B').
        { marketplace: 'IT', fiscalKind: null },
      ],
    },
    include: { items: true },
  })

  // Filter on day-window via purchaseDate || createdAt at the JS
  // layer (Prisma doesn't easily express "either column").
  const dayOrders = orders.filter((o) => {
    const at = o.purchaseDate ?? o.createdAt
    return at >= dayStart && at <= dayEnd
  })

  // Aggregate by VAT rate.
  const byRateMap = new Map<number, { imponibile: number; imposta: number }>()
  let totalImponibile = 0
  let totalImposta = 0
  for (const o of dayOrders) {
    for (const it of o.items) {
      const gross = Number(it.price) * it.quantity
      const rate = it.itVatRatePct != null ? Number(it.itVatRatePct) : 22
      const net = rate > 0 ? gross / (1 + rate / 100) : gross
      const tax = gross - net
      const cur = byRateMap.get(rate) ?? { imponibile: 0, imposta: 0 }
      cur.imponibile += net
      cur.imposta += tax
      byRateMap.set(rate, cur)
      totalImponibile += net
      totalImposta += tax
    }
  }
  const byRate = [...byRateMap.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([rate, v]) => ({
      rate,
      imponibile: Math.round(v.imponibile * 100) / 100,
      imposta: Math.round(v.imposta * 100) / 100,
    }))
  const grandTotal = totalImponibile + totalImposta

  // XML — simplified tracciato. The real Agenzia delle Entrate
  // format expected by an RT depends on the vendor (Custom /
  // Olivetti / RCH / etc.); this is a reasonable starting shape
  // that captures the same data and survives a JSON-equivalent
  // ingest by most RT software. Sandbox-test against the
  // operator's chosen RT before production submission.
  const filename = `corrispettivi_${ISSUER.vatNumber.replace(/^IT/i, '')}_${date}.xml`
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CorrispettiviGiornalieri xmlns="http://nexus-commerce.example/corrispettivi/v1">
  <Emittente>
    <PartitaIva>${escapeXml(ISSUER.vatNumber.replace(/^IT/i, ''))}</PartitaIva>
    <CodiceFiscale>${escapeXml(ISSUER.fiscalCode)}</CodiceFiscale>
    ${ISSUER.rtMatricola ? `<MatricolaRT>${escapeXml(ISSUER.rtMatricola)}</MatricolaRT>` : ''}
  </Emittente>
  <Riepilogo data="${escapeXml(date)}" numeroOperazioni="${dayOrders.length}">
    ${byRate
      .map(
        (g) => `<TotaleAliquota aliquota="${fmtDecimal(g.rate)}">
      <Imponibile>${fmtDecimal(g.imponibile)}</Imponibile>
      <Imposta>${fmtDecimal(g.imposta)}</Imposta>
    </TotaleAliquota>`,
      )
      .join('\n    ')}
    <TotaleImponibile>${fmtDecimal(totalImponibile)}</TotaleImponibile>
    <TotaleImposta>${fmtDecimal(totalImposta)}</TotaleImposta>
    <TotaleGenerale>${fmtDecimal(grandTotal)}</TotaleGenerale>
  </Riepilogo>
</CorrispettiviGiornalieri>
`

  return {
    date,
    xml,
    filename,
    orderCount: dayOrders.length,
    byRate,
    totalImponibile: Math.round(totalImponibile * 100) / 100,
    totalImposta: Math.round(totalImposta * 100) / 100,
    grandTotal: Math.round(grandTotal * 100) / 100,
  }
}

/**
 * Stub for RT dispatch. Like the F.4 SDI dispatch, real
 * implementation goes through whichever RT vendor the operator
 * is registered with — each has its own auth/format/
 * acknowledgement loop.
 */
export async function dispatchCorrispettiviDaily(date: string): Promise<{
  status: 'PENDING' | 'SENT' | 'NOT_IMPLEMENTED'
  message: string
  orderCount?: number
}> {
  const result = await generateCorrispettiviDaily(date)

  if (!ENABLED) {
    logger.info('corrispettivi: dryRun', {
      date,
      orderCount: result.orderCount,
      grandTotal: result.grandTotal,
    })
    return {
      status: 'PENDING',
      message:
        'dryRun: corrispettivi summary generated locally but not transmitted to RT. Set NEXUS_ENABLE_CORRISPETTIVI_DISPATCH=true and ship the RT-vendor integration to actually submit.',
      orderCount: result.orderCount,
    }
  }

  return {
    status: 'NOT_IMPLEMENTED',
    message:
      'Real RT dispatch not implemented in this commit. Follow-up: pick an RT vendor (Custom / Olivetti / RCH / virtual cloud RT), wire their REST + auth, handle the ricevuta callback. Until then, download the XML and upload manually via the vendor portal.',
  }
}
