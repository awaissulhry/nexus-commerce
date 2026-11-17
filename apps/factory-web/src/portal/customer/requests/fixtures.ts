import { customerNumberOf } from '@nexus/factory-domain/sales/customer-numbers'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import type { Locale } from '../../../lib/i18n/locales'
import { CATALOGUE, createTranslator } from '../../../lib/i18n/messages'
import type { RequestStateCode, RequestView } from './api'
import { at, betaShellOf, dayAt, PREFIX, QUESTION, REQUEST_ID, requestView, threadOf } from './design-data'
import { NS, stateLinks, stateTone, yourNumberText } from './model'
import { RequestCase, type RequestCaseBuilder } from './view/RequestCase'

/**
 * SCR-185-request › the customer's request (B-TH-222, B-TH-303; threads plan X-P-CUS-REQ, picture 20 drawn to the approved
 * look — "comfortable" portal density), MADE-UP data only and read by Brand Beta (brand B): one case per true state (Sent,
 * Being reviewed, We need something from you with the question and Answer, Quote being prepared, Quote sent, Quote accepted,
 * Order waiting for approval, Order confirmed, Declined, Closed), the request with lines and a delivery address that waits for
 * our check, loading, a failed read, another customer's request (the neutral not-found page) and no connection. Every case
 * shows the customer's own number ("Your request 7"), never the office's INQ-… series.
 */

const words = (locale: Locale) => createTranslator(locale, CATALOGUE[locale][NS] ?? {})

function page(code: RequestStateCode, over: (locale: Locale) => { view?: Partial<RequestView>; state?: 'loading' | 'error' | 'missing' | 'ready'; offline?: string | null; question?: boolean } = () => ({})): RequestCaseBuilder {
  return (locale) => {
    const t = words(locale)
    const extra = over(locale)
    const state = extra.state ?? 'ready'
    const request = state === 'ready' || (state === 'error' && extra.view) ? requestView(code, extra.view ?? {}) : null
    const yours = request ? yourNumberText(request.yourNumber, locale) : null
    const band = {
      title: state === 'missing' ? t('missing.title') : request?.yourNumber ? t('title', { seq: request.yourNumber.seq }) : t('titleNone'),
      back: { href: `${PREFIX}/orders`, label: t('back') },
      refs: request?.customerRef ? { theirs: request.customerRef, ours: null } : null,
      status: request ? { label: request.state.words[locale], tone: stateTone(request.state.code) } : null,
      ask: state === 'missing' ? null : { type: 'Inquiry', id: REQUEST_ID, label: yours },
    }
    return {
      shell: betaShellOf(locale, band, '/orders'),
      page: {
        state,
        request,
        links: request ? stateLinks(request, PREFIX, locale, t) : { order: null, quote: null },
        question: code === 'NEED_INFO' && extra.question !== false ? { body: QUESTION, at: at(-20) } : null,
        offlineSince: extra.offline ?? null,
        backHref: `${PREFIX}/orders`,
      },
      thread: request ? threadOf(locale, code) : null,
    }
  }
}

const QUOTE = (sent: boolean) => ({ id: 'b2b2b2b2-0000-4000-8000-000000000961', number: 'QT-2026-0098', yourNumber: customerNumberOf('QUOTE', 3), sent })
const ORDER = { id: 'b2b2b2b2-0000-4000-8000-000000000971', number: 'SO-2026-0142', yourNumber: customerNumberOf('ORDER', 12) }

export const designScreen = defineDesignScreen<RequestCaseBuilder>({
  screen: 'SCR-185-request',
  title: 'The customer’s request: its true state and its thread (B-TH-222)',
  view: RequestCase,
  cases: [
    { id: 'th-222-sent', label: 'Sent — nobody has picked it up yet', model: page('SENT'), note: 'One state line in true states only; their words are the first message of the thread; the details beside it from 1280 px.' },
    { id: 'th-222-reviewed', label: 'Being reviewed', model: page('BEING_REVIEWED') },
    { id: 'th-222-need-info', label: 'We need something from you — the question quoted, Answer', model: page('NEED_INFO'), note: 'Our last message after their last one is quoted; Answer puts the cursor in the message box. Their answer resumes the request (back to Being reviewed).' },
    { id: 'th-222-need-info-unread', label: 'We need something from you — the thread not read yet', model: page('NEED_INFO', () => ({ question: false })), note: 'Until the thread is read the line points at the messages below.' },
    { id: 'th-222-quote-prepared', label: 'Quote being prepared (a draft is never "Quote sent")', model: page('QUOTE_BEING_PREPARED', () => ({ view: { made: { quote: QUOTE(false), order: null } } })), note: 'The quote is not named until it was sent (review R-01).' },
    { id: 'th-222-quote-sent', label: 'Quote sent (see your e-mail)', model: page('QUOTE_SENT', () => ({ view: { made: { quote: QUOTE(true), order: null } } })), note: '“Your quote 3”: the customer’s own count, never QT-…' },
    { id: 'th-222-quote-accepted', label: 'Quote accepted', model: page('QUOTE_ACCEPTED', () => ({ view: { made: { quote: QUOTE(true), order: null } } })) },
    { id: 'th-222-order-waiting', label: 'Order waiting for approval (never "confirmed" before it is)', model: page('ORDER_WAITING', () => ({ view: { made: { quote: QUOTE(true), order: ORDER } } })), note: '“Made into Your order 12” opens the order page.' },
    { id: 'th-222-order-confirmed', label: 'Order confirmed', model: page('ORDER_CONFIRMED', () => ({ view: { made: { quote: QUOTE(true), order: ORDER } } })) },
    // B-TH-228: made straight into an order by the office (no quote between): the order's own state.
    { id: 'th-228-ordered-straight', label: 'Made straight into an order, waiting for approval', model: page('ORDER_WAITING', () => ({ view: { made: { quote: null, order: ORDER } } })), note: 'The office made the order from the request (Make order): the page reads the order’s own state — waiting for approval is never “confirmed” — and links “Your order 12”.' },
    { id: 'th-222-declined', label: 'Declined — our message in the thread', model: page('DECLINED') },
    { id: 'th-222-closed', label: 'Closed', model: page('CLOSED') },
    {
      id: 'th-222-details',
      label: 'With lines and a new delivery address',
      model: page('BEING_REVIEWED', () => ({
        view: {
          pieces: 40,
          shipTo: { id: 'b2b2b2b2-0000-4000-8000-000000000951', name: 'Shop', line1: 'Betaweg 5', postalCode: '10117', city: 'Berlin', country: 'DE', waiting: true },
          lines: [
            { id: 'l1', seq: 1, style: { id: 's1', code: 'BX-200', name: 'Rain jacket Beta' }, colourway: { id: 'c1', code: 'NAV', name: 'Navy' }, colourText: null, description: null, sizes: { S: 5, M: 10, L: 15, XL: 10 }, quantity: null, note: null },
          ],
        },
      })),
      note: 'What was asked, beside the thread: subject, PO, wanted by, the delivery address (waits for our check), the lines.',
    },
    { id: 'th-222-loading', label: 'Loading', model: page('SENT', () => ({ state: 'loading' })) },
    { id: 'th-222-error', label: 'Could not be read', model: page('SENT', () => ({ state: 'error' })), note: 'The problem in words + Try again.' },
    { id: 'th-222-missing', label: 'Another customer’s request (or none): the neutral page', model: page('SENT', () => ({ state: 'missing' })), note: 'The same words as a request that does not exist: it never says another customer exists (W37).' },
    { id: 'th-222-offline', label: 'No connection', model: page('BEING_REVIEWED', (locale) => ({ offline: new Intl.DateTimeFormat(locale === 'it' ? 'it-IT' : 'en-GB', { hour: '2-digit', minute: '2-digit' }).format(new Date(at(-1))) })), note: 'What was loaded and when; the thread’s Send says why it waits.' },
  ],
})

/** The wanted day the cases use (the tests read it). */
export const WANTED = dayAt(40)
