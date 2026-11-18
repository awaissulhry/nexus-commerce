import { APPROVAL_DECISIONS, isAnswered, KIND_RULES, type ApprovalDecision, type ApprovalKind } from '@nexus/factory-domain/approvals-out/kinds'
import { isApiError, issuePath } from '../../../lib/api/errors'
import type { Locale } from '../../../lib/i18n/locales'
import type { DecideForAnswer, DecideForBody, OverrideRequest, ReverseAnswer } from './api'

/**
 * F-PR-09 — the office's "Decide for <customer>" and "Reverse" on an approval asked of a customer (a sample round, a swatch, the
 * round a gate waits for, a new date, our counter-offer), pure: which act a request offers now, why it is held (in our words), the
 * decision's draft and what holds its Send, the body sent, a refusal said from its code, what was done. Every word is a key of the
 * `customer-override` catalogue (it, en). The rules are the API's (factory-domain approvals-out/rules, production-brand/override —
 * server-only modules, so their few constants are mirrored here and named): the API checks everything again.
 *
 * Wall (PW-04, PW-09 web side): the part is about ONE request of ONE customer, read in the reader's scope; another customer's id
 * reads as "not there any more" — never "another customer's".
 */

export const NS = 'customer-override'
export const NAMESPACES = [NS] as const

/** The office right both acts need (production-brand/permissions PRODUCTION_BRAND_OVERRIDE). */
export const OVERRIDE_RIGHT = 'production.brand.override'

/** The customer's own word: nobody decides it for them or reverses it (mirror of approvals-out/rules OWN_WORD_KINDS). */
export const OWN_WORD_KINDS: readonly ApprovalKind[] = Object.freeze(['CONCESSION', 'REVISED_ORDER', 'SIGNATURE', 'PROOF'])
export const isOwnWord = (kind: ApprovalKind): boolean => OWN_WORD_KINDS.includes(kind)

/** The limits the API checks (approvals-out/rules APPROVAL_LIMITS, OVERRIDE_LIMITS). */
export const OVERRIDE_LIMITS = Object.freeze({ reason: 1000, answer: 4000, typedNameMin: 2, typedName: 200 })

/** What a reversal does to its record (mirror of production-brand/override REVERSE_EFFECTS; an unknown one is said plainly). */
export const KNOWN_EFFECTS = ['ROUND_UNDER_REVIEW', 'GATE_WAITING', 'SWATCH_UNDECIDED', 'ASK_AGAIN', 'MARK_ONLY'] as const

/** Every refusal code the two routes send (`refusal/<CODE>`), each with its words in the catalogue. */
export const KNOWN_REFUSALS = ['OWN_WORD', 'NOT_OPEN', 'ANSWERED', 'OWN_ASK', 'NOT_ANSWERED', 'REVERSED', 'PENDING', 'HELD', 'NO_APPROVER', 'CUT', 'LEATHER_CUT', 'APPLIED'] as const

/** A phrase of the catalogue: its key and parameters. */
export interface Phrase {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}

export type OverrideAct = 'decide' | 'reverse'

// ---- which act, and why it is held --------------------------------------------------------------------------------------------

/** The act a request offers now: an open request is decided for the customer; an answer not reversed yet is reversed; else none. */
export function actOf(request: Pick<OverrideRequest, 'status' | 'reversed'>): OverrideAct | null {
  if (request.status === 'OPEN') return 'decide'
  if (isAnswered(request.status) && request.reversed === null) return 'reverse'
  return null
}

export interface HeldContext {
  /** The reader holds production.brand.override (somewhere: the API says per customer through `may`). */
  readonly can: boolean
  readonly offline: boolean
  readonly busy: boolean
  readonly locale: Locale
}

/** Why the act is held, in our words (null: it may go): the right first, then the request's own state, then the reader's scope. */
export function overrideHeld(request: Pick<OverrideRequest, 'kind' | 'status' | 'reversed' | 'override' | 'may'>, act: OverrideAct, context: HeldContext): Phrase | null {
  if (!context.can) return { key: 'held.noRight' }
  if (isOwnWord(request.kind)) return { key: 'held.ownWord', params: { kind: KIND_RULES[request.kind].name[context.locale] } }
  if (request.override !== null) return { key: 'held.pending' }
  if (act === 'decide') {
    if (request.status !== 'OPEN') return { key: isAnswered(request.status) ? 'held.answered' : 'held.notOpen' }
    // Never the person who asked the customer (Owner answer 11-10 Q3), or a right that does not reach this customer.
    if (!request.may.decideForParty) return { key: 'held.notYours' }
  } else {
    if (request.reversed !== null) return { key: 'held.reversed' }
    if (!isAnswered(request.status)) return { key: 'held.notAnswered' }
    if (!request.may.reverse) return { key: 'held.noReach' }
  }
  if (context.busy) return { key: 'held.busy' }
  if (context.offline) return { key: 'held.offline' }
  return null
}

/**
 * Of a record's requests (newest first), the one its part is about: an open one (to decide for the customer), else the newest
 * answer not reversed yet (to reverse), else the newest reversed one (said as reversed); null: nothing asked of the customer.
 */
export function pickRequest<R extends Pick<OverrideRequest, 'status' | 'reversed'>>(requests: readonly R[]): R | null {
  return requests.find((request) => request.status === 'OPEN') ?? requests.find((request) => isAnswered(request.status) && request.reversed === null) ?? requests.find((request) => request.reversed !== null) ?? null
}

// ---- what the part says about the request ---------------------------------------------------------------------------------------

export type OverrideFact =
  | { readonly kind: 'decidedFor'; readonly name: string | null; readonly reason: string }
  | { readonly kind: 'reversed'; readonly name: string | null; readonly at: string; readonly reason: string }
  | { readonly kind: 'pending'; readonly act: 'DECIDE_FOR' | 'REVERSE'; readonly taskId: string }

/** Decided by us for the customer, its answer reversed, an override waiting for a second person — in that order. */
export function factsOf(request: Pick<OverrideRequest, 'decidedForParty' | 'reversed' | 'override'>): OverrideFact[] {
  const facts: OverrideFact[] = []
  if (request.decidedForParty) facts.push({ kind: 'decidedFor', name: request.decidedForParty.byName, reason: request.decidedForParty.reason })
  if (request.reversed) facts.push({ kind: 'reversed', name: request.reversed.byName, at: request.reversed.at, reason: request.reversed.reason })
  if (request.override) facts.push({ kind: 'pending', act: request.override.act, taskId: request.override.taskId })
  return facts
}

/** Where a second person grants it: its task in Home › Approvals (with the company prefix). */
export const taskHref = (prefix: string, taskId: string): string => `${prefix}/home/approvals?open=${encodeURIComponent(taskId)}`

/** What reversing this answer does, before it is done (the API says exactly what it did afterwards). */
export function reverseWhatKey(request: Pick<OverrideRequest, 'kind' | 'record'>): string {
  if (request.record.type === 'SampleRound') return 'reverse.what.SampleRound'
  if (request.record.type === 'SampleSwatch') return 'reverse.what.SampleSwatch'
  if (request.kind === 'REPROMISE') return 'reverse.what.REPROMISE'
  if (request.kind === 'COUNTER_OFFER') return 'reverse.what.COUNTER_OFFER'
  return 'reverse.what.other'
}

/** A reversal's effect in our words. */
export const effectKey = (effect: string): string => ((KNOWN_EFFECTS as readonly string[]).includes(effect) ? `effect.${effect}` : 'effect.other')

// ---- the decision we take for the customer ----------------------------------------------------------------------------------------

export interface DecideDraft {
  readonly decision: ApprovalDecision | null
  /** What should change, or why it is refused (the customer reads it). */
  readonly answer: string
  /** Why we decide for them (the customer reads it). */
  readonly reason: string
  /** The office person's typed name (prefilled with their own). */
  readonly typedName: string
}

export type DecideField = 'decision' | 'answer' | 'reason' | 'typedName'

export const emptyDecideDraft = (typedName: string): DecideDraft => ({ decision: null, answer: '', reason: '', typedName })

/** The decisions the kind allows (approve with changes only where it may). */
export const decisionsFor = (kind: ApprovalKind): ApprovalDecision[] => APPROVAL_DECISIONS.filter((decision) => decision !== 'APPROVED_WITH_CHANGES' || KIND_RULES[kind].withChanges)

/** Why "Decide for <customer>" is held in the dialog (null: it may be sent) — the API's own checks, said first. */
export function decideDraftHeld(kind: ApprovalKind, draft: DecideDraft): Phrase | null {
  if (!draft.decision || !decisionsFor(kind).includes(draft.decision)) return { key: 'decide.held.pick' }
  const answer = draft.answer.trim()
  if (draft.decision !== 'APPROVED' && answer === '') return { key: draft.decision === 'REFUSED' ? 'decide.held.why' : 'decide.held.changes' }
  if (answer.length > OVERRIDE_LIMITS.answer) return { key: 'decide.held.answerLong', params: { max: OVERRIDE_LIMITS.answer } }
  const reason = reasonHeld(draft.reason)
  if (reason) return reason
  const name = draft.typedName.trim()
  if (name.length < OVERRIDE_LIMITS.typedNameMin) return { key: 'decide.held.typedName' }
  if (name.length > OVERRIDE_LIMITS.typedName) return { key: 'decide.held.typedNameLong', params: { max: OVERRIDE_LIMITS.typedName } }
  return null
}

/** Why the reason holds the Send (both acts): the customer reads it, so it is said in words, 1 to 1000 characters. */
export function reasonHeld(reason: string): Phrase | null {
  const words = reason.trim()
  if (words === '') return { key: 'held.reason' }
  if (words.length > OVERRIDE_LIMITS.reason) return { key: 'held.reasonLong', params: { max: OVERRIDE_LIMITS.reason } }
  return null
}

/** The body of POST …/decide-for-party from the draft (a plain approval sends no words). */
export function decideBodyOf(request: Pick<OverrideRequest, 'version'>, draft: DecideDraft & { readonly decision: ApprovalDecision }): DecideForBody {
  const answer = draft.answer.trim()
  return {
    version: request.version,
    decision: draft.decision,
    ...(draft.decision !== 'APPROVED' && answer !== '' ? { answer } : {}),
    typedName: draft.typedName.trim(),
    reason: draft.reason.trim(),
  }
}

// ---- a refused act, and what was done ----------------------------------------------------------------------------------------------

/** The refusal's code the API sent (`refusal/<CODE>`, also on the 403 of the person who asked), else null. */
export function refusalCodeOf(error: unknown): string | null {
  if (!isApiError(error)) return null
  for (const issue of error.issues) {
    const path = issuePath(issue)
    if (path.startsWith('refusal/')) return path.slice('refusal/'.length)
  }
  return null
}

export interface OverrideProblem {
  readonly phrase: Phrase
  /** The fields the API named (a 400). */
  readonly fields: Partial<Record<DecideField, Phrase>>
  /** The request changed or is gone: the part reads it again. */
  readonly reload: boolean
}

const FIELD_OF_PATH: Readonly<Record<string, DecideField>> = { 'body/decision': 'decision', 'body/answer': 'answer', 'body/reason': 'reason', 'body/typedName': 'typedName' }

/** A refused act in our words: its code first, then the kind of the answer (another customer's id reads as gone, neutral). */
export function overrideProblem(error: unknown): OverrideProblem {
  if (!isApiError(error)) return { phrase: { key: 'refusal.failed' }, fields: {}, reload: false }
  const code = refusalCodeOf(error)
  if (code) return { phrase: { key: (KNOWN_REFUSALS as readonly string[]).includes(code) ? `refusal.${code}` : 'refusal.other' }, fields: {}, reload: true }
  switch (error.kind) {
    case 'conflict':
      return { phrase: { key: 'refusal.stale' }, fields: {}, reload: true }
    case 'invalid': {
      const fields: Partial<Record<DecideField, Phrase>> = {}
      for (const issue of error.issues) {
        const field = FIELD_OF_PATH[issuePath(issue).replace(/\./g, '/')]
        if (field) fields[field] = { key: `field.${field}` }
      }
      return { phrase: { key: 'refusal.invalid' }, fields, reload: false }
    }
    case 'forbidden':
      return { phrase: { key: 'refusal.forbidden' }, fields: {}, reload: true }
    case 'not_found':
      return { phrase: { key: 'refusal.notFound' }, fields: {}, reload: true }
    case 'step_up':
      return { phrase: { key: 'refusal.stepUp' }, fields: {}, reload: false }
    case 'rate_limited':
      return { phrase: { key: 'refusal.rateLimited' }, fields: {}, reload: false }
    case 'unavailable':
      return { phrase: { key: 'refusal.unavailable' }, fields: {}, reload: false }
    default:
      return { phrase: { key: 'refusal.failed' }, fields: {}, reload: false }
  }
}

/** A failed read in our words (another customer's request, or one the reader may not see, is hidden: the part draws nothing). */
export function readOutcomeOf(error: unknown): { readonly hidden: true } | { readonly hidden: false; readonly problem: string } {
  if (isApiError(error) && (error.kind === 'not_found' || error.kind === 'forbidden')) return { hidden: true }
  if (isApiError(error) && error.kind === 'unavailable') return { hidden: false, problem: 'read.offline' }
  return { hidden: false, problem: 'read.failed' }
}

/** The step-up code refused: wrong or used, too many tries, or no answer. */
export function stepUpProblemOf(error: unknown): string {
  if (!isApiError(error)) return 'stepUp.problem.unavailable'
  if (error.kind === 'rate_limited') return 'stepUp.problem.locked'
  if (error.kind === 'invalid' || error.kind === 'forbidden' || error.kind === 'signed_out') return 'stepUp.problem.wrong'
  return 'stepUp.problem.unavailable'
}

export interface OverrideOutcome {
  readonly act: OverrideAct
  /** A second person grants it first (the customer's switch): its task. */
  readonly secondPerson: boolean
  readonly taskId: string | null
  /** What a reversal did to the record (codes). */
  readonly effects: readonly string[]
  /** A new date asked again: its link ONCE, for a customer without a portal (never kept beyond this part). */
  readonly link: string | null
}

export const outcomeOfDecide = (answer: Pick<DecideForAnswer, 'override'>): OverrideOutcome => ({ act: 'decide', secondPerson: answer.override.outcome === 'SECOND_PERSON', taskId: answer.override.taskId, effects: [], link: null })

export const outcomeOfReverse = (answer: Pick<ReverseAnswer, 'override' | 'effects' | 'asked'>): OverrideOutcome => ({
  act: 'reverse',
  secondPerson: answer.override.outcome === 'SECOND_PERSON',
  taskId: answer.override.taskId,
  effects: [...answer.effects],
  link: answer.asked?.url ?? null,
})

/** The outcome's title key: done, or asked of a second person. */
export const outcomeKey = (outcome: Pick<OverrideOutcome, 'act' | 'secondPerson'>): string => (outcome.secondPerson ? 'done.secondPerson' : outcome.act === 'decide' ? 'done.decided' : 'done.reversed')
