/**
 * R6.3 — return-event customer emails.
 *
 * Three transactional templates trigger from drawer/cron actions:
 *
 *   received  — package landed at warehouse; "we've got it, we'll
 *               inspect within 48h, you'll see your refund within
 *               14 days of receipt".
 *
 *   refunded  — refund posted; channel-specific note (Stripe vs
 *               Amazon vs eBay) on settlement timing.
 *
 *   rejected  — return denied (outside policy window, condition
 *               failed inspection, etc.); operator-supplied reason.
 *
 * Italian first (Xavia is IT-first; Italian consumer law makes
 * Italian the safe default for compliance copy). English fallback
 * for non-IT customers.
 *
 * Templates live here. Provider HTTP + dryRun gate live in
 * `services/email/transport.ts` (TECH_DEBT #51 consolidation,
 * 2026-05-08).
 */

import { sendEmail, type SendResult } from '../email/transport.js'
import { resolveBusinessIdentity, type BusinessIdentity } from '../business-identity.service.js'

// RX.7 — comms journey. authorized + label_ready extend the existing
// received / refunded / rejected stages so the buyer is kept informed
// across the whole return lifecycle.
export type ReturnEmailKind = 'received' | 'refunded' | 'rejected' | 'authorized' | 'label_ready'

export interface ReturnEmailContext {
  to: string
  customerName: string | null
  rmaNumber: string | null
  channelOrderId: string | null
  channel: string
  refundCents: number | null
  currencyCode: string
  /** Operator-supplied reason — required for 'rejected', optional otherwise. */
  reason?: string | null
  /** Refund deadline in days from receipt (renders "you'll see it
   *  within 14 days of receipt" copy). */
  refundDeadlineDays: number
  /** Locale: 'it' (default) | 'en'. */
  locale?: 'it' | 'en'
}

export interface ReturnEmailRendered {
  subject: string
  html: string
  text: string
}

const escapeHtml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** O3 — rendered as `identity`, the business the return belongs to (Xavia's copy is unchanged). */
export function renderReturnEmail(
  kind: ReturnEmailKind,
  ctx: ReturnEmailContext,
  identity: BusinessIdentity,
): ReturnEmailRendered {
  const it = (ctx.locale ?? 'it') === 'it'
  const brandName = identity.brandName
  const brand = escapeHtml(identity.brandName)
  const support = escapeHtml(identity.supportEmail)
  const greet = it
    ? `Ciao ${ctx.customerName?.trim() || 'cliente'},`
    : `Hi ${ctx.customerName?.trim() || 'there'},`

  const rmaSuffix = ctx.rmaNumber ? ` · ${ctx.rmaNumber}` : ''
  const refundEur =
    ctx.refundCents != null
      ? `€${(ctx.refundCents / 100).toFixed(2)}`
      : null

  let subject = ''
  let body = ''

  if (kind === 'authorized') {
    subject = it
      ? `Reso approvato · ${brandName}${rmaSuffix}`
      : `Return approved · ${brandName}${rmaSuffix}`
    body = it
      ? `Il tuo reso è stato approvato. Spedisci l'articolo al nostro magazzino il prima possibile. Una volta ricevuto, lo controlleremo e procederemo al rimborso entro ${ctx.refundDeadlineDays} giorni.`
      : `Your return has been approved. Please ship the item back to our warehouse as soon as you can. Once it arrives we'll inspect it and process your refund within ${ctx.refundDeadlineDays} days.`
  } else if (kind === 'label_ready') {
    subject = it
      ? `Etichetta di reso pronta · ${brandName}${rmaSuffix}`
      : `Return label ready · ${brandName}${rmaSuffix}`
    body = it
      ? `La tua etichetta di reso è pronta. Applicala al pacco e consegnalo al corriere. Ti aggiorneremo non appena il pacco arriva al nostro magazzino.`
      : `Your return label is ready. Attach it to the parcel and drop it off with the carrier. We'll let you know as soon as it reaches our warehouse.`
  } else if (kind === 'received') {
    subject = it
      ? `Reso ricevuto · ${brandName}${rmaSuffix}`
      : `Return received · ${brandName}${rmaSuffix}`
    body = it
      ? `Abbiamo ricevuto il tuo reso al nostro magazzino. Il nostro team lo controllerà entro 48 ore. Vedrai il rimborso accreditato entro ${ctx.refundDeadlineDays} giorni dalla ricezione.`
      : `We've received your return at our warehouse. Our team will inspect it within 48 hours. You'll see your refund credited within ${ctx.refundDeadlineDays} days of receipt.`
  } else if (kind === 'refunded') {
    subject = it
      ? `Rimborso emesso · ${brandName}${rmaSuffix}`
      : `Refund issued · ${brandName}${rmaSuffix}`
    const channelNote = it
      ? ctx.channel === 'AMAZON'
        ? 'Il rimborso comparirà sul tuo metodo di pagamento Amazon entro 5 giorni lavorativi.'
        : ctx.channel === 'EBAY'
          ? 'Il rimborso comparirà sul tuo metodo di pagamento eBay/PayPal entro 3 giorni lavorativi.'
          : 'Il rimborso comparirà sul tuo metodo di pagamento originale entro 5 giorni lavorativi.'
      : ctx.channel === 'AMAZON'
        ? 'The refund will appear on your Amazon payment method within 5 business days.'
        : ctx.channel === 'EBAY'
          ? 'The refund will appear on your eBay/PayPal payment method within 3 business days.'
          : 'The refund will appear on your original payment method within 5 business days.'
    const amount = refundEur
      ? it
        ? ` di ${refundEur}`
        : ` of ${refundEur}`
      : ''
    body = it
      ? `Abbiamo emesso il tuo rimborso${amount}. ${channelNote}`
      : `We've issued your refund${amount}. ${channelNote}`
  } else {
    // rejected
    subject = it
      ? `Reso non accettato · ${brandName}${rmaSuffix}`
      : `Return not accepted · ${brandName}${rmaSuffix}`
    const reasonLine = ctx.reason
      ? it
        ? ` Motivo: ${ctx.reason}.`
        : ` Reason: ${ctx.reason}.`
      : ''
    body = it
      ? `Dopo aver esaminato il tuo reso, non siamo in grado di accettarlo.${reasonLine} Ti contatteremo entro 24 ore per spiegare i prossimi passi e organizzare il reinvio dell'articolo.`
      : `After reviewing your return, we're unable to accept it.${reasonLine} We'll be in touch within 24 hours to explain next steps and arrange the return of your item.`
  }

  const orderLine = ctx.channelOrderId
    ? it
      ? `<p style="font-size:13px;color:#64748b;font-family:monospace;">Ordine ${ctx.channel} · ${ctx.channelOrderId}</p>`
      : `<p style="font-size:13px;color:#64748b;font-family:monospace;">${ctx.channel} order · ${ctx.channelOrderId}</p>`
    : ''

  const footer = it
    ? `<p style="font-size:11px;color:#94a3b8;margin-top:24px;">Email inviata per il tuo reso${rmaSuffix ? ` ${ctx.rmaNumber}` : ''}. Per dubbi: <a href="mailto:${support}" style="color:#2563eb;">${support}</a>.</p>`
    : `<p style="font-size:11px;color:#94a3b8;margin-top:24px;">Email sent for your return${rmaSuffix ? ` ${ctx.rmaNumber}` : ''}. Questions? <a href="mailto:${support}" style="color:#2563eb;">${support}</a>.</p>`

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f8fafc;">
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f8fafc;padding:32px 16px;">
  <tr><td align="center">
    <table cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;background:#fff;border-radius:8px;border:1px solid #e2e8f0;padding:32px;font-family:Inter,-apple-system,sans-serif;color:#0f172a;">
      <tr><td>
        <div style="font-size:22px;font-weight:700;color:#0f172a;margin-bottom:24px;">${brand}</div>
        <p style="font-size:16px;margin:0 0 12px 0;">${greet}</p>
        <p style="font-size:16px;margin:0 0 20px 0;">${body}</p>
        ${orderLine}
        ${footer}
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`

  const text = `${greet}\n\n${body}\n\n${ctx.channelOrderId ? `${ctx.channel} · ${ctx.channelOrderId}\n` : ''}${ctx.rmaNumber ? `RMA: ${ctx.rmaNumber}\n` : ''}— ${brandName}`

  return { subject, html, text }
}

export type { SendResult as ReturnEmailSendResult } from '../email/transport.js'

/**
 * Send a return-event email. Delegates to the shared `sendEmail()`
 * transport — dryRun (default) returns success without HTTP, real
 * mode hits Resend.
 */
export async function sendReturnEmail(
  kind: ReturnEmailKind,
  ctx: ReturnEmailContext,
): Promise<SendResult> {
  // O3 — sent as the business the return belongs to; refused (nothing sent) when it has no identity for buyers.
  const found = await resolveBusinessIdentity()
  if (found.ok === false) return { ok: false, provider: 'mock', dryRun: false, error: found.reason }
  const { subject, html, text } = renderReturnEmail(kind, ctx, found.identity)
  return sendEmail({
    to: ctx.to,
    subject,
    html,
    text,
    tag: `return-${kind}`,
    ...(found.identity.emailFrom ? { from: found.identity.emailFrom } : {}),
  })
}

/** Exposed for unit tests. */
export const __test = { renderReturnEmail }
