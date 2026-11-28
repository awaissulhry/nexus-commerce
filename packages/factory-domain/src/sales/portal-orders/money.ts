import type { BusinessDate } from '../../core/time'

/**
 * The customer's Money tab of its order (owb- order workflow, S1 po2.2; design order-workflow § 5m; the S1 Shape "MONEY"): totals,
 * the payment plan's steps with their state, invoices and credit notes, the customer's "I paid" notices. Every amount is the office's
 * ONE rule (sales/orders later-columns orderMoneyPartsOf): this file only says each step's state, and when a notice is refused.
 * The customer's "I paid: tell the factory…" is a NOTICE: it changes nothing owed (only the factory records a payment). Pure.
 */

export const PLAN_STEP_KINDS = ['DEPOSIT', 'MILESTONE', 'REST'] as const
export type PlanStepKind = (typeof PLAN_STEP_KINDS)[number]
export const PLAN_STATES = ['PAID', 'PART_PAID', 'DUE', 'LATE', 'LATER'] as const
export type PlanState = (typeof PLAN_STATES)[number]
export const ADDS_UP_KEYS = ['LINES', 'CHARGES', 'VAT', 'CREDIT_NOTES', 'PAID'] as const
export type AddsUpKey = (typeof ADDS_UP_KEYS)[number]
export const MONEY_DOCUMENT_KINDS = ['INVOICE', 'CREDIT_NOTE'] as const
export const NOTICE_STATES = ['OPEN', 'RECORDED', 'DISMISSED'] as const

/** The id of the rest of the order (what no step covers): it names no deposit request and no milestone. */
export const REST_STEP_ID = 'REST'

export interface StepFacts {
  /** Minor units. */
  readonly amount: number
  /** Placed on it so far (minor units). */
  readonly paid: number
  /** The day it is due; null: none set. */
  readonly due: BusinessDate | null
  /** The office marked it paid (or settled it otherwise). */
  readonly settled: boolean
  /** With no day: due now (a deposit) rather than later (the rest, before it ships). */
  readonly dueWithoutDay: boolean
}

/** A step's state for the customer: paid, part paid, due (today or no day and due now), late (its day passed), later. */
export function stepStateOf(step: StepFacts, today: BusinessDate): PlanState {
  if (step.settled || (step.amount > 0 && step.paid >= step.amount)) return 'PAID'
  if (step.paid > 0) return 'PART_PAID'
  if (step.due === null) return step.dueWithoutDay ? 'DUE' : 'LATER'
  if (step.due < today) return 'LATE'
  return step.due === today ? 'DUE' : 'LATER'
}

export const MONEY_WORDS = Object.freeze({
  NO_PRICES: { en: 'Prices are not part of your access.', it: 'I prezzi non fanno parte del vostro accesso.' },
  NOTHING_TO_PAY: { en: 'This order has nothing still to pay.', it: 'Questo ordine non ha più niente da pagare.' },
  AMOUNT: { en: 'Say how much you paid (more than 0).', it: 'Indicate quanto avete pagato (più di 0).' },
  TOO_MUCH: { en: 'The amount is more than what is still to pay on this order.', it: 'L’importo è più di quanto resta da pagare su questo ordine.' },
  FUTURE: { en: 'The day you paid is today or earlier.', it: 'Il giorno del pagamento è oggi o prima.' },
  STEP: { en: 'Choose a step of this order’s payment plan, or none.', it: 'Scegliete un passo del piano di pagamento di questo ordine, o nessuno.' },
  FILE: { en: 'Choose a receipt you sent to the factory.', it: 'Scegliete una ricevuta che avete inviato alla fabbrica.' },
} as const)

export type NoticeRefusal = keyof typeof MONEY_WORDS

export interface NoticeFacts {
  readonly amount: number
  readonly stillToPay: number
  readonly paidOn: BusinessDate
  readonly today: BusinessDate
}

/**
 * Why the customer's "I paid" notice is refused (null: it may be sent). NOTHING_TO_PAY is a 409; the rest are 400 (an amount above what
 * is open is refused: the design's "no loophole").
 */
export function noticeProblem(facts: NoticeFacts): Exclude<NoticeRefusal, 'NO_PRICES' | 'STEP' | 'FILE'> | null {
  if (facts.stillToPay <= 0) return 'NOTHING_TO_PAY'
  if (!Number.isInteger(facts.amount) || facts.amount < 1) return 'AMOUNT'
  if (facts.amount > facts.stillToPay) return 'TOO_MUCH'
  if (facts.paidOn > facts.today) return 'FUTURE'
  return null
}
