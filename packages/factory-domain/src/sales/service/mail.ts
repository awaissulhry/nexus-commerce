import type { CaseStatus, MoveTarget } from './rules'

/**
 * The status mail of a service case (B-W2b-345; SAL-436 "Status emails come with returns and repairs"; design case.activity
 * "Status-change mails sent to the customer"): what the customer's contact reads when the case moves and the case says to
 * tell them (`notifyCustomer`). Pure; in the customer's language (Italian or English, else Italian). It names the case's
 * number and where it is now, and adds the office's own words when the move gives them; never the internal note, the
 * resolution as typed for the office, a cover decision's reasons, an amount or a worker. Email out adds the sender's
 * signature, the company's legal block and the privacy notice (platform/email-out).
 */

export const MAIL_LANGUAGES = ['it', 'en'] as const
export type MailLanguage = (typeof MAIL_LANGUAGES)[number]
export const mailLanguageOf = (...candidates: readonly (string | null | undefined)[]): MailLanguage => {
  for (const candidate of candidates) {
    const language = (candidate ?? '').trim().toLowerCase().slice(0, 2)
    if (language === 'it' || language === 'en') return language
  }
  return 'it'
}

const STATUS: Readonly<Record<MailLanguage, Readonly<Record<CaseStatus, string>>>> = Object.freeze({
  it: { NEW: 'ricevuta', OPEN: 'in lavorazione', WAITING_CUSTOMER: 'in attesa di un suo riscontro', WAITING_PART: 'in attesa di un ricambio', RESOLVED: 'risolta', CLOSED: 'chiusa' },
  en: { NEW: 'received', OPEN: 'in progress', WAITING_CUSTOMER: 'waiting for you', WAITING_PART: 'waiting for a part', RESOLVED: 'resolved', CLOSED: 'closed' },
})

const SENTENCE: Readonly<Record<MailLanguage, Readonly<Record<MoveTarget | 'REOPENED', string>>>> = Object.freeze({
  it: {
    OPEN: 'Abbiamo preso in carico la sua richiesta e la stiamo esaminando.',
    REOPENED: 'La sua pratica è stata riaperta: la stiamo esaminando di nuovo.',
    WAITING_CUSTOMER: 'Per proseguire ci serve un suo riscontro: trova qui sotto cosa ci occorre, oppure le scriveremo a breve.',
    WAITING_PART: 'Stiamo aspettando un ricambio per completare il lavoro: le scriveremo appena arriva.',
    RESOLVED: 'La sua richiesta è stata risolta.',
    CLOSED: 'La pratica è chiusa.',
  },
  en: {
    OPEN: 'We have taken your request on and are looking into it.',
    REOPENED: 'Your case has been opened again: we are looking into it once more.',
    WAITING_CUSTOMER: 'To go on we need something from you: you will find what below, or we will write to you shortly.',
    WAITING_PART: 'We are waiting for a part to finish the work: we will write to you as soon as it arrives.',
    RESOLVED: 'Your request has been resolved.',
    CLOSED: 'The case is closed.',
  },
})

const WORDS: Readonly<Record<MailLanguage, { subject: string; dear: string; customer: string; is: string; reply: string }>> = Object.freeze({
  it: { subject: 'Pratica di assistenza {number}: {status}', dear: 'Gentile {name},', customer: 'Cliente', is: 'la sua pratica di assistenza {number} è {status}.', reply: 'Per qualsiasi domanda può rispondere a questa e-mail.' },
  en: { subject: 'Service case {number}: {status}', dear: 'Dear {name},', customer: 'customer', is: 'your service case {number} is {status}.', reply: 'If you have any question, just reply to this e-mail.' },
})

const fill = (template: string, values: Readonly<Record<string, string>>): string => template.replace(/\{(\w+)\}/g, (all, key: string) => values[key] ?? all)

export interface StatusMailInput {
  readonly language: MailLanguage
  readonly number: string
  readonly from: CaseStatus
  readonly to: MoveTarget
  /** The contact's name, as kept (null: "Dear customer"). */
  readonly contactName: string | null
  /** The office's own words for the customer with this move. */
  readonly message?: string | null | undefined
  /** The company that writes (the mail's last line). */
  readonly companyName: string
}

/**
 * B-W2b-422 (TM1:01): the values of the e-mail template `service.status_changed` (factory-domain templates/mail.ts), so a
 * company's template in use says what this code says: the case's number and where it is now, the sentence of the move, the
 * contact (else "customer"), the office's own words, the company. Without a template in use the mail is statusMailOf's.
 */
export function statusMailValuesOf(input: StatusMailInput): Readonly<Record<string, string>> {
  const words = WORDS[input.language]
  return {
    'case.number': input.number,
    'case.status': STATUS[input.language][input.to],
    'case.sentence': SENTENCE[input.language][input.from === 'RESOLVED' && input.to === 'OPEN' ? 'REOPENED' : input.to],
    'contact.name': (input.contactName ?? '').trim() || words.customer,
    message: (input.message ?? '').trim(),
    'company.name': input.companyName,
  }
}

/** The subject and the text of the mail a move sends. */
export function statusMailOf(input: StatusMailInput): { subject: string; body: string } {
  const words = WORDS[input.language]
  const status = STATUS[input.language][input.to]
  const sentence = SENTENCE[input.language][input.from === 'RESOLVED' && input.to === 'OPEN' ? 'REOPENED' : input.to]
  const message = (input.message ?? '').trim()
  const lines = [
    fill(words.dear, { name: (input.contactName ?? '').trim() || words.customer }),
    fill(words.is, { number: input.number, status }),
    '',
    sentence,
    ...(message ? ['', message] : []),
    '',
    words.reply,
    '',
    input.companyName,
  ]
  return { subject: fill(words.subject, { number: input.number, status }), body: lines.join('\n') }
}
