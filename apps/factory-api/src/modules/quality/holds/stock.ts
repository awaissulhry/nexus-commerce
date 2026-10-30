import type { CommandTx } from '../../../core/command'

/**
 * Held stock (B-W2a-26; design warehouse.stock "Available = on hand − reserved − on hold"; w2a-11's note): the stock of a
 * lot or hide under an ACTIVE quality hold is held, as the stock of a lot that is not RELEASED is (W1). The inventory
 * module's figures read it here, one place each: modules/inventory/reservations store.ts readStockParts (what may be
 * reserved and written off) and modules/inventory/stock stock.ts stockOverview (the Stock screen's held and available).
 * Any client (the floor's role reads its site's holds).
 */

export interface HeldByHolds {
  readonly lots: ReadonlySet<string>
  readonly hides: ReadonlySet<string>
  /** Is this balance held by a quality hold (its lot's or its own)? */
  holds(balance: { readonly lotId: string | null; readonly hideId: string | null }): boolean
}

export const NOTHING_HELD: HeldByHolds = Object.freeze({ lots: new Set<string>(), hides: new Set<string>(), holds: () => false })

/** The lots and hides among these that an ACTIVE quality hold holds. */
export async function heldByQualityHolds(db: Pick<CommandTx, 'qualityHold'>, keys: { readonly lotIds: readonly (string | null)[]; readonly hideIds: readonly (string | null)[] }): Promise<HeldByHolds> {
  const lotIds = [...new Set(keys.lotIds.filter((id): id is string => id !== null))]
  const hideIds = [...new Set(keys.hideIds.filter((id): id is string => id !== null))]
  if (lotIds.length === 0 && hideIds.length === 0) return NOTHING_HELD
  const rows = await db.qualityHold.findMany({
    where: {
      status: 'ACTIVE',
      OR: [...(lotIds.length > 0 ? [{ subjectType: 'Lot', subjectIds: { hasSome: lotIds } }] : []), ...(hideIds.length > 0 ? [{ subjectType: 'Hide', subjectIds: { hasSome: hideIds } }] : [])],
    },
    select: { subjectType: true, subjectIds: true },
  })
  const lots = new Set<string>()
  const hides = new Set<string>()
  for (const row of rows) for (const id of row.subjectIds) (row.subjectType === 'Lot' ? lots : hides).add(id)
  return { lots, hides, holds: (balance) => (balance.lotId !== null && lots.has(balance.lotId)) || (balance.hideId !== null && hides.has(balance.hideId)) }
}

/**
 * The balances and lot statuses the stock overview's totals (factory-domain inventory/stock/overview itemTotals) read,
 * with quality-held stock counted as held: a balance a hold holds reads as a held lot's (a lot held by its hold as
 * BLOCKED; a hide held by its own hold under a stand-in lot id of its own, which the totals never show).
 */
export function heldForTotals<Balance extends { readonly lotId: string | null; readonly hideId: string | null }, Status>(
  balances: readonly Balance[],
  statusOf: (lotId: string) => Status | undefined,
  quality: HeldByHolds,
  held: Status,
): { readonly balances: Balance[]; readonly statusOf: (lotId: string) => Status | undefined } {
  const standIn = (hideId: string) => `quality-hold:${hideId}`
  return {
    balances: balances.map((balance) => (balance.hideId !== null && quality.hides.has(balance.hideId) && !(balance.lotId !== null && quality.lots.has(balance.lotId)) ? { ...balance, lotId: standIn(balance.hideId) } : balance)),
    statusOf: (lotId) => (lotId.startsWith('quality-hold:') || quality.lots.has(lotId) ? held : statusOf(lotId)),
  }
}
