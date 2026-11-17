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
