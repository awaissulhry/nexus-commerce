import type { Prisma } from '@nexus/factory-db'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { INVENTORY_STOCK_VIEW } from '@nexus/factory-domain/inventory/permissions'
import { Dec, ZERO, type Decimal } from '@nexus/factory-domain/tax/decimal'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { officeContextOf } from '../ledger/access'
import { PRODUCTION_RECEIPT, type Reader } from './post'

/**
 * Finished goods on hand (B-W2a-12; GAP-003; what partial shipments, B-W2a-48, and the year-end count read): per FINISHED
 * item (one per SKU) its stock per site and place from the ledger (every move: receipts, transfers, counts, issues), and
 * the work orders (batches) it came in from, net of reversals. Office, inventory.stock.view over the moves' company and
 * site. Whole garments; never a cost (the value is the stock overview's, with the cost grain).
 */

export interface FinishedQuery {
  readonly siteId?: string | undefined
  readonly styleId?: string | undefined
  readonly workOrderId?: string | undefined
  /** Part of the SKU (any case). */
  readonly q?: string | undefined
}

const whole = (value: Decimal): number => Number(value.toFixed(0))
const dec = (value: { toString(): string } | null | undefined): Decimal => (value === null || value === undefined ? ZERO : new Dec(value.toString()))

/** Net received per work order and item: PRODUCTION_RECEIPT moves less their reversals. */
export async function receivedByWorkOrder(db: Reader, where: Prisma.StockMoveWhereInput): Promise<Map<string, Decimal>> {
  const rows = await db.stockMove.groupBy({ by: ['workOrderId', 'itemId', 'reversalOfId'], where: { ...where, reason: PRODUCTION_RECEIPT, workOrderId: { not: null } }, _sum: { baseQuantity: true } })
  const net = new Map<string, Decimal>()
  for (const row of rows) {
    const key = `${row.workOrderId}|${row.itemId}`
    const quantity = dec(row._sum.baseQuantity)
    net.set(key, (net.get(key) ?? ZERO).plus(row.reversalOfId ? quantity.negated() : quantity))
  }
  return net
}

export async function listFinished(caller: CommandCaller, query: FinishedQuery) {
  const context = officeContextOf(caller)
  const scope = scopeWhere(actorOf(context), INVENTORY_STOCK_VIEW, { company: 'companyId', site: 'siteId' }) as Prisma.StockMoveWhereInput
  return caller.withClient(async (client) => {
    const q = query.q?.trim()
    const items = await client.item.findMany({
      where: { kind: 'FINISHED', ...(query.styleId ? { variant: { styleId: query.styleId } } : {}), ...(q ? { code: { contains: q, mode: 'insensitive' } } : {}) },
      select: { id: true, code: true, name: true, tracking: true, variantId: true },
      orderBy: { code: 'asc' },
    })
    if (items.length === 0) return { items: [] }
    const itemIds = items.map((item) => item.id)
    const base: Prisma.StockMoveWhereInput = { AND: [scope, { itemId: { in: itemIds } }, query.siteId ? { siteId: query.siteId } : {}] }
    const into = await client.stockMove.groupBy({ by: ['siteId', 'toLocationId', 'itemId'], where: { AND: [base, { toLocationId: { not: null } }] }, _sum: { baseQuantity: true } })
    const outOf = await client.stockMove.groupBy({ by: ['siteId', 'fromLocationId', 'itemId'], where: { AND: [base, { fromLocationId: { not: null } }] }, _sum: { baseQuantity: true } })
    const places = new Map<string, { siteId: string; locationId: string; itemId: string; onHand: Decimal }>()
    const add = (siteId: string, locationId: string, itemId: string, quantity: Decimal) => {
      const key = `${siteId}|${locationId}|${itemId}`
      const entry = places.get(key) ?? { siteId, locationId, itemId, onHand: ZERO }
      places.set(key, { ...entry, onHand: entry.onHand.plus(quantity) })
    }
    for (const row of into) add(row.siteId, row.toLocationId!, row.itemId, dec(row._sum.baseQuantity))
    for (const row of outOf) add(row.siteId, row.fromLocationId!, row.itemId, dec(row._sum.baseQuantity).negated())
    const received = await receivedByWorkOrder(client, { AND: [base, query.workOrderId && isUuid(query.workOrderId) ? { workOrderId: query.workOrderId } : {}] })

    const variants = await client.variant.findMany({ where: { id: { in: items.flatMap((item) => (item.variantId ? [item.variantId] : [])) } }, select: { id: true, styleId: true, colourwayId: true, size: true } })
    const styles = await client.style.findMany({ where: { id: { in: [...new Set(variants.map((variant) => variant.styleId))] } }, select: { id: true, code: true, name: true } })
    const colourways = await client.colourway.findMany({ where: { id: { in: [...new Set(variants.map((variant) => variant.colourwayId))] } }, select: { id: true, code: true, name: true } })
    const locations = await client.location.findMany({ where: { id: { in: [...new Set([...places.values()].map((entry) => entry.locationId))] } }, select: { id: true, code: true } })
    const sites = await client.site.findMany({ where: { id: { in: [...new Set([...places.values()].map((entry) => entry.siteId))] } }, select: { id: true, code: true } })
    const workOrderIds = [...new Set([...received.keys()].map((key) => key.split('|')[0]!))]
    const workOrders = await client.workOrder.findMany({ where: { id: { in: workOrderIds } }, select: { id: true, number: true, batchNumber: true } })
    const variantOf = new Map(variants.map((row) => [row.id, row]))
    const styleOf = new Map(styles.map((row) => [row.id, row]))
    const colourwayOf = new Map(colourways.map((row) => [row.id, row]))
    const locationCode = new Map(locations.map((row) => [row.id, row.code]))
    const siteCode = new Map(sites.map((row) => [row.id, row.code]))
    const workOrderOf = new Map(workOrders.map((row) => [row.id, row]))

    return {
      items: items.flatMap((item) => {
        const variant = item.variantId ? variantOf.get(item.variantId) : undefined
        const held = [...places.values()].filter((entry) => entry.itemId === item.id && !entry.onHand.isZero())
        const from = [...received.entries()].filter(([key, quantity]) => key.endsWith(`|${item.id}`) && !quantity.isZero())
        if (held.length === 0 && from.length === 0) return []
        if (query.workOrderId && from.length === 0) return []
        return [
          {
            itemId: item.id,
            sku: item.code,
            name: item.name,
            tracking: item.tracking,
            styleId: variant?.styleId ?? null,
            styleCode: variant ? (styleOf.get(variant.styleId)?.code ?? '') : '',
            colourwayCode: variant ? (colourwayOf.get(variant.colourwayId)?.code ?? '') : '',
            colourwayName: variant ? (colourwayOf.get(variant.colourwayId)?.name ?? '') : '',
            size: variant?.size ?? '',
            onHand: whole(held.reduce<Decimal>((sum, entry) => sum.plus(entry.onHand), ZERO)),
            places: held
              .map((entry) => ({ siteId: entry.siteId, siteCode: siteCode.get(entry.siteId) ?? '', locationId: entry.locationId, locationCode: locationCode.get(entry.locationId) ?? '', onHand: whole(entry.onHand) }))
              .sort((a, b) => a.siteCode.localeCompare(b.siteCode) || a.locationCode.localeCompare(b.locationCode)),
            workOrders: from
              .map(([key, quantity]) => {
                const workOrderId = key.split('|')[0]!
                const row = workOrderOf.get(workOrderId)
                return { workOrderId, number: row?.number ?? '', batchNumber: row?.batchNumber ?? null, received: whole(quantity) }
              })
              .sort((a, b) => a.number.localeCompare(b.number)),
          },
        ]
      }),
    }
  })
}
