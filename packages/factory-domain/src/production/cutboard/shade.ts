import { asksOneShadePerOrder, type ShadeRule } from '../../inventory/reservations/shade'

/**
 * One shade lot per order on the work order's Leather panel (B-W2b-130; SCM-206; design production.workorders "Materials &
 * leather" › Leather: "lot(s) and shade group (W1 the cutter keeps one dye batch by hand; W2b one shade lot rule) · hides"),
 * pure. For each leather of a work order, the shade lots (factory-domain inventory/reservations/shade `shadeLotKey`: a lot and its
 * shade group, else its W1 shade text) of the hides it holds, has reserved or has cut:
 *
 *   NONE    no hide yet (the first hide reserved, picked or cut sets the shade lot)
 *   ONE     one shade lot: the garments of the order match
 *   MIXED   two shade lots or more: under the ORDER rule this breaks it (an override at the pick or the reserve, a lead's
 *           "Cut anyway" at the table, or hides from before the rule); under GARMENT or OFF it is allowed
 *
 * A hide of an out-of-shade group breaks the ORDER rule on its own. Counts only: no money, no person.
 */

export const SHADE_VERDICTS = ['NONE', 'ONE', 'MIXED'] as const
export type ShadeVerdict = (typeof SHADE_VERDICTS)[number]

export interface ShadeLotUse {
  readonly key: string
  readonly outOfShade: boolean
}

export interface ShadeSummary {
  readonly verdict: ShadeVerdict
  /** The rule asks one shade lot per order and the hides break it (MIXED, or a hide out of shade). */
  readonly breaksRule: boolean
  readonly outOfShade: boolean
}

export function shadeSummary(rule: ShadeRule, lots: readonly ShadeLotUse[]): ShadeSummary {
  const keys = new Set(lots.map((lot) => lot.key))
  const verdict: ShadeVerdict = keys.size === 0 ? 'NONE' : keys.size === 1 ? 'ONE' : 'MIXED'
  const outOfShade = lots.some((lot) => lot.outOfShade)
  return { verdict, breaksRule: asksOneShadePerOrder(rule) && (verdict === 'MIXED' || outOfShade), outOfShade }
}
