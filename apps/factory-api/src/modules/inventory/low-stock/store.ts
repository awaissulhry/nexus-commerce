import type { Uom } from '@nexus/factory-db'
import { lowStockOf, lowStockWords, minimumOf, type MinimumBasis } from '@nexus/factory-domain/inventory/low-stock/rules'
import { Dec, ZERO, type Decimal } from '@nexus/factory-domain/tax/decimal'
import { readReservations } from '../../planning/inputs'
import { readPurchases, readStock, type Reader } from '../../planning/store'
import { fixed } from '../stock/read-kit'

/**
 * Below the minimum (B-W2b-314; SCM-281): for each site, every material (and colour, where the site keeps its own
 * parameters for one) whose planning parameters keep a minimum (factory-domain inventory/low-stock `minimumOf`: MIN_MAX
 * minStock, REORDER_POINT the point, else the safety stock), what the site has and expects — on hand (the ledger, every
 * place of the site), + what open purchase lines still bring, − what ACTIVE reservations of open demand hold, as planning
 * counts them (planning/store readStock, readPurchases; planning/inputs readReservations) — and whether it is below.
 * The stock page's tile and list (./read.ts) and the LOW_STOCK alert rule (./alerts.ts) read it; no money, no person.
 */

export interface LowStockRow {
  readonly companyId: string
  readonly siteId: string
  readonly itemId: string
  /** The colour the parameters are for; null: every colour of the item together. */
  readonly itemColourId: string | null
  readonly itemPlanningId: string
  readonly basis: MinimumBasis
  readonly minimum: string
  readonly onHand: string
  readonly onOrder: string
  readonly reserved: string
  readonly position: string
  readonly below: boolean
  readonly short: string
  readonly uom: Uom
  readonly words: { readonly en: string; readonly it: string }
}

export interface LowStockScope {
  readonly siteIds: readonly string[]
  readonly itemIds?: readonly string[] | undefined
}

/** The rows of the sites (planned materials with a minimum), each with its verdict; site by site, one query after another. */
export async function readLowStock(db: Reader, scope: LowStockScope): Promise<LowStockRow[]> {
  if (scope.siteIds.length === 0) return []
  const planning = await db.itemPlanning.findMany({
    where: { siteId: { in: [...scope.siteIds] }, ...(scope.itemIds ? { itemId: { in: [...scope.itemIds] } } : {}), item: { status: 'ACTIVE' } },
    orderBy: [{ siteId: 'asc' }, { itemId: 'asc' }, { id: 'asc' }],
    select: { id: true, companyId: true, siteId: true, itemId: true, itemColourId: true, method: true, minStock: true, reorderPoint: true, safetyStock: true, item: { select: { baseUom: true } } },
  })
  const planned = planning.flatMap((row) => {
    const minimum = minimumOf({ method: row.method, minStock: row.minStock?.toString() ?? null, reorderPoint: row.reorderPoint?.toString() ?? null, safetyStock: row.safetyStock?.toString() ?? null })
    return minimum ? [{ row, minimum }] : []
  })
  const rows: LowStockRow[] = []
  for (const siteId of [...new Set(planned.map((entry) => entry.row.siteId))]) {
    const ofSite = planned.filter((entry) => entry.row.siteId === siteId)
    const itemIds = [...new Set(ofSite.map((entry) => entry.row.itemId))]
    const stock = await readStock(db, siteId, itemIds)
    const purchases = await readPurchases(db, siteId, itemIds)
    const reservations = (await readReservations(db, siteId, itemIds)).filter((row) => row.demandOpen)
    const sum = (entries: readonly { itemId: string; itemColourId: string | null; quantity: Decimal }[], itemId: string, colourId: string | null) =>
      entries.filter((entry) => entry.itemId === itemId && (colourId === null || entry.itemColourId === colourId)).reduce((total, entry) => total.plus(entry.quantity), ZERO)
    const onHandOf = stock.map((entry) => ({ itemId: entry.itemId, itemColourId: entry.itemColourId, quantity: new Dec(entry.quantity) }))
    const onOrderOf = purchases.map((line) => ({ itemId: line.itemId, itemColourId: line.itemColourId, quantity: new Dec(line.openQuantity.toString()) }))
    const reservedOf = reservations.map((row) => ({ itemId: row.itemId, itemColourId: row.itemColourId, quantity: new Dec(row.open) }))
    for (const { row, minimum } of ofSite) {
      const facts = {
        onHand: sum(onHandOf, row.itemId, row.itemColourId),
        onOrder: sum(onOrderOf, row.itemId, row.itemColourId),
        reserved: sum(reservedOf, row.itemId, row.itemColourId),
        minimum: minimum.minimum,
        basis: minimum.basis,
      }
      const verdict = lowStockOf(facts)
      const uom = row.item.baseUom
      rows.push({
        companyId: row.companyId,
        siteId: row.siteId,
        itemId: row.itemId,
        itemColourId: row.itemColourId,
        itemPlanningId: row.id,
        basis: minimum.basis,
        minimum: fixed(minimum.minimum),
        onHand: fixed(facts.onHand),
        onOrder: fixed(facts.onOrder),
        reserved: fixed(facts.reserved),
        position: verdict.position,
        below: verdict.below,
        short: verdict.short,
        uom,
        words: { en: lowStockWords({ ...facts, uom }, 'en'), it: lowStockWords({ ...facts, uom }, 'it') },
      })
    }
  }
  return rows
}
