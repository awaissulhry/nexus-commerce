import { BUSINESS_TIME_ZONE } from '../../core/time'
import { CUSTOMER_NUMBER_KINDS, customerNumberOf, type CustomerNumberKind } from '../../sales/customer-numbers'
import { isPartnerTaskKind, taskWords, type PortalLocale } from '../tasks/kinds'
import type { PartnerEmailTopic } from './topics'

/**
 * What a partner person is told (B-W2b-167, PLT-148; design portal.frame Notifications "what changed, on which record,
 * when"). A partner notification is a Notification row of the person (partyId = their party) whose `messageKey` is one of
 * these and whose `params` hold only what the sentence needs: never an amount, never an office person's id (the partner
 * role cannot read `actorId` either), never another partner's name. The sentence is made in the reader's language when it
 * is read or mailed. Each key has its e-mail topic (COL-063) and the notification category of the bell.
 */

export const PARTNER_MESSAGE_TEMPLATES = {
  'portal.task.opened': { topic: null, category: 'ASSIGNMENT', en: '{company} asks you: {what}', it: '{company} vi chiede: {what}' },
  'portal.task.reminded': { topic: 'REMINDERS', category: 'ASSIGNMENT', en: 'Reminder: {what}{due}', it: 'Promemoria: {what}{due}' },
  // th2-backend step 7 (§0.5): {yours} is the customer's own words of its request, quote or order ("your order 12", in the
  // reader's language) when the notice names one, else the record's label (a supplier's PO keeps its number).
  'portal.message.posted': { topic: 'MESSAGES', category: 'FOLLOWING', en: 'New message from {company} on {yours}', it: 'Nuovo messaggio da {company} per {yours}' },
  'portal.order.sent': { topic: 'ORDERS', category: 'FOLLOWING', en: 'New purchase order {label}', it: "Nuovo ordine d'acquisto {label}" },
  'portal.order.confirmed': { topic: 'ORDERS', category: 'FOLLOWING', en: '{Yours} is confirmed', it: '{Yours} è confermato' },
  // B-TH-006 (L2-G06): an order that waits for our yes (credit, an approval rule, measures to check) is received, not
  // confirmed; "confirmed" follows the yes.
  'portal.order.received': { topic: 'ORDERS', category: 'FOLLOWING', en: 'We received {yours}: it is waiting for our approval', it: 'Abbiamo ricevuto {yours}: è in attesa della nostra approvazione' },
  'portal.order.dates_changed': { topic: 'DATES', category: 'FOLLOWING', en: 'The delivery date of {yours} changed{due}', it: 'Nuova data di consegna per {yours}{due}' },
  // ---- B-PR-31 (production plan §6 "Notifications" L15, review fix R-51; walls PW-P07, PW-15): a customer's orders in production,
  // each by its own number ({yours}: "your order 12", never SO-…). Topic PRODUCTION (non-essential: a daily summary by default).
  // Which event makes which: factory-domain production-brand/notices.ts; the rules: apps/factory-api platform/portal/notifications/
  // rules/production.ts and change-requests.ts. Our acts say "we", never a name ("Changed by us"); {more}: how many more of ITS OWN
  // orders the same act named (" and 2 more"); {inYours}: the order of its batch whose conversation holds our answer. Never an
  // amount, a reason a person typed, a work order, a line, a site or a person. Italian in "voi".
  'portal.production.cutting': { topic: 'PRODUCTION', category: 'FOLLOWING', en: 'Cutting has started on {yours}', it: 'È iniziato il taglio per {yours}' },
  'portal.production.sewing': { topic: 'PRODUCTION', category: 'FOLLOWING', en: 'Sewing has started on {yours}', it: 'È iniziata la cucitura per {yours}' },
  'portal.production.quality': { topic: 'PRODUCTION', category: 'FOLLOWING', en: '{Yours} is at the quality check', it: '{Yours} è al controllo qualità' },
  'portal.production.ready': { topic: 'PRODUCTION', category: 'FOLLOWING', en: '{Yours} is ready to ship', it: '{Yours} è pronto per la spedizione' },
  'portal.production.at_risk': { topic: 'PRODUCTION', category: 'FOLLOWING', en: '{Yours} is at risk of missing its date', it: '{Yours} rischia di non rispettare la data' },
  'portal.production.late': { topic: 'PRODUCTION', category: 'FOLLOWING', en: '{Yours} is late', it: '{Yours} è in ritardo' },
  'portal.production.on_hold': { topic: 'PRODUCTION', category: 'FOLLOWING', en: 'Work on {yours} is on hold', it: 'La lavorazione per {yours} è sospesa' },
  'portal.production.hold_lifted': { topic: 'PRODUCTION', category: 'FOLLOWING', en: 'Work on {yours} has resumed', it: 'La lavorazione per {yours} è ripresa' },
  'portal.production.set_regular': { topic: 'PRODUCTION', category: 'FOLLOWING', en: 'We set {yours}{more} back to Regular', it: 'Abbiamo riportato {yours}{more} a normale' },
  'portal.production.locked': { topic: 'PRODUCTION', category: 'FOLLOWING', en: 'We locked {yours}{more} at Regular', it: 'Abbiamo bloccato {yours}{more} su normale' },
  'portal.production.unlocked': { topic: 'PRODUCTION', category: 'FOLLOWING', en: 'We unlocked the urgency of {yours}{more}', it: "Abbiamo sbloccato l'urgenza per {yours}{more}" },
  'portal.production.problem_answered': { topic: 'PRODUCTION', category: 'FOLLOWING', en: 'We answered the problem you reported on {yours}', it: 'Abbiamo risposto al problema che avete segnalato per {yours}' },
  'portal.production.problem_answered_in': { topic: 'PRODUCTION', category: 'FOLLOWING', en: 'We answered the problem you reported on {yours} in the conversation of {inYours}', it: 'Abbiamo risposto al problema che avete segnalato per {yours} nella conversazione {inYours}' },
  // The answer to a production ask (the words are on the order's page) and our counter-offer to any ask (it waits in Waiting for
  // you; its amount, if any, never here). A change or cancel countered is order news (ORDERS, at once), as its answer is.
  'portal.production.rush_accepted': { topic: 'PRODUCTION', category: 'FOLLOWING', en: 'Your urgent request on {yours} was accepted', it: 'La vostra richiesta di urgenza per {yours} è stata accettata' },
  'portal.production.rush_refused': { topic: 'PRODUCTION', category: 'FOLLOWING', en: 'Your urgent request on {yours} was not accepted', it: 'La vostra richiesta di urgenza per {yours} non è stata accettata' },
  'portal.production.hold_accepted': { topic: 'PRODUCTION', category: 'FOLLOWING', en: 'Your pause request on {yours} was accepted', it: 'La vostra richiesta di pausa per {yours} è stata accettata' },
  'portal.production.hold_refused': { topic: 'PRODUCTION', category: 'FOLLOWING', en: 'Your pause request on {yours} was not accepted', it: 'La vostra richiesta di pausa per {yours} non è stata accettata' },
  'portal.production.resume_accepted': { topic: 'PRODUCTION', category: 'FOLLOWING', en: 'Your resume request on {yours} was accepted', it: 'La vostra richiesta di ripresa per {yours} è stata accettata' },
  'portal.production.resume_refused': { topic: 'PRODUCTION', category: 'FOLLOWING', en: 'Your resume request on {yours} was not accepted', it: 'La vostra richiesta di ripresa per {yours} non è stata accettata' },
  'portal.production.split_accepted': { topic: 'PRODUCTION', category: 'FOLLOWING', en: 'Your request to ship what is ready on {yours} was accepted', it: 'La vostra richiesta di spedire ciò che è pronto per {yours} è stata accettata' },
  'portal.production.split_refused': { topic: 'PRODUCTION', category: 'FOLLOWING', en: 'Your request to ship what is ready on {yours} was not accepted', it: 'La vostra richiesta di spedire ciò che è pronto per {yours} non è stata accettata' },
  'portal.production.sample_accepted': { topic: 'PRODUCTION', category: 'FOLLOWING', en: 'Your request for another sample on {yours} was accepted', it: 'La vostra richiesta di un altro campione per {yours} è stata accettata' },
  'portal.production.sample_refused': { topic: 'PRODUCTION', category: 'FOLLOWING', en: 'Your request for another sample on {yours} was not accepted', it: 'La vostra richiesta di un altro campione per {yours} non è stata accettata' },
  'portal.production.countered': { topic: 'PRODUCTION', category: 'FOLLOWING', en: 'We answered your request on {yours} with a counter-offer: it waits for your answer', it: 'Abbiamo risposto alla vostra richiesta per {yours} con una controproposta: attende la vostra risposta' },
  'portal.order.countered': { topic: 'ORDERS', category: 'FOLLOWING', en: 'We answered your request on {yours} with a counter-offer: it waits for your answer', it: 'Abbiamo risposto alla vostra richiesta per {yours} con una controproposta: attende la vostra risposta' },
  // ---- end B-PR-31
  // th3b follow-up 5 (§0.5): a delivery of the customer's own order ({yours}: "your order 12"), never the office's SH-… series.
  'portal.shipment.shipped': { topic: 'SHIPPED', category: 'FOLLOWING', en: 'A delivery of {yours} has shipped', it: 'È stata spedita una consegna per {yours}' },
  'portal.invoice.issued': { topic: 'INVOICES', category: 'FOLLOWING', en: 'Invoice {label} was issued', it: 'È stata emessa la fattura {label}' },
  'portal.claim.sent': { topic: 'CLAIMS', category: 'FOLLOWING', en: 'New claim {label}', it: 'Nuovo reclamo {label}' },
  // B-W2b-183: the office's answer to a change or cancel request from the portal (the words are on the order's page).
  'portal.order.change_accepted': { topic: 'ORDERS', category: 'FOLLOWING', en: 'Your change request on {yours} was accepted', it: 'La vostra richiesta di modifica per {yours} è stata accettata' },
  'portal.order.change_refused': { topic: 'ORDERS', category: 'FOLLOWING', en: 'Your change request on {yours} was not accepted', it: 'La vostra richiesta di modifica per {yours} non è stata accettata' },
  'portal.order.cancel_accepted': { topic: 'ORDERS', category: 'FOLLOWING', en: 'Your cancel request on {yours} was accepted', it: 'La vostra richiesta di annullamento per {yours} è stata accettata' },
  'portal.order.cancel_refused': { topic: 'ORDERS', category: 'FOLLOWING', en: 'Your cancel request on {yours} was not accepted', it: 'La vostra richiesta di annullamento per {yours} non è stata accettata' },
  // B-W2b-F15: our check of a delivery address the person added ({label}: the address in short; {reason}: the office's
  // reason of a refusal, which the customer also reads on its address list). Orders need it: a transactional topic.
  'portal.address.approved': { topic: 'ORDERS', category: 'FOLLOWING', en: 'Your delivery address {label} was checked: your orders can use it', it: 'Il vostro indirizzo di consegna {label} è stato verificato: i vostri ordini possono usarlo' },
  'portal.address.refused': { topic: 'ORDERS', category: 'FOLLOWING', en: 'Your delivery address {label} was not accepted{reason}', it: 'Il vostro indirizzo di consegna {label} non è stato accettato{reason}' },
  // B-TH-011 (threads plan N24, L2-G05, L2-G19): a request's news; th2-backend step 7 (§0.5): the customer's own number only
  // ({yours}: "your request 7", from params.yourKind / yourSeq), never the office's series. Received is the copy of what the
  // person sent (P-CUS-NEW.receipt-F02); a question from us and our no follow; a catalogue order we did not accept (its words are
  // on the request's page). Orders need them: a transactional topic.
  'portal.request.received': { topic: 'ORDERS', category: 'FOLLOWING', en: 'We received {yours}', it: 'Abbiamo ricevuto {yours}' },
  'portal.request.need_info': { topic: 'ORDERS', category: 'FOLLOWING', en: 'We need something from you on {yours}', it: 'Ci serve qualcosa da voi per {yours}' },
  'portal.request.declined': { topic: 'ORDERS', category: 'FOLLOWING', en: '{Yours} was declined', it: '{Yours} non è stata accettata' },
  'portal.order_request.refused': { topic: 'ORDERS', category: 'FOLLOWING', en: 'Your order request {label} was not accepted', it: "La vostra richiesta d'ordine {label} non è stata accettata" },
  // B-TH-068 (threads plan TH-5, PROJ.members-F04): the factory added the person to a project of their organisation ({label}: its
  // number and name, which the portal shows); told to that person only.
  'portal.project.added': { topic: 'MESSAGES', category: 'FOLLOWING', en: '{company} added you to the project {label}', it: '{company} vi ha aggiunto al progetto {label}' },
} as const satisfies Record<string, { readonly topic: PartnerEmailTopic | null; readonly category: 'ASSIGNMENT' | 'FOLLOWING' | 'SYSTEM'; readonly en: string; readonly it: string }>

export type PartnerMessageKey = keyof typeof PARTNER_MESSAGE_TEMPLATES
export const PARTNER_MESSAGE_KEYS = Object.freeze(Object.keys(PARTNER_MESSAGE_TEMPLATES)) as readonly PartnerMessageKey[]
export const isPartnerMessageKey = (value: unknown): value is PartnerMessageKey => typeof value === 'string' && Object.hasOwn(PARTNER_MESSAGE_TEMPLATES, value)

/** A notification as the sentence needs it. */
export interface PartnerNotice {
  readonly messageKey: string
  readonly recordLabel: string
  readonly params: unknown
}

const paramsOf = (params: unknown): Record<string, unknown> => (params !== null && typeof params === 'object' && !Array.isArray(params) ? (params as Record<string, unknown>) : {})

/** "5 Nov" / "5 nov", in the business zone. */
export function shortDate(value: Date, locale: PortalLocale): string {
  return new Intl.DateTimeFormat(locale === 'it' ? 'it-IT' : 'en-GB', { timeZone: BUSINESS_TIME_ZONE, day: 'numeric', month: 'short' }).format(value)
}

/**
 * The e-mail topic of a notification: its key's, or for a new request its kind's (the API passes the kind's topic). A key
 * this list does not know has none (never e-mailed).
 */
export function topicOfNotice(notice: PartnerNotice, kindTopic: (kind: string) => PartnerEmailTopic | null): PartnerEmailTopic | null {
  if (!isPartnerMessageKey(notice.messageKey)) return null
  const template = PARTNER_MESSAGE_TEMPLATES[notice.messageKey]
  if (template.topic !== null) return template.topic
  const kind = paramsOf(notice.params).kind
  return typeof kind === 'string' ? kindTopic(kind) : null
}

// ---- th-backend-g step 2 (B-TH-279: the portal's new-message mail reads its template) --------------------------------------------
/**
 * The record a notice names, as its customer reads it (th2-backend step 7, §0.5): its own words of its request, quote or order ("your
 * order 12" / "Your order 12", in the reader's language), else the record's label (a supplier's PO keeps its number). A request notice
 * made before step 7 named only yourSeq (REQUEST).
 */
export function yoursOf(notice: PartnerNotice, locale: PortalLocale): { readonly yours: string; readonly Yours: string } {
  const params = paramsOf(notice.params)
  const yourKind: CustomerNumberKind = typeof params.yourKind === 'string' && (CUSTOMER_NUMBER_KINDS as readonly string[]).includes(params.yourKind) ? (params.yourKind as CustomerNumberKind) : 'REQUEST'
  const yourNumber = customerNumberOf(yourKind, typeof params.yourSeq === 'number' ? params.yourSeq : null)
  const own = yourNumber ? yourNumber.words[locale] : null
  return { yours: own ? `${own.charAt(0).toLowerCase()}${own.slice(1)}` : notice.recordLabel, Yours: own ?? notice.recordLabel }
}
// ---- end th-backend-g step 2

// ---- B-PR-31: the words a production notice adds ------------------------------------------------------------------------------
/**
 * {inYours}: the customer's own order whose conversation holds our answer to a problem it reported on several of its orders
 * ("your order 13" / "del vostro ordine 13"; params.inSeq), or, without a number of its own, "another of your orders". {more}:
 * how many more of its own orders one act of ours named (params.more: " and 2 more" / " e altri 2"; none: nothing). Both name only
 * the customer's own orders, by its own count.
 */
export function productionWordsOf(params: unknown, locale: PortalLocale): { readonly inYours: string; readonly more: string } {
  const values = paramsOf(params)
  const inSeq = typeof values.inSeq === 'number' && Number.isInteger(values.inSeq) && values.inSeq > 0 ? values.inSeq : null
  const more = typeof values.more === 'number' && Number.isInteger(values.more) && values.more > 0 ? values.more : 0
  return {
    inYours: inSeq !== null ? (locale === 'it' ? `del vostro ordine ${inSeq}` : `your order ${inSeq}`) : locale === 'it' ? 'di un altro vostro ordine' : 'another of your orders',
    more: more === 0 ? '' : locale === 'it' ? ` e altri ${more}` : ` and ${more} more`,
  }
}
// ---- end B-PR-31

/** The sentence in the reader's language; `company` is the factory's name as the portal shows it. */
export function partnerSentence(notice: PartnerNotice, locale: PortalLocale, company: string): string {
  if (!isPartnerMessageKey(notice.messageKey)) return notice.recordLabel
  const params = paramsOf(notice.params)
  const kind = params.kind
  const what = isPartnerTaskKind(kind) ? taskWords(kind, notice.recordLabel, locale) : notice.recordLabel
  const dueAt = typeof params.dueAt === 'string' && !Number.isNaN(Date.parse(params.dueAt)) ? new Date(params.dueAt) : null
  const due = dueAt ? (locale === 'it' ? ` (entro il ${shortDate(dueAt, locale)})` : ` (by ${shortDate(dueAt, locale)})`) : ''
  // B-W2b-F15: a reason the office wrote, as it wrote it. Free text (the reason; an address typed by the customer as the
  // label) goes in by a function, so a "$&" in it is never read as a replacement pattern.
  const reason = typeof params.reason === 'string' && params.reason.trim() !== '' ? `: ${params.reason.trim()}` : ''
  // B-TH-011/105 and th2-backend step 7 (§0.5): the customer's own words of its request, quote or order ("your request 7", "il
  // vostro ordine 12"), in the reader's language; a notice of no such record (a supplier's PO) reads its label instead. A request
  // notice made before step 7 named only yourSeq (REQUEST).
  const { yours, Yours } = yoursOf(notice, locale) // th-backend-g step 2: one rule, shared with the new-message mail's template
  const { inYours, more } = productionWordsOf(notice.params, locale) // B-PR-31
  return PARTNER_MESSAGE_TEMPLATES[notice.messageKey][locale]
    .replace('{yours}', () => yours)
    .replace('{Yours}', () => Yours)
    .replace('{company}', company)
    .replace('{what}', what)
    .replace('{label}', () => notice.recordLabel)
    .replace('{due}', due)
    .replace('{reason}', () => reason)
    // B-PR-31
    .replace('{inYours}', () => inYours)
    .replace('{more}', () => more)
}
