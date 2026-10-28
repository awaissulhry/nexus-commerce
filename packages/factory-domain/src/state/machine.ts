import { InvalidStateError, type Issue } from '../core/errors'

/**
 * State machines (plan A1 §2.1 "Status", §2.5; features PLT-033, PLT-097). Every status column of the factory changes
 * only along its module's machine, defined here once with `defineMachine` and checked by `command()` in the API before
 * the write (one transaction: the check, the move and its audit row).
 *
 *   const quoteMachine = defineMachine({
 *     name: 'quote',
 *     states: ['DRAFT', 'SENT', 'ACCEPTED', 'CANCELLED'],
 *     transitions: { DRAFT: ['SENT', 'CANCELLED'], SENT: ['ACCEPTED', 'CANCELLED'] },
 *     guards: { SENT: (facts: { lines: number }) => (facts.lines > 0 ? [] : ['at least one line']) },
 *   })
 *   assertTransition(quoteMachine, 'DRAFT', 'SENT', { lines: 2 })   // passes
 *   assertTransition(quoteMachine, 'SENT', 'DRAFT')                  // InvalidStateError
 *
 * A state with no transitions out of it is final. A guard belongs to the target state: it receives the facts the
 * caller loaded and returns what is missing, in words for the person ("a released style revision"), so a refusal says
 * exactly what to do (PLT-097). Pure: no I/O; the facts are passed in.
 */

/** Returns what is missing for the move; an empty list allows it. */
export type Guard<State extends string, Facts> = (facts: Facts, move: { readonly from: State; readonly to: State }) => readonly string[]

export interface MachineSpec<State extends string, Facts> {
  /** The record kind, for messages (`quote`, `work order`). */
  readonly name: string
  readonly states: readonly State[]
  /** Every allowed move: a state → the states it may go to. A state not listed here is final. */
  readonly transitions: { readonly [From in State]?: readonly State[] }
  /** Conditions of the moves INTO a state. */
  readonly guards?: { readonly [To in State]?: Guard<State, Facts> }
}

export interface Machine<State extends string = string, Facts = undefined> extends MachineSpec<State, Facts> {
  /** The states no move leaves. */
  readonly finals: readonly State[]
}

export class MachineDefinitionError extends Error {
  override name = 'MachineDefinitionError'
}

/**
 * Declares a machine; a mistake in it (no states, a state twice, a move from or to an unknown state, a move to itself,
 * a move listed twice, a guard for a state no move enters) throws at once, so at import.
 */
export function defineMachine<const State extends string, Facts = undefined>(spec: MachineSpec<State, Facts>): Machine<State, Facts> {
  const problems: string[] = []
  const at = `machine ${JSON.stringify(spec.name)}`
  if (typeof spec.name !== 'string' || spec.name.trim() === '') problems.push('a machine needs a name')
  if (!Array.isArray(spec.states) || spec.states.length === 0) problems.push(`${at} has no states`)
  const states = new Set<string>()
  for (const state of spec.states ?? []) {
    if (typeof state !== 'string' || state === '') problems.push(`${at}: a state must be a non-empty string`)
    else if (states.has(state)) problems.push(`${at}: state ${state} is listed twice`)
    states.add(state)
  }
  const entered = new Set<string>()
  for (const [from, targets] of Object.entries(spec.transitions ?? {}) as [string, readonly string[] | undefined][]) {
    if (!states.has(from)) problems.push(`${at}: a move from unknown state ${from}`)
    if (!Array.isArray(targets)) {
      problems.push(`${at}: the moves from ${from} must be a list`)
      continue
    }
    const seen = new Set<string>()
    for (const to of targets) {
      if (!states.has(to)) problems.push(`${at}: a move ${from} → ${to}, an unknown state`)
      if (to === from) problems.push(`${at}: a move ${from} → ${from} changes nothing`)
      if (seen.has(to)) problems.push(`${at}: the move ${from} → ${to} is listed twice`)
      seen.add(to)
      entered.add(to)
    }
  }
  for (const [to, guard] of Object.entries(spec.guards ?? {})) {
    if (!entered.has(to)) problems.push(`${at}: a guard for ${to}, which no move enters`)
    if (typeof guard !== 'function') problems.push(`${at}: the guard for ${to} must be a function`)
  }
  if (problems.length > 0) throw new MachineDefinitionError(problems.join('; '))

  const finals = spec.states.filter((state) => (spec.transitions[state] ?? []).length === 0)
  return Object.freeze({
    ...spec,
    states: Object.freeze([...spec.states]),
    transitions: Object.freeze({ ...spec.transitions }),
    ...(spec.guards ? { guards: Object.freeze({ ...spec.guards }) } : {}),
    finals: Object.freeze(finals),
  })
}

export function isState<State extends string, Facts>(machine: Machine<State, Facts>, value: unknown): value is State {
  return typeof value === 'string' && (machine.states as readonly string[]).includes(value)
}

/** The states a record in `from` may move to (before guards). Empty for a final or unknown state. */
export function nextStates<State extends string, Facts>(machine: Machine<State, Facts>, from: State): readonly State[] {
  return isState(machine, from) ? (machine.transitions[from] ?? []) : []
}

export type TransitionRefusal = 'unknown_state' | 'not_allowed' | 'guard'

export type TransitionCheck<State extends string> =
  | { readonly ok: true; readonly from: State; readonly to: State }
  | {
      readonly ok: false
      readonly reason: TransitionRefusal
      readonly from: string
      readonly to: string
      /** What a guard found missing (reason `guard`). */
      readonly missing: readonly string[]
      /** For the person: what is refused and why. */
      readonly message: string
    }

type FactsArgument<Facts> = undefined extends Facts ? [facts?: Facts] : [facts: Facts]

/** May a record move from `from` to `to`? Runs the guard of `to` with the facts. Never throws for a refusal. */
export function canTransition<State extends string, Facts>(
  machine: Machine<State, Facts>,
  from: string,
  to: string,
  ...[facts]: FactsArgument<Facts>
): TransitionCheck<State> {
  const refuse = (reason: TransitionRefusal, message: string, missing: readonly string[] = []) =>
    ({ ok: false, reason, from, to, missing: Object.freeze([...missing]), message }) as const
  if (!isState(machine, from)) return refuse('unknown_state', `A ${machine.name} cannot be in state ${String(from)}.`)
  if (!isState(machine, to)) return refuse('unknown_state', `A ${machine.name} has no state ${String(to)}.`)
  if (!nextStates(machine, from).includes(to)) {
    const allowed = nextStates(machine, from)
    const options = allowed.length === 0 ? `${from} is final` : `from ${from} it can go to ${allowed.join(', ')}`
    return refuse('not_allowed', `A ${machine.name} in ${from} cannot move to ${to} (${options}).`)
  }
  const guard = machine.guards?.[to]
  if (guard) {
    const missing = guard(facts as Facts, { from, to })
    if (missing.length > 0) {
      return refuse('guard', `A ${machine.name} cannot move from ${from} to ${to} yet; missing: ${missing.join('; ')}.`, missing)
    }
  }
  return { ok: true, from, to }
}

/** The refusal of a move: InvalidStateError (409 `invalid_state`), with each missing condition as an issue. */
export class TransitionError extends InvalidStateError {
  override name = 'TransitionError'
  override readonly issues: readonly Issue[]
  constructor(readonly refusal: Extract<TransitionCheck<string>, { ok: false }>) {
    super(refusal.message)
    this.issues = refusal.missing.map((message) => ({ path: 'state', message }))
  }
}

/** Throws a TransitionError unless the move is allowed. */
export function assertTransition<State extends string, Facts>(
  machine: Machine<State, Facts>,
  from: string,
  to: string,
  ...facts: FactsArgument<Facts>
): asserts to is State {
  const check = canTransition(machine, from, to, ...facts)
  if (!check.ok) throw new TransitionError(check)
}
