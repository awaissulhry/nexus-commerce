import type { Grains } from '../../model'
import type { BySizeView } from '../versions/api'
import type { CostSheetAbilities, Phrase } from '../versions/model'

/**
 * Style › Cost › Cost by size: the suggested size surcharge for big sizes (B-W2b-430 on B-W2b-420's by-size read; design
 * products.styles style.cost.bysize "Suggested size surcharge for big sizes (W2b)"; FIN-016), pure: one row per size of the
 * version (its cost, how far above the base size, the price surcharge that keeps the target margin, the style's own
 * surcharge now) and why "Use this surcharge" waits (sales' route: pricelists.manage and the price grain; a suggestion needs
 * the version's target margin; the same amount already set changes nothing).
 */

export interface SizeRow {
  readonly size: string
  readonly base: boolean
  readonly total: string | null
  readonly complete: boolean
  readonly extraCost: string | null
  readonly extraPct: string | null
  /** null: no suggestion for this size (not big enough, or no target margin). */
  readonly suggested: string | null
  readonly suggestedFor: boolean
  readonly current: { readonly amount: string | null; readonly currency: string | null; readonly pct: string | null } | null
}

export function sizeRowsOf(view: BySizeView): SizeRow[] {
  return view.sizes.map((size) => {
    const split = view.split.find((cell) => cell.size === size)
    const surcharge = view.surcharges.find((entry) => entry.size === size)
    return {
      size,
      base: size === view.baseSize,
      total: split?.total ?? null,
      complete: split?.complete ?? false,
      extraCost: surcharge?.extraCost ?? null,
      extraPct: surcharge?.extraPct ?? null,
      suggested: surcharge?.priceSurcharge ?? null,
      suggestedFor: !!surcharge,
      current: surcharge?.current ? { amount: surcharge.current.amount ?? null, currency: surcharge.current.currency, pct: surcharge.current.pct ?? null } : null,
    }
  })
}

/** Why "Use this surcharge" waits for a size, or null. */
export function surchargeHeld(row: SizeRow, can: CostSheetAbilities, grains: Grains, currency: string, busy: boolean): Phrase | null {
  if (!can.surcharge) return { key: 'bysize.heldRight' }
  if (!grains.price) return { key: 'bysize.heldGrain' }
  if (!row.suggested) return { key: 'bysize.heldNoTarget' }
  if (row.current?.amount && row.current.currency === currency && Number(row.current.amount) === Number(row.suggested)) return { key: 'bysize.heldSame' }
  if (busy) return { key: 'verHeld.busy' }
  return null
}
