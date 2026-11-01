/**
 * LegalGate's rules (B-W2b-28, design part LegalGate): a card of legal preconditions that holds a switch until every
 * one is met — piece pay at a site, one person's efficiency, machine signals, the People settings that need a basis.
 *
 * - **Met or not**: only `met` counts as met. `missing`, `expired` (a basis that ran out) and `unknown` (not checked)
 *   all hold the switch, each named in the reason ("2 conditions missing: Worker notice, Payroll codes").
 * - **Folds when on**: a gate that is on with every condition met folds to one line ("On since 1 Dec · every condition
 *   met", with Show conditions). A gate that is on while a condition is no longer met never folds: it says so.
 * - The switch itself is the app's command; the gate only says whether it may run and why not.
 */

export type LegalItemState = 'met' | 'missing' | 'expired' | 'unknown'

export interface LegalGateSummary<T extends { state: LegalItemState }> {
  total: number
  met: number
  /** The conditions not met, in order. */
  open: T[]
}

export function legalGateSummary<T extends { state: LegalItemState }>(items: readonly T[]): LegalGateSummary<T> {
  const open = items.filter((i) => i.state !== 'met')
  return { total: items.length, met: items.length - open.length, open }
}

export interface LegalGateWords {
  /** "2 conditions missing: A, B". */
  held: (count: number, names: readonly string[]) => string
  /** A gate with no conditions listed (never allowed to run on nothing). */
  none: string
}

/** Why the switch is held, or null when every condition is met. A gate with no conditions is held too. */
export function legalGateHeld(items: readonly { state: LegalItemState; label: string }[], words: LegalGateWords): string | null {
  if (items.length === 0) return words.none
  const { open } = legalGateSummary(items)
  return open.length ? words.held(open.length, open.map((i) => i.label)) : null
}

/** Folds to one line: on, with every condition met. */
export function legalGateFolds(on: boolean, items: readonly { state: LegalItemState }[]): boolean {
  return on && items.length > 0 && legalGateSummary(items).open.length === 0
}
