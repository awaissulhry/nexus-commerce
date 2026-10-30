import type { FactoryClient, ItemKind, Prisma, StockValuationMethod } from '@nexus/factory-db'
import { OPEN_COUNT_STATUSES } from '@nexus/factory-domain/inventory/counts/rules'
import { balancesFromSums, locatedKeyOf, type Balance, type LocatedKey } from '@nexus/factory-domain/inventory/ledger/moves'
import { costBasis, lotUnitCost } from '@nexus/factory-domain/inventory/ledger/valuation'
import type { CommandTx } from '../../../core/command'

/**
 * What the counts read of the ledger, in their own files (B-W2a-15): the balances AS OF an instant (moves by their
 * `occurredAt`), the site's location tree, a stock key's unit cost (as the ledger values it: the lot's cost, else the
 * item's standard cost; for the year-end list from the lot's valuations up to the inventory date), the moves since a
 * count's snapshot, and the stock keys other open counts hold. Stock as of a date is B-W2a-11's to offer for every
 * screen; until it is merged the counts compute it here (named in the step's notes). No Promise.all: these run on a
 * command's transaction client too.
 */

type Client = FactoryClient | CommandTx

export interface LocationNode {
  readonly id: string
  readonly parentId: string | null
  readonly code: string
  readonly name: string
  readonly status: string
  /** The codes from the root down, joined with `/` (the count sheet's walking order). */
  readonly path: string
}

/** Every location of the site, with its path. */
export async function siteLocations(client: Client, siteId: string): Promise<Map<string, LocationNode>> {
  const rows = await client.location.findMany({ where: { siteId }, select: { id: true, parentId: true, code: true, name: true, status: true } })
  const byId = new Map(rows.map((row) => [row.id, row]))
  const paths = new Map<string, string>()
  const pathOf = (id: string, depth = 0): string => {
    const known = paths.get(id)
    if (known !== undefined) return known
    const row = byId.get(id)
    if (!row) return ''
    const parent = row.parentId && depth < 64 ? pathOf(row.parentId, depth + 1) : ''
    const path = parent ? `${parent}/${row.code}` : row.code
    paths.set(id, path)
    return path
  }
  return new Map(rows.map((row) => [row.id, { ...row, path: pathOf(row.id) }]))
}

/** The location and every location under it. */
export function subtreeOf(locations: ReadonlyMap<string, LocationNode>, rootId: string): Set<string> {
  const children = new Map<string, string[]>()
  for (const node of locations.values()) if (node.parentId) children.set(node.parentId, [...(children.get(node.parentId) ?? []), node.id])
  const found = new Set<string>()
  const walk = (id: string, depth: number) => {
    if (found.has(id) || depth > 64) return
    found.add(id)
    for (const child of children.get(id) ?? []) walk(child, depth + 1)
  }
  if (locations.has(rootId)) walk(rootId, 0)
  return found
}

export interface ScopeQuery {
  readonly siteId: string
  /** The locations counted (a subtree); null: every location of the site. */
  readonly locationIds: ReadonlySet<string> | null
  readonly itemId?: string | null
  readonly lotId?: string | null
  readonly itemKind?: ItemKind | null
}

type GroupRow = { siteId: string; itemId: string; itemColourId: string | null; lotId: string | null; hideId: string | null; _sum: { baseQuantity: Prisma.Decimal | null } }

/** The balances inside a scope as of an instant: the moves that happened at or before it (their `occurredAt`). */
export async function balancesAt(client: Client, scope: ScopeQuery, at: Date): Promise<Balance[]> {
  const base: Prisma.StockMoveWhereInput = {
    siteId: scope.siteId,
    occurredAt: { lte: at },
    ...(scope.itemId ? { itemId: scope.itemId } : {}),
    ...(scope.lotId ? { lotId: scope.lotId } : {}),
    ...(scope.itemKind ? { item: { kind: scope.itemKind } } : {}),
  }
  const locations = scope.locationIds ? [...scope.locationIds] : null
  const into = await client.stockMove.groupBy({
    by: ['toLocationId', 'siteId', 'itemId', 'itemColourId', 'lotId', 'hideId'],
    where: { ...base, toLocationId: locations ? { in: locations } : { not: null } },
    _sum: { baseQuantity: true },
  })
  const outOf = await client.stockMove.groupBy({
    by: ['fromLocationId', 'siteId', 'itemId', 'itemColourId', 'lotId', 'hideId'],
    where: { ...base, fromLocationId: locations ? { in: locations } : { not: null } },
    _sum: { baseQuantity: true },
  })
  const side = (row: GroupRow, locationId: string) => ({ ...row, locationId, quantity: row._sum.baseQuantity?.toString() ?? '0' })
  return balancesFromSums(
    into.map((row) => side(row, row.toLocationId!)),
    outOf.map((row) => side(row, row.fromLocationId!)),
  )
}

export interface UnitCost {
  /** Per base unit, six decimals; null: nothing gives one. */
  readonly unitCost: string | null
  readonly method: StockValuationMethod | null
  readonly currency: string
}

const costKey = (key: { readonly itemId: string; readonly lotId: string | null }) => `${key.itemId}|${key.lotId ?? '-'}`

/**
 * The unit cost of each item and lot as the ledger values them (factory-domain valuation `costBasis`): the lot's cost
 * (its valuations' moving average), else the item's standard cost. `asOf`: only the valuations of moves that happened
 * by then (the year-end list); null: every valuation. Office reads only (the cost grain's columns).
 */
export async function unitCostsOf(client: Client, siteId: string, keys: readonly { readonly itemId: string; readonly lotId: string | null }[], asOf: Date | null): Promise<Map<string, UnitCost>> {
  const itemIds = [...new Set(keys.map((key) => key.itemId))]
  const lotIds = [...new Set(keys.flatMap((key) => (key.lotId ? [key.lotId] : [])))]
  const items = itemIds.length ? await client.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, standardCost: true, currency: true } }) : []
  const valuations = lotIds.length
    ? await client.stockValuation.findMany({
        where: { siteId, lotId: { in: lotIds }, ...(asOf ? { move: { occurredAt: { lte: asOf } } } : {}) },
        select: { lotId: true, quantity: true, unitCost: true },
      })
    : []
  const byLot = new Map<string, { quantity: string; unitCost: string }[]>()
  for (const row of valuations) byLot.set(row.lotId!, [...(byLot.get(row.lotId!) ?? []), { quantity: row.quantity.toString(), unitCost: row.unitCost.toString() }])
  const itemOf = new Map(items.map((item) => [item.id, item]))
  const costs = new Map<string, UnitCost>()
  for (const key of keys) {
    const id = costKey(key)
    if (costs.has(id)) continue
    const item = itemOf.get(key.itemId)
    const basis = costBasis({ lotCost: key.lotId ? lotUnitCost(byLot.get(key.lotId) ?? []) : null, standardCost: item?.standardCost?.toString() ?? null })
    costs.set(id, { unitCost: basis ? basis.unitCost.toFixed(6) : null, method: basis ? (basis.method as StockValuationMethod) : null, currency: item?.currency ?? 'EUR' })
  }
  return costs
}

export const unitCostOf = (costs: ReadonlyMap<string, UnitCost>, key: { readonly itemId: string; readonly lotId: string | null }): UnitCost =>
  costs.get(costKey(key)) ?? { unitCost: null, method: null, currency: 'EUR' }

/**
 * The lines whose stock moved at their location since the count's snapshot (posted or dated after it), other than by the
 * count's own moves: their counted quantity may not be what was there at the snapshot (no freeze until W2b, SCM-226).
 */
export async function movedSince(client: Client, siteId: string, lines: readonly (LocatedKey & { readonly id: string; readonly moveId: string | null })[], since: Date): Promise<Set<string>> {
  if (lines.length === 0) return new Set()
  const locations = [...new Set(lines.map((line) => line.locationId))]
  const items = [...new Set(lines.map((line) => line.itemId))]
  const own = lines.flatMap((line) => (line.moveId ? [line.moveId] : []))
  const moves = await client.stockMove.findMany({
    where: {
      siteId,
      itemId: { in: items },
      OR: [{ toLocationId: { in: locations } }, { fromLocationId: { in: locations } }],
      AND: [{ OR: [{ occurredAt: { gt: since } }, { createdAt: { gt: since } }] }, own.length ? { id: { notIn: own } } : {}],
    },
    select: { siteId: true, itemId: true, itemColourId: true, lotId: true, hideId: true, fromLocationId: true, toLocationId: true },
  })
  const touched = new Set<string>()
  for (const move of moves) {
    for (const locationId of [move.fromLocationId, move.toLocationId]) if (locationId) touched.add(locatedKeyOf({ ...move, locationId }))
  }
  return new Set(lines.filter((line) => touched.has(locatedKeyOf(line))).map((line) => line.id))
}

export interface HeldKey {
  readonly key: string
  readonly number: string
}

/** The stock keys (location + key) of these that another open count of the site holds (COUNTING to APPROVED). */
export async function heldByOtherCounts(tx: CommandTx, siteId: string, countId: string, keys: readonly LocatedKey[]): Promise<HeldKey[]> {
  if (keys.length === 0) return []
  const wanted = new Set(keys.map(locatedKeyOf))
  const rows = await tx.stockCountLine.findMany({
    where: {
      siteId,
      countId: { not: countId },
      locationId: { in: [...new Set(keys.map((key) => key.locationId))] },
      itemId: { in: [...new Set(keys.map((key) => key.itemId))] },
      count: { status: { in: [...OPEN_COUNT_STATUSES] } },
    },
    select: { siteId: true, locationId: true, itemId: true, itemColourId: true, lotId: true, hideId: true, count: { select: { number: true } } },
  })
  return rows.filter((row) => wanted.has(locatedKeyOf(row))).map((row) => ({ key: locatedKeyOf(row), number: row.count.number }))
}
