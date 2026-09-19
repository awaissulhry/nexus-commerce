import prisma from '../../db.js'
import { Prisma } from '@prisma/client'
import { logger } from '../../utils/logger.js'

/**
 * Shared stock plan step 4 — "B ships from its own copy of A's warehouse address" (plan §7, contract
 * docs/2026-09-19-shared-stock-build.md §4).
 *
 * An order whose units came from a pool leaves the LENDER's warehouse, so its shipment needs that
 * warehouse's address as the ship-from. A shipment can only point at a warehouse of its own business,
 * so the borrower keeps a copy: one `Warehouse` row per lent location (`sharedFromLocationId`), kept in
 * step with the lender's address through door `nexus_pool_lent_addresses` (the borrower's own grants
 * only). The copy is an ADDRESS, never stock: it has no StockLocation, stock writes naming it are
 * refused (stock-movement.service.ts resolveLocationId), and it is never the default nor a scored
 * routing choice (order-routing.service.ts).
 */

type LentAddress = {
  grant_id: string
  grant_status: string
  lender_name: string
  location_id: string
  location_code: string
  location_name: string
  address_line1: string | null
  address_line2: string | null
  city: string | null
  postal_code: string | null
  country: string | null
}

export const SHARED_WAREHOUSE_KIND = 'SHARED_STOCK'

/**
 * This business's own warehouses: every warehouse that is not a copy of a lent address. For pickers and
 * lookups that must never offer a copy (purchase orders, routing rules): a copy holds no stock and ships
 * only the orders whose units are in the lender's warehouse.
 */
export const OWN_WAREHOUSES = { sharedFromLocationId: null } satisfies Prisma.WarehouseWhereInput

/** The words for a refused copy, one place for every route that refuses one. */
export const SHARED_ADDRESS_REFUSED =
  'This is a copy of another business’s warehouse address for shared stock. It ships only the orders whose units are there. Choose one of this business’s own warehouses.'

/** Is this warehouse a copy of a lent address? */
export async function isSharedStockAddress(warehouseId: string): Promise<boolean> {
  const row = await prisma.warehouse.findUnique({ where: { id: warehouseId }, select: { sharedFromLocationId: true } })
  return Boolean(row?.sharedFromLocationId)
}

/**
 * Create or update this business's copies of the addresses it borrows stock from. A copy stays active
 * while its grant is on or paused (orders already made may still ship); a location no longer lent keeps
 * its row (old shipments point at it) but goes inactive. Writes only what changed.
 */
export async function syncSharedWarehouses(): Promise<{ created: number; updated: number; deactivated: number }> {
  const out = { created: 0, updated: 0, deactivated: 0 }
  const lent = await prisma.$queryRaw<LentAddress[]>(Prisma.sql`SELECT * FROM nexus_pool_lent_addresses()`)
  const existing = await prisma.warehouse.findMany({
    where: { sharedFromLocationId: { not: null } },
    select: { id: true, code: true, name: true, addressLine1: true, addressLine2: true, city: true, postalCode: true, country: true, isActive: true, sharedFromLocationId: true },
  })
  const bySource = new Map(existing.map((w) => [w.sharedFromLocationId!, w]))
  const lentIds = new Set<string>()
  for (const l of lent) {
    lentIds.add(l.location_id)
    const want = {
      name: `${l.location_name} — ${l.lender_name} (shared stock)`.slice(0, 190),
      addressLine1: l.address_line1,
      addressLine2: l.address_line2,
      city: l.city,
      postalCode: l.postal_code,
      country: l.country || 'IT',
      isActive: l.grant_status === 'active' || l.grant_status === 'paused',
    }
    const copy = bySource.get(l.location_id)
    if (!copy) {
      await prisma.warehouse.create({
        data: { ...want, code: await freeCode(`SHARED-${l.location_code}`), isDefault: false, kind: SHARED_WAREHOUSE_KIND, sharedFromLocationId: l.location_id },
      })
      out.created++
      continue
    }
    const changed = (Object.keys(want) as Array<keyof typeof want>).some((k) => copy[k] !== want[k])
    if (changed) {
      await prisma.warehouse.update({ where: { id: copy.id }, data: want })
      out.updated++
    }
  }
  for (const copy of existing) {
    if (!lentIds.has(copy.sharedFromLocationId!) && copy.isActive) {
      await prisma.warehouse.update({ where: { id: copy.id }, data: { isActive: false } })
      out.deactivated++
    }
  }
  return out
}

async function freeCode(base: string): Promise<string> {
  const taken = new Set((await prisma.warehouse.findMany({ where: { code: { startsWith: base } }, select: { code: true } })).map((w) => w.code))
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`
}

/**
 * The ship-from for an order whose units came from a pool: this business's copy of the lent warehouse
 * the order took the most from (door `nexus_pool_order_locations`). Null when the order took nothing
 * from a pool — the caller keeps its own choice. The copies are brought up to date first.
 */
export async function sharedWarehouseForOrder(orderId: string): Promise<string | null> {
  try {
    const sources = await prisma.$queryRaw<Array<{ location_id: string; units: number }>>(Prisma.sql`SELECT location_id, units FROM nexus_pool_order_locations(${orderId})`)
    if (sources.length === 0) return null
    await syncSharedWarehouses()
    const copy = await prisma.warehouse.findFirst({ where: { sharedFromLocationId: sources[0].location_id }, select: { id: true } })
    return copy?.id ?? null
  } catch (error) {
    logger.warn('[stock-pool] shared warehouse for order failed', { orderId, error: error instanceof Error ? error.message : String(error) })
    return null
  }
}
