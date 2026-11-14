import type { Issue } from '../core/errors'
import { isTemplateLanguage, type TemplateLanguage } from './language'
import { fillPlaceholders, placeholderProblems, type PlaceholderValues } from './placeholders'

/**
 * E-mail templates (B-W2b-422; PLT-232; design admin.documents "E-mail templates": event, language, subject, last changed;
 * "Edit with placeholders and a preview on a sample record"): the subject and body of one mail the code sends, per event and
 * language, a company's own or every company's (the database's EmailTemplate, in versions DRAFT → ACTIVE → RETIRED). The
 * mail reads the company's version in use, else every company's, else the code's own words (each event's code below names
 * them). A template only changes the words: who gets the mail, when, and whether it goes at all stay the code's, and a mail
 * goes only when a person sends it or a switch that is ON says so. Pure.
 *
 *   service.status_changed   a service case moved and the case says to tell the customer (B-W2b-345; SAL-436; TM1:01)
 *   shipping.tracking_link   the customer's tracking page when the goods leave or a new link is asked (B-W2b-170; LOG-062)
 */

/** The company's names every template may use: its name as printed (trade name, else legal name), legal name and trade name. */
export const COMPANY_PLACEHOLDERS = ['company.name', 'company.legalName', 'company.tradeName'] as const

export const MAIL_EVENTS = ['service.status_changed', 'shipping.tracking_link'] as const
export type MailEvent = (typeof MAIL_EVENTS)[number]

export const isMailEvent = (value: unknown): value is MailEvent => typeof value === 'string' && (MAIL_EVENTS as readonly string[]).includes(value)

export interface MailWords {
  readonly subject: string
  readonly body: string
}

export interface MailEventDefinition {
  readonly event: MailEvent
  /** The record the mail is about (a thread's record type). */
  readonly recordType: string
  readonly placeholders: readonly string[]
  /** The code's own words as a template: what is sent without a template in use, and what a new one starts from. */
  readonly words: Readonly<Record<TemplateLanguage, MailWords>>
  /** Made-up values of a sample record for the preview (the company's names come from the company). */
  readonly sample: Readonly<Record<TemplateLanguage, PlaceholderValues>>
}

export const MAIL_EVENT_DEFINITIONS: Readonly<Record<MailEvent, MailEventDefinition>> = Object.freeze({
  'service.status_changed': {
    event: 'service.status_changed',
    recordType: 'ServiceCase',
    placeholders: ['case.number', 'case.status', 'case.sentence', 'contact.name', 'message', ...COMPANY_PLACEHOLDERS],
    words: {
      it: {
        subject: 'Pratica di assistenza {{case.number}}: {{case.status}}',
        body: 'Gentile {{contact.name}},\nla sua pratica di assistenza {{case.number}} è {{case.status}}.\n\n{{case.sentence}}\n\n{{message}}\n\nPer qualsiasi domanda può rispondere a questa e-mail.\n\n{{company.name}}',
      },
      en: {
        subject: 'Service case {{case.number}}: {{case.status}}',
        body: 'Dear {{contact.name}},\nyour service case {{case.number}} is {{case.status}}.\n\n{{case.sentence}}\n\n{{message}}\n\nIf you have any question, just reply to this e-mail.\n\n{{company.name}}',
      },
    },
    sample: {
      it: { 'case.number': 'SVC-2026-0042', 'case.status': 'in lavorazione', 'case.sentence': 'Abbiamo preso in carico la sua richiesta e la stiamo esaminando.', 'contact.name': 'Anna Esempio', message: 'Il tecnico la chiamerà domani in mattinata.' },
      en: { 'case.number': 'SVC-2026-0042', 'case.status': 'in progress', 'case.sentence': 'We have taken your request on and are looking into it.', 'contact.name': 'Ann Example', message: 'The technician will call you tomorrow morning.' },
    },
  },
  'shipping.tracking_link': {
    event: 'shipping.tracking_link',
    recordType: 'Shipment',
    placeholders: ['order.number', 'shipment.number', 'shipment.where', 'shipment.facts', 'carrier.name', 'delivery.expected', 'trackingUrl', 'contact.name', ...COMPANY_PLACEHOLDERS],
    words: {
      it: {
        subject: 'Il suo ordine {{order.number}} — {{company.name}}',
        body: 'Buongiorno,\n\n{{shipment.where}}\n\n{{shipment.facts}}\n\nLo segua da questa pagina, nella sua lingua: dove si trova, le notizie del corriere e i documenti della spedizione.\n{{trackingUrl}}\n\nLa pagina resta aperta fino a 60 giorni dopo la consegna. Se qualcosa non va, dalla stessa pagina può segnalarcelo.',
      },
      en: {
        subject: 'Your order {{order.number}} — {{company.name}}',
        body: "Hello,\n\n{{shipment.where}}\n\n{{shipment.facts}}\n\nFollow it on this page, in your language: where it is, the carrier's news and the shipment's papers.\n{{trackingUrl}}\n\nThe page stays open until 60 days after delivery. If something is wrong, you can tell us from the same page.",
      },
    },
    sample: {
      it: {
        'order.number': 'SO-2026-0101',
        'shipment.number': 'SH-2026-0077',
        'shipment.where': 'il suo ordine SO-2026-0101 è in viaggio (spedizione SH-2026-0077).',
        'shipment.facts': 'Corriere: Corriere Esempio.\nConsegna prevista: 20 novembre 2026.',
        'carrier.name': 'Corriere Esempio',
        'delivery.expected': '20 novembre 2026',
        trackingUrl: 'https://example.com/l#token=sample',
        'contact.name': 'Anna Esempio',
      },
      en: {
        'order.number': 'SO-2026-0101',
        'shipment.number': 'SH-2026-0077',
        'shipment.where': 'your order SO-2026-0101 is on its way (shipment SH-2026-0077).',
        'shipment.facts': 'Carrier: Example Carrier.\nExpected delivery: 20 November 2026.',
        'carrier.name': 'Example Carrier',
        'delivery.expected': '20 November 2026',
        trackingUrl: 'https://example.com/l#token=sample',
        'contact.name': 'Ann Example',
      },
    },
  },
})

export const EMAIL_TEMPLATE_LIMITS = Object.freeze({ subject: 200, body: 20000 })

/** Every problem of a mail template's words for its event and language (empty when it can be saved). */
export function emailTemplateProblems(event: string, language: string, words: MailWords): Issue[] {
  const problems: Issue[] = []
  if (!isMailEvent(event)) return [{ path: 'body/event', message: 'No mail of the code takes a template for this event.' }]
  if (!isTemplateLanguage(language)) problems.push({ path: 'body/language', message: 'Mail is written in Italian or English.' })
  const offered = MAIL_EVENT_DEFINITIONS[event].placeholders
  const subject = words.subject.trim()
  if (subject === '' || subject.length > EMAIL_TEMPLATE_LIMITS.subject || /[\r\n]/.test(subject)) problems.push({ path: 'body/subject', message: `One line of 1 to ${EMAIL_TEMPLATE_LIMITS.subject} characters.` })
  else problems.push(...placeholderProblems(subject, 'body/subject', offered))
  const body = words.body.trim()
  if (body === '' || body.length > EMAIL_TEMPLATE_LIMITS.body) problems.push({ path: 'body/body', message: `1 to ${EMAIL_TEMPLATE_LIMITS.body} characters.` })
  else problems.push(...placeholderProblems(body, 'body/body', offered))
  return problems
}

/** The mail's subject (one line) and body with the values filled. */
export function fillMail(words: MailWords, values: PlaceholderValues): MailWords {
  return { subject: fillPlaceholders(words.subject, values).replace(/\s+/g, ' ').trim(), body: fillPlaceholders(words.body, values) }
}

/** The company's names as placeholders. */
export function companyValues(company: { readonly legalName: string; readonly tradeName?: string | null }): PlaceholderValues {
  const tradeName = company.tradeName?.trim() || null
  return { 'company.name': tradeName ?? company.legalName.trim(), 'company.legalName': company.legalName.trim(), 'company.tradeName': tradeName }
}
