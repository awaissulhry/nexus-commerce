/**
 * O.30 — Customer-facing email notifications.
 *
 * Sends transactional emails (shipped / delivered / exception) for
 * direct-channel orders (Shopify, Woo). Marketplace channels (Amazon,
 * eBay) keep using the marketplace's own emails — sending duplicates
 * would degrade the customer experience.
 *
 * Templates live here. Provider HTTP + dryRun gate live in
 * `transport.ts` (TECH_DEBT #51 consolidation, 2026-05-08).
 *
 * Env knobs (read in transport.ts):
 *   NEXUS_ENABLE_OUTBOUND_EMAILS=true|false   default 'false'
 *   RESEND_API_KEY                             when sending real
 *   NEXUS_EMAIL_FROM=Xavia <ship@xavia.it>    sender address
 *   NEXUS_BRANDED_TRACKING_BASE_URL            link template
 */

import { resolveTrackingUrl } from '../carriers.service.js'
import { sendEmail, __test as transportTest } from './transport.js'

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

export type { SendResult } from './transport.js'

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
 * Send a shipment-related email. dryRun (default) returns success
 * without HTTP; real mode delegates to the shared `sendEmail()`
 * transport.
 */
export async function sendShipmentEmail(
  kind: EmailKind,
  ctx: ShipmentEmailContext,
) {
  const { subject, html, text } = render(kind, ctx)
  return sendEmail({
    to: ctx.to,
    subject,
    html,
    text,
    tag: `shipment-${kind}`,
  })
}

export const __test = {
  isReal: transportTest.isReal,
  render,
}
