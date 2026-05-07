/**
 * O.30 — Customer-facing email notifications.
 *
 * Sends transactional emails (shipped / delivered / exception) for
 * direct-channel orders (Shopify, Woo). Marketplace channels (Amazon,
 * eBay) keep using the marketplace's own emails — sending duplicates
 * would degrade the customer experience.
 *
 * Provider: Resend by default (modern, simple HTTP API). The shape is
 * generic enough that swapping to Postmark / SES later is a single-
 * function rewrite.
 *
 * Env knobs (matching the rest of Wave 7+):
 *   NEXUS_ENABLE_OUTBOUND_EMAILS=true|false   default 'false'
 *   NEXUS_EMAIL_PROVIDER=resend|smtp          default 'resend'
 *   RESEND_API_KEY                             when provider=resend
 *   NEXUS_EMAIL_FROM=Xavia <ship@xavia.it>    sender address
 *   NEXUS_BRANDED_TRACKING_BASE_URL            link template
 *
 * dryRun (default): console.logs the email + returns success without
 * any HTTP. The retry job (O.12) and Sendcloud webhook (O.7) can
 * fire emails freely while operator sets up Resend.
 *
 * Templates are inline + minimal. Future commit can extract to a
 * proper template system (MJML, react-email) when there's enough
 * variation to justify it. For v0, three plain-but-branded HTML
 * templates cover the common cases.
 */

import { resolveTrackingUrl } from '../carriers.service.js'

export type EmailKind = 'shipped' | 'delivered' | 'exception'

export interface ShipmentEmailContext {
  to: string
  customerName: string
  orderId: string
  orderChannelId: string
  trackingNumber: string | null
  trackingUrl: string | null
  carrier: string
  estimatedDelivery: string | null
  destinationCity: string | null
  /** App-side branded tracking URL (with /track/[number] route). */
  brandedTrackingUrl: string | null
  /** Locale: 'it' | 'en'. Defaults to 'it' (Xavia is IT-first). */
  locale?: 'it' | 'en'
}

export interface SendResult {
  ok: boolean
  provider: 'resend' | 'smtp' | 'mock'
  messageId?: string
  error?: string
  dryRun: boolean
}

export class EmailError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly response?: unknown,
  ) {
    super(message)
    this.name = 'EmailError'
  }
}

function isReal(): boolean {
  return process.env.NEXUS_ENABLE_OUTBOUND_EMAILS === 'true'
}

/**
 * Render the email subject + HTML body for a given kind + context.
 * Italian first; English fallback. Plain HTML, inline styles since
 * many email clients still don't load external stylesheets.
 */
function render(
  kind: EmailKind,
  ctx: ShipmentEmailContext,
): { subject: string; html: string; text: string } {
  const it = (ctx.locale ?? 'it') === 'it'
  const trackUrl =
    ctx.brandedTrackingUrl
    ?? ctx.trackingUrl
    ?? (ctx.trackingNumber ? resolveTrackingUrl(ctx.carrier, ctx.trackingNumber) : null)

  const greet = it ? `Ciao ${ctx.customerName || 'cliente'},` : `Hi ${ctx.customerName || 'there'},`

  const subject = it
    ? kind === 'shipped'
      ? `Il tuo ordine Xavia è in viaggio · ${ctx.orderChannelId}`
      : kind === 'delivered'
      ? `Il tuo ordine Xavia è stato consegnato · ${ctx.orderChannelId}`
      : `Aggiornamento sulla consegna del tuo ordine · ${ctx.orderChannelId}`
    : kind === 'shipped'
    ? `Your Xavia order is on its way · ${ctx.orderChannelId}`
    : kind === 'delivered'
    ? `Your Xavia order has been delivered · ${ctx.orderChannelId}`
    : `Update on your Xavia order delivery · ${ctx.orderChannelId}`

  const body = it
    ? kind === 'shipped'
      ? `Buone notizie — il tuo ordine è stato spedito${ctx.destinationCity ? ` verso ${ctx.destinationCity}` : ''} con ${ctx.carrier}.`
      : kind === 'delivered'
      ? `Il tuo ordine è stato consegnato${ctx.destinationCity ? ` a ${ctx.destinationCity}` : ''}. Speriamo ti piaccia!`
      : `Stiamo verificando un'anomalia con la consegna del tuo ordine. Ti aggiorneremo a breve.`
    : kind === 'shipped'
    ? `Good news — your order is on its way${ctx.destinationCity ? ` to ${ctx.destinationCity}` : ''} with ${ctx.carrier}.`
    : kind === 'delivered'
    ? `Your order has arrived${ctx.destinationCity ? ` at ${ctx.destinationCity}` : ''}. We hope you love it!`
    : `We're investigating a delivery exception on your order and will update you shortly.`

  const cta = trackUrl
    ? it
      ? `<a href="${trackUrl}" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-family:Inter,-apple-system,sans-serif;">Traccia il tuo pacco</a>`
      : `<a href="${trackUrl}" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-family:Inter,-apple-system,sans-serif;">Track your package</a>`
    : ''

  const eta =
    ctx.estimatedDelivery && kind === 'shipped'
      ? it
        ? `<p style="font-size:14px;color:#475569;">Consegna stimata: ${new Date(ctx.estimatedDelivery).toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' })}</p>`
        : `<p style="font-size:14px;color:#475569;">Estimated delivery: ${new Date(ctx.estimatedDelivery).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}</p>`
      : ''

  const tracking = ctx.trackingNumber
    ? `<p style="font-size:13px;color:#64748b;font-family:monospace;">${ctx.carrier} · ${ctx.trackingNumber}</p>`
    : ''

  const unsubFooter = it
    ? `<p style="font-size:11px;color:#94a3b8;margin-top:24px;">Questa email è stata inviata per il tuo ordine ${ctx.orderChannelId}. Per dubbi, scrivi a <a href="mailto:support@xavia.it" style="color:#2563eb;">support@xavia.it</a>.</p>`
    : `<p style="font-size:11px;color:#94a3b8;margin-top:24px;">This email was sent for your order ${ctx.orderChannelId}. Questions? Reach us at <a href="mailto:support@xavia.it" style="color:#2563eb;">support@xavia.it</a>.</p>`

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f8fafc;">
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f8fafc;padding:32px 16px;">
  <tr><td align="center">
    <table cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;background:#fff;border-radius:8px;border:1px solid #e2e8f0;padding:32px;font-family:Inter,-apple-system,sans-serif;color:#0f172a;">
      <tr><td>
        <div style="font-size:22px;font-weight:700;color:#0f172a;margin-bottom:24px;">Xavia</div>
        <p style="font-size:16px;margin:0 0 12px 0;">${greet}</p>
        <p style="font-size:16px;margin:0 0 20px 0;">${body}</p>
        ${eta}
        ${tracking}
        <div style="margin:24px 0;">${cta}</div>
        ${unsubFooter}
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`

  const text = `${greet}\n\n${body}\n\n${ctx.trackingNumber ? `${ctx.carrier} · ${ctx.trackingNumber}\n` : ''}${trackUrl ? `${trackUrl}\n\n` : ''}— Xavia`

  return { subject, html, text }
}

/**
 * Send a shipment-related email. dryRun mode returns success and
 * logs to console; real mode hits Resend's API.
 */
export async function sendShipmentEmail(
  kind: EmailKind,
  ctx: ShipmentEmailContext,
): Promise<SendResult> {
  const { subject, html, text } = render(kind, ctx)
  const from = process.env.NEXUS_EMAIL_FROM ?? 'Xavia <ship@xavia.it>'

  if (!isReal()) {
    // eslint-disable-next-line no-console
    console.log(`[email:dry-run] ${kind} → ${ctx.to} | "${subject}"`)
    return { ok: true, provider: 'mock', dryRun: true, messageId: `mock-${Date.now()}` }
  }

  const provider = (process.env.NEXUS_EMAIL_PROVIDER ?? 'resend') as 'resend' | 'smtp'
  if (provider !== 'resend') {
    return {
      ok: false,
      provider,
      dryRun: false,
      error: `Provider "${provider}" not supported in v0. Set NEXUS_EMAIL_PROVIDER=resend.`,
    }
  }

  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) {
    return {
      ok: false,
      provider: 'resend',
      dryRun: false,
      error: 'RESEND_API_KEY not set',
    }
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [ctx.to],
      subject,
      html,
      text,
    }),
  })
  const body: any = await res.json().catch(() => null)
  if (!res.ok) {
    return {
      ok: false,
      provider: 'resend',
      dryRun: false,
      error: body?.message ?? `HTTP ${res.status}`,
    }
  }
  return {
    ok: true,
    provider: 'resend',
    dryRun: false,
    messageId: body?.id,
  }
}

export const __test = { isReal, render }
