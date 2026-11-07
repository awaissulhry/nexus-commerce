import { BUSINESS_TIME_ZONE } from '../../core/time'
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
  'portal.task.opened': { topic: null, category: 'ASSIGNMENT', en: '{company} asks you: {what}', it: '{company} ti chiede: {what}' },
  'portal.task.reminded': { topic: 'REMINDERS', category: 'ASSIGNMENT', en: 'Reminder: {what}{due}', it: 'Promemoria: {what}{due}' },
  'portal.message.posted': { topic: 'MESSAGES', category: 'FOLLOWING', en: 'New message from {company} on {label}', it: 'Nuovo messaggio da {company} su {label}' },
  'portal.order.sent': { topic: 'ORDERS', category: 'FOLLOWING', en: 'New purchase order {label}', it: "Nuovo ordine d'acquisto {label}" },
  'portal.order.confirmed': { topic: 'ORDERS', category: 'FOLLOWING', en: 'Your order {label} is confirmed', it: 'Il tuo ordine {label} è confermato' },
  'portal.order.dates_changed': { topic: 'DATES', category: 'FOLLOWING', en: 'The delivery date of {label} changed{due}', it: 'La data di consegna di {label} è cambiata{due}' },
  'portal.shipment.shipped': { topic: 'SHIPPED', category: 'FOLLOWING', en: '{label} has shipped', it: '{label} è stata spedita' },
  'portal.invoice.issued': { topic: 'INVOICES', category: 'FOLLOWING', en: 'Invoice {label} was issued', it: 'È stata emessa la fattura {label}' },
  'portal.claim.sent': { topic: 'CLAIMS', category: 'FOLLOWING', en: 'New claim {label}', it: 'Nuovo reclamo {label}' },
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

/** The sentence in the reader's language; `company` is the factory's name as the portal shows it. */
export function partnerSentence(notice: PartnerNotice, locale: PortalLocale, company: string): string {
  if (!isPartnerMessageKey(notice.messageKey)) return notice.recordLabel
  const params = paramsOf(notice.params)
  const kind = params.kind
  const what = isPartnerTaskKind(kind) ? taskWords(kind, notice.recordLabel, locale) : notice.recordLabel
  const dueAt = typeof params.dueAt === 'string' && !Number.isNaN(Date.parse(params.dueAt)) ? new Date(params.dueAt) : null
  const due = dueAt ? (locale === 'it' ? ` (entro il ${shortDate(dueAt, locale)})` : ` (by ${shortDate(dueAt, locale)})`) : ''
  return PARTNER_MESSAGE_TEMPLATES[notice.messageKey][locale]
    .replace('{company}', company)
    .replace('{what}', what)
    .replace('{label}', notice.recordLabel)
    .replace('{due}', due)
}
