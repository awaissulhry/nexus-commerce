import Decimal from 'decimal.js'
import type { Locale } from './rules'

/**
 * The footer of every mail the factory sends for a company, pure:
 *   - the legal block of the Italian civil code, art. 2250 (the correspondence of a company states its registered
 *     office, the companies register it is entered in and its number, and for a company with share capital the capital
 *     as paid), with the VAT number and the PEC address the Company row also holds. Only what the row has is printed;
 *     a company without a REA entry or a capital prints no such line;
 *   - the privacy-notice link (GDPR art. 13 and 14; feature GAP-005): one notice per company, linked in every mail. The
 *     link is a slot filled by the caller with the company's notice URL; the notice's text is a later admin screen.
 */

/** What the footer needs of a Company row (packages/factory-db _core.prisma). */
export interface CompanyLegal {
  readonly legalName: string
  readonly address?: unknown
  readonly vatNumber?: string | null
  readonly fiscalCode?: string | null
  readonly reaOffice?: string | null
  readonly reaNumber?: string | null
  /** Capitale sociale, as a decimal string ("10000.00"); null for a company without one (a sole trader). */
  readonly shareCapital?: string | null
  /** ISO 4217 (`EUR`). */
  readonly currency?: string | null
  readonly pec?: string | null
}

const LABELS = {
  it: {
    office: 'Sede legale',
    register: (office: string, number: string) => `Registro delle Imprese di ${office} n. ${number}`,
    rea: 'REA',
    capital: 'Capitale sociale',
    vat: 'P. IVA',
    fiscal: 'C.F.',
    pec: 'PEC',
    privacy: 'Informativa privacy (artt. 13-14 GDPR)',
  },
  en: {
    office: 'Registered office',
    register: (office: string, number: string) => `Companies Register of ${office} no. ${number}`,
    rea: 'REA',
    capital: 'Share capital',
    vat: 'VAT no.',
    fiscal: 'Tax code',
    pec: 'Certified email (PEC)',
    privacy: 'Privacy notice (GDPR art. 13-14)',
  },
} as const

const CURRENCY_SIGNS: Readonly<Record<string, string>> = { EUR: '€', GBP: '£', USD: '$', CHF: 'CHF' }

/** One line of text from a stored value: no control characters, no line breaks. */
const line = (value: unknown): string =>
  typeof value === 'string'
    ? value
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    : ''

/** The registered office from the Company's address JSON: `Via X 1, 00100 Roma (RM), IT`. */
export function officeAddress(address: unknown): string {
  if (address === null || typeof address !== 'object') return ''
  const a = address as Record<string, unknown>
  const street = [line(a.line1), line(a.line2)].filter(Boolean).join(', ')
  const city = [line(a.postalCode), line(a.city)].filter(Boolean).join(' ')
  const province = line(a.province)
  const place = province ? `${city} (${province})` : city
  return [street, place, line(a.country)].filter(Boolean).join(', ')
}

/** A share capital in the reader's notation: 10000 → "€ 10.000,00" (it) or "€ 10,000.00" (en). */
export function formatCapital(value: string, currency: string | null | undefined, locale: Locale): string {
  const fixed = new Decimal(value).toFixed(2)
  const negative = fixed.startsWith('-')
  const [whole, cents] = (negative ? fixed.slice(1) : fixed).split('.') as [string, string]
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, locale === 'it' ? '.' : ',')
  const amount = `${negative ? '-' : ''}${grouped}${locale === 'it' ? ',' : '.'}${cents}`
  const code = (currency ?? 'EUR').toUpperCase()
  return `${CURRENCY_SIGNS[code] ?? code} ${amount}`
}

/** The legal block's lines (c.c. art. 2250), only those the company's row can fill. */
export function legalLines(company: CompanyLegal, locale: Locale): string[] {
  const labels = LABELS[locale]
  const lines: string[] = [line(company.legalName)]
  const office = officeAddress(company.address)
  if (office) lines.push(`${labels.office}: ${office}`)
  const reaOffice = line(company.reaOffice)
  const reaNumber = line(company.reaNumber)
  const registered: string[] = []
  // The companies register number is the company's codice fiscale.
  if (reaOffice && line(company.fiscalCode)) registered.push(labels.register(reaOffice, line(company.fiscalCode)))
  if (reaOffice && reaNumber) registered.push(`${labels.rea} ${reaOffice}-${reaNumber}`)
  if (registered.length > 0) lines.push(registered.join(' – '))
  if (company.shareCapital !== null && company.shareCapital !== undefined && company.shareCapital !== '') {
    lines.push(`${labels.capital} ${formatCapital(company.shareCapital, company.currency, locale)}`)
  }
  const ids = [line(company.vatNumber) && `${labels.vat} ${line(company.vatNumber)}`, line(company.fiscalCode) && `${labels.fiscal} ${line(company.fiscalCode)}`].filter(Boolean)
  if (ids.length > 0) lines.push(ids.join(' – '))
  if (line(company.pec)) lines.push(`${labels.pec}: ${line(company.pec)}`)
  return lines
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
  const labels = LABELS[locale]
  const lines = legalLines(company, locale)
  const text = ['-- ', ...lines, `${labels.privacy}: ${url}`].join('\n')
  const html =
    '<div style="margin-top:24px;padding-top:12px;border-top:1px solid #dddddd;color:#666666;font-size:12px;line-height:1.5">' +
    lines.map((entry) => `<div>${escapeHtml(entry)}</div>`).join('') +
    `<div><a href="${escapeHtml(url)}" style="color:#666666">${escapeHtml(labels.privacy)}</a></div>` +
    '</div>'
  return { text, html }
}
