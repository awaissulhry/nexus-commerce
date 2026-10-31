import { isApiError, issuePath } from '../../../../lib/api/errors'
import type { Phrase } from '../../_shared/model'
import type { DecidedMethod, MethodState } from './api'

/**
 * The Costing card's rules, pure (B-W2a-80; design finance.settings sec:costing "Method: standard · moving average · FIFO
 * (locked once transactions exist — held with that reason)" and pop:method-lock): who may read (costing.view) and choose
 * (costing.method.manage), where the method comes from, why a choice is held (locked: entries rely on it; the accountant's
 * decision, GATE-ACCOUNTANT: the person confirms the accountant chose it), the reason's rule, the refusals in words.
 * Words: `finance-daily` costing.*; the method names are `finance-costing` method.name.* (B-W2a-72).
 */

const phrase = (key: string, params?: Record<string, string | number>): Phrase => (params ? { key, params } : { key })

export interface CostingAbilities {
  view: boolean
  choose: boolean
}

export const costingAbilitiesOf = (permissions: readonly string[]): CostingAbilities => {
  const held = new Set(permissions)
  return { view: held.has('costing.view'), choose: held.has('costing.method.manage') }
}

/** The card's state words: not decided (every cost provisional), chosen (locks with the first entry), locked. */
export function methodState(state: Pick<MethodState, 'method' | 'locked'>): { key: string; tone: 'warning' | 'info' | 'neutral' } {
  if (state.method === 'UNDECIDED') return { key: 'costing.state.undecided', tone: 'warning' }
  return state.locked ? { key: 'costing.state.locked', tone: 'neutral' } : { key: 'costing.state.chosen', tone: 'info' }
}

/** Where the method comes from: this company's own choice, the tenant-wide one, or nothing chosen yet. */
export const fromKey = (state: Pick<MethodState, 'from'>): string => `costing.from.${state.from}`

/** Why choosing a method waits, or null: the right, a method not locked yet, a different method picked. */
export function chooseHeld(state: MethodState | null, can: CostingAbilities, picked: DecidedMethod | null): Phrase | null {
  if (!can.choose) return phrase('costing.held.noRight')
  if (!state) return phrase('costing.held.reading')
  if (state.locked) return phrase('costing.held.locked')
  if (!picked) return phrase('costing.held.pick')
  if (picked === state.method && state.from === 'COMPANY') return phrase('costing.held.same')
  return null
}

/** The confirmation's problems (message keys): the accountant's choice ticked; a reason of 3 to 500 when one is typed. */
export function confirmProblems(input: { accountant: boolean; reason: string }): { accountant?: string; reason?: string } {
  const problems: { accountant?: string; reason?: string } = {}
  if (!input.accountant) problems.accountant = 'costing.problem.accountant'
  const reason = input.reason.trim()
  if (reason !== '' && reason.length < 3) problems.reason = 'costing.problem.reasonShort'
  else if (reason.length > 500) problems.reason = 'costing.problem.reasonLong'
  return problems
}

/** The pop-up "Why the costing method is locked": since when entries exist, when it locked, how many entries rely on it. */
export function lockWords(state: Pick<MethodState, 'locked' | 'lockedAt' | 'firstEntryAt' | 'entries'>): { since: string | null; lockedAt: string | null; entries: number } | null {
  if (!state.locked) return null
  return { since: state.firstEntryAt, lockedAt: state.lockedAt, entries: state.entries }
}

/** A refused choice in words: locked meanwhile, moved, the step-up, no right. */
export function chooseProblem(error: unknown): Phrase & { reload: boolean } {
  if (!isApiError(error)) return { key: 'costing.problem.write', reload: false }
  if (error.kind === 'conflict') {
    if (error.issues.map(issuePath).some((path) => path.split(/[./]/).includes('version'))) return { key: 'costing.problem.moved', reload: true }
    return { key: 'costing.problem.locked', reload: true }
  }
  if (error.kind === 'forbidden') return { key: 'costing.problem.forbidden', reload: false }
  if (error.kind === 'step_up') return { key: 'costing.problem.stepUp', reload: false }
  if (error.kind === 'not_found') return { key: 'costing.problem.notFound', reload: true }
  return { key: 'costing.problem.write', reload: false }
}

/** A live event that changes the card. */
export const costingTouched = (change: { type: string }): boolean => change.type === 'costing_method.changed' || change.type === 'work_order_cost.posted'
