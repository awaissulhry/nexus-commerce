/**
 * RV.6.3 / RV.9.3 — "How was it?" sentiment check email.
 *
 * Pre-Solicitations diversion email: two big buttons. Happy → thank-you
 * page (fires Amazon Solicitations or our own review request
 * downstream). Unhappy → short feedback form that emails support.
 *
 * Localized per Amazon marketplace — IT/DE/FR/ES (Xavia's active EU
 * markets) — with English secondary block for buyers in mixed-locale
 * regions. Locale is resolved from the marketplace code at the caller.
 *
 * Gated by NEXUS_ENABLE_OUTBOUND_EMAILS + RESEND_API_KEY.
 */

import { sendEmail } from '../email/transport.js'
import { isEmailSuppressed, unsubscribeTokenFor } from './email-suppression.service.js'

export type SentimentEmailLocale = 'it' | 'de' | 'fr' | 'es' | 'en'

export interface SentimentEmailContext {
  to: string
  customerName: string | null
  productName: string | null
  /** Token-based URL — both /r/{token}/positive and /r/{token}/negative. */
  baseUrl: string
  channelOrderId: string | null
  /** Resolved customer locale; defaults to 'it' (Xavia primary). */
  locale?: SentimentEmailLocale
}

/**
 * Map an Amazon marketplace code (or eBay site) to a sentiment-email
 * locale. Unknown markets fall back to Italian (Xavia primary). Kept
 * narrow on purpose — only the markets Xavia actually sells in.
 */
export function resolveLocaleForMarketplace(
  marketplace: string | null | undefined,
): SentimentEmailLocale {
  const m = (marketplace ?? '').toUpperCase()
  if (m === 'IT') return 'it'
  if (m === 'DE' || m === 'AT') return 'de'
  if (m === 'FR' || m === 'BE') return 'fr'
  if (m === 'ES') return 'es'
  if (m === 'UK' || m === 'GB' || m === 'IE') return 'en'
  return 'it'
}

interface LocaleCopy {
  htmlLang: string
  subject: string
  greeting: (firstName: string | null) => string
  /** Body sentence after greeting, with {product} placeholder. */
  body: string
  productFallback: string
  ctaPositive: string
  ctaNegative: string
  orderLabel: string
  // Short bullet line under the EN secondary block.
  enHint: { positive: string; negative: string }
  // Footer disclaimer.
  footer: string
  // Text-only "How was it?" line.
  textPrompt: string
}

const COPY: Record<SentimentEmailLocale, LocaleCopy> = {
  it: {
    htmlLang: 'it',
    subject: 'Come è andata? — Xavia',
    greeting: (n) => (n ? `Ciao ${n},` : 'Ciao motociclista,'),
    body: "Speriamo che {product} sia all'altezza delle aspettative. La tua opinione conta — ci aiuta a migliorare e aiuta altri motociclisti a scegliere bene.",
    productFallback: 'la tua attrezzatura',
    ctaPositive: '😊 Adoro',
    ctaNegative: '😕 Qualcosa non va',
    orderLabel: 'Ordine',
    enHint: {
      positive: "we'll send a short review invitation",
      negative: "we'll fix it within 24h",
    },
    footer: "Xavia — abbigliamento moto Made in Italy.\nQuesta è un'email automatica. Non rispondere — usa i pulsanti sopra.",
    textPrompt: "Come è andata con {product}?",
  },
  de: {
    htmlLang: 'de',
    subject: 'Wie war es? — Xavia',
    greeting: (n) => (n ? `Hallo ${n},` : 'Hallo Biker,'),
    body: 'Wir hoffen, dass {product} Deinen Erwartungen entspricht. Deine Meinung zählt — sie hilft uns, besser zu werden, und anderen Bikern bei der Wahl.',
    productFallback: 'Deine Ausrüstung',
    ctaPositive: '😊 Top',
    ctaNegative: '😕 Etwas stimmt nicht',
    orderLabel: 'Bestellung',
    enHint: {
      positive: "we'll send a short review invitation",
      negative: "we'll fix it within 24h",
    },
    footer: 'Xavia — italienische Motorradausrüstung.\nDies ist eine automatisch versendete E-Mail. Bitte nicht antworten — nutze die Buttons oben.',
    textPrompt: 'Wie war es mit {product}?',
  },
  fr: {
    htmlLang: 'fr',
    subject: 'Comment ça s\'est passé ? — Xavia',
    greeting: (n) => (n ? `Salut ${n},` : 'Salut motard,'),
    body: "Nous espérons que {product} est à la hauteur de tes attentes. Ton avis compte — il nous aide à nous améliorer et aide d'autres motards à bien choisir.",
    productFallback: 'ton équipement',
    ctaPositive: '😊 J\'adore',
    ctaNegative: '😕 Un souci',
    orderLabel: 'Commande',
    enHint: {
      positive: "we'll send a short review invitation",
      negative: "we'll fix it within 24h",
    },
    footer: "Xavia — équipement moto italien.\nCeci est un e-mail automatique. Ne pas répondre — utilise les boutons ci-dessus.",
    textPrompt: "Comment s'est passé {product} ?",
  },
  es: {
    htmlLang: 'es',
    subject: '¿Qué tal fue? — Xavia',
    greeting: (n) => (n ? `Hola ${n},` : 'Hola motero,'),
    body: 'Esperamos que {product} esté a la altura. Tu opinión cuenta — nos ayuda a mejorar y ayuda a otros moteros a elegir bien.',
    productFallback: 'tu equipamiento',
    ctaPositive: '😊 Me encanta',
    ctaNegative: '😕 Algo va mal',
    orderLabel: 'Pedido',
    enHint: {
      positive: "we'll send a short review invitation",
      negative: "we'll fix it within 24h",
    },
    footer: 'Xavia — equipamiento moto italiano.\nEste es un correo automático. No respondas — usa los botones de arriba.',
    textPrompt: '¿Qué tal con {product}?',
  },
  en: {
    htmlLang: 'en',
    subject: 'How was it? — Xavia',
    greeting: (n) => (n ? `Hi ${n},` : 'Hi rider,'),
    body: 'We hope {product} is everything you needed. Your opinion helps us improve and helps other riders choose well.',
    productFallback: 'your gear',
    ctaPositive: '😊 Love it',
    ctaNegative: '😕 Something\'s wrong',
    orderLabel: 'Order',
    enHint: {
      positive: "we'll send a short review invitation",
      negative: "we'll fix it within 24h",
    },
    footer: 'Xavia — Italian motorcycle gear.\nThis is an automated email. Don\'t reply — use the buttons above.',
    textPrompt: 'How was {product}?',
  },
}

function firstNameOf(fullName: string | null): string | null {
  if (!fullName) return null
  const trimmed = fullName.trim().split(/\s+/)[0]
  return trimmed || null
}

const UNSUBSCRIBE_LABEL: Record<SentimentEmailLocale, string> = {
  it: 'Annulla iscrizione',
  de: 'Abmelden',
  fr: 'Se désinscrire',
  es: 'Cancelar suscripción',
  en: 'Unsubscribe',
}

function buildHtml(ctx: SentimentEmailContext): string {
  const locale = ctx.locale ?? 'it'
  const copy = COPY[locale]
  const positiveUrl = `${ctx.baseUrl}/positive`
  const negativeUrl = `${ctx.baseUrl}/negative`
  const webBase = (process.env.NEXUS_WEB_URL ?? 'https://nexus-commerce-three.vercel.app').replace(/\/$/, '')
  const unsubUrl = `${webBase}/api/email/unsubscribe?token=${unsubscribeTokenFor(ctx.to)}&channel=review-sentiment-check`
  const productStrong = ctx.productName
    ? `<strong>${escapeHtml(ctx.productName)}</strong>`
    : copy.productFallback
  const productEn = ctx.productName ? `<strong>${escapeHtml(ctx.productName)}</strong>` : 'your gear'
  const greeting = copy.greeting(firstNameOf(ctx.customerName))
  const greetingEn = COPY.en.greeting(firstNameOf(ctx.customerName))
  const orderRef = ctx.channelOrderId
    ? `<span style="color:#888">${copy.orderLabel} #${escapeHtml(ctx.channelOrderId)}</span>`
    : ''
  const bodyHtml = copy.body.replace('{product}', productStrong)
  const showEnSecondary = locale !== 'en'

  return `<!doctype html>
<html lang="${copy.htmlLang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(copy.subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1a1a1a;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f5f5f5;">
    <tr><td align="center" style="padding:24px 12px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:100%;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.05);">

        <tr><td style="padding:32px 32px 8px;text-align:center;border-bottom:3px solid #c62828;">
          <h1 style="margin:0;font-size:22px;font-weight:800;letter-spacing:0.05em;color:#c62828;">XAVIA</h1>
        </td></tr>

        <tr><td style="padding:32px 32px 8px;text-align:center;">
          <div style="font-size:48px;line-height:1;margin-bottom:8px;">🏍️</div>
          <h2 style="margin:0 0 8px;font-size:22px;font-weight:700;">${escapeHtml(copy.subject.replace(' — Xavia', ''))}</h2>
        </td></tr>

        <tr><td style="padding:8px 32px;font-size:15px;line-height:1.5;color:#333;">
          <p style="margin:16px 0 8px;">${escapeHtml(greeting)}</p>
          <p style="margin:0 0 16px;">${bodyHtml}</p>
        </td></tr>

        <tr><td style="padding:16px 32px 8px;" align="center">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td style="padding:8px;">
                <a href="${positiveUrl}" style="display:inline-block;padding:18px 32px;font-size:17px;font-weight:600;color:#fff;background:#2e7d32;border-radius:8px;text-decoration:none;min-width:160px;text-align:center;">
                  ${escapeHtml(copy.ctaPositive)}
                </a>
              </td>
            </tr>
            <tr>
              <td style="padding:8px;">
                <a href="${negativeUrl}" style="display:inline-block;padding:18px 32px;font-size:17px;font-weight:600;color:#fff;background:#888;border-radius:8px;text-decoration:none;min-width:160px;text-align:center;">
                  ${escapeHtml(copy.ctaNegative)}
                </a>
              </td>
            </tr>
          </table>
        </td></tr>

        ${
          showEnSecondary
            ? `<tr><td style="padding:16px 32px 8px;font-size:13px;line-height:1.5;color:#666;border-top:1px solid #eee;margin-top:16px;">
          <p style="margin:8px 0 4px;">${escapeHtml(greetingEn)}</p>
          <p style="margin:0 0 8px;">${COPY.en.body.replace('{product}', productEn)}</p>
          <ul style="font-size:12px;color:#888;padding-left:18px;margin:8px 0;">
            <li><strong>${escapeHtml(copy.ctaPositive)} / ${escapeHtml(COPY.en.ctaPositive)}</strong> — ${escapeHtml(copy.enHint.positive)}.</li>
            <li><strong>${escapeHtml(copy.ctaNegative)} / ${escapeHtml(COPY.en.ctaNegative)}</strong> — ${escapeHtml(copy.enHint.negative)}.</li>
          </ul>
        </td></tr>`
            : ''
        }

        <tr><td style="padding:24px 32px;background:#fafafa;text-align:center;border-top:1px solid #eee;">
          ${orderRef ? `<div style="font-size:12px;color:#aaa;margin-bottom:4px;">${orderRef}</div>` : ''}
          <p style="margin:0;font-size:11px;color:#999;white-space:pre-line;">${escapeHtml(copy.footer)}</p>
          <p style="margin:8px 0 0;font-size:11px;color:#aaa;">
            <a href="${unsubUrl}" style="color:#888;text-decoration:underline;">${escapeHtml(UNSUBSCRIBE_LABEL[locale])}</a>
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`
}

function buildText(ctx: SentimentEmailContext): string {
  const locale = ctx.locale ?? 'it'
  const copy = COPY[locale]
  const positiveUrl = `${ctx.baseUrl}/positive`
  const negativeUrl = `${ctx.baseUrl}/negative`
  const product = ctx.productName ?? copy.productFallback
  const webBase = (process.env.NEXUS_WEB_URL ?? 'https://nexus-commerce-three.vercel.app').replace(/\/$/, '')
  const unsubUrl = `${webBase}/api/email/unsubscribe?token=${unsubscribeTokenFor(ctx.to)}&channel=review-sentiment-check`
  const lines = [
    copy.greeting(firstNameOf(ctx.customerName)),
    '',
    copy.textPrompt.replace('{product}', product),
    '',
    `${copy.ctaPositive}: ${positiveUrl}`,
    `${copy.ctaNegative}: ${negativeUrl}`,
    '',
    '— Xavia',
  ]
  if (locale !== 'en') {
    lines.push(
      '',
      '---',
      '',
      COPY.en.greeting(firstNameOf(ctx.customerName)),
      '',
      'How was it? Tap one of the links above.',
    )
  }
  lines.push('', `${UNSUBSCRIBE_LABEL[locale]}: ${unsubUrl}`)
  return lines.join('\n')
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * RV.9.6 — Test-mode HTML preview. Pure renderer; no DB, no send.
 * Lets the dashboard iframe show the operator what the email looks
 * like in each locale before exposing real customers.
 */
export function renderSentimentCheckPreview(opts: {
  locale: SentimentEmailLocale
  productName?: string | null
  customerName?: string | null
}): string {
  return buildHtml({
    to: 'preview@xavia.it',
    customerName: opts.customerName ?? 'Test Operator',
    productName: opts.productName ?? 'Casco Xavia Carbon',
    baseUrl: (process.env.NEXUS_WEB_URL ?? 'https://nexus-commerce-three.vercel.app').replace(/\/$/, '') + '/r/__test__',
    channelOrderId: 'TEST-PREVIEW',
    locale: opts.locale,
  })
}

export async function sendSentimentCheckEmail(
  ctx: SentimentEmailContext,
): Promise<{ ok: boolean; dryRun: boolean; error?: string; suppressed?: boolean }> {
  // RV.9.5 — check the suppression list before sending. The mailer
  // treats `ok:false, suppressed:true` as SKIPPED, not FAILED.
  const sup = await isEmailSuppressed(ctx.to, 'review-sentiment-check')
  if (sup.suppressed) {
    return { ok: false, dryRun: false, suppressed: true, error: `suppressed (${sup.source})` }
  }
  const locale = ctx.locale ?? 'it'
  const copy = COPY[locale]
  const result = await sendEmail({
    to: ctx.to,
    subject: copy.subject,
    html: buildHtml(ctx),
    text: buildText(ctx),
    tag: 'review-sentiment-check',
    headers: buildUnsubscribeHeaders(ctx.to),
  })
  return { ok: result.ok, dryRun: result.dryRun, error: result.error }
}

/**
 * RFC 8058 List-Unsubscribe + List-Unsubscribe-Post headers — these
 * unlock the one-click "Unsubscribe" button in Gmail / Apple Mail. Bare
 * `mailto:` is the legacy fallback for ancient clients.
 */
function buildUnsubscribeHeaders(to: string): Record<string, string> {
  const webBase = (process.env.NEXUS_WEB_URL ?? 'https://nexus-commerce-three.vercel.app').replace(/\/$/, '')
  const token = unsubscribeTokenFor(to)
  const httpUrl = `${webBase}/api/email/unsubscribe?token=${token}&channel=review-sentiment-check`
  const mailto = 'mailto:unsubscribe@xavia.it?subject=unsubscribe'
  return {
    'List-Unsubscribe': `<${httpUrl}>, <${mailto}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  }
}
