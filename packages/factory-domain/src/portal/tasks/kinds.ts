import type { Grain } from '../../auth/grains/grains'
import { PORTAL_APPROVE, PORTAL_COMMENT, PORTAL_UPLOAD } from '../../auth/partners/permissions'
import type { Permission } from '../../core/permissions'
import type { PartnerEmailTopic } from '../notifications/topics'
import { PORTAL_HOME_VIEW } from './permissions'
// B-W2b-174: a PO to confirm is for the people who see the supplier's purchase orders.
import { PORTAL_PURCHASE_ORDERS_VIEW } from '../../purchasing/portal-orders/permissions'
// B-W2b-185: paying is the customer's Finance and Admin (portal.payments.pay).
import { PORTAL_PAYMENTS_PAY } from '../../payments/online/permissions'

/**
 * The kinds of request we make of a partner (B-W2b-167, COL-043; portal-frame.prisma PartnerTaskKind; design portal.frame
 * action-needed "Kinds: confirm a PO, accept a quote, approve a sample, send measurements, upload a document, answer a
 * message, pay an invoice, confirm a kit, report progress"). ONE model for every request wherever it shows: Home's "What
 * waits for you", the rail's badges and the reminder e-mails read the same rows.
 *
 * Per kind:
 *   verb     the one verb in the row ("Confirm", "Upload", "Approve", "Pay"), Italian and English
 *   what     the sentence of the request, `{label}` the record as the partner reads it
 *   needs    who in the party it is for (there is no assignee: plan B-W2b-156 Decided): the permissions the verb takes, over
 *            the task's company and party — every main role holds portal.home.view; approving, accepting, confirming and
 *            signing take portal.approve, sending a file or measurements portal.upload, answering portal.comment
 *   grain    the money grain the verb shows (a quote's or an invoice's amount: price), or null
 *   area     the rail area whose badge counts it ("Orders, 2 to confirm"); `badge` the badge's noun
 *   topic    the e-mail topic of its notifications (COL-063)
 */

export const PARTNER_TASK_KINDS = [
  'CONFIRM_PO',
  'ACCEPT_QUOTE',
  'APPROVE',
  'SEND_MEASUREMENTS',
  'UPLOAD_DOCUMENT',
  'ANSWER_MESSAGE',
  'PAY_INVOICE',
  'CONFIRM_KIT',
  'REPORT_PROGRESS',
  'ANSWER_QUESTIONNAIRE',
  'RECONFIRM_ORDER',
] as const
export type PartnerTaskKind = (typeof PARTNER_TASK_KINDS)[number]
export const isPartnerTaskKind = (value: unknown): value is PartnerTaskKind => typeof value === 'string' && (PARTNER_TASK_KINDS as readonly string[]).includes(value)

export const PARTNER_TASK_STATUSES = ['OPEN', 'DONE', 'CANCELLED'] as const
export type PartnerTaskStatus = (typeof PARTNER_TASK_STATUSES)[number]

/** The partner's areas (design portal.frame rail): a task's badge sits on one. */
export const PORTAL_AREAS = ['home', 'orders', 'quotes', 'deliveries', 'documents', 'returns', 'account'] as const
export type PortalArea = (typeof PORTAL_AREAS)[number]

export type PortalLocale = 'it' | 'en'
export interface Words {
  readonly it: string
  readonly en: string
}

export interface KindRule {
  readonly verb: Words
  readonly what: Words
  readonly needs: readonly Permission[]
  readonly grain: Grain | null
  readonly area: PortalArea
  /** The badge's noun for N tasks ("2 to confirm"). */
  readonly badge: Words
  readonly topic: PartnerEmailTopic
}

const rule = (verb: Words, what: Words, needs: readonly Permission[], area: PortalArea, badge: Words, topic: PartnerEmailTopic, grain: Grain | null = null): KindRule =>
  Object.freeze({ verb: Object.freeze(verb), what: Object.freeze(what), needs: Object.freeze<Permission[]>([PORTAL_HOME_VIEW, ...needs]), grain, area, badge: Object.freeze(badge), topic })

export const KIND_RULES: Readonly<Record<PartnerTaskKind, KindRule>> = Object.freeze({
  CONFIRM_PO: rule({ it: 'Conferma', en: 'Confirm' }, { it: "Conferma l'ordine {label}", en: 'Confirm order {label}' }, [PORTAL_APPROVE, PORTAL_PURCHASE_ORDERS_VIEW], 'orders', { it: 'da confermare', en: 'to confirm' }, 'ORDERS'),
  ACCEPT_QUOTE: rule({ it: 'Accetta', en: 'Accept' }, { it: "Accetta l'offerta {label}", en: 'Accept quote {label}' }, [PORTAL_APPROVE], 'quotes', { it: 'da accettare', en: 'to accept' }, 'ORDERS', 'price'),
  APPROVE: rule({ it: 'Approva', en: 'Approve' }, { it: 'Approva {label}', en: 'Approve {label}' }, [PORTAL_APPROVE], 'quotes', { it: 'da approvare', en: 'to approve' }, 'DOCUMENTS'),
  SEND_MEASUREMENTS: rule({ it: 'Invia le misure', en: 'Send measurements' }, { it: 'Invia le misure per {label}', en: 'Send the measurements for {label}' }, [PORTAL_UPLOAD], 'orders', { it: 'misure da inviare', en: 'measurements to send' }, 'ORDERS'),
  UPLOAD_DOCUMENT: rule({ it: 'Carica', en: 'Upload' }, { it: 'Carica il documento richiesto per {label}', en: 'Upload the document we asked for on {label}' }, [PORTAL_UPLOAD], 'documents', { it: 'richiesti', en: 'requested' }, 'DOCUMENTS'),
  ANSWER_MESSAGE: rule({ it: 'Rispondi', en: 'Answer' }, { it: 'Rispondi al nostro messaggio su {label}', en: 'Answer our message on {label}' }, [PORTAL_COMMENT], 'home', { it: 'da rispondere', en: 'to answer' }, 'MESSAGES'),
  PAY_INVOICE: rule({ it: 'Paga', en: 'Pay' }, { it: 'Paga la fattura {label}', en: 'Pay invoice {label}' }, [PORTAL_PAYMENTS_PAY], 'documents', { it: 'da pagare', en: 'to pay' }, 'INVOICES', 'price'),
  CONFIRM_KIT: rule({ it: 'Conferma il kit', en: 'Confirm the kit' }, { it: 'Conferma il kit ricevuto per {label}', en: 'Confirm the kit you received for {label}' }, [PORTAL_APPROVE], 'orders', { it: 'kit da confermare', en: 'kits to confirm' }, 'ORDERS'),
  REPORT_PROGRESS: rule({ it: "Comunica l'avanzamento", en: 'Report progress' }, { it: "Comunica l'avanzamento di {label}", en: 'Report the progress of {label}' }, [PORTAL_COMMENT], 'orders', { it: 'avanzamenti da comunicare', en: 'progress to report' }, 'ORDERS'),
  ANSWER_QUESTIONNAIRE: rule({ it: 'Compila', en: 'Fill in' }, { it: 'Compila il questionario {label}', en: 'Fill in questionnaire {label}' }, [PORTAL_COMMENT], 'documents', { it: 'questionari da compilare', en: 'questionnaires to fill in' }, 'DOCUMENTS'),
  RECONFIRM_ORDER: rule({ it: 'Riconferma', en: 'Re-confirm' }, { it: "Riconferma l'ordine modificato {label}", en: 'Re-confirm the changed order {label}' }, [PORTAL_APPROVE], 'orders', { it: 'da riconfermare', en: 'to re-confirm' }, 'ORDERS', 'price'),
})

/** The request's sentence in a language, the record's label put in. */
export const taskWords = (kind: PartnerTaskKind, label: string, locale: PortalLocale): string => KIND_RULES[kind].what[locale].replace('{label}', label)
