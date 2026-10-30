import { locatedKeyOf } from '@nexus/factory-domain/inventory/ledger/moves'
import { Dec, ZERO, type Decimal } from '@nexus/factory-domain/tax/decimal'
import { cellInStock, stockMoveNote, takeFromStock, type StockCell, type StockTake } from '@nexus/factory-domain/shipping/shipments/stock'
import type { CommandTools, CommandTx } from '../../../core/command'
import { finishedPlaces, PRODUCTION_RECEIPT, type Reader } from '../../inventory/finished/post'
import { postMoves, readBalances, type MoveDraft } from '../../inventory/ledger/post-moves'
import { lockReservations } from '../../inventory/reservations/store'
import { tenantOf } from '../cells'
import type { ShipmentHeader } from '../store'

/**
 * Shipping from finished-goods stock (B-W2a-48 with B-W2a-12; GAP-003, LOG-004; design warehouse.shipments "Mark handed
 * over: posts the stock leaving finished goods"): when a shipment leaves, each of its cells takes its garments out of
 * finished goods first, as far as its work order still has them there (factory-domain shipping/shipments/stock), with
 * ONE ADJUSTMENT move out per cell and place through postMoves, inside the leaving command:
 *
 *   the move     reason ADJUSTMENT (the ledger has no SHIPMENT reason yet: a schema need), out of the finished-goods
 *                place, the cell's SKU's FINISHED item, whole garments, the cell's work order (the batch), reference the
 *                shipment's number, the note in words, key `shipping.fromStock:<shipment id>:<n>` (what marks it as a
 *                shipment's move: `takenFromStockByCell` reads them back)
 *   locks        the items' reservation locks (as a write-off), then postMoves' own stock locks; the shipment's row and
 *                its cells' shipping locks are already held by the leaving command
 *   the rest     garments that never went into stock, or are no longer there, leave straight from the release
 *
 * `takenFromStockByCell` is what "Report finished to stock" subtracts from a cell's garments on shipments (B-W2a-12
 * named it): a garment shipped from stock is in stock's receipts AND on a shipment, and must be counted once.
 */

export const FROM_STOCK_KEY = 'shipping.fromStock'

const whole = (value: Decimal): number => Number(value.toFixed(0))
const dec = (value: { toString(): string } | null | undefined): Decimal => (value === null || value === undefined ? ZERO : new Dec(value.toString()))

/** A cell of a shipment as the stock side reads it. */
export interface ShippedCell {
  readonly cellId: string
  readonly workOrderId: string
  readonly styleId: string
  readonly colourwayId: string
  readonly size: string
  readonly label: string
  readonly garments: number
}

/** The FINISHED item of each cell's SKU (null: the SKU never went into stock, so it has none). */
async function itemsOf(db: Reader, cells: readonly Pick<ShippedCell, 'cellId' | 'styleId' | 'colourwayId' | 'size'>[]): Promise<Map<string, string>> {
  if (cells.length === 0) return new Map()
  const variants = await db.variant.findMany({
    where: { styleId: { in: [...new Set(cells.map((cell) => cell.styleId))] }, colourwayId: { in: [...new Set(cells.map((cell) => cell.colourwayId))] }, size: { in: [...new Set(cells.map((cell) => cell.size))] } },
    select: { id: true, styleId: true, colourwayId: true, size: true },
  })
  const items = variants.length > 0 ? await db.item.findMany({ where: { variantId: { in: variants.map((variant) => variant.id) }, kind: 'FINISHED' }, select: { id: true, variantId: true } }) : []
  const itemOfVariant = new Map(items.map((item) => [item.variantId!, item.id]))
  const variantOf = new Map(variants.map((variant) => [`${variant.styleId}|${variant.colourwayId}|${variant.size}`, variant.id]))
  const byCell = new Map<string, string>()
  for (const cell of cells) {
    const variantId = variantOf.get(`${cell.styleId}|${cell.colourwayId}|${cell.size}`)
    const itemId = variantId ? itemOfVariant.get(variantId) : undefined
    if (itemId) byCell.set(cell.cellId, itemId)
  }
  return byCell
}

/** Per work order and item: its garments put into finished goods (receipts less their reversals). */
async function receivedOf(db: Reader, workOrderIds: readonly string[], itemIds: readonly string[]): Promise<Map<string, number>> {
  if (workOrderIds.length === 0 || itemIds.length === 0) return new Map()
  const rows = await db.stockMove.groupBy({ by: ['workOrderId', 'itemId', 'reversalOfId'], where: { reason: PRODUCTION_RECEIPT, workOrderId: { in: [...workOrderIds] }, itemId: { in: [...itemIds] } }, _sum: { baseQuantity: true } })
  const net = new Map<string, Decimal>()
  for (const row of rows) {
    const key = `${row.workOrderId}|${row.itemId}`
    const quantity = dec(row._sum.baseQuantity)
    net.set(key, (net.get(key) ?? ZERO).plus(row.reversalOfId ? quantity.negated() : quantity))
  }
  return new Map([...net].map(([key, value]) => [key, whole(value)]))
}

/** Per work order and item: the garments leaving shipments took out of finished goods (their moves less reversals). */
async function takenOf(db: Reader, workOrderIds: readonly string[], itemIds?: readonly string[]): Promise<Map<string, number>> {
  if (workOrderIds.length === 0) return new Map()
  const rows = await db.stockMove.groupBy({
    by: ['workOrderId', 'itemId', 'reversalOfId'],
    where: { reason: 'ADJUSTMENT', workOrderId: { in: [...workOrderIds] }, idempotencyKey: { startsWith: `${FROM_STOCK_KEY}:` }, ...(itemIds ? { itemId: { in: [...itemIds] } } : {}) },
    _sum: { baseQuantity: true },
  })
  const net = new Map<string, Decimal>()
  for (const row of rows) {
    const key = `${row.workOrderId}|${row.itemId}`
    const quantity = dec(row._sum.baseQuantity)
    net.set(key, (net.get(key) ?? ZERO).plus(row.reversalOfId ? quantity.negated() : quantity))
  }
  return new Map([...net].map(([key, value]) => [key, whole(value)]))
}

/**
 * B-W2a-12's `onShipments` correction: per cell of a work order, the garments its shipments took out of finished goods
 * (0 for a cell without). `cells` are the work order's cells with their SKU's FINISHED item.
 */
export async function takenFromStockByCell(db: Reader, workOrderId: string, cells: readonly { readonly cellId: string; readonly itemId: string | null }[]): Promise<Map<string, number>> {
  const withItem = cells.filter((cell): cell is { cellId: string; itemId: string } => cell.itemId !== null)
  if (withItem.length === 0) return new Map()
  const taken = await takenOf(db, [workOrderId], withItem.map((cell) => cell.itemId))
  return new Map(withItem.map((cell) => [cell.cellId, taken.get(`${workOrderId}|${cell.itemId}`) ?? 0]))
}

/** Per cell: the work order's garments of it still in finished goods (the ready list and the record read it). */
export async function finishedInStockByCell(db: Reader, cells: readonly Pick<ShippedCell, 'cellId' | 'workOrderId' | 'styleId' | 'colourwayId' | 'size'>[]): Promise<Map<string, number>> {
  const items = await itemsOf(db, cells)
  if (items.size === 0) return new Map()
  const workOrderIds = [...new Set(cells.map((cell) => cell.workOrderId))]
  const itemIds = [...new Set(items.values())]
  const received = await receivedOf(db, workOrderIds, itemIds)
  const taken = await takenOf(db, workOrderIds, itemIds)
  const result = new Map<string, number>()
  for (const cell of cells) {
    const itemId = items.get(cell.cellId)
    if (!itemId) continue
    const key = `${cell.workOrderId}|${itemId}`
    result.set(cell.cellId, cellInStock(received.get(key) ?? 0, taken.get(key) ?? 0))
  }
  return result
}

/** The leaving shipment's cells: garments per cell (its lines added up), with what the stock side needs. */
export async function shippedCells(tx: CommandTx, shipmentId: string): Promise<ShippedCell[]> {
  const lines = await tx.shipmentLine.findMany({
    where: { shipmentId },
    select: { workOrderSizeId: true, quantity: true, size: true, workOrderSize: { select: { colourwayId: true, colourway: { select: { code: true } }, workOrder: { select: { id: true, number: true, styleId: true } } } } },
    orderBy: { id: 'asc' },
  })
  const byCell = new Map<string, ShippedCell>()
  for (const line of lines) {
    const known = byCell.get(line.workOrderSizeId)
    if (known) {
      byCell.set(line.workOrderSizeId, { ...known, garments: known.garments + line.quantity })
      continue
    }
    const workOrder = line.workOrderSize.workOrder
    byCell.set(line.workOrderSizeId, {
      cellId: line.workOrderSizeId,
      workOrderId: workOrder.id,
      styleId: workOrder.styleId,
      colourwayId: line.workOrderSize.colourwayId,
      size: line.size,
      label: `${workOrder.number} ${line.workOrderSize.colourway.code} ${line.size}`,
      garments: line.quantity,
    })
  }
  return [...byCell.values()].sort((a, b) => (a.cellId < b.cellId ? -1 : 1))
}

export interface StockTaken {
  readonly takes: readonly StockTake[]
  readonly moveIds: readonly string[]
}

/**
 * Inside the leaving command (the shipment's row and its cells' shipping locks held): takes each cell's garments out
 * of finished goods as far as its work order has them there, and answers what came from stock and what from the
 * release, cell by cell.
 */
export async function takeFromFinishedGoodsInCommand(tools: CommandTools, shipment: Pick<ShipmentHeader, 'id' | 'number' | 'siteId'>, cells: readonly ShippedCell[]): Promise<StockTaken> {
  const { tx } = tools
  const items = await itemsOf(tx, cells)
  const stocked = cells.filter((cell) => items.has(cell.cellId))
  if (stocked.length === 0) return { takes: cells.map((cell) => ({ cellId: cell.cellId, label: cell.label, garments: cell.garments, fromPlaces: [], fromStock: 0, fromRelease: cell.garments })), moveIds: [] }
  const tenantId = tenantOf(tools.context)
  await lockReservations(tx, tenantId, [...new Set(stocked.map((cell) => items.get(cell.cellId)!))].map((itemId) => ({ siteId: shipment.siteId, itemId, itemColourId: null })))
  const places = await finishedPlaces(tx, shipment.siteId)
  const itemIds = [...new Set(stocked.map((cell) => items.get(cell.cellId)!))]
  const keys = itemIds.flatMap((itemId) => places.map((place) => ({ siteId: shipment.siteId, locationId: place.id, itemId, itemColourId: null, lotId: null, hideId: null })))
  const balances = await readBalances(tx, keys)
  const workOrderIds = [...new Set(stocked.map((cell) => cell.workOrderId))]
  const received = await receivedOf(tx, workOrderIds, itemIds)
  const taken = await takenOf(tx, workOrderIds, itemIds)

  // Several cells may share an item (two work orders of the same SKU): what one takes from a place, the next no longer finds.
  const left = new Map(keys.map((key) => [`${key.locationId}|${key.itemId}`, whole(balances.get(locatedKeyOf(key)) ?? ZERO)]))
  const takes: StockTake[] = []
  for (const cell of cells) {
    const itemId = items.get(cell.cellId)
    if (!itemId) {
      takes.push({ cellId: cell.cellId, label: cell.label, garments: cell.garments, fromPlaces: [], fromStock: 0, fromRelease: cell.garments })
      continue
    }
    const key = `${cell.workOrderId}|${itemId}`
    const stockCell: StockCell = {
      cellId: cell.cellId,
      label: cell.label,
      garments: cell.garments,
      inStock: cellInStock(received.get(key) ?? 0, taken.get(key) ?? 0),
      places: places.map((place) => ({ locationId: place.id, code: place.code, onHand: left.get(`${place.id}|${itemId}`) ?? 0 })),
    }
    const [take] = takeFromStock([stockCell])
    for (const place of take!.fromPlaces) left.set(`${place.locationId}|${itemId}`, (left.get(`${place.locationId}|${itemId}`) ?? 0) - place.quantity)
    takes.push(take!)
  }

  const drafts: MoveDraft[] = takes.flatMap((take) => {
    const cell = cells.find((entry) => entry.cellId === take.cellId)!
    return take.fromPlaces.map((place) => ({
      siteId: shipment.siteId,
      reason: 'ADJUSTMENT' as const,
      itemId: items.get(take.cellId)!,
      itemColourId: null,
      lotId: null,
      hideId: null,
      fromLocationId: place.locationId,
      toLocationId: null,
      quantity: String(place.quantity),
      uom: 'PCS' as const,
      workOrderId: cell.workOrderId,
      reference: shipment.number,
      note: stockMoveNote(shipment.number, take.label),
    }))
  })
  const posted = drafts.length > 0 ? await postMoves(tools, drafts, { key: `${FROM_STOCK_KEY}:${shipment.id}`, issuePath: () => 'shipment' }) : []
  return { takes, moveIds: posted.map((move) => move.id) }
}
