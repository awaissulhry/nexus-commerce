/**
 * SR.4 — Post-purchase review request email templates.
 *
 * Italian-first (Xavia primary market). productType-aware: the copy
 * emphasises different product qualities depending on what was bought.
 *
 * Only used for non-Amazon orders (eBay, Shopify). Amazon customers are
 * reached via the Amazon Solicitations API (D.7) — sending our own email
 * to Amazon buyers violates their messaging policy.
 *
 * sendReviewRequestEmail() is the only public function; it is gated by
 * NEXUS_ENABLE_OUTBOUND_EMAILS=true (same as all other transactional mail).
 */

import { sendEmail } from '../email/transport.js'

export interface ReviewEmailContext {
  to: string
  customerName: string | null
  channelOrderId: string | null
  channel: string
  marketplace: string | null
  /** Product that most benefits from a review (first item in order). */
  productName: string | null
  productType: string | null
  /** e.g. https://www.ebay.it/usr/xavia or a Shopify product page */
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

function renderHtml(ctx: ReviewEmailContext): { subject: string; html: string; text: string } {
  const it = (ctx.locale ?? 'it') === 'it'
  const { itAngle, enAngle } = productAngle(ctx.productType)
  const angle = it ? itAngle : enAngle
  const firstName = ctx.customerName?.split(' ')[0]?.trim() || (it ? 'motociclista' : 'rider')
  const productRef = ctx.productName ?? (it ? 'il tuo acquisto' : 'your purchase')
  const reviewHref = ctx.reviewUrl ?? '#'

  if (it) {
    const subject = `Come ti trovi con ${productRef}? Lasciaci la tua opinione`
    const html = `<!DOCTYPE html>
<html lang="it">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${subject}</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
<tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="600" style="max-width:600px;background:#ffffff;border-radius:8px;overflow:hidden">
  <tr><td style="background:#1a1a2e;padding:24px 32px;text-align:center">
    <span style="color:#ffffff;font-size:22px;font-weight:bold;letter-spacing:2px">XAVIA</span>
    <span style="color:#9b8ea8;font-size:12px;display:block;margin-top:4px">Abbigliamento da moto</span>
  </td></tr>
  <tr><td style="padding:32px">
    <p style="color:#333;font-size:16px;line-height:1.6;margin:0 0 16px">Ciao ${firstName},</p>
    <p style="color:#333;font-size:16px;line-height:1.6;margin:0 0 16px">
      Speriamo tu abbia avuto il tempo di provare <strong>${productRef}</strong> sulle tue uscite in moto.
    </p>
    <p style="color:#333;font-size:16px;line-height:1.6;margin:0 0 24px">
      Ci farebbe molto piacere sapere cosa ne pensi — soprattutto ${angle}.
      La tua esperienza aiuta altri motociclisti a scegliere meglio.
    </p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr><td align="center" style="padding-bottom:24px">
      <a href="${reviewHref}" style="display:inline-block;background:#e63946;color:#ffffff;font-size:15px;font-weight:bold;padding:14px 32px;border-radius:6px;text-decoration:none">
        Lascia la tua recensione →
      </a>
    </td></tr>
    </table>
    <p style="color:#666;font-size:13px;line-height:1.6;margin:0 0 8px">
      Bastano 2 minuti. La tua opinione conta molto per noi e per la community Xavia.
    </p>
    <p style="color:#999;font-size:12px;line-height:1.5;margin:24px 0 0;border-top:1px solid #eee;padding-top:16px">
      Hai ricevuto questa email perché hai acquistato da Xavia${ctx.channelOrderId ? ` (ordine ${ctx.channelOrderId})` : ''}.
      Se hai dubbi o problemi con il prodotto, <a href="mailto:assistenza@xavia.it" style="color:#e63946">contattaci</a> — non lasciare
      una recensione negativa prima di darci la possibilità di aiutarti.
    </p>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`
    const text = `Ciao ${firstName},

Speriamo tu abbia avuto il tempo di provare ${productRef} sulle tue uscite in moto.

Ci farebbe molto piacere sapere cosa ne pensi — soprattutto ${angle}.

Lascia la tua recensione: ${reviewHref}

Bastano 2 minuti. Grazie!

— Il team Xavia`
    return { subject, html, text }
  }

  // English fallback
  const subject = `How are you finding your ${productRef}? Share your review`
  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${subject}</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
<tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="600" style="max-width:600px;background:#ffffff;border-radius:8px;overflow:hidden">
  <tr><td style="background:#1a1a2e;padding:24px 32px;text-align:center">
    <span style="color:#ffffff;font-size:22px;font-weight:bold;letter-spacing:2px">XAVIA</span>
    <span style="color:#9b8ea8;font-size:12px;display:block;margin-top:4px">Motorcycle Gear</span>
  </td></tr>
  <tr><td style="padding:32px">
    <p style="color:#333;font-size:16px;line-height:1.6;margin:0 0 16px">Hi ${firstName},</p>
    <p style="color:#333;font-size:16px;line-height:1.6;margin:0 0 16px">
      We hope you've had the chance to try your <strong>${productRef}</strong> out on the road.
    </p>
    <p style="color:#333;font-size:16px;line-height:1.6;margin:0 0 24px">
      We'd love to hear what you think — especially ${angle}.
      Your experience helps other riders choose the right gear.
    </p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr><td align="center" style="padding-bottom:24px">
      <a href="${reviewHref}" style="display:inline-block;background:#e63946;color:#ffffff;font-size:15px;font-weight:bold;padding:14px 32px;border-radius:6px;text-decoration:none">
        Leave your review →
      </a>
    </td></tr>
    </table>
    <p style="color:#666;font-size:13px;line-height:1.6;margin:0 0 8px">
      It only takes 2 minutes. Your feedback means a lot to us and the Xavia community.
    </p>
    <p style="color:#999;font-size:12px;line-height:1.5;margin:24px 0 0;border-top:1px solid #eee;padding-top:16px">
      You received this email because you purchased from Xavia${ctx.channelOrderId ? ` (order ${ctx.channelOrderId})` : ''}.
      If you have any issues with the product, <a href="mailto:support@xavia.it" style="color:#e63946">contact us first</a> —
      we'd love to make it right before you leave a review.
    </p>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`
  const text = `Hi ${firstName},

We hope you've had the chance to try your ${productRef} out on the road.

We'd love to hear what you think — especially ${angle}.

Leave your review: ${reviewHref}

It only takes 2 minutes. Thank you!

— The Xavia Team`
  return { subject, html, text }
}

export async function sendReviewRequestEmail(ctx: ReviewEmailContext): Promise<{
  ok: boolean
  dryRun: boolean
  error?: string
}> {
  const rendered = renderHtml(ctx)
  const result = await sendEmail({
    to: ctx.to,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    tag: 'review-request',
  })
  return { ok: result.ok, dryRun: result.dryRun, error: result.error }
}
