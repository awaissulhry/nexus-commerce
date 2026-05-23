/**
 * RV.6.3 — "How was it?" sentiment check email.
 *
 * The pre-Solicitations diversion email: gives the customer two big
 * buttons — happy → goes to a thank-you page (which fires Amazon
 * Solicitations or our own review request downstream) — unhappy →
 * routes to a short feedback form that emails support directly.
 *
 * Bilingual Italian + English (Xavia's primary market is IT but EU
 * buyers may not read IT). Branded with Xavia colors; mobile-first
 * because customers open these on a phone.
 *
 * Gated by NEXUS_ENABLE_OUTBOUND_EMAILS + RESEND_API_KEY (same as
 * sendReviewRequestEmail). Dry-run logs the would-be content.
 */

import { sendEmail } from '../email/transport.js'

export interface SentimentEmailContext {
  to: string
  customerName: string | null
  productName: string | null
  /** Token-based URL — both /r/{token}/positive and /r/{token}/negative. */
  baseUrl: string
  channelOrderId: string | null
  locale?: 'it' | 'en'
}

function greetingIt(name: string | null): string {
  const first = (name ?? '').trim().split(/\s+/)[0]
  return first ? `Ciao ${first},` : 'Ciao motociclista,'
}

function greetingEn(name: string | null): string {
  const first = (name ?? '').trim().split(/\s+/)[0]
  return first ? `Hi ${first},` : 'Hi rider,'
}

function buildHtml(ctx: SentimentEmailContext): string {
  const positiveUrl = `${ctx.baseUrl}/positive`
  const negativeUrl = `${ctx.baseUrl}/negative`
  const product = ctx.productName ? `<strong>${ctx.productName}</strong>` : 'your gear'
  const productIt = ctx.productName ? `<strong>${ctx.productName}</strong>` : 'la tua attrezzatura'
  const orderRef = ctx.channelOrderId ? `<span style="color:#888">Ordine #${ctx.channelOrderId}</span>` : ''

  return `<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Come è andata?</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1a1a1a;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f5f5f5;">
    <tr><td align="center" style="padding:24px 12px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:100%;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.05);">

        <!-- Header / logo block -->
        <tr><td style="padding:32px 32px 8px;text-align:center;border-bottom:3px solid #c62828;">
          <h1 style="margin:0;font-size:22px;font-weight:800;letter-spacing:0.05em;color:#c62828;">XAVIA</h1>
        </td></tr>

        <!-- Hero -->
        <tr><td style="padding:32px 32px 8px;text-align:center;">
          <div style="font-size:48px;line-height:1;margin-bottom:8px;">🏍️</div>
          <h2 style="margin:0 0 8px;font-size:22px;font-weight:700;">Come è andata?</h2>
          <p style="margin:0;font-size:14px;color:#888;">How was it?</p>
        </td></tr>

        <!-- IT body -->
        <tr><td style="padding:8px 32px;font-size:15px;line-height:1.5;color:#333;">
          <p style="margin:16px 0 8px;">${greetingIt(ctx.customerName)}</p>
          <p style="margin:0 0 16px;">
            Speriamo che ${productIt} sia all'altezza delle aspettative.
            La tua opinione conta — ci aiuta a migliorare e aiuta altri
            motociclisti a scegliere bene.
          </p>
        </td></tr>

        <!-- CTA buttons -->
        <tr><td style="padding:16px 32px 8px;" align="center">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td style="padding:8px;">
                <a href="${positiveUrl}" style="display:inline-block;padding:18px 32px;font-size:17px;font-weight:600;color:#fff;background:#2e7d32;border-radius:8px;text-decoration:none;min-width:160px;text-align:center;">
                  😊 Adoro
                </a>
              </td>
            </tr>
            <tr>
              <td style="padding:8px;">
                <a href="${negativeUrl}" style="display:inline-block;padding:18px 32px;font-size:17px;font-weight:600;color:#fff;background:#888;border-radius:8px;text-decoration:none;min-width:160px;text-align:center;">
                  😕 Qualcosa non va
                </a>
              </td>
            </tr>
          </table>
        </td></tr>

        <!-- EN body -->
        <tr><td style="padding:16px 32px 8px;font-size:13px;line-height:1.5;color:#666;border-top:1px solid #eee;margin-top:16px;">
          <p style="margin:8px 0 4px;">${greetingEn(ctx.customerName)}</p>
          <p style="margin:0 0 8px;">
            We hope ${product} is everything you needed. Your opinion helps
            us improve and helps other riders choose well — tap one of the
            buttons above.
          </p>
          <ul style="font-size:12px;color:#888;padding-left:18px;margin:8px 0;">
            <li><strong>Adoro / I love it</strong> — we'll send a short review invitation.</li>
            <li><strong>Qualcosa non va / Something's wrong</strong> — we'll fix it within 24h.</li>
          </ul>
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding:24px 32px;background:#fafafa;text-align:center;border-top:1px solid #eee;">
          ${orderRef ? `<div style="font-size:12px;color:#aaa;margin-bottom:4px;">${orderRef}</div>` : ''}
          <p style="margin:0;font-size:11px;color:#999;">
            Xavia — Italian motorcycle gear.<br>
            Questa è un'email automatica. Non rispondere — usa i pulsanti sopra.
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`
}

function buildText(ctx: SentimentEmailContext): string {
  const positiveUrl = `${ctx.baseUrl}/positive`
  const negativeUrl = `${ctx.baseUrl}/negative`
  return [
    greetingIt(ctx.customerName),
    '',
    `Come è andata con ${ctx.productName ?? 'la tua attrezzatura'}?`,
    '',
    `😊 Adoro:           ${positiveUrl}`,
    `😕 Qualcosa non va: ${negativeUrl}`,
    '',
    '— Xavia',
    '',
    '---',
    '',
    `${greetingEn(ctx.customerName)}`,
    '',
    'How was it? Tap one of the links above.',
  ].join('\n')
}

export async function sendSentimentCheckEmail(
  ctx: SentimentEmailContext,
): Promise<{ ok: boolean; dryRun: boolean; error?: string }> {
  const result = await sendEmail({
    to: ctx.to,
    subject: ctx.locale === 'en' ? 'How was it? — Xavia' : 'Come è andata? — Xavia',
    html: buildHtml(ctx),
    text: buildText(ctx),
    tag: 'review-sentiment-check',
  })
  return { ok: result.ok, dryRun: result.dryRun, error: result.error }
}
