import { legalLines, legalName } from '../documents/legal'
import type { CompanyLegal } from '../documents/model'
import type { Locale } from './rules'

/**
 * The footer of every mail the factory sends for a company, pure:
 *   - the legal block of the Italian civil code, art. 2250, exactly as the company's documents print it
 *     (documents/legal.ts): its name (with "in liquidazione" when it is, c. 3), registered office, VAT number and
 *     codice fiscale, companies register office and number with the REA number (c. 1), share capital as paid in (c. 2),
 *     "Società con socio unico" (c. 4), PEC. Only what the Company row holds is printed;
 *   - the privacy-notice link (GDPR art. 13 and 14; feature GAP-005): one notice per company, linked in every mail. The
 *     link is a slot filled by the caller with the company's notice URL; the notice's text is a later admin screen.
 * The company comes as documents' CompanyLegal (apps/factory-api platform/documents companyLegalOf: from its row).
 */

export type { CompanyLegal } from '../documents/model'

const PRIVACY = {
  it: 'Informativa privacy (artt. 13-14 GDPR)',
  en: 'Privacy notice (GDPR art. 13-14)',
} as const

/** The legal block's lines (c.c. art. 2250): the name as printed, then the lines under it. */
export function legalBlock(company: CompanyLegal, locale: Locale): string[] {
  return [legalName(company, locale), ...legalLines(company, locale)]
}

/** An http(s) URL safe to print and link, or null. */
export function safeUrl(value: string): string | null {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null
  } catch {
    return null
  }
}

/**
 * The privacy-notice slot (GAP-005): the URL of the company's notice. Until the admin screen of the notice exists, every
 * company's notice lives at one address of the factory web: `<web origin>/privacy/<company id>`.
 */
export function privacyNoticeUrl(webOrigin: string, companyId: string): string {
  return `${webOrigin.replace(/\/+$/, '')}/privacy/${encodeURIComponent(companyId)}`
}

export interface Footer {
  readonly text: string
  readonly html: string
}

/** Escapes text for HTML (element content and quoted attribute values). */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] as string)
}

/** The footer: the legal block and the privacy-notice link, as plain text and as safe HTML. */
export function footerOf(company: CompanyLegal, privacyUrl: string, locale: Locale): Footer {
  const url = safeUrl(privacyUrl)
  if (!url) throw new Error('The privacy notice needs an http(s) URL.')
  const privacy = PRIVACY[locale]
  const lines = legalBlock(company, locale)
  const text = ['-- ', ...lines, `${privacy}: ${url}`].join('\n')
  const html =
    '<div style="margin-top:24px;padding-top:12px;border-top:1px solid #dddddd;color:#666666;font-size:12px;line-height:1.5">' +
    lines.map((entry) => `<div>${escapeHtml(entry)}</div>`).join('') +
    `<div><a href="${escapeHtml(url)}" style="color:#666666">${escapeHtml(privacy)}</a></div>` +
    '</div>'
  return { text, html }
}
