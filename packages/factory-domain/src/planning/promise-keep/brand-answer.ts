import type { ApprovalLocale, ApprovalStatus, Words } from '../../approvals-out/kinds'
import { PROMISE_REASON_CODES, PROMISE_REASON_WORDS, type PromiseReasonCode } from '../promise/rules'
import { longDay, type ProposalSize } from './repromise'

/**
 * B-PR-28 (production plan §3 "Brand alone: accept or refuse a new date", plain rule "A brand's 'no' to a new date does not
 * undo the date (capacity is shared). It sets 'waiting on us' and tells us."; 08-backend §4.3; 07-control (e); lead picks L3; the
 * Owner rule 2026-11-16: "One brand must not be able to see anything related to any other brand. But we, as the production
 * unit, should be able to see it all. And manage it all as well."): the customer answers a new promise date, pure.
 *
 *   ask       sales accepts a re-promise asking the customer (`askBrand`): in the same command the promise is given as
 *             today (the date stands) and a REPROMISE approval request is asked on the sales order — its question names the
 *             order, its line, each size from → to and the reason in the customer's words, and that the date stands
 *   answer    the customer accepts, or refuses with its words (approvals-out: a refusal always says why), in its portal or
 *             by the request's link; never "with changes" (the kind does not offer it)
 *   accepted  the date stands; the order's timeline says the customer accepted it
 *   refused   the date stands too (it is the factory's word: capacity is shared); a follow-up task on the order for us
 *             (its supervisor, else the person who asked) — while it is open the order waits on us — and the office reads
 *             the customer's words on the order's thread
 *   held      an open question about a date that moved again since (a newer re-promise of the line accepted) or an order
 *             that no longer waits takes no answer; a newer question of the same line withdraws the older one
 * The words never name a load, a lane, another order or another customer: the order's own dates and the curated reason only.
 */

/** Audit actions on the order (the request's own rows are the approvals engine's). */
export const ASK_CUSTOMER_ACTION = 'planning.promise.askCustomer'
export const CUSTOMER_ACCEPTED_ACTION = 'planning.promise.customerAccepted'
export const CUSTOMER_REFUSED_ACTION = 'planning.promise.customerRefused'

/** The generic "Ask for approval" never asks a new date: it is asked only when sales accepts a re-promise. */
export const ASKED_ONLY_FROM_REPROMISE = 'A new date is asked of the customer when sales accepts a re-promise with "Ask the customer" (Planning › Promise dates).'

/** What a sales order's REPROMISE request is about (kept on its ask's audit row). */
export interface RepromiseAsked {
  readonly proposalId: string
  readonly orderLineId: string
  readonly sizes: readonly ProposalSize[]
  readonly reasonCode: string
}

export interface RepromiseFacts {
  readonly orderNumber: string
  readonly customerRef: string | null
  readonly lineSeq: number
  readonly style: { readonly code: string; readonly name: string }
  readonly colourway: { readonly code: string; readonly name: string } | null
  readonly sizes: readonly ProposalSize[]
  readonly reasonCode: string
}

const reasonOf = (code: string, locale: ApprovalLocale): string => PROMISE_REASON_WORDS[(PROMISE_REASON_CODES as readonly string[]).includes(code) ? (code as PromiseReasonCode) : 'PLANNING'][locale]

const sizeLabel = (size: string | null, locale: ApprovalLocale): string => (size === null ? (locale === 'it' ? 'Capo' : 'Garment') : locale === 'it' ? `Taglia ${size}` : `Size ${size}`)

const fromTo = (entry: ProposalSize, locale: ApprovalLocale): string => `${entry.from ? `${longDay(entry.from, locale)} → ` : ''}${longDay(entry.to, locale)}`

/** "The date stands either way": what the customer reads before answering. */
export const DATE_STANDS_WORDS: Words = Object.freeze({
  it: 'La nuova data resta quella indicata. Se non vi va bene, rifiutatela e diteci perché: la riguardiamo con voi.',
  en: 'The new date stands as given. If it does not suit you, refuse it and tell us why: we look at it with you.',
})

/**
 * The question of the REPROMISE request (every reader of the customer's approvals reads it; at most 4000 characters): the
 * order and its reference, the line, each size from → to, the reason in its curated words, and that the date stands.
 */
export function repromiseQuestion(facts: RepromiseFacts, locale: ApprovalLocale): string {
  const it = locale === 'it'
  const ref = facts.customerRef ? (it ? ` (vostro riferimento ${facts.customerRef})` : ` (your reference ${facts.customerRef})`) : ''
  const what = `${facts.style.code} ${facts.style.name}${facts.colourway ? ` ${facts.colourway.code}` : ''}`
  const sizes = facts.sizes.map((entry) => `${sizeLabel(entry.size, locale)}: ${fromTo(entry, locale)}`).join('; ')
  const head = it ? `Nuova data per l'ordine ${facts.orderNumber}${ref}, riga ${facts.lineSeq} – ${what}: ${sizes}.` : `New date for order ${facts.orderNumber}${ref}, line ${facts.lineSeq} – ${what}: ${sizes}.`
  const reason = it ? `Motivo: ${reasonOf(facts.reasonCode, locale)}.` : `Reason: ${reasonOf(facts.reasonCode, locale)}.`
  return `${head} ${reason} ${DATE_STANDS_WORDS[locale]}`.slice(0, 4000)
}

/** The facts the answer page shows (the order's own dates only). */
export function repromiseFactsOf(facts: RepromiseFacts, locale: ApprovalLocale): { label: string; value: string }[] {
  const it = locale === 'it'
  return [
    { label: it ? 'Ordine' : 'Order', value: `${facts.orderNumber}${facts.customerRef ? ` · ${facts.customerRef}` : ''}` },
    { label: it ? 'Riga' : 'Line', value: `${facts.lineSeq} · ${facts.style.code} ${facts.style.name}${facts.colourway ? ` ${facts.colourway.code}` : ''}` },
    ...facts.sizes.map((entry) => ({ label: sizeLabel(entry.size, locale), value: fromTo(entry, locale) })),
    { label: it ? 'Motivo' : 'Reason', value: reasonOf(facts.reasonCode, locale) },
    { label: it ? 'Attenzione' : 'Please note', value: DATE_STANDS_WORDS[locale] },
  ]
}

/** Why an open question about a new date takes no answer now, in the reader's words (null: it may be answered). */
export function repromiseHeld(input: { readonly orderOpen: boolean; readonly movedSince: boolean }, locale: ApprovalLocale): string | null {
  const it = locale === 'it'
  if (!input.orderOpen) return it ? 'Questo ordine non attende più la vostra risposta.' : 'This order no longer waits for your answer.'
  if (input.movedSince) return it ? 'La data è cambiata di nuovo: vi chiediamo della più recente.' : 'The date changed again: we ask you about the newest one.'
  return null
}

/** The words an older question is withdrawn with, when a newer date of the same line is asked. */
export const NEWER_DATE_WORDS = 'A newer date of this line replaces it.'

/** The customer's answer to a new date, as the office's proposal shows it. */
export const CUSTOMER_ANSWERS = ['WAITING', 'ACCEPTED', 'REFUSED', 'WITHDRAWN', 'EXPIRED'] as const
export type CustomerAnswer = (typeof CUSTOMER_ANSWERS)[number]

export function customerAnswerOf(status: ApprovalStatus): CustomerAnswer {
  if (status === 'OPEN') return 'WAITING'
  if (status === 'APPROVED' || status === 'APPROVED_WITH_CHANGES') return 'ACCEPTED'
  return status
}

/** The office's words of the customer's answer (the proposal; English, as the office's other proposal words). */
export const CUSTOMER_ANSWER_WORDS: Readonly<Record<CustomerAnswer, string>> = Object.freeze({
  WAITING: 'Waiting for the customer’s answer',
  ACCEPTED: 'The customer accepted the new date',
  REFUSED: 'The customer did not accept the new date: it stands; the follow-up waits for us',
  WITHDRAWN: 'No longer asked of the customer',
  EXPIRED: 'The customer did not answer in time',
})

/** The follow-up task when the customer refuses (the office's words; their own words are on the order's thread). */
export function refusalTaskOf(input: { readonly orderNumber: string; readonly lineSeq: number; readonly sizes: readonly ProposalSize[]; readonly answer: string | null }): { readonly title: string; readonly description: string } {
  const dates = input.sizes.map((entry) => `${entry.size ?? 'every size'}: ${entry.to}`).join('; ')
  const words = input.answer?.trim() ? ` Their words: “${input.answer.trim().slice(0, 1500)}”.` : ''
  return {
    title: `The customer did not accept the new date: ${input.orderNumber} line ${input.lineSeq}`.slice(0, 200),
    description:
      `The customer did not accept the new date (${dates}).${words} The date stands. Re-plan and propose again, keep the date and tell them why in the order's thread, or answer their request if they ask to cancel. Close this task when it is handled.`.slice(0, 4000),
  }
}

// ---- B-PR-30b (production plan §3 "decide for a brand or undo"; 08-backend §4.6 "REPROMISE asked again"): putting the
// customer's answer to a new date back. The date stands either way; the customer is asked again about the same date — unless
// the order no longer waits or the line's date moved since (then the newer date is asked from the re-promise). ---------------

/** Why the customer's answer to a new date is not put back (the office reads it; null: it is, and they are asked again). */
export function repromiseReverseHeld(input: { readonly orderOpen: boolean; readonly movedSince: boolean }): Words | null {
  if (!input.orderOpen) return { it: "Questo ordine non attende più una nuova data: non c'è niente da chiedere di nuovo.", en: 'This order no longer waits for a new date: there is nothing to ask again.' }
  if (input.movedSince) return { it: 'La data è cambiata di nuovo: chiedete al cliente la più recente dalla riprogrammazione.', en: 'The date changed again since: ask the customer about the newest one from the re-promise.' }
  return null
}
