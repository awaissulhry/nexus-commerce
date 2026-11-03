import type { Issue } from '../../core/errors'
import { acceptedDecisionProblem } from '../defects/severity'
import type { DefectClass } from '../defects/rules'

/**
 * A concession asked of the customer (B-W2b-113; QHS-085 "Customer concession by link, with NCR"; plan §12: the link page is
 * links.approve, W2b-3 — until then the office records the customer's written answer with its file). Pure: what an ask
 * needs, what an answer needs, when each may be written. The …_quality_problems_w2b_guards trigger (NcrConcession_guard)
 * holds the same rules for every login:
 *
 *   ask     the deviation in words and what we propose, of a CUSTOMER or BRAND of the NCR's company (and the person asked
 *           when known), while the NCR is neither CLOSED nor CANCELLED. Never on a CRITICAL NCR: a critical defect is never
 *           sold under a concession (factory-domain quality/defects/severity acceptedDecisionProblem; Reg. (EU) 2016/425).
 *           Its words change while it is ASKED.
 *   answer  ACCEPTED or REFUSED, once (both final): when, the name of who answered for the customer, their words (required
 *           when refused) and their written answer (a file of the concession). May come after the NCR closed.
 */

export const CONCESSION_STATUSES = ['ASKED', 'ACCEPTED', 'REFUSED'] as const
export type ConcessionStatus = (typeof CONCESSION_STATUSES)[number]
export const CONCESSION_ANSWERS = ['ACCEPTED', 'REFUSED'] as const
export type ConcessionAnswer = (typeof CONCESSION_ANSWERS)[number]

export const CONCESSION_LIMITS = Object.freeze({
  ask: 1000,
  proposal: 1000,
  answer: 2000,
  answeredBy: 120,
  /** Concessions of one NCR. */
  perNcr: 10,
})

/** The record type of a concession's files (its written answer). */
export const CONCESSION_RECORD = 'NcrConcession' as const

/** Why a concession may not be asked on this NCR now (null: it may), in words. */
export function askHeld(ncr: { readonly stage: string; readonly severity: DefectClass }): string | null {
  if (ncr.stage === 'CLOSED' || ncr.stage === 'CANCELLED') return `The NCR is ${ncr.stage === 'CLOSED' ? 'closed' : 'cancelled'}: no concession is asked any more.`
  return acceptedDecisionProblem('CONCESSION', ncr.severity)
}

const words = (value: string | null | undefined): string => (value ?? '').trim()

/** An ask as typed: problems at body/<field>. `creating`: both texts are required. */
export function askProblems(draft: { readonly ask?: string | null | undefined; readonly proposal?: string | null | undefined }, creating: boolean): Issue[] {
  const problems: Issue[] = []
  if ((creating || draft.ask !== undefined) && words(draft.ask) === '') problems.push({ path: 'body/ask', message: 'Say the deviation the customer is asked to accept.' })
  if (words(draft.ask).length > CONCESSION_LIMITS.ask) problems.push({ path: 'body/ask', message: `At most ${CONCESSION_LIMITS.ask} characters.` })
  if ((creating || draft.proposal !== undefined) && words(draft.proposal) === '') problems.push({ path: 'body/proposal', message: 'Say what we propose (a discount, a delivery as they are, a later replacement…).' })
  if (words(draft.proposal).length > CONCESSION_LIMITS.proposal) problems.push({ path: 'body/proposal', message: `At most ${CONCESSION_LIMITS.proposal} characters.` })
  return problems
}

export interface AnswerDraft {
  readonly status: ConcessionAnswer
  readonly answer?: string | null | undefined
  readonly answeredBy: string
  readonly answeredAt: Date
}

/** An answer as recorded: problems at body/<field>. */
export function answerProblems(draft: AnswerDraft, askedAt: Date, now: Date): Issue[] {
  const problems: Issue[] = []
  if (words(draft.answeredBy) === '') problems.push({ path: 'body/answeredBy', message: 'The name of who answered for the customer.' })
  if (words(draft.answeredBy).length > CONCESSION_LIMITS.answeredBy) problems.push({ path: 'body/answeredBy', message: `At most ${CONCESSION_LIMITS.answeredBy} characters.` })
  if (draft.status === 'REFUSED' && words(draft.answer) === '') problems.push({ path: 'body/answer', message: 'Say why the customer refused (their words).' })
  if (words(draft.answer).length > CONCESSION_LIMITS.answer) problems.push({ path: 'body/answer', message: `At most ${CONCESSION_LIMITS.answer} characters.` })
  // A few minutes for the clocks of the screen and the server.
  if (draft.answeredAt.getTime() > now.getTime() + 5 * 60_000) problems.push({ path: 'body/answeredAt', message: 'The customer answered now or earlier.' })
  else if (draft.answeredAt.getTime() < askedAt.getTime() - 5 * 60_000) problems.push({ path: 'body/answeredAt', message: 'The customer answered after the concession was asked.' })
  return problems
}

/** Why an answer may not be recorded now (null: it may). */
export const answerHeld = (status: ConcessionStatus): string | null => (status === 'ASKED' ? null : `The concession is ${status === 'ACCEPTED' ? 'accepted' : 'refused'} already: an answer is recorded once.`)
