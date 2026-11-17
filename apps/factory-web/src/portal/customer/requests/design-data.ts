import type { PartnerMessage } from '@nexus/ui/patterns/PartnerThread/index'
import { REQUEST_STATE_WORDS, isOpenRequest } from '@nexus/factory-domain/sales/portal-requests/state'
import { customerNumberOf } from '@nexus/factory-domain/sales/customer-numbers'
import { formatDateTime } from '../../../lib/i18n/format'
import type { Locale } from '../../../lib/i18n/locales'
import { BRAND_BETA } from '../../../lib/testing/two-brands'
import type { PortalBand } from '../../shell/frame'
import type { PortalShellViewModel } from '../../shell/view/PortalShellView'
import type { ThreadViewModel } from '../../shell/view/ThreadView'
import { shellOf as ordersShellOf } from '../orders/design-data'
import type { RequestRow, RequestStateCode, RequestView } from './api'

/**
 * The made-up world of the customer's requests (B-TH-220, B-TH-222, B-TH-223, B-TH-303; PLAN §3.1): the reader is Brand Beta
 * (lib/testing/two-brands, brand B), so every case can be scanned for Brand Alpha (brand A) and must hold nothing of it (T00 at
 * the screen level). Its own numbers are its own count ("Your request 7"); the office's numbers (INQ-…) are in the data, as the
 * API sends them, and must never be drawn. Never a real company, person, address or number.
 */

const HOUR = 3_600_000
export const NOW = Math.floor(Date.now() / HOUR) * HOUR
export const at = (hours: number) => new Date(NOW + hours * HOUR).toISOString()
export const dayAt = (days: number) => at(days * 24).slice(0, 10)
export const PREFIX = `/p/${BRAND_BETA.code}`
const id = (n: number) => `b2b2b2b2-0000-4000-8000-${String(900 + n).padStart(12, '0')}`
export const REQUEST_ID = id(1)

/** The frame of brand B's portal: its name, its person, its own address prefix (never brand A's). */
export function betaShellOf(locale: Locale, band: PortalBand, path: string, over: Partial<PortalShellViewModel> = {}): PortalShellViewModel {
  return ordersShellOf(locale, band, {
    partyName: BRAND_BETA.legalName,
    person: { displayName: BRAND_BETA.portalPerson.name, email: BRAND_BETA.portalPerson.email },
    prefix: PREFIX,
    termsHref: `${PREFIX}/terms`,
    path,
    badges: {},
    ...over,
  })
}

const stateOf = (code: RequestStateCode): RequestRow['state'] => ({ code, words: REQUEST_STATE_WORDS[code], open: isOpenRequest(code), needsYou: code === 'NEED_INFO' })

export function requestRow(n: number, code: RequestStateCode, over: Partial<RequestRow> = {}): RequestRow {
  return {
    id: id(n),
    // The office's number, as the API sends it: never drawn in the portal (B-TH-303).
    number: `INQ-2026-00${140 + n}`,
    yourNumber: customerNumberOf('REQUEST', n),
    customerRef: null,
    subject: n % 2 === 0 ? 'Winter gloves for the shop, sizes S to XL' : 'Rain jackets like last spring, 40 pieces',
    state: stateOf(code),
    wantedDate: null,
    receivedAt: at(-24 * (10 - n)),
    updatedAt: at(-6 * (10 - n)),
    pieces: 0,
    ...over,
  }
}

/** Brand B's open and closed requests (the list and the side column). */
export const REQUESTS: readonly RequestRow[] = [
  requestRow(7, 'NEED_INFO', { customerRef: BRAND_BETA.customerRef, subject: 'Rain jackets like last spring, 40 pieces' }),
  requestRow(6, 'QUOTE_BEING_PREPARED', { subject: 'Winter gloves for the shop, sizes S to XL' }),
  requestRow(5, 'BEING_REVIEWED', { subject: 'Name labels on the team suits' }),
  requestRow(4, 'SENT', { subject: 'Two spare zips for the touring jacket' }),
  requestRow(3, 'ORDER_WAITING', { subject: 'Club vests, 25 pieces' }),
  requestRow(2, 'DECLINED', { subject: 'Leather bag in a new colour' }),
  requestRow(1, 'ORDER_CONFIRMED', { subject: 'First order of rain jackets' }),
]

export function requestView(code: RequestStateCode, over: Partial<RequestView> = {}): RequestView {
  const row = requestRow(7, code, { customerRef: BRAND_BETA.customerRef, wantedDate: dayAt(40), subject: 'Rain jackets like last spring, 40 pieces' })
  return {
    ...row,
    request: `Rain jackets like last spring, 40 pieces\n\n${BRAND_BETA.message}\nSame colours as last time, sizes S to XXL.`,
    source: 'PORTAL',
    shipTo: { id: id(50), name: 'Lager', line1: BRAND_BETA.address.line1, postalCode: BRAND_BETA.address.postalCode, city: BRAND_BETA.address.city, country: BRAND_BETA.address.country, waiting: false },
    lines: [],
    made: { quote: null, order: null },
    closedAt: null,
    ...over,
  }
}

const message = (n: number, side: 'company' | 'partner', body: string, hours: number, locale: Locale, name: string, mine: boolean): PartnerMessage => ({
  id: `m${n}`,
  side,
  channel: 'portal',
  author: { name, mine },
  body,
  attachments: [],
  at: at(hours),
  atText: formatDateTime(at(hours), { locale }),
})

export const QUESTION = 'Thank you. Which sizes do you need for the 40 jackets, and is the hood the detachable one?'

/** The request's thread as brand B reads it: its words first, our messages after (never an office note: the type has none). */
export function threadOf(locale: Locale, code: RequestStateCode): ThreadViewModel {
  const messages: PartnerMessage[] = [message(1, 'partner', requestView(code).request, -30, locale, BRAND_BETA.portalPerson.name, true)]
  if (code !== 'SENT') messages.push(message(2, 'company', code === 'DECLINED' ? 'We are sorry: we do not make bags in that leather any more.' : code === 'NEED_INFO' ? QUESTION : 'Thank you, we are on it.', -20, locale, 'Alex Demo', false))
  if (code === 'QUOTE_BEING_PREPARED' || code === 'QUOTE_SENT' || code === 'ORDER_WAITING' || code === 'ORDER_CONFIRMED') messages.push(message(3, 'partner', 'Sizes: S 5, M 10, L 15, XL 10. Yes, the detachable hood.', -10, locale, BRAND_BETA.portalPerson.name, true))
  return {
    state: 'ready',
    title: locale === 'it' ? 'Messaggi su questa richiesta' : 'Messages about this request',
    record: null,
    companyName: 'Pelletteria Esempio',
    messages,
    composer: code === 'CLOSED' || code === 'DECLINED' ? { value: '', busy: false, heldReason: null, hint: null, limit: 10_000 } : { value: '', busy: false, heldReason: null, hint: locale === 'it' ? 'Potete anche rispondere alle nostre e-mail.' : 'You can also answer our e-mails.', limit: 10_000 },
    loadMore: null,
    accessLine: null,
    failed: null,
  }
}
