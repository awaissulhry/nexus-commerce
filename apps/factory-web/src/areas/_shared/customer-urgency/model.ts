import { URGENCY_LOCK_REASON_MAX, URGENCY_OFFICE_BATCH_MAX } from '@nexus/factory-domain/production-brand/urgency'
import { isApiError } from '../../../lib/api/errors'
import type { UrgencyAnswer } from './api'

/**
 * F-CW-302 (customer Work tab plan §4; 13-backend §8; lead settles S7, S14) — the urgency window without a screen: Set to regular… ·
 * Lock… · Unlock… on a customer's order (production plan §3: production.brand.override, a fresh code, no second person — it is our
 * own plan). MOVED here as it is from the work order's Customer card (F-PR-05b), which still shows it; the ONE Orders sheet mounts
 * the same window from its row ⋯ and More ▾. The words stay the card's (`production`: `customerCard.dialog.*`,
 * `customerCard.urgency.*`): one set of words for one window.
 *
 * The wall (PW-10): the result names only the orders that were asked; any other row, or one the reader does not reach, is counted.
 */

/** A phrase of the `production` catalogue. */
export interface Phrase {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}

export const CARD_LIMITS = Object.freeze({ reason: URGENCY_LOCK_REASON_MAX, orders: URGENCY_OFFICE_BATCH_MAX })

/** An order the window names. */
export interface UrgencyTarget {
  readonly id: string
  readonly number: string
  readonly customerRef: string | null
}

/** The urgency acts the office has: Set to regular… (an Urgent order), Lock (not locked), Unlock (locked). */
export type UrgencyAct = 'regular' | 'lock' | 'unlock'

export interface UrgencyDialog {
  readonly act: UrgencyAct
  readonly partyId: string
  readonly orders: readonly UrgencyTarget[]
}

/** Why the dialog's Send waits: a reason the customer reads for Set to regular and Lock (one line, at most 500); busy. */
export function urgencyDialogHeld(act: UrgencyAct, reason: string, busy: boolean): Phrase | null {
  if (act !== 'unlock') {
    if (reason.trim() === '') return { key: 'customerCard.urgency.held.reason' }
    if (/[\r\n]/.test(reason)) return { key: 'customerCard.urgency.held.line' }
    if (reason.trim().length > CARD_LIMITS.reason) return { key: 'customerCard.urgency.held.long', params: { count: CARD_LIMITS.reason } }
  }
  if (busy) return { key: 'held.busy' }
  return null
}

/** What a set-back, lock or unlock did: per order done, or why not (the API's words, only for this card's own orders); others counted. */
export interface UrgencyOutcome {
  readonly act: UrgencyAct
  readonly done: readonly string[]
  readonly notDone: ReadonlyArray<{ readonly number: string; readonly words: { readonly it: string; readonly en: string } | null }>
  /** Rows the reader does not reach, or not of this card: counted, never named (PW-10). */
  readonly notShown: number
}

export function urgencyOutcomeOf(act: UrgencyAct, answer: UrgencyAnswer, asked: readonly UrgencyTarget[]): UrgencyOutcome {
  const own = (orderId: string) => asked.some((order) => order.id === orderId)
  const rows = answer.results.filter((row) => own(row.orderId))
  return {
    act,
    done: rows.filter((row) => row.done).map((row) => row.number),
    notDone: rows.filter((row) => !row.done).map((row) => ({ number: row.number, words: row.words })),
    notShown: answer.notFound + (answer.results.length - rows.length),
  }
}

/** A refused write in the card's words (a 409 carries each row's words: the card reads again). */
export function urgencyProblemOf(error: unknown): Phrase {
  if (isApiError(error)) {
    if (error.kind === 'forbidden') return { key: 'customerCard.urgency.problem.forbidden' }
    if (error.kind === 'conflict') return { key: 'customerCard.urgency.problem.conflict' }
    if (error.kind === 'not_found') return { key: 'customerCard.urgency.problem.gone' }
    if (error.kind === 'invalid') return { key: 'customerCard.urgency.problem.invalid' }
    if (error.kind === 'unavailable') return { key: 'error.offline' }
  }
  return { key: 'customerCard.urgency.problem.failed' }
}

// ---- the window's model, as its hook holds it and its views draw it ---------------------------------------------------------------

export interface UrgencyOverrideModel {
  readonly dialog: UrgencyDialog | null
  readonly busy: boolean
  /** A refused write, said in the dialog. */
  readonly problem: Phrase | null
  /** The last set-back, lock or unlock: per order done or why not. */
  readonly outcome: UrgencyOutcome | null
  /** Design cases: the dialog's reason and lock. */
  readonly draft?: { readonly reason?: string; readonly lock?: boolean }
}

export interface UrgencyOverrideActions {
  onDialog?: (dialog: UrgencyDialog | null) => void
  onUrgency?: (input: { readonly act: UrgencyAct; readonly partyId: string; readonly orders: readonly UrgencyTarget[]; readonly reason: string; readonly lock: boolean }) => void
  onDismissOutcome?: () => void
}
