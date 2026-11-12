import { daysFrom } from '../../calendars/dates'
import type { BusinessDate } from '../../core/time'
import { PROMISE_REASON_CODES, PROMISE_REASON_WORDS, reasonProblem, type PromiseReasonCode } from '../promise/rules'

/**
 * The re-promise workflow (B-W2b-317; PLN-175; design planning.promise › repromise "Proposed date per size from the plan ·
 * Reason (Listbox) · Message to the customer (preview, their language) · What happens: sales accepts; the customer sees it in
 * the portal and gets the message", action "Send to sales for acceptance").
 *
 *   propose   planning (planning.promise.manage) proposes new dates per size with a reason and the words to the customer;
 *             the proposal waits for sales as a task on the order. Nothing is promised yet: the promise is the factory's
 *             word to the brand, given by sales.
 *   accept    sales (orders.manage over the order) gives the word: the RE_PROMISE rows are written, the line's date follows
 *             its latest size (W1's promise date, so the portal and every W1 reader see it) and, when sales says so, the
 *             message goes to the customer on the order's thread by e-mail (a person sends it; never a rule) and the rows
 *             say when the customer was told.
 *   decline   sales says no, with its words; nothing changes.
 *   withdraw  the planner who proposed takes it back.
 *
 * Nobody accepts or declines their own proposal (the Owner included): another person of sales gives the word. One proposal
 * waits per line at a time. No approval rule is involved (the approval engine's rules stay off).
 */

export const PROPOSAL_STATES = ['WAITING', 'ACCEPTED', 'DECLINED', 'WITHDRAWN', 'CLOSED'] as const
export type ProposalState = (typeof PROPOSAL_STATES)[number]
export const PROPOSAL_DECISIONS = ['ACCEPTED', 'DECLINED', 'WITHDRAWN'] as const
export type ProposalDecision = (typeof PROPOSAL_DECISIONS)[number]

/** Audit actions of the workflow (the proposal and its decision are their own audit rows on the order). */
export const PROPOSE_ACTION = 'planning.promise.propose'
export const DECISION_ACTIONS = Object.freeze({ ACCEPTED: 'planning.promise.accept', DECLINED: 'planning.promise.decline', WITHDRAWN: 'planning.promise.withdraw' } as const satisfies Record<ProposalDecision, `${string}.${string}`>)

/** The state of a proposal: its decision, else its task (OPEN: waiting; closed without a decision: CLOSED). */
export function proposalStateOf(decision: ProposalDecision | null, taskStatus: 'OPEN' | 'DONE' | 'CANCELLED' | null): ProposalState {
  if (decision) return decision
  return taskStatus === 'OPEN' ? 'WAITING' : 'CLOSED'
}

export const REPROMISE_REFUSALS = Object.freeze({
  WAITING_EXISTS: 'A re-promise of this line already waits for sales: withdraw it or let sales decide first.',
  NOT_WAITING: 'This re-promise no longer waits for sales.',
  OWN_PROPOSAL: 'Nobody decides their own re-promise: another person of sales gives the word.',
  NOT_PROPOSER: 'Only the person who proposed it takes it back.',
  STALE: 'The promise changed since this re-promise was proposed: propose it again from the dates now.',
  NO_RECIPIENT: 'The customer has no e-mail address on the order or its contacts: name one, or accept without telling them here.',
})

export interface ProposalSize {
  /** null: every size (a made-to-measure unit). */
  readonly size: string | null
  /** Its promise when proposed (null: none). */
  readonly from: BusinessDate | null
  readonly to: BusinessDate
}

/** Every problem of the planner's new dates at once (beyond B-W2b-301's checks of the sizes and days). */
export function repromiseProblems(input: { readonly sizes: readonly ProposalSize[]; readonly reasonCode: string | null | undefined }): { path: string; message: string }[] {
  const problems: { path: string; message: string }[] = []
  if (input.reasonCode === null || input.reasonCode === undefined) problems.push({ path: 'body/reasonCode', message: 'Say why the date changes (the customer reads the reason in their words).' })
  else {
    const unknown = reasonProblem(input.reasonCode)
    if (unknown) problems.push({ path: 'body/reasonCode', message: unknown })
  }
  input.sizes.forEach((entry, index) => {
    if (entry.from === null) problems.push({ path: `body/sizes/${index}/size`, message: `${entry.size === null ? 'The unit' : `Size ${entry.size}`} has no promise yet: record its first promise instead.` })
    else if (entry.from === entry.to) problems.push({ path: `body/sizes/${index}/date`, message: `${entry.size === null ? 'The unit' : `Size ${entry.size}`} is promised for ${entry.to} already.` })
  })
  return problems
}

/** The reasons offered (the Listbox), in both languages. */
export const reasonChoices = () => PROMISE_REASON_CODES.map((code) => ({ code, it: PROMISE_REASON_WORDS[code].it, en: PROMISE_REASON_WORDS[code].en }))

// ---- the message to the customer ------------------------------------------------------------------------------------------

const MONTHS: Readonly<Record<'it' | 'en', readonly string[]>> = Object.freeze({
  it: ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'],
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
})

export type MessageLanguage = 'it' | 'en'
export const messageLanguageOf = (language: string | null | undefined): MessageLanguage => (language === 'en' ? 'en' : 'it')

/** "11 dicembre 2026" / "11 December 2026". */
export const longDay = (date: BusinessDate, language: MessageLanguage): string => `${Number(date.slice(8, 10))} ${MONTHS[language][Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`

export interface MessageInput {
  readonly language: MessageLanguage
  readonly orderNumber: string
  readonly customerRef: string | null
  readonly lineSeq: number
  readonly style: { readonly code: string; readonly name: string }
  readonly colourway: { readonly code: string; readonly name: string } | null
  readonly sizes: readonly ProposalSize[]
  readonly reasonCode: string
}

/**
 * The words to the customer, in their language: the order, the line, each size from → to, the reason in its curated words
 * (never the office's note), and an apology when a date moves later. The planner may write other words; sales may edit them
 * before sending.
 */
export function customerMessageOf(input: MessageInput): { subject: string; body: string } {
  const { language } = input
  const code = (PROMISE_REASON_CODES as readonly string[]).includes(input.reasonCode) ? (input.reasonCode as PromiseReasonCode) : 'PLANNING'
  const reason = PROMISE_REASON_WORDS[code][language]
  const later = input.sizes.some((entry) => entry.from !== null && daysFrom(entry.from, entry.to) > 0)
  const ref = input.customerRef ? (language === 'it' ? ` (vostro riferimento ${input.customerRef})` : ` (your reference ${input.customerRef})`) : ''
  const what = `${input.style.code} ${input.style.name}${input.colourway ? ` ${input.colourway.code}` : ''}`
  const lines = input.sizes.map((entry) => {
    const label = entry.size === null ? (language === 'it' ? 'capo' : 'garment') : language === 'it' ? `taglia ${entry.size}` : `size ${entry.size}`
    return `- ${label}: ${entry.from ? `${longDay(entry.from, language)} → ` : ''}${longDay(entry.to, language)}`
  })
  if (language === 'it') {
    return {
      subject: `Ordine ${input.orderNumber}: nuova data di consegna`,
      body: [
        'Gentile cliente,',
        '',
        `la data prevista per l'ordine ${input.orderNumber}${ref}, riga ${input.lineSeq} – ${what}, cambia:`,
        ...lines,
        '',
        `Motivo: ${reason}.`,
        ...(later ? ['Ci scusiamo per il disagio.'] : []),
        'Per qualsiasi domanda rispondete pure a questo messaggio.',
      ].join('\n'),
    }
  }
  return {
    subject: `Order ${input.orderNumber}: new delivery date`,
    body: [
      'Dear customer,',
      '',
      `the date planned for order ${input.orderNumber}${ref}, line ${input.lineSeq} – ${what}, changes:`,
      ...lines,
      '',
      `Reason: ${reason}.`,
      ...(later ? ['We are sorry for the inconvenience.'] : []),
      'If you have any question, just reply to this message.',
    ].join('\n'),
  }
}

/** "52: 4 Dec → 11 Dec; 54: 4 Dec → 18 Dec" (office words, English). */
export const proposalWords = (sizes: readonly ProposalSize[], dayWords: (date: BusinessDate) => string): string =>
  sizes.map((entry) => `${entry.size === null ? 'every size' : entry.size}: ${entry.from ? `${dayWords(entry.from)} → ` : ''}${dayWords(entry.to)}`).join('; ')
