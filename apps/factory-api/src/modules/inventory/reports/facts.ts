import type { StockMoveReason } from '@nexus/factory-db'
import type { Reader } from '../../costing/actual/store'
import { keyBalances } from '../../costing/valuation/valuation'

/**
 * What the warehouse reports read from the stock ledger (B-W2b-356), each query over the sites `placeOf` allows (row-level
 * security keeps the tenant). A move counts when it enters or leaves the site's stock (exactly one of its two places is
 * outside the site: a TRANSFER inside the site changes nothing); the time is when it happened (`occurredAt`, as the stock
 * valuation reads it). Values are the ledger's StockValuation rows, never recomputed.
 */

export { keyBalances }

/** The moment a period ends (its last instant): every move up to it counts. */
export const lastInstant = (end: Date): Date => new Date(end.getTime() - 1)

export interface ItemFact {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly kind: string
  readonly baseUom: string
  readonly tracking: string
}

export async function itemsOf(db: Reader, ids: readonly string[]): Promise<Map<string, ItemFact>> {
  if (ids.length === 0) return new Map()
  const rows = await db.item.findMany({ where: { id: { in: [...ids] } }, select: { id: true, code: true, name: true, kind: true, baseUom: true, tracking: true } })
  return new Map(rows.map((row) => [row.id, row]))
}

export async function coloursOf(db: Reader, ids: readonly string[]): Promise<Map<string, { id: string; code: string; name: string }>> {
  if (ids.length === 0) return new Map()
  const rows = await db.itemColour.findMany({ where: { id: { in: [...ids] } }, select: { id: true, code: true, name: true } })
  return new Map(rows.map((row) => [row.id, row]))
}

export interface LotFact {
  readonly id: string
  readonly code: string
  readonly receivedAt: Date | null
  readonly ownerPartyId: string | null
  readonly parentLotId: string | null
  readonly supplierId: string | null
  readonly supplierLotRef: string | null
  readonly dyeBatch: string | null
}

export async function lotsOf(db: Reader, ids: readonly string[]): Promise<Map<string, LotFact>> {
  if (ids.length === 0) return new Map()
  const rows = await db.lot.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, code: true, receivedAt: true, ownerPartyId: true, parentLotId: true, supplierId: true, supplierLotRef: true, dyeBatch: true },
  })
  return new Map(rows.map((row) => [row.id, row]))
}

/** Each lot's first move into the site's stock up to `at` (a lot without a received day: opening stock). */
export async function firstInOf(db: Reader, lotIds: readonly string[], at: Date): Promise<Map<string, Date>> {
  if (lotIds.length === 0) return new Map()
  const rows = await db.$queryRaw<{ lotId: string; first: Date }[]>`
    SELECT m."lotId" AS "lotId", MIN(m."occurredAt") AS first
      FROM "StockMove" m
     WHERE m."lotId" = ANY(${[...lotIds]}::uuid[])
       AND m."fromLocationId" IS NULL AND m."toLocationId" IS NOT NULL
       AND m."occurredAt" <= ${at}::timestamptz
     GROUP BY m."lotId"`
  return new Map(rows.map((row) => [row.lotId, row.first]))
}

/** An untracked stock key's moves into the site's stock up to `at` (first in, first out), oldest first. */
export interface InMove {
  readonly siteId: string
  readonly itemId: string
  readonly itemColourId: string | null
  readonly at: Date
  readonly quantity: string
}

export async function untrackedInsOf(db: Reader, siteIds: readonly string[], itemIds: readonly string[], at: Date): Promise<InMove[]> {
  if (siteIds.length === 0 || itemIds.length === 0) return []
  return db.$queryRaw<InMove[]>`
    SELECT m."siteId" AS "siteId", m."itemId" AS "itemId", m."itemColourId" AS "itemColourId", m."occurredAt" AS at, m."baseQuantity"::text AS quantity
      FROM "StockMove" m
     WHERE m."siteId" = ANY(${[...siteIds]}::uuid[])
       AND m."itemId" = ANY(${[...itemIds]}::uuid[])
       AND m."lotId" IS NULL
       AND m."fromLocationId" IS NULL AND m."toLocationId" IS NOT NULL
       AND m."occurredAt" <= ${at}::timestamptz
     ORDER BY m."occurredAt", m.id`
}

// ---- leather ----------------------------------------------------------------------------------------------------------------

/** The leather moves of the period by supplier lot (a split lot's children under their parent), reason and direction. */
export interface LeatherFlowRow {
  readonly rootLotId: string | null
  readonly itemId: string
  readonly itemColourId: string | null
  readonly reason: StockMoveReason
  readonly direction: 'IN' | 'OUT'
  readonly quantity: string
  /** Σ of the moves' valuations, signed + into stock, minor units. */
  readonly value: string
  readonly unvalued: number
  /** The valuations' currencies, first and last by name (the same: one currency). */
  readonly currencyMin: string | null
  readonly currencyMax: string | null
}

export async function leatherFlowsOf(db: Reader, siteIds: readonly string[], start: Date, end: Date): Promise<LeatherFlowRow[]> {
  if (siteIds.length === 0) return []
  return db.$queryRaw<LeatherFlowRow[]>`
    SELECT COALESCE(l."parentLotId", m."lotId") AS "rootLotId", m."itemId" AS "itemId", m."itemColourId" AS "itemColourId",
           m.reason AS reason,
           CASE WHEN m."toLocationId" IS NULL THEN 'OUT' ELSE 'IN' END AS direction,
           SUM(m."baseQuantity")::text AS quantity,
           COALESCE(SUM(v."valueAmount"), 0)::text AS value,
           (COUNT(*) FILTER (WHERE v.id IS NULL))::int AS unvalued,
           MIN(v.currency) AS "currencyMin", MAX(v.currency) AS "currencyMax"
      FROM "StockMove" m
      JOIN "Item" i ON i."tenantId" = m."tenantId" AND i.id = m."itemId"
      LEFT JOIN "Lot" l ON l."tenantId" = m."tenantId" AND l.id = m."lotId"
      LEFT JOIN "StockValuation" v ON v."tenantId" = m."tenantId" AND v."siteId" = m."siteId" AND v."moveId" = m.id
     WHERE i.kind = 'LEATHER'
       AND (m."fromLocationId" IS NULL) <> (m."toLocationId" IS NULL)
       AND m."siteId" = ANY(${[...siteIds]}::uuid[])
       AND m."occurredAt" >= ${start}::timestamptz AND m."occurredAt" < ${end}::timestamptz
     GROUP BY 1, 2, 3, 4, 5`
}

/** The leather on hand by supplier lot before `before` (its quantity and the ledger's value), and its hides on hand then. */
export interface LeatherBalanceRow {
  readonly rootLotId: string | null
  readonly itemId: string
  readonly itemColourId: string | null
  readonly quantity: string
  readonly value: string
  readonly hides: number
  readonly currencyMin: string | null
  readonly currencyMax: string | null
}

export async function leatherBalancesOf(db: Reader, siteIds: readonly string[], before: Date): Promise<LeatherBalanceRow[]> {
  if (siteIds.length === 0) return []
  return db.$queryRaw<LeatherBalanceRow[]>`
    WITH keyed AS (
      SELECT COALESCE(l."parentLotId", m."lotId") AS "rootLotId", m."itemId", m."itemColourId", m."hideId",
             SUM(CASE WHEN m."toLocationId" IS NULL THEN -m."baseQuantity" ELSE m."baseQuantity" END) AS quantity,
             COALESCE(SUM(v."valueAmount"), 0) AS value,
             MIN(v.currency) AS "currencyMin", MAX(v.currency) AS "currencyMax"
        FROM "StockMove" m
        JOIN "Item" i ON i."tenantId" = m."tenantId" AND i.id = m."itemId"
        LEFT JOIN "Lot" l ON l."tenantId" = m."tenantId" AND l.id = m."lotId"
        LEFT JOIN "StockValuation" v ON v."tenantId" = m."tenantId" AND v."siteId" = m."siteId" AND v."moveId" = m.id
       WHERE i.kind = 'LEATHER'
         AND (m."fromLocationId" IS NULL) <> (m."toLocationId" IS NULL)
         AND m."siteId" = ANY(${[...siteIds]}::uuid[])
         AND m."occurredAt" < ${before}::timestamptz
       GROUP BY 1, 2, 3, 4
    )
    SELECT "rootLotId", "itemId", "itemColourId", SUM(quantity)::text AS quantity, SUM(value)::text AS value,
           (COUNT(*) FILTER (WHERE "hideId" IS NOT NULL AND quantity > 0))::int AS hides,
           MIN("currencyMin") AS "currencyMin", MAX("currencyMax") AS "currencyMax"
      FROM keyed
     GROUP BY 1, 2, 3`
}

/** The hides received from a supplier in the period, by supplier lot (net of a reversed receipt). */
export async function hidesReceivedOf(db: Reader, siteIds: readonly string[], start: Date, end: Date): Promise<{ rootLotId: string | null; itemId: string; itemColourId: string | null; hides: number }[]> {
  if (siteIds.length === 0) return []
  return db.$queryRaw`
    WITH received AS (
      SELECT COALESCE(l."parentLotId", m."lotId") AS "rootLotId", m."itemId", m."itemColourId", m."hideId",
             SUM(CASE WHEN m."toLocationId" IS NULL THEN -m."baseQuantity" ELSE m."baseQuantity" END) AS quantity
        FROM "StockMove" m
        JOIN "Item" i ON i."tenantId" = m."tenantId" AND i.id = m."itemId"
        LEFT JOIN "Lot" l ON l."tenantId" = m."tenantId" AND l.id = m."lotId"
       WHERE i.kind = 'LEATHER' AND m.reason = 'RECEIPT' AND m."hideId" IS NOT NULL
         AND m."siteId" = ANY(${[...siteIds]}::uuid[])
         AND m."occurredAt" >= ${start}::timestamptz AND m."occurredAt" < ${end}::timestamptz
       GROUP BY 1, 2, 3, 4
    )
    SELECT "rootLotId", "itemId", "itemColourId", (COUNT(*) FILTER (WHERE quantity > 0))::int AS hides FROM received GROUP BY 1, 2, 3`
}

/** Child lots of each lot (B-W2b-313's split). */
export async function childCountsOf(db: Reader, lotIds: readonly string[]): Promise<Map<string, number>> {
  if (lotIds.length === 0) return new Map()
  const rows = await db.lot.groupBy({ by: ['parentLotId'], where: { parentLotId: { in: [...lotIds] } }, _count: { _all: true } })
  return new Map(rows.filter((row) => row.parentLotId !== null).map((row) => [row.parentLotId!, row._count._all]))
}

export async function suppliersOf(db: Reader, ids: readonly string[]): Promise<Map<string, { id: string; code: string; name: string }>> {
  if (ids.length === 0) return new Map()
  const rows = await db.party.findMany({ where: { id: { in: [...ids] } }, select: { id: true, code: true, legalName: true, tradeName: true } })
  return new Map(rows.map((row) => [row.id, { id: row.id, code: row.code, name: row.tradeName ?? row.legalName }]))
}
