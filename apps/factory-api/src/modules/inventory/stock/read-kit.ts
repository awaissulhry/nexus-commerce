import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { quantityText } from '@nexus/factory-domain/inventory/ledger/moves'
import { Dec, ZERO, type Decimal } from '@nexus/factory-domain/tax/decimal'

/**
 * What the warehouse screens' reads share (reads-contract.ts): the ledger summed per hide, per lot and per location
 * (balances are sums of StockMove, never a stored figure), and the names a row shows. Every read runs on the caller's
 * client (row-level security), inside the scope the handler built with scopeWhere().
 */

export const SCOPE = { company: 'companyId', site: 'siteId' } as const
export type Reader = Pick<FactoryClient, 'stockMove'>

type Sum = { _sum: { baseQuantity: Prisma.Decimal | null } }
const dec = (row: Sum) => new Dec(row._sum.baseQuantity?.toString() ?? '0')

export interface Located {
  /** The site's stock of it (Σ in − Σ out over every location). */
  readonly onHand: Decimal
  /** Per location, only the places that hold some. */
  readonly at: ReadonlyMap<string, Decimal>
}

/**
 * The ledger of the moves matching `where`, per value of `key` (a hide, a lot) and location: what each holds now and
 * where. Two GROUP BYs (into a location, out of one); a transfer inside the site moves stock between places, never in
 * or out of the site's stock.
 */
export async function locatedBy(client: Reader, key: 'hideId' | 'lotId', where: Prisma.StockMoveWhereInput): Promise<Map<string, Located>> {
  const notNull = { [key]: { not: null } } as Prisma.StockMoveWhereInput
  const [into, outOf] = await Promise.all([
    client.stockMove.groupBy({ by: [key, 'toLocationId'], where: { AND: [where, notNull, { toLocationId: { not: null } }] }, _sum: { baseQuantity: true } }),
    client.stockMove.groupBy({ by: [key, 'fromLocationId'], where: { AND: [where, notNull, { fromLocationId: { not: null } }] }, _sum: { baseQuantity: true } }),
  ])
  const places = new Map<string, Map<string, Decimal>>()
  const add = (id: string, locationId: string, quantity: Decimal) => {
    const at = places.get(id) ?? new Map<string, Decimal>()
    at.set(locationId, (at.get(locationId) ?? ZERO).plus(quantity))
    places.set(id, at)
  }
  for (const row of into as unknown as (Sum & Record<string, string>)[]) add(row[key]!, row.toLocationId!, dec(row))
  for (const row of outOf as unknown as (Sum & Record<string, string>)[]) add(row[key]!, row.fromLocationId!, dec(row).negated())
  const result = new Map<string, Located>()
  for (const [id, at] of places) {
    const held = new Map([...at].filter(([, quantity]) => !quantity.isZero()))
    result.set(id, { onHand: [...at.values()].reduce<Decimal>((sum, quantity) => sum.plus(quantity), ZERO), at: held })
  }
  return result
}

/** The place that holds most of it (a hide lies in one place), or null when nothing is left. */
export function mainPlace(located: Located | undefined): string | null {
  if (!located) return null
  let best: [string, Decimal] | null = null
  for (const entry of located.at) if (entry[1].greaterThan(0) && (!best || entry[1].greaterThan(best[1]))) best = entry
  return best?.[0] ?? null
}

export const fixed = (value: Decimal | null | undefined): string => quantityText(value ?? ZERO)
export const decimalText = (value: Prisma.Decimal | null | undefined, scale = 4): string | null => (value === null || value === undefined ? null : new Dec(value.toString()).toFixed(scale))

/** Σ per unit, units in a stable order (totals never add different units). */
export function perUnit<Unit extends string>(entries: Iterable<{ readonly uom: Unit; readonly quantity: Decimal }>): { uom: Unit; quantity: string }[] {
  const sums = new Map<Unit, Decimal>()
  for (const entry of entries) sums.set(entry.uom, (sums.get(entry.uom) ?? ZERO).plus(entry.quantity))
  return [...sums.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([uom, quantity]) => ({ uom, quantity: quantityText(quantity) }))
}

/** A party as a row names it: its trade name, else its legal name. */
export const partyName = (party: { readonly id: string; readonly code: string; readonly legalName: string; readonly tradeName: string | null } | null | undefined) =>
  party ? { id: party.id, code: party.code, name: party.tradeName ?? party.legalName } : null

export const PARTY_SELECT = { id: true, code: true, legalName: true, tradeName: true } as const
