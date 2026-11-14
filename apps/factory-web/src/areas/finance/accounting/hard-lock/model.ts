import { isApiError, issuePath } from '../../../../lib/api/errors'
import type { AccountingCan, LockFacts, Phrase } from '../model'
import { REFUSAL_CODES } from '../model'

/**
 * B-W2b-426 — "Close August for good?" (design finance.accounting pop:hard-lock; FIN-155; B-W2b-408's POST
 * /accounting/locks level HARD), the pure rules: what opens the pop-up (the lock permission, accounting.close, a month, not
 * closed already), what holds its button (all of that and the typed phrase, in either language), what closing means in
 * words, and the month's problems a refused close names (every `problem/<CODE>` of the 409, not only the first). The API
 * asks, in order: accounting.close, the phrase, the month's problems, then a fresh code — last, so a close refused anyway
 * asks none. Nothing is sent to the accountant.
 */

const phrase = (key: string, params?: Record<string, string | number>): Phrase => (params ? { key, params } : { key })

export type HardFacts = Omit<LockFacts, 'level' | 'phrase' | 'can'> & { readonly can: Pick<AccountingCan, 'lock' | 'close'> }

/** Why "Close <month> for good…" cannot open the pop-up (null: it can): the permissions, a month, closed already, running. */
export function hardOpenHeld(facts: HardFacts): Phrase | null {
  if (!facts.can.lock) return phrase('lock.held.noLock')
  if (!facts.can.close) return phrase('hard.held.noClose')
  if (!facts.month) return phrase('lock.held.chooseMonth')
  if (facts.current?.status === 'LOCKED' && facts.current.level === 'HARD') return phrase('lock.held.alreadyHard')
  if (facts.busy) return phrase('held.busy')
  return null
}

/** What closing a month for good means (the month in words), said before the phrase is typed. */
export function hardConsequences(month: string): Phrase[] {
  return [phrase('hard.what.nothing', { month }), phrase('hard.what.correct', { month }), phrase('hard.what.lift'), phrase('hard.what.accountant')]
}

/** The month's problems a refused close names (every `problem/<CODE>` the screen has words for), in the API's order. */
export function closeProblemCodes(error: unknown): string[] {
  if (!isApiError(error) || error.kind !== 'conflict') return []
  const codes = error.issues.map(issuePath).map((path) => /^problem[/.]([A-Z_]+)$/.exec(path)?.[1]).filter((code): code is string => !!code && (REFUSAL_CODES as readonly string[]).includes(code))
  return [...new Set(codes)]
}
