import type { Locale } from '../../../lib/i18n/locales'
import type { RequestRow, RequestStateCode, RequestView, YourNumber } from './api'

/**
 * The customer's request page and its rows (B-TH-222, B-TH-223, B-TH-303; threads plan X-P-CUS-REQ, P-CUS-ORD-LIST.list), pure:
 * the address, the tone of each true state, the customer's own numbers in words, what the state line links to, the question
 * we asked (NEED_INFO), and the text a search over the requests reads. Only true states reach the customer (review R-01:
 * never "Quote sent" for a draft; never "confirmed" while an order waits for our yes): the words are the API's
 * (factory-domain sales/portal-requests/state), drawn as they come. No office number (INQ-…, QT-…, SO-…) is ever drawn.
 */

export const NS = 'portal-requests'

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string

/** `/p/<party>/orders/requests/<id>` (RECORD_PAGES.Inquiry opens it). */
export const requestHref = (prefix: string, id: string): string => `${prefix}/orders/requests/${encodeURIComponent(id)}`

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

/** The pill's tone of a true state: what waits for the customer is amber, an order confirmed blue (the DS's success pill), an end neutral. */
export function stateTone(code: RequestStateCode): Tone {
  switch (code) {
    case 'NEED_INFO':
      return 'warning'
    case 'QUOTE_SENT':
    case 'QUOTE_ACCEPTED':
    case 'ORDER_WAITING':
      return 'info'
    case 'ORDER_CONFIRMED':
      return 'success'
    default:
      return 'neutral'
  }
}

/** "Your request 7" in the page's language; null when the record has no number of its own yet. */
export const yourNumberText = (number: YourNumber, locale: Locale): string | null => (number ? number.words[locale] : null)

/**
 * What the state line links to once it exists: the order made from the request (its own page), else the quote — which has
 * no portal page yet (it came by e-mail or link), so it is named, not linked. Each with the customer's own number only.
 */
export interface StateLinks {
  order: { href: string; label: string } | null
  quote: { label: string } | null
}

export function stateLinks(view: Pick<RequestView, 'made'>, prefix: string, locale: Locale, t: Translate): StateLinks {
  const order = view.made.order
  const quote = view.made.quote
  return {
    order: order ? { href: `${prefix}/orders/${encodeURIComponent(order.id)}`, label: yourNumberText(order.yourNumber, locale) ?? t('state.theOrder') } : null,
    // A quote is named only once it was sent (before, "Quote being prepared" names none: the backend's rule, B-TH-011).
    quote: quote && quote.sent ? { label: yourNumberText(quote.yourNumber, locale) ?? t('state.theQuote') } : null,
  }
}

/** What the state line says under the state's words: when it happened and what to do (keys of this catalogue). */
export function stateHint(code: RequestStateCode): string {
  return `hint.${code}`
}

/** A message of the request's thread as the page needs it (the DS PartnerThread's own shape). */
export interface ThreadLine {
  id: string
  side: 'company' | 'partner'
  body: string
  at: string
}

/**
 * The question of a request that waits for the customer (NEED_INFO): our last message after its last own one (Ask for info
 * posts it in the request's thread, B-TH-013). Null: not waiting, or the thread holds no message of ours after theirs.
 */
export function questionOf(code: RequestStateCode, messages: readonly ThreadLine[]): ThreadLine | null {
  if (code !== 'NEED_INFO') return null
  for (let at = messages.length - 1; at >= 0; at--) {
    const message = messages[at]!
    if (message.side === 'partner') return null
    if (message.body.trim() !== '') return message
  }
  return null
}

/** At most `max` characters of a quoted message, on one line, cut with "…". */
export function quoteText(body: string, max = 280): string {
  const line = body.replace(/\s+/g, ' ').trim()
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`
}

/** The text a search over the requests reads: the subject, their PO and their own number ("7", "Your request 7"). */
export function requestSearchText(row: Pick<RequestRow, 'subject' | 'customerRef' | 'yourNumber'>, locale: Locale): string {
  return [row.subject, row.customerRef ?? '', row.yourNumber ? `${row.yourNumber.seq} ${row.yourNumber.words[locale]}` : ''].join(' ').toLowerCase()
}

export const matchesSearch = (row: Pick<RequestRow, 'subject' | 'customerRef' | 'yourNumber'>, q: string, locale: Locale): boolean => {
  const typed = q.trim().toLowerCase()
  return typed === '' || requestSearchText(row, locale).includes(typed)
}

/** The rows of the request list in the order the customer reads them: what needs it first, then by its last move, newest first. */
export function requestOrder(rows: readonly RequestRow[]): RequestRow[] {
  return [...rows].sort((a, b) => Number(b.state.needsYou) - Number(a.state.needsYou) || b.updatedAt.localeCompare(a.updatedAt))
}

/** A request's pieces asked (its lines), "—" for a request in words only. */
export const piecesText = (pieces: number): string | null => (pieces > 0 ? String(pieces) : null)

/** The delivery address asked, on one line. */
export function shipToText(shipTo: NonNullable<RequestView['shipTo']>): string {
  return [shipTo.name, shipTo.line1, [shipTo.postalCode, shipTo.city].filter(Boolean).join(' '), shipTo.country].filter((part) => part && part.trim() !== '').join(', ')
}
