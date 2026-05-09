/**
 * DO.40 — Command Center digest email.
 *
 * Renders a compact HTML summary of the dashboard's headline
 * numbers + alerts + top SKUs and dispatches it via the shared
 * email transport. Pure HTML + inline CSS — no recharts SVG, no
 * external assets — because email clients (Gmail, Outlook,
 * Apple Mail) are notoriously inconsistent about external
 * resources and we want the digest to render the same in every
 * inbox.
 *
 * Italian-first localisation (Xavia is IT-first per the project
 * memory). English fallback for stakeholders who prefer it.
 *
 * Computation: re-uses the same window arithmetic as
 * /api/dashboard/overview so the digest matches what the
 * operator would see if they opened the dashboard. Window for
 * the digest is hardcoded:
 *
 *   daily   → yesterday (UTC midnight - 1d, zoned Europe/Rome)
 *   weekly  → last 7 days
 *   monthly → last 30 days
 */

import prisma from '../db.js'
import { sendEmail, type SendResult } from './email/transport.js'

const OPERATOR_TIMEZONE = 'Europe/Rome'

export type DigestFrequency = 'daily' | 'weekly' | 'monthly'

interface DigestData {
  windowLabel: string
  rangeFrom: Date
  rangeTo: Date
  primaryCurrency: string
  revenue: number
  orders: number
  aov: number
  units: number
  pendingShipments: number
  lateShipments: number
  outOfStock: number
  failedListings: number
  byChannel: Array<{ channel: string; revenue: number; orders: number }>
  topSkus: Array<{ sku: string; units: number; revenue: number }>
}

function zonedMidnight(y: number, m: number, d: number, tz: string): Date {
  const probe = new Date(Date.UTC(y, m, d, 12, 0, 0))
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(probe)
  const get = (t: string) =>
    Number(parts.find((p) => p.type === t)?.value ?? '0')
  const observedLocal = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') === 24 ? 0 : get('hour'),
    get('minute'),
  )
  const offsetMs = observedLocal - probe.getTime()
  return new Date(Date.UTC(y, m, d, 0, 0, 0) - offsetMs)
}

function digestRange(
  frequency: DigestFrequency,
  now: Date,
): { from: Date; to: Date; label: string } {
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone: OPERATOR_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
  const [y, m, d] = ymd.split('-').map(Number)
  const todayStart = zonedMidnight(y, m - 1, d, OPERATOR_TIMEZONE)
  if (frequency === 'daily') {
    const yesterdayStart = new Date(
      todayStart.getTime() - 24 * 60 * 60 * 1000,
    )
    return { from: yesterdayStart, to: todayStart, label: 'Yesterday' }
  }
  if (frequency === 'weekly') {
    const from = new Date(todayStart.getTime() - 7 * 24 * 60 * 60 * 1000)
    return { from, to: todayStart, label: 'Last 7 days' }
  }
  // monthly
  const from = new Date(todayStart.getTime() - 30 * 24 * 60 * 60 * 1000)
  return { from, to: todayStart, label: 'Last 30 days' }
}

export async function buildDigestData(
  frequency: DigestFrequency,
  now = new Date(),
): Promise<DigestData> {
  const { from, to, label } = digestRange(frequency, now)

  // Pick primary currency from the window's order mix; fall back to
  // EUR. Mirrors DO.1's logic in dashboard.routes.ts.
  const orderRows = await prisma.order.findMany({
    where: { createdAt: { gte: from, lte: to } },
    select: { totalPrice: true, currencyCode: true, channel: true },
  })
  const byCurrency = new Map<string, number>()
  for (const o of orderRows) {
    const c = (o.currencyCode ?? 'EUR') || 'EUR'
    byCurrency.set(
      c,
      (byCurrency.get(c) ?? 0) + Number((o.totalPrice as unknown as number) || 0),
    )
  }
  let primary = 'EUR'
  let top = -1
  for (const [c, v] of byCurrency.entries()) {
    if (v > top) {
      top = v
      primary = c
    }
  }

  const inPrimary = orderRows.filter(
    (o) => (o.currencyCode ?? 'EUR') === primary,
  )
  const revenue = inPrimary.reduce(
    (s, r) => s + Number((r.totalPrice as unknown as number) || 0),
    0,
  )
  const orders = inPrimary.length
  const aov = orders > 0 ? revenue / orders : 0

  const channelMap = new Map<string, { revenue: number; orders: number }>()
  for (const o of inPrimary) {
    const ch = String(o.channel)
    const slot = channelMap.get(ch) ?? { revenue: 0, orders: 0 }
    slot.revenue += Number((o.totalPrice as unknown as number) || 0)
    slot.orders += 1
    channelMap.set(ch, slot)
  }
  const byChannel = Array.from(channelMap.entries())
    .map(([channel, v]) => ({ channel, ...v }))
    .sort((a, b) => b.revenue - a.revenue)

  const [
    unitsRow,
    pendingShipments,
    lateShipments,
    outOfStock,
    failedListings,
    topSkuRows,
  ] = await Promise.all([
    prisma.$queryRawUnsafe(
      `SELECT COALESCE(SUM(oi.quantity), 0)::bigint AS u
       FROM "OrderItem" oi
       JOIN "Order" o ON o.id = oi."orderId"
       WHERE o."createdAt" >= $1 AND o."createdAt" <= $2
         AND COALESCE(o."currencyCode", 'EUR') = $3`,
      from,
      to,
      primary,
    )
      .then((r) => Number((r as Array<{ u: bigint }>)[0]?.u ?? 0n))
      .catch(() => 0),
    prisma.order
      .count({ where: { status: { in: ['PENDING', 'PROCESSING'] } } })
      .catch(() => 0),
    prisma.order
      .count({
        where: {
          status: { in: ['PENDING', 'PROCESSING'] },
          shipByDate: { lt: to, not: null },
        },
      })
      .catch(() => 0),
    prisma.product.count({ where: { totalStock: { lte: 0 } } }).catch(() => 0),
    prisma.channelListing
      .count({ where: { listingStatus: 'ERROR' } })
      .catch(() => 0),
    prisma.$queryRawUnsafe(
      `SELECT oi.sku AS sku,
              COALESCE(SUM(oi.quantity), 0)::bigint AS units,
              COALESCE(SUM(oi.price * oi.quantity), 0)::float AS revenue
       FROM "OrderItem" oi
       JOIN "Order" o ON o.id = oi."orderId"
       WHERE o."createdAt" >= $1 AND o."createdAt" <= $2
         AND COALESCE(o."currencyCode", 'EUR') = $3
       GROUP BY oi.sku
       ORDER BY revenue DESC
       LIMIT 5`,
      from,
      to,
      primary,
    )
      .then(
        (r) =>
          r as Array<{
            sku: string
            units: bigint
            revenue: number
          }>,
      )
      .catch(
        () =>
          [] as Array<{
            sku: string
            units: bigint
            revenue: number
          }>,
      ),
  ])

  return {
    windowLabel: label,
    rangeFrom: from,
    rangeTo: to,
    primaryCurrency: primary,
    revenue,
    orders,
    aov,
    units: unitsRow,
    pendingShipments,
    lateShipments,
    outOfStock,
    failedListings,
    byChannel,
    topSkus: topSkuRows.map((r) => ({
      sku: r.sku,
      units: Number(r.units),
      revenue: r.revenue,
    })),
  }
}

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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

interface RenderedDigest {
  subject: string
  html: string
  text: string
}

export function renderDigest(
  data: DigestData,
  frequency: DigestFrequency,
): RenderedDigest {
  // Italian-first headline; English fallback in subject only so
  // inbox preview reads cleanly for stakeholders not on IT.
  const headline = `Nexus · ${data.windowLabel}`
  const subject = `${headline} — ${fmtCurrency(data.revenue, data.primaryCurrency)} · ${fmtNumber(data.orders)} ordini`

  const tableStyle = `
    border-collapse:collapse;
    width:100%;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    font-size:14px;
  `
  const thStyle = `
    padding:6px 10px;
    text-align:left;
    border-bottom:1px solid #e2e8f0;
    color:#64748b;
    font-weight:600;
    font-size:11px;
    text-transform:uppercase;
    letter-spacing:0.05em;
  `
  const tdStyle = `padding:8px 10px;border-bottom:1px solid #f1f5f9;`

  const channelRows = data.byChannel
    .map(
      (c) => `
    <tr>
      <td style="${tdStyle}">${escapeHtml(CHANNEL_LABEL[c.channel] ?? c.channel)}</td>
      <td style="${tdStyle}text-align:right;font-variant-numeric:tabular-nums;">
        ${fmtCurrency(c.revenue, data.primaryCurrency)}
      </td>
      <td style="${tdStyle}text-align:right;font-variant-numeric:tabular-nums;color:#64748b;">
        ${fmtNumber(c.orders)} ordini
      </td>
    </tr>
  `,
    )
    .join('')

  const topSkuRows = data.topSkus
    .map(
      (s) => `
    <tr>
      <td style="${tdStyle}font-family:ui-monospace,'SF Mono',monospace;font-size:13px;">${escapeHtml(s.sku)}</td>
      <td style="${tdStyle}text-align:right;font-variant-numeric:tabular-nums;color:#64748b;">${fmtNumber(s.units)} un.</td>
      <td style="${tdStyle}text-align:right;font-variant-numeric:tabular-nums;font-weight:600;">${fmtCurrency(s.revenue, data.primaryCurrency)}</td>
    </tr>
  `,
    )
    .join('')

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

  const alertsBlock =
    alerts.length === 0
      ? `<p style="color:#10b981;font-weight:600;">✓ Nessun avviso operativo.</p>`
      : `
        <table style="${tableStyle}">
          ${alerts
            .map(
              (a) => `
            <tr>
              <td style="${tdStyle}font-weight:600;color:${a.tone === 'rose' ? '#b91c1c' : '#b45309'};">
                ${escapeHtml(a.label)}
              </td>
              <td style="${tdStyle}text-align:right;font-variant-numeric:tabular-nums;font-weight:700;">
                ${fmtNumber(a.count)}
              </td>
            </tr>
          `,
            )
            .join('')}
        </table>
      `

  const html = `
    <!DOCTYPE html>
    <html lang="it">
    <head>
      <meta charset="utf-8" />
      <title>${escapeHtml(subject)}</title>
    </head>
    <body style="margin:0;padding:24px;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#0f172a;">
      <div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
        <div style="padding:20px 24px;border-bottom:1px solid #e2e8f0;">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#64748b;font-weight:600;">
            Nexus Command Center
          </div>
          <h1 style="margin:4px 0 0 0;font-size:20px;font-weight:700;">${escapeHtml(headline)}</h1>
        </div>
        <div style="padding:20px 24px;">
          <div style="display:flex;flex-wrap:wrap;gap:12px;margin-bottom:16px;">
            <div style="flex:1 1 140px;">
              <div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;">Fatturato</div>
              <div style="font-size:22px;font-weight:700;font-variant-numeric:tabular-nums;">${fmtCurrency(data.revenue, data.primaryCurrency)}</div>
            </div>
            <div style="flex:1 1 140px;">
              <div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;">Ordini</div>
              <div style="font-size:22px;font-weight:700;font-variant-numeric:tabular-nums;">${fmtNumber(data.orders)}</div>
            </div>
            <div style="flex:1 1 140px;">
              <div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;">VMO</div>
              <div style="font-size:22px;font-weight:700;font-variant-numeric:tabular-nums;">${fmtCurrency(data.aov, data.primaryCurrency)}</div>
            </div>
            <div style="flex:1 1 140px;">
              <div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;">Unità</div>
              <div style="font-size:22px;font-weight:700;font-variant-numeric:tabular-nums;">${fmtNumber(data.units)}</div>
            </div>
          </div>

          <h2 style="margin:24px 0 8px 0;font-size:13px;text-transform:uppercase;letter-spacing:0.05em;color:#64748b;">Avvisi operativi</h2>
          ${alertsBlock}

          ${data.byChannel.length > 0 ? `
          <h2 style="margin:24px 0 8px 0;font-size:13px;text-transform:uppercase;letter-spacing:0.05em;color:#64748b;">Per canale</h2>
          <table style="${tableStyle}">${channelRows}</table>
          ` : ''}

          ${data.topSkus.length > 0 ? `
          <h2 style="margin:24px 0 8px 0;font-size:13px;text-transform:uppercase;letter-spacing:0.05em;color:#64748b;">Top SKU per fatturato</h2>
          <table style="${tableStyle}">${topSkuRows}</table>
          ` : ''}
        </div>
        <div style="padding:16px 24px;background:#f8fafc;border-top:1px solid #e2e8f0;font-size:12px;color:#64748b;">
          Digest ${frequency} · ${data.rangeFrom.toLocaleDateString('it-IT')} → ${data.rangeTo.toLocaleDateString('it-IT')}.
        </div>
      </div>
    </body>
    </html>
  `

  // Plain-text alternative (for clients that strip HTML).
  const text = [
    headline,
    '',
    `Fatturato: ${fmtCurrency(data.revenue, data.primaryCurrency)}`,
    `Ordini: ${fmtNumber(data.orders)}`,
    `VMO: ${fmtCurrency(data.aov, data.primaryCurrency)}`,
    `Unità: ${fmtNumber(data.units)}`,
    '',
    'Avvisi:',
    ...(alerts.length === 0
      ? ['  Nessun avviso operativo.']
      : alerts.map((a) => `  ${a.label}: ${fmtNumber(a.count)}`)),
    '',
    'Per canale:',
    ...data.byChannel.map(
      (c) =>
        `  ${CHANNEL_LABEL[c.channel] ?? c.channel}: ${fmtCurrency(c.revenue, data.primaryCurrency)} (${fmtNumber(c.orders)} ordini)`,
    ),
    '',
    'Top SKU:',
    ...data.topSkus.map(
      (s) =>
        `  ${s.sku}: ${fmtCurrency(s.revenue, data.primaryCurrency)} (${fmtNumber(s.units)} un.)`,
    ),
  ].join('\n')

  return { subject, html, text }
}

/**
 * Build the digest payload for the given frequency and dispatch
 * an email to `recipients`. Returns the transport SendResult so
 * the cron can log + record lastSentAt only on success.
 */
export async function sendDigest(opts: {
  recipients: string | string[]
  frequency: DigestFrequency
  now?: Date
}): Promise<SendResult> {
  const data = await buildDigestData(opts.frequency, opts.now)
  const rendered = renderDigest(data, opts.frequency)
  return sendEmail({
    to: opts.recipients,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    tag: `dashboard-digest-${opts.frequency}`,
  })
}

export const __test = { buildDigestData, renderDigest, digestRange }
