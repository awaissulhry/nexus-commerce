/**
 * Which team owns which basket, decided when the baskets are made (owb- order workflow, S3 ss2 step 2.2; PL-schema § 5A row 10,
 * G4; design "Teams own the work" — "Give to a team…", together or split). An order's open OrderTeam rows say how its work is
 * shared: rows with a `basketShare` split the baskets (each team takes that many, in line order; what is left goes to the team in
 * charge); rows without one work TOGETHER on every basket (no basket is named on them). Pure: the print command
 * (apps/factory-api modules/production/print-start) calls it with the baskets it just made and writes `bundleIds` on the rows.
 *
 *   exact   the shares add up to the baskets: each team its share
 *   short   the shares are fewer than the baskets: the rest to the team in charge (none in charge: the rest unnamed)
 *   long    the shares are more than the baskets: the teams later in the list get what is left (maybe none)
 *   none    no row has a share (together), or no row at all: no basket is named
 */

/** An open OrderTeam row of the order, in the order the rows were given (createdAt, then id). */
export interface OrderTeamShare {
  readonly orderTeamId: string
  readonly inCharge: boolean
  /** Baskets the team takes in a split (≥ 1); null: it works together, no share. */
  readonly basketShare: number | null
}

/** A basket just made, in line order (the order's line seq, then the work order's cell order). */
export interface BasketAtPrint {
  readonly bundleId: string
}

/** The baskets each row takes (only rows that take at least one). */
export type BasketShares = ReadonlyMap<string, readonly string[]>

export function shareBasketsAtPrint(rows: readonly OrderTeamShare[], baskets: readonly BasketAtPrint[]): BasketShares {
  const out = new Map<string, string[]>()
  const split = rows.filter((row) => row.basketShare !== null && row.basketShare > 0)
  if (split.length === 0 || baskets.length === 0) return out
  let next = 0
  for (const row of split) {
    const take = baskets.slice(next, next + row.basketShare!).map((basket) => basket.bundleId)
    next += take.length
    if (take.length > 0) out.set(row.orderTeamId, take)
  }
  const rest = baskets.slice(next).map((basket) => basket.bundleId)
  const inCharge = rows.find((row) => row.inCharge)
  if (rest.length > 0 && inCharge) out.set(inCharge.orderTeamId, [...(out.get(inCharge.orderTeamId) ?? []), ...rest])
  return out
}
