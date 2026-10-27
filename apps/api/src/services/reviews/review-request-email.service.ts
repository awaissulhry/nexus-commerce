/**
 * SR.4 — Post-purchase review request email templates.
 *
 * Italian for Italy, English for every other market (the only two texts there are). productType-aware: the copy
 * names the qualities a buyer can judge for what was bought.
 *
 * Only used for non-Amazon orders (eBay, Shopify). Amazon customers are
 * reached via the Amazon Solicitations API (D.7) — sending our own email
 * to Amazon buyers violates their messaging policy.
 *
 * Neutral by rule (Owner, 2026-10-27; CHANNEL-FACTS 5a, 5b, 6): every buyer is asked the same way for an honest
 * review. The text never asks for a positive review and never sends an unhappy buyer to us "before" a review; the
 * support address in the footer is about the order, not about the review.
 *
 * The review button appears only when there is a review page for the order (the eBay site of the order's market, the
 * business's own shop); without one the e-mail has no button and no link — never a dead `#` link.
 *
 * sendReviewRequestEmail() sends; renderReviewRequestEmail() is the same e-mail for the Preview (no send). Sending is
 * switched off on a server that does not send e-mail (the transport answers a dry run).
 */

import { sendEmail } from '../email/transport.js'
import { resolveBusinessIdentity, type BusinessIdentity } from '../business-identity.service.js'

export interface ReviewEmailContext {
  to: string
  customerName: string | null
  channelOrderId: string | null
  channel: string
  marketplace: string | null
  /** Product that most benefits from a review (first item in order). */
  productName: string | null
  productType: string | null
  /** Where the buyer leaves the review (review-links.service.ts): the order's eBay site, the business's own shop; null = no button. */
  reviewUrl: string | null
  locale?: 'it' | 'en'
}

// ── productType → review-angle copy ───────────────────────────────────────

function productAngle(productType: string | null): {
  itAngle: string
  enAngle: string
} {
  const t = (productType ?? '').toLowerCase()
  if (t.includes('casco')) {
    return {
      itAngle: 'la protezione e la comodità del casco',
      enAngle: 'the protection and comfort of the helmet',
    }
  }
  if (t.includes('giacca') || t.includes('giubbotto')) {
    return {
      itAngle: 'la vestibilità e la protezione della giacca',
      enAngle: 'the fit and protection of the jacket',
    }
  }
  if (t.includes('guant')) {
    return {
      itAngle: 'la sensibilità al manubrio e la protezione dei guanti',
      enAngle: 'the grip feel and protection of the gloves',
    }
  }
  if (t.includes('stival') || t.includes('scarpe')) {
    return {
      itAngle: 'il comfort e la protezione degli stivali',
      enAngle: 'the comfort and protection of the boots',
    }
  }
  if (t.includes('pantalon')) {
    return {
      itAngle: 'la vestibilità e la protezione dei pantaloni',
      enAngle: 'the fit and protection of the trousers',
    }
  }
  if (t.includes('combinat')) {
    return {
      itAngle: 'la comodità e la protezione della tuta',
      enAngle: 'the comfort and protection of the suit',
    }
  }
  return {
    itAngle: 'la qualità e la comodità del prodotto',
    enAngle: 'the quality and comfort of the product',
  }
}

// ── HTML template ─────────────────────────────────────────────────────────

const escapeHtml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * O3 — rendered as `identity`, the business the order belongs to (Xavia keeps its tagline and Italian support address).
 * The button and the text's link appear only when `reviewUrl` is set.
 */
function renderHtml(ctx: ReviewEmailContext, identity: BusinessIdentity): { subject: string; html: string; text: string } {
  const it = (ctx.locale ?? 'it') === 'it'
  const brandName = identity.brandName
  const brand = escapeHtml(identity.brandName)
  const mark = escapeHtml(identity.brandMark)
  const support = escapeHtml(identity.supportEmail)
  const supportIt = identity.xavia ? 'assistenza@xavia.it' : support
  const tagline = (line: string) => (identity.xavia ? `<span style="color:#9b8ea8;font-size:12px;display:block;margin-top:4px">${line}</span>` : '')
  const { itAngle, enAngle } = productAngle(ctx.productType)
  const angle = it ? itAngle : enAngle
  const firstName = escapeHtml(ctx.customerName?.split(' ')[0]?.trim() || (it ? 'motociclista' : 'rider'))
  // Without a product name: "il tuo acquisto" / "purchase" (the English lines already say "your").
  const productText = ctx.productName ?? (it ? 'il tuo acquisto' : 'purchase')
  const productRef = escapeHtml(productText)
  const reviewHref = ctx.reviewUrl ? escapeHtml(ctx.reviewUrl) : null
  const orderRef = ctx.channelOrderId ? escapeHtml(ctx.channelOrderId) : null
  const button = (label: string) => (reviewHref
    ? `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr><td align="center" style="padding-bottom:24px">
      <a href="${reviewHref}" style="display:inline-block;background:#e63946;color:#ffffff;font-size:15px;font-weight:bold;padding:14px 32px;border-radius:6px;text-decoration:none">
        ${label}
      </a>
    </td></tr>
    </table>`
    : '')
  const shell = (lang: string, subject: string, taglineLine: string, body: string) => `<!DOCTYPE html>
<html lang="${lang}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
<tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="600" style="max-width:600px;background:#ffffff;border-radius:8px;overflow:hidden">
  <tr><td style="background:#1a1a2e;padding:24px 32px;text-align:center">
    <span style="color:#ffffff;font-size:22px;font-weight:bold;letter-spacing:2px">${mark}</span>
    ${tagline(taglineLine)}
  </td></tr>
  <tr><td style="padding:32px">${body}
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`

  if (it) {
    const subject = `Come ti trovi con ${productText}? Lascia una recensione sincera`
    const html = shell('it', subject, 'Abbigliamento da moto', `
    <p style="color:#333;font-size:16px;line-height:1.6;margin:0 0 16px">Ciao ${firstName},</p>
    <p style="color:#333;font-size:16px;line-height:1.6;margin:0 0 16px">
      Grazie per il tuo acquisto! Speriamo tu abbia avuto il tempo di provare <strong>${productRef}</strong>.
    </p>
    <p style="color:#333;font-size:16px;line-height:1.6;margin:0 0 24px">
      Se ti va, condividi la tua opinione sincera lasciando una recensione (per esempio su questi aspetti: ${angle}).
      La tua esperienza aiuta altri motociclisti a scegliere.
    </p>${button('Lascia una recensione →')}
    <p style="color:#999;font-size:12px;line-height:1.5;margin:24px 0 0;border-top:1px solid #eee;padding-top:16px">
      Hai ricevuto questa email perché hai acquistato da ${brand}${orderRef ? ` (ordine ${orderRef})` : ''}.
      Per domande sul tuo ordine scrivi a <a href="mailto:${supportIt}" style="color:#e63946">${supportIt}</a>.
    </p>`)
    const text = [
      `Ciao ${ctx.customerName?.split(' ')[0]?.trim() || 'motociclista'},`,
      '',
      `Grazie per il tuo acquisto! Speriamo tu abbia avuto il tempo di provare ${productText}.`,
      '',
      `Se ti va, condividi la tua opinione sincera lasciando una recensione (per esempio su questi aspetti: ${angle}).`,
      ...(ctx.reviewUrl ? ['', `Lascia una recensione: ${ctx.reviewUrl}`] : []),
      '',
      `— Il team ${brandName}`,
    ].join('\n')
    return { subject, html, text }
  }

  // English for every other market
  const subject = `How is your ${productText}? Share your honest review`
  const html = shell('en', subject, 'Motorcycle Gear', `
    <p style="color:#333;font-size:16px;line-height:1.6;margin:0 0 16px">Hi ${firstName},</p>
    <p style="color:#333;font-size:16px;line-height:1.6;margin:0 0 16px">
      Thank you for your purchase! We hope you've had the chance to try your <strong>${productRef}</strong>.
    </p>
    <p style="color:#333;font-size:16px;line-height:1.6;margin:0 0 24px">
      Feel free to share your honest feedback by leaving a review (for example about ${angle}).
      Your experience helps other riders choose.
    </p>${button('Leave a review →')}
    <p style="color:#999;font-size:12px;line-height:1.5;margin:24px 0 0;border-top:1px solid #eee;padding-top:16px">
      You received this email because you purchased from ${brand}${orderRef ? ` (order ${orderRef})` : ''}.
      Questions about your order? Write to <a href="mailto:${support}" style="color:#e63946">${support}</a>.
    </p>`)
  const text = [
    `Hi ${ctx.customerName?.split(' ')[0]?.trim() || 'rider'},`,
    '',
    `Thank you for your purchase! We hope you've had the chance to try your ${productText}.`,
    '',
    `Feel free to share your honest feedback by leaving a review (for example about ${angle}).`,
    ...(ctx.reviewUrl ? ['', `Leave a review: ${ctx.reviewUrl}`] : []),
    '',
    `— The ${brandName} Team`,
  ].join('\n')
  return { subject, html, text }
}

/**
 * Reviews area PR C — the review request e-mail exactly as `sendReviewRequestEmail` sends it, for the Requests page's
 * "Preview email" (pure: no send, no database).
 */
export function renderReviewRequestEmail(ctx: ReviewEmailContext, identity: BusinessIdentity): { subject: string; html: string; text: string } {
  return renderHtml(ctx, identity)
}

export async function sendReviewRequestEmail(ctx: ReviewEmailContext): Promise<{
  ok: boolean
  dryRun: boolean
  error?: string
  suppressed?: boolean
}> {
  // RV.9.5 — Suppression check before sending.
  const { isEmailSuppressed, unsubscribeTokenFor } = await import('./email-suppression.service.js')
  const sup = await isEmailSuppressed(ctx.to, 'review-request')
  if (sup.suppressed) {
    return { ok: false, dryRun: false, suppressed: true, error: `suppressed (${sup.source})` }
  }
  // O3 — sent as the business the order belongs to; refused (nothing sent) when it has no identity for buyers.
  const found = await resolveBusinessIdentity()
  if (found.ok === false) return { ok: false, dryRun: false, error: found.reason }
  const identity = found.identity
  const webBase = (process.env.NEXUS_WEB_URL ?? 'https://nexus-commerce-web.up.railway.app').replace(/\/$/, '')
  const unsubUrl = `${webBase}/api/email/unsubscribe?token=${unsubscribeTokenFor(ctx.to)}&channel=review-request`
  const rendered = renderHtml(ctx, identity)
  const result = await sendEmail({
    to: ctx.to,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    tag: 'review-request',
    ...(identity.emailFrom ? { from: identity.emailFrom } : {}),
    headers: {
      'List-Unsubscribe': `<${unsubUrl}>, <mailto:${identity.unsubscribeEmail}?subject=unsubscribe>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  })
  return { ok: result.ok, dryRun: result.dryRun, error: result.error }
}
