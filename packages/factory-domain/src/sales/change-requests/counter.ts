import type { ApprovalDecision, ApprovalLocale } from '../../approvals-out/kinds'
import type { Issue } from '../../core/errors'
import type { BusinessDate } from '../../core/time'
import { ASK_RULES, dayWords, ORDER_REQUEST_KIND_WORDS, type OrderRequestKind, type RequestStatus, type Words } from './rules'

/**
 * B-PR-24 (production plan §3 "We accept, counter or refuse with words it reads", "Money: a priced counter-offer is answered
 * only by the brand's Buyer or Admin"; 08-backend §4.2 Counter; Appendix C: the counter is a COUNTER_OFFER approval; review
 * fixes R-09, R-32): our counter-offer to a customer's ask, pure. The database's guard (…_brand_asks_guards) holds the shape.
 *
 *   who       the office, on an OPEN request, once (it becomes COUNTERED), of a kind we counter (every kind but a resume: the
 *             pause is the customer's to end)
 *   what      a date (from today on), a fee (a price: whole minor units of the order's currency, 0 or more), words (1 to 2000):
 *             at least one of the three
 *   how       a COUNTER_OFFER approval request about the request (record OrderChangeRequest) asked of the customer; its question
 *             names the date and the words, never the amount ("A price applies: your buyer sees it")
 *   answered  by the customer, in Waiting for you: yes → the request ACCEPTED with the counter (the office carries it out with
 *             the counter's date, fee and words); no → the request WITHDRAWN (the customer's words stay on the approval)
 *   money     a counter with a fee above 0 is priced: only a customer role with the price grain answers it (Buyer, Admin); the
 *             others read "A price may apply: your buyer answers this counter-offer" and see no amount (R-09)
 */

export const COUNTER_LIMITS = Object.freeze({ note: 2000, fee: 2_147_483_647 })

/** What we offer instead (OrderChangeRequest.counterDate, counterFee, counterNote). */
export interface Counter {
  readonly date: BusinessDate | null
  /** Minor units of the order's currency (a price: the money.price grain); null: no fee said. */
  readonly fee: number | null
  readonly note: string | null
}

export interface CounterDraft {
  readonly date?: BusinessDate | null | undefined
  readonly fee?: number | null | undefined
  readonly note?: string | null | undefined
}

/** The kinds we may counter (every kind but RESUME). */
export const isCounterable = (kind: OrderRequestKind): boolean => ASK_RULES[kind].counter

const clean = (text: string | null | undefined): string => (typeof text === 'string' ? text.trim() : '')

/** The counter as stored: trimmed words, nothing said → null. */
export const counterOf = (draft: CounterDraft): Counter => ({ date: draft.date ?? null, fee: draft.fee ?? null, note: clean(draft.note) === '' ? null : clean(draft.note) })

/** The problems of a counter-offer, in words, by path (the office's dialog). */
export function counterProblems(request: { readonly kind: OrderRequestKind; readonly status: RequestStatus }, draft: CounterDraft, today: BusinessDate): Issue[] {
  if (request.status === 'COUNTERED') return [{ path: 'body', message: 'We countered this request already: the customer answers it.' }]
  if (request.status !== 'OPEN') return [{ path: 'body', message: `This request is ${request.status.toLowerCase()}: only a request that waits for our answer is countered.` }]
  if (!isCounterable(request.kind)) return [{ path: 'body', message: 'A resume is accepted or refused: the pause is the customer’s to end.' }]
  const counter = counterOf(draft)
  const issues: Issue[] = []
  if (counter.date === null && counter.fee === null && counter.note === null) issues.push({ path: 'body', message: 'Say what you offer instead: a date, a price or words.' })
  if (counter.date !== null && counter.date < today) issues.push({ path: 'body/date', message: 'A date from today on.' })
  if (counter.fee !== null && (!Number.isInteger(counter.fee) || counter.fee < 0 || counter.fee > COUNTER_LIMITS.fee)) issues.push({ path: 'body/fee', message: 'A price of 0 or more, in whole cents.' })
  if (counter.note !== null && counter.note.length > COUNTER_LIMITS.note) issues.push({ path: 'body/note', message: `At most ${COUNTER_LIMITS.note} characters.` })
  return issues
}

/** A counter with a fee above 0: answered only by a customer role with the price grain. */
export const counterPriced = (counter: Pick<Counter, 'fee'>): boolean => counter.fee !== null && counter.fee > 0

/**
 * The question of the COUNTER_OFFER approval (every reader of the customer's approvals reads it): the kind asked, the date we
 * offer, that a price applies (never the amount), our words.
 */
export function counterQuestion(kind: OrderRequestKind, counter: Counter, locale: ApprovalLocale): string {
  const it = locale === 'it'
  const asked = ORDER_REQUEST_KIND_WORDS[kind][locale]
  const parts = [it ? `La nostra controproposta alla tua richiesta «${asked}».` : `Our counter-offer to your request “${asked}”.`]
  if (counter.date !== null) parts.push(it ? `La data che proponiamo: ${dayWords(counter.date, 'it')}.` : `The date we offer: ${dayWords(counter.date, 'en')}.`)
  if (counterPriced(counter)) parts.push(it ? 'È previsto un costo: lo vede il tuo buyer.' : 'A price applies: your buyer sees it.')
  if (counter.note !== null) parts.push(counter.note)
  return parts.join(' ')
}

/** The counter as a customer reader reads it: the fee only with the price grain (else only that a price applies). */
export function counterForReader(counter: Counter, maySeePrices: boolean): { readonly date: BusinessDate | null; readonly note: string | null; readonly priced: boolean; readonly fee?: number | null } {
  const priced = counterPriced(counter)
  return maySeePrices ? { date: counter.date, note: counter.note, priced, fee: counter.fee } : { date: counter.date, note: counter.note, priced }
}

/** Why this customer person may not answer the counter-offer (null: they may), in their words. */
export function counterAnswerHeld(input: { readonly priced: boolean; readonly maySeePrices: boolean; readonly mayAnswer: boolean }, locale: ApprovalLocale = 'en'): string | null {
  const it = locale === 'it'
  if (!input.mayAnswer) return it ? 'Puoi leggere questa controproposta, non rispondere: chiedi al tuo amministratore il diritto di approvare.' : 'Your access lets you read this counter-offer, not answer it: ask your admin for the right to approve.'
  if (input.priced && !input.maySeePrices) return it ? 'Può essere previsto un costo: a questa controproposta risponde il tuo buyer.' : 'A price may apply: your buyer answers this counter-offer.'
  return null
}

/** The customer's answer to the counter, as the request's event says it (order_change_request.counter_answered). */
export const COUNTER_ANSWERS = ['ACCEPTED', 'REFUSED'] as const
export type CounterAnswer = (typeof COUNTER_ANSWERS)[number]
export const counterAnswerOf = (decision: ApprovalDecision): CounterAnswer => (decision === 'REFUSED' ? 'REFUSED' : 'ACCEPTED')

/** What the customer's answer does to the request: yes → ACCEPTED (with the counter), no → WITHDRAWN (the database's rule). */
export const counterOutcome = (decision: ApprovalDecision): 'ACCEPTED' | 'WITHDRAWN' => (decision === 'REFUSED' ? 'WITHDRAWN' : 'ACCEPTED')

/** What an accepted counter carries out: the counter's date in place of the one asked, its fee and words. */
export function acceptedWithCounter(request: { readonly requestedDate: BusinessDate | null }, counter: Counter): { readonly date: BusinessDate | null; readonly fee: number | null; readonly note: string | null } {
  return { date: counter.date ?? request.requestedDate, fee: counter.fee, note: counter.note }
}

/** The customer's words of a countered request with our offer (the request card; the amount never in words). */
export function counteredWords(counter: Counter): Words {
  const date = counter.date !== null ? { it: ` · ${dayWords(counter.date, 'it')}`, en: ` · ${dayWords(counter.date, 'en')}` } : { it: '', en: '' }
  const price = counterPriced(counter) ? { it: ' · è previsto un costo', en: ' · a price applies' } : { it: '', en: '' }
  return { it: `La nostra controproposta${date.it}${price.it}`, en: `Our counter-offer${date.en}${price.en}` }
}

// ---- B-PR-26 (production plan §3 "We accept, counter or refuse with words it reads", "Money: a priced counter-offer is
// answered only by the brand's Buyer or Admin"; lead pick L4; review fixes R-05, R-32): where a countered request stands, what
// the office may answer now, and what the customer reads of the counter-offer's approval (Italian to the customer: "voi") -----

/**
 * Where our counter-offer stands — its COUNTER_OFFER approval request's status:
 *   WAITING  OPEN: the customer answers it (Waiting for you); the office waits
 *   AGREED   APPROVED: the customer said yes; the office accepts the request, which carries it out with the counter (its date
 *            in place of the one asked: acceptedWithCounter) — the request stays COUNTERED until then (the database makes
 *            COUNTERED → ACCEPTED exactly when the counter was approved)
 *   REFUSED  the customer said no: the request is WITHDRAWN (the office's side of the answer does it: the approvals' settle)
 *   LAPSED   EXPIRED or WITHDRAWN: no answer comes; the office refuses the request with words (a request is countered once);
 *            B-PR-40: also a yes we put back (B-PR-30b, the counter's answer reversed before the accept carried it out): it is no
 *            yes any more, and the database refuses the request's accept
 */
export const COUNTER_STATES = ['WAITING', 'AGREED', 'REFUSED', 'LAPSED'] as const
export type CounterState = (typeof COUNTER_STATES)[number]

/**
 * The counter's state from its approval request's status (null: not a status an approval has) and whether its answer was put
 * back (B-PR-40: a yes put back before the accept carried it out lapses — the office refuses the request with words; a no put
 * back leaves its request withdrawn).
 */
export function counterStateOf(approvalStatus: string | null | undefined, reversed = false): CounterState | null {
  switch (approvalStatus) {
    case 'OPEN':
      return 'WAITING'
    case 'APPROVED':
    case 'APPROVED_WITH_CHANGES':
      return reversed ? 'LAPSED' : 'AGREED' // B-PR-40
    case 'REFUSED':
      return 'REFUSED'
    case 'EXPIRED':
    case 'WITHDRAWN':
      return 'LAPSED'
    default:
      return null
  }
}

/** The counter's state in the customer's words (the portal: "voi") and in the office's. */
export const COUNTER_STATE_WORDS: Readonly<Record<CounterState, { readonly customer: Words; readonly office: Words }>> = Object.freeze({
  WAITING: {
    customer: { it: 'La nostra controproposta aspetta la vostra risposta', en: 'Our counter-offer waits for your answer' },
    office: { it: 'Controproposta inviata: risponde il cliente', en: 'Counter-offer sent: the customer answers' },
  },
  AGREED: {
    customer: { it: 'Avete accettato la nostra controproposta: la eseguiamo', en: 'You said yes to our counter-offer: we carry it out' },
    office: { it: 'Il cliente ha accettato la controproposta: accetta la richiesta per eseguirla', en: 'The customer said yes to the counter-offer: accept the request to carry it out' },
  },
  REFUSED: {
    customer: { it: 'Avete rifiutato la nostra controproposta: la richiesta è ritirata', en: 'You said no to our counter-offer: the request is withdrawn' },
    office: { it: 'Il cliente ha rifiutato la controproposta: la richiesta è ritirata', en: 'The customer said no to the counter-offer: the request is withdrawn' },
  },
  // B-PR-40: a yes put back lapses too (the words say so, never only "expired").
  LAPSED: {
    customer: { it: 'La nostra controproposta non è più valida: vi rispondiamo noi', en: 'Our counter-offer no longer stands: we will answer you' },
    office: {
      it: 'La controproposta è scaduta, è stata ritirata o il suo sì è stato revocato: rifiuta la richiesta con un motivo',
      en: 'The counter-offer expired, was withdrawn or its yes was put back: refuse the request with a reason',
    },
  },
})

/** Who the request waits on now: us (the office answers), the customer (our counter-offer), or nobody (it is closed). */
export type WaitingOn = 'US' | 'CUSTOMER' | null

/** What the office may answer now (each still needs the kind's permission over the order: ASK_RULES[kind].answeredWith). */
export interface OfficeAnswers {
  readonly accept: boolean
  readonly refuse: boolean
  readonly counter: boolean
  readonly waitingOn: WaitingOn
  /** Where it stands, in the office's words. */
  readonly words: Words
}

const WAITS_FOR_US: Words = Object.freeze({ it: 'Aspetta la nostra risposta', en: 'Waits for our answer' })
const CLOSED_WORDS: Readonly<Record<'ACCEPTED' | 'REFUSED' | 'WITHDRAWN', Words>> = Object.freeze({
  ACCEPTED: { it: 'Accettata', en: 'Accepted' },
  REFUSED: { it: 'Rifiutata', en: 'Refused' },
  WITHDRAWN: { it: 'Ritirata dal cliente', en: 'Withdrawn by the customer' },
})

/**
 * What the office may answer, from the request's state and its counter's: an OPEN request is accepted, countered (every kind but
 * a resume) or refused; a COUNTERED one waits for the customer, is accepted once the customer said yes (it is carried out with
 * the counter), and refused once the counter lapsed (it is countered only once); an answered or withdrawn one takes nothing.
 */
export function officeAnswersOf(request: { readonly kind: OrderRequestKind; readonly status: RequestStatus }, counter: CounterState | null): OfficeAnswers {
  if (request.status === 'OPEN') return { accept: true, refuse: true, counter: isCounterable(request.kind), waitingOn: 'US', words: WAITS_FOR_US }
  if (request.status !== 'COUNTERED') return { accept: false, refuse: false, counter: false, waitingOn: null, words: CLOSED_WORDS[request.status] }
  switch (counter) {
    case 'WAITING':
      return { accept: false, refuse: false, counter: false, waitingOn: 'CUSTOMER', words: COUNTER_STATE_WORDS.WAITING.office }
    case 'AGREED':
      return { accept: true, refuse: false, counter: false, waitingOn: 'US', words: COUNTER_STATE_WORDS.AGREED.office }
    case 'REFUSED':
      // The customer's no withdraws the request (the approvals' settle); until it has, nothing is answered.
      return { accept: false, refuse: false, counter: false, waitingOn: null, words: COUNTER_STATE_WORDS.REFUSED.office }
    default:
      // LAPSED, or a counter not found: no answer comes from the customer; we refuse with words.
      return { accept: false, refuse: true, counter: false, waitingOn: 'US', words: COUNTER_STATE_WORDS.LAPSED.office }
  }
}

export type OfficeAnswer = 'ACCEPTED' | 'REFUSED' | 'COUNTERED'

/** Why the office may not answer this way now (null: it may), in words, by path (`request/<STATUS>` or `request/<COUNTER>`). */
export function officeAnswerProblem(answer: OfficeAnswer, request: { readonly kind: OrderRequestKind; readonly status: RequestStatus }, counter: CounterState | null): Issue | null {
  const may = officeAnswersOf(request, counter)
  if (answer === 'ACCEPTED' ? may.accept : answer === 'REFUSED' ? may.refuse : may.counter) return null
  if (request.status === 'WITHDRAWN') return { path: 'request/WITHDRAWN', message: 'The customer withdrew this request.' }
  if (request.status === 'ACCEPTED' || request.status === 'REFUSED') return { path: `request/${request.status}`, message: 'This request is already answered.' }
  if (request.status === 'OPEN') return { path: 'request/RESUME', message: 'A resume is accepted or refused: the pause is the customer’s to end.' }
  const state = counter ?? 'LAPSED'
  const message =
    state === 'WAITING'
      ? 'Our counter-offer waits for the customer’s answer: they answer it first.'
      : state === 'AGREED'
        ? answer === 'COUNTERED'
          ? 'We countered this request already: the customer said yes, accept it to carry it out.'
          : 'The customer said yes to our counter-offer: accept the request to carry it out.'
        : state === 'REFUSED'
          ? 'The customer said no to our counter-offer: the request is withdrawn.'
          : answer === 'COUNTERED'
            ? 'A request is countered once: our counter-offer lapsed, refuse the request with words.'
            : 'Our counter-offer no longer stands (it lapsed, or its yes was put back): refuse the request with words; it cannot be accepted without the customer’s yes.' // B-PR-40
  return { path: `request/COUNTER_${state}`, message }
}

/** The generic "Ask for approval" never asks a counter-offer: only our answer to a customer's request does. */
export const ASKED_ONLY_FROM_COUNTER = 'A counter-offer is made from the customer’s request in Home › Approvals, not asked here.'

/** Why a counter-offer takes no answer now: the request no longer waits for it (answered, withdrawn), in the reader's words. */
export function counterGoneWords(locale: ApprovalLocale): string {
  return locale === 'it' ? 'Questa controproposta non è più in attesa: la richiesta è cambiata nel frattempo.' : 'This counter-offer no longer waits: the request moved on since.'
}

/**
 * Who of the customer answers a counter-offer (null: this answerer may), in their words: in its portal only (Waiting for you —
 * the money rule rests on the person's role, a link carries none), and a priced one only by a role with the price grain (the
 * Buyer, the Admin); the others read that a price may apply.
 */
export function counterAnswererHeld(input: { readonly priced: boolean; readonly via: 'LINK' | 'PORTAL'; readonly seesPrices: boolean }, locale: ApprovalLocale): string | null {
  const it = locale === 'it'
  if (input.via === 'LINK') return it ? 'Rispondete a questa controproposta nel vostro portale.' : 'Answer this counter-offer in your portal.'
  if (input.priced && !input.seesPrices) return it ? 'Può essere previsto un costo: a questa controproposta risponde il vostro buyer.' : 'A price may apply: your buyer answers this counter-offer.'
  return null
}

/** One fact of the counter-offer's page (the approvals engine's Fact). */
export interface CounterFact {
  readonly label: string
  readonly value: string
}

/**
 * What the customer reads on the counter-offer's page (every reader of its approvals: never the amount, only whether a price
 * applies): the order, the request it answers, the date asked, the date we offer, the price, our words.
 */
export function counterFactsOf(input: { readonly kind: OrderRequestKind; readonly orderNumber: string; readonly askedOn: BusinessDate; readonly requestedDate: BusinessDate | null; readonly counter: Counter }, locale: ApprovalLocale): CounterFact[] {
  const it = locale === 'it'
  const { counter } = input
  const facts: CounterFact[] = [
    { label: it ? 'Ordine' : 'Order', value: input.orderNumber },
    { label: it ? 'La vostra richiesta' : 'Your request', value: `${ORDER_REQUEST_KIND_WORDS[input.kind][locale]} · ${dayWords(input.askedOn, locale)}` },
  ]
  if (input.requestedDate !== null) facts.push({ label: it ? 'La data che avete chiesto' : 'The date you asked', value: dayWords(input.requestedDate, locale) })
  if (counter.date !== null) facts.push({ label: it ? 'La data che proponiamo' : 'The date we offer', value: dayWords(counter.date, locale) })
  if (counter.fee !== null) facts.push({ label: it ? 'Costo' : 'Price', value: counterPriced(counter) ? (it ? 'È previsto un costo: lo vede il vostro buyer' : 'A price applies: your buyer sees it') : it ? 'Nessun costo' : 'No price' })
  if (counter.note !== null) facts.push({ label: it ? 'Le nostre parole' : 'Our words', value: counter.note })
  return facts
}
// ---- end B-PR-26
