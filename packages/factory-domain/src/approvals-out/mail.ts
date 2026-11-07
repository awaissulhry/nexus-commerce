import { KIND_RULES, type ApprovalKind, type ApprovalLocale, type ApprovalStatus } from './kinds'
import { decidedWords, shortDayOf } from './rules'

/**
 * The mails of approval requests (B-W2b-184), in the reader's language (it/en). No money, no cost and no office id in any of
 * them: the request mail names the record and what we ask, the receipt repeats the answer as signed. The link is in the sent
 * mail only (the EmailOutbound row keeps the subject, never the body).
 *
 *   request    to the partner's contact on file (or the address typed): what we ask, by when, the link (one answer, then it
 *              opens nothing), "please do not forward it"
 *   receipt    to whoever answered (the link's address, the portal person's): the answer, the typed name, the time
 *   office     PLT-089: to an office person who asked for it, each approval waiting for their yes with its own link; the link
 *              asks for the office sign-in first and opens nothing for anybody else
 */

export interface Mail {
  readonly subject: string
  readonly body: string
}

const TEMPLATE_PREFIX = 'approvals'
export const APPROVAL_MAIL_TEMPLATES = Object.freeze({ request: `${TEMPLATE_PREFIX}.request`, receipt: `${TEMPLATE_PREFIX}.receipt`, office: `${TEMPLATE_PREFIX}.office` })

export interface RequestMailFacts {
  readonly companyName: string
  readonly kind: ApprovalKind
  /** The record as the partner reads it ("SO-2026-0042 revision 2", "Style AX-100"). */
  readonly label: string
  readonly question: string
  readonly dueAt: Date
}

export function requestMail(locale: ApprovalLocale, facts: RequestMailFacts, url: string): Mail {
  const what = KIND_RULES[facts.kind].name[locale].toLowerCase()
  const due = shortDayOf(facts.dueAt, locale)
  if (locale === 'it') {
    return {
      subject: `Da approvare: ${what} — ${facts.label} — ${facts.companyName}`,
      body: [
        'Buongiorno,',
        '',
        `${facts.companyName} vi chiede di approvare: ${what}, ${facts.label}.`,
        facts.question,
        '',
        `Aprite il link per vedere tutto e rispondere (approvare${KIND_RULES[facts.kind].withChanges ? ', approvare con modifiche' : ''} o rifiutare), entro il ${due}:`,
        url,
        '',
        'Una sola risposta per richiesta, firmata con il vostro nome; dopo la risposta il link non apre più nulla. Il link è solo per voi: non inoltratelo.',
      ].join('\n'),
    }
  }
  return {
    subject: `To approve: ${what} — ${facts.label} — ${facts.companyName}`,
    body: [
      'Hello,',
      '',
      `${facts.companyName} asks you to approve: ${what}, ${facts.label}.`,
      facts.question,
      '',
      `Open the link to see everything and answer (approve${KIND_RULES[facts.kind].withChanges ? ', approve with changes' : ''} or refuse) by ${due}:`,
      url,
      '',
      'One answer per request, signed with your name; after the answer the link opens nothing. The link is for you only: please do not forward it.',
    ].join('\n'),
  }
}

export interface ReceiptFacts {
  readonly companyName: string
  readonly kind: ApprovalKind
  readonly label: string
  readonly status: ApprovalStatus
  readonly typedName: string
  readonly answeredAt: Date
  readonly answer: string | null
}

export function receiptMail(locale: ApprovalLocale, facts: ReceiptFacts): Mail {
  const what = KIND_RULES[facts.kind].name[locale].toLowerCase()
  const decided = decidedWords(facts.kind, facts.status, facts.typedName, facts.answeredAt, locale)
  if (locale === 'it') {
    return {
      subject: `Ricevuta della vostra risposta: ${what} — ${facts.label}`,
      body: ['Buongiorno,', '', `abbiamo ricevuto la vostra risposta su ${what}, ${facts.label}, per ${facts.companyName}:`, decided, ...(facts.answer ? ['', `Le vostre parole: ${facts.answer}`] : []), '', 'Conservate questa mail come ricevuta.'].join('\n'),
    }
  }
  return {
    subject: `Receipt of your answer: ${what} — ${facts.label}`,
    body: ['Hello,', '', `we received your answer on ${what}, ${facts.label}, for ${facts.companyName}:`, decided, ...(facts.answer ? ['', `Your words: ${facts.answer}`] : []), '', 'Keep this mail as your receipt.'].join('\n'),
  }
}

export interface OfficeMailItem {
  /** The record as the office reads it ("Q-2026-0142"). */
  readonly label: string
  readonly url: string
}

/** PLT-089: the office approvals waiting for the person, each with its link (at most 20; "and N more in the app"). */
export function officeApprovalsMail(locale: ApprovalLocale, items: readonly OfficeMailItem[], more: number): Mail {
  const count = items.length + more
  if (locale === 'it') {
    return {
      subject: count === 1 ? `Un'approvazione attende il tuo sì: ${items[0]?.label ?? ''}` : `${count} approvazioni attendono il tuo sì`,
      body: [
        'Buongiorno,',
        '',
        count === 1 ? "un'approvazione attende la tua decisione:" : `${count} approvazioni attendono la tua decisione:`,
        ...items.map((item) => `- ${item.label}: ${item.url}`),
        ...(more > 0 ? [`… e altre ${more} nell'app (Home › Approvazioni).`] : []),
        '',
        "Ogni link chiede prima di accedere all'ufficio (con il codice a due fattori se il tuo ruolo lo richiede) e apre la decisione solo per te.",
      ].join('\n'),
    }
  }
  return {
    subject: count === 1 ? `An approval waits for your yes: ${items[0]?.label ?? ''}` : `${count} approvals wait for your yes`,
    body: [
      'Hello,',
      '',
      count === 1 ? 'an approval waits for your decision:' : `${count} approvals wait for your decision:`,
      ...items.map((item) => `- ${item.label}: ${item.url}`),
      ...(more > 0 ? [`… and ${more} more in the app (Home › Approvals).`] : []),
      '',
      'Each link asks you to sign in to the office first (with the two-factor code when your role asks for it) and opens the decision for you only.',
    ].join('\n'),
  }
}
