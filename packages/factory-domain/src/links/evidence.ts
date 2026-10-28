import { ForbiddenError, ValidationError, type Issue } from '../core/errors'
import { actionRule, EVIDENCE_ACTIONS, type EvidenceAction, type LinkAction, type LinkPurpose } from './purposes'

/**
 * The evidence of a link's use (plan A1 §3.10: "a quote accept also asks for a typed name, and checks the email when
 * known"; ported from the old app's acceptance evidence, apps/factory/src/lib/quotes/evidence.ts, EPQ.5: the typed
 * "Nome e cognome", server time, hashed client address and user agent, CAD art. 20). Every open and every answer of a
 * link leaves one evidence row; these rules decide what it holds and refuse an answer that lacks what its purpose asks.
 *
 *   typed name   trimmed, inner spaces collapsed, Unicode NFC; 2 to 200 characters with at least one letter and no
 *                control character (the old app: 2 to 200 after trimming). Kept as typed.
 *   email check  MATCHED     the person typed the address the link was sent to (trimmed, lower case)
 *                NOT_KNOWN   the action checks the address but the link has none: nothing to compare
 *                NOT_ASKED   the action does not check it
 *                A typed address that differs is refused; nothing is stored for it. The typed address itself is never
 *                stored: only the outcome.
 *   user agent   at most 300 characters (the old app), control characters removed.
 * The client address is stored only as the API's HMAC of its /24 or /64 (the office sessions' ipHash).
 */

export const TYPED_NAME_MIN = 2
export const TYPED_NAME_MAX = 200
export const USER_AGENT_MAX = 300

export const EMAIL_CHECKS = ['MATCHED', 'NOT_KNOWN', 'NOT_ASKED'] as const
export type EmailCheck = (typeof EMAIL_CHECKS)[number]

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u
const CONTROL_ALL = /[\u0000-\u001f\u007f-\u009f]/gu
const LETTER = /\p{L}/u

/** The typed name as stored: NFC, trimmed, inner whitespace collapsed to one space. */
export function normalizeTypedName(value: string): string {
  return value.normalize('NFC').replace(/\s+/gu, ' ').trim()
}

/** What is wrong with a (normalized) typed name, or null. */
export function typedNameProblem(name: string): string | null {
  if (name.length < TYPED_NAME_MIN || name.length > TYPED_NAME_MAX) return `Type your full name (${TYPED_NAME_MIN} to ${TYPED_NAME_MAX} characters).`
  if (CONTROL.test(name)) return 'The name holds a character that cannot be typed.'
  if (!LETTER.test(name)) return 'Type your full name in letters.'
  return null
}

/** An address as compared: trimmed and lower case (the office's sign-in names follow the same rule). */
export const normalizeLinkEmail = (value: string): string => value.trim().toLowerCase()

/** The user agent as stored: control characters removed, at most 300 characters; null without one. */
export function userAgentOf(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const clean = value.replace(CONTROL_ALL, '').trim().slice(0, USER_AGENT_MAX)
  return clean === '' ? null : clean
}

export interface EvidenceInput {
  readonly typedName?: string | null | undefined
  readonly email?: string | null | undefined
}

/** What the evidence row of one use holds (the API adds the link, the time, the address hash, the user agent). */
export interface EvidenceDraft {
  readonly action: EvidenceAction
  /** The use counts against the link's use limit. */
  readonly counts: boolean
  readonly typedName: string | null
  readonly emailCheck: EmailCheck
}

/**
 * The evidence of `action` on a link of `purpose`, or the refusal: a ForbiddenError when the purpose does not allow the
 * action, a ValidationError naming `typedName` or `email` when the answer lacks what the purpose asks.
 */
export function evidenceFor(purpose: LinkPurpose, action: LinkAction, link: { readonly email: string | null }, input: EvidenceInput = {}): EvidenceDraft {
  const rule = actionRule(purpose, action)
  if (!rule) throw new ForbiddenError('This link cannot do that.')
  const issues: Issue[] = []

  let typedName: string | null = null
  const typed = typeof input.typedName === 'string' ? normalizeTypedName(input.typedName) : ''
  if (rule.typedName === 'none') {
    typedName = null
  } else if (typed === '') {
    if (rule.typedName === 'required') issues.push({ path: 'typedName', message: 'Type your full name to confirm.' })
  } else {
    const problem = typedNameProblem(typed)
    if (problem) issues.push({ path: 'typedName', message: problem })
    else typedName = typed
  }

  let emailCheck: EmailCheck = 'NOT_ASKED'
  if (rule.checksEmail) {
    if (link.email === null || link.email === '') {
      emailCheck = 'NOT_KNOWN'
    } else {
      const given = typeof input.email === 'string' ? normalizeLinkEmail(input.email) : ''
      if (given === '') issues.push({ path: 'email', message: 'Type the email address this link was sent to.' })
      else if (given !== normalizeLinkEmail(link.email)) issues.push({ path: 'email', message: 'This is not the address this link was sent to.' })
      else emailCheck = 'MATCHED'
    }
  }

  if (issues.length > 0) throw new ValidationError('The answer is not complete.', issues)
  return { action: EVIDENCE_ACTIONS[action], counts: rule.counts, typedName, emailCheck }
}

/** What the page must ask before an action: a typed name, the email address. */
export function evidenceNeeds(purpose: LinkPurpose, action: LinkAction, link: { readonly email: string | null }): { readonly typedName: 'required' | 'optional' | 'none'; readonly email: boolean } {
  const rule = actionRule(purpose, action)
  if (!rule) return { typedName: 'none', email: false }
  return { typedName: rule.typedName, email: rule.checksEmail && link.email !== null && link.email !== '' }
}
