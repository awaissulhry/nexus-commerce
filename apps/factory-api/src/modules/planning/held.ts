import type { Prisma } from '@nexus/factory-db'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { reasonWords } from '../../platform/reasons/service'
import { activeHoldsOf, type ActiveHold } from '../quality/holds/checks'
import type { Reader } from './store'

/**
 * The quality holds behind the stock the plan's Why drawer and the unusable-stock view list (B-W2a-70, the lead's
 * follow-up of #985): both read their stock through `withQualityHolds` (./inputs, the run's own rule), so a lot or hide
 * under an ACTIVE quality hold is held there too; this names the hold of each held line (its reason in both languages
 * and since when), and turns the stand-in lot of a held hide (`quality-hold:<hideId>`) back into its hide and real lot.
 */

export const STAND_IN = 'quality-hold:'

export interface StockHoldView {
  readonly id: string
  readonly subjectType: 'Lot' | 'Hide'
  readonly reasonCode: string
  readonly reasonIt: string
  readonly reasonEn: string
  readonly placedAt: string
}

export interface StockHolds {
  /** A held lot's hold (the oldest ACTIVE one). */
  readonly lots: ReadonlyMap<string, StockHoldView>
  /** A held hide's own hold. */
  readonly hides: ReadonlyMap<string, StockHoldView>
  /** The hides behind stand-in lots: their code and real lot. */
  readonly standIns: ReadonlyMap<string, { readonly id: string; readonly code: string; readonly lotId: string | null }>
}

/** The hide id a stand-in lot id names, or null for a real lot id. */
export const standInHideOf = (lotId: string | null): string | null => (lotId?.startsWith(STAND_IN) ? lotId.slice(STAND_IN.length) : null)

/** The ACTIVE holds of these lots and of the hides behind these stand-ins, with their reasons in words. */
export async function stockHoldsOf(db: Reader, lotIds: readonly (string | null)[]): Promise<StockHolds> {
  const hideIds = [...new Set(lotIds.map(standInHideOf).filter((id): id is string => id !== null))]
  const realLots = [...new Set(lotIds.filter((id): id is string => id !== null && standInHideOf(id) === null))]
  const lotHolds = await activeHoldsOf(db, 'Lot', realLots)
  const hideHolds = await activeHoldsOf(db, 'Hide', hideIds)
  if (lotHolds.length === 0 && hideHolds.length === 0) return { lots: new Map(), hides: new Map(), standIns: new Map() }
  const reasons = await reasonWords(db as Prisma.TransactionClient, 'HOLD')
  const viewOf = (hold: ActiveHold, subjectType: 'Lot' | 'Hide'): StockHoldView => {
    const reason = reasons.get(hold.reasonCode)
    return { id: hold.id, subjectType, reasonCode: hold.reasonCode, reasonIt: reason?.labelIt ?? hold.reasonCode, reasonEn: reason?.labelEn ?? hold.reasonCode, placedAt: toUtcIso(hold.placedAt) }
  }
  const lots = new Map<string, StockHoldView>()
  for (const id of realLots) {
    const hold = lotHolds.find((entry) => entry.subjectIds.includes(id))
    if (hold) lots.set(id, viewOf(hold, 'Lot'))
  }
  const hides = new Map<string, StockHoldView>()
  for (const id of hideIds) {
    const hold = hideHolds.find((entry) => entry.subjectIds.includes(id))
    if (hold) hides.set(id, viewOf(hold, 'Hide'))
  }
  const rows = hideIds.length === 0 ? [] : await db.hide.findMany({ where: { id: { in: hideIds } }, select: { id: true, code: true, lotId: true } })
  return { lots, hides, standIns: new Map(rows.map((row) => [row.id, row])) }
}
