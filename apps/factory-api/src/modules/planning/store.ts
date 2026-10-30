import type { FactoryClient, Prisma } from '@nexus/factory-db'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import { NO_SUPPLY_RULES, supplyRulesFor, type SupplyRules } from '@nexus/factory-domain/planning/buy'
import {
  MADE_WORK_ORDER_STATUSES,
  OPEN_WORK_ORDER_STATUSES,
  PLANNED_ORDER_STATUSES,
  type PlanItem,
  type PlanOrderLine,
  type PlanPurchase,
  type PlanRevision,
  type PlanStock,
  type PlanWarning,
  type PlanWorkOrderCell,
  type WorkOrderIssue,
} from '@nexus/factory-domain/planning/explode'
import { OPEN_PURCHASE_STATUSES, openQuantityOf, type LotFacts } from '@nexus/factory-domain/planning/netting'
import { Dec, ZERO, type Decimal } from '@nexus/factory-domain/tax/decimal'
import type { CommandTx } from '../../core/command'
import { readLines } from '../product/bom/store'

/**
 * What a planning run reads (B-W1-29), in one client: the run's command transaction for a run, a read-only client for
 * an explanation. Queries run one after another (one connection runs one query at a time). Every read names its columns.
 */

export type Reader = FactoryClient | CommandTx

/** A calendar day stored as @db.Date. */
export const dayOf = (value: Date): BusinessDate => value.toISOString().slice(0, 10)
const text = (value: { toString(): string }): string => decimalText(value.toString())
const q4 = (value: { toString(): string } | Decimal): string => new Dec(value.toString()).toFixed(4)

export const SITE_COLUMNS = { id: true, companyId: true, code: true, name: true, kind: true, status: true, timezone: true } as const satisfies Prisma.SiteSelect
export type SiteRow = Prisma.SiteGetPayload<{ select: typeof SITE_COLUMNS }>

export const ITEM_COLUMNS = {
  id: true,
  code: true,
  name: true,
  kind: true,
  sourcing: true,
  baseUom: true,
  purchaseUom: true,
  purchaseFactor: true,
  consumptionUom: true,
  consumptionFactor: true,
  defaultSupplierId: true,
  leadTimeDays: true,
  minOrderQty: true,
  orderMultiple: true,
  requiresCrViTest: true,
  currency: true,
} as const satisfies Prisma.ItemSelect
export type ItemRow = Prisma.ItemGetPayload<{ select: typeof ITEM_COLUMNS }>

export const unitsOf = (item: ItemRow) => ({
  baseUom: item.baseUom,
  purchaseUom: item.purchaseUom,
  purchaseFactor: text(item.purchaseFactor),
  consumptionUom: item.consumptionUom,
  consumptionFactor: text(item.consumptionFactor),
})

export const planItemOf = (item: ItemRow): PlanItem => ({ id: item.id, code: item.code, sourcing: item.sourcing, units: unitsOf(item), defaultSupplierId: item.defaultSupplierId })

/** The supplier's terms for the items (Item.leadTimeDays, minOrderQty, orderMultiple; Party.leadTimeDays): ./buy supplyRulesFor. */
export async function readSupplyRules(db: Reader, items: readonly ItemRow[], supplierIds: Iterable<string | null>): Promise<(itemId: string, supplierId: string | null) => SupplyRules> {
  const ids = [...new Set([...items.flatMap((item) => (item.defaultSupplierId ? [item.defaultSupplierId] : [])), ...[...supplierIds].filter((value): value is string => value !== null)])]
  const parties = ids.length === 0 ? [] : await db.party.findMany({ where: { id: { in: ids } }, select: { id: true, leadTimeDays: true } })
  const partyOf = new Map(parties.map((party) => [party.id, party]))
  const itemOf = new Map(items.map((item) => [item.id, item]))
  return (itemId, supplierId) => {
    const item = itemOf.get(itemId)
    if (!item) return NO_SUPPLY_RULES
    const chosen = supplierId ?? item.defaultSupplierId
    return supplyRulesFor(
      { defaultSupplierId: item.defaultSupplierId, leadTimeDays: item.leadTimeDays, minOrderQty: item.minOrderQty === null ? null : text(item.minOrderQty), orderMultiple: item.orderMultiple === null ? null : text(item.orderMultiple) },
      chosen ? (partyOf.get(chosen) ?? { id: chosen, leadTimeDays: null }) : null,
    )
  }
}

// ---- demand -----------------------------------------------------------------------------------------------------------

export interface DemandRead {
  readonly orderLines: PlanOrderLine[]
  readonly revisions: PlanRevision[]
  /** Order lines of the company that have no making site while it has several plants: not planned. */
  readonly unplaced: PlanWarning[]
}

/**
 * The open order lines planned at the site (CONFIRMED and IN_PRODUCTION orders of its company): those made at the site,
 * and those with no making site yet when the site is its company's only ACTIVE plant (else they are listed, not planned).
 * Each with the revision to explode: the line's own, else the style's RELEASED one.
 */
export async function readDemand(db: Reader, site: SiteRow): Promise<DemandRead> {
  const plants = await db.site.count({ where: { companyId: site.companyId, kind: 'PLANT', status: 'ACTIVE' } })
  const onlyPlant = plants === 1 && site.kind === 'PLANT' && site.status === 'ACTIVE'
  const rows = await db.salesOrderLine.findMany({
    where: { companyId: site.companyId, order: { status: { in: [...PLANNED_ORDER_STATUSES] } }, OR: [{ siteId: site.id }, { siteId: null }] },
    select: {
      id: true,
      orderId: true,
      seq: true,
      kind: true,
      styleId: true,
      styleRevisionId: true,
      colourwayId: true,
      baseSize: true,
      siteId: true,
      requestedDate: true,
      promiseDate: true,
      order: { select: { number: true, requestedDate: true, promiseDate: true } },
      sizes: { select: { size: true, quantity: true } },
    },
    orderBy: [{ orderId: 'asc' }, { seq: 'asc' }],
  })
  const unplaced: PlanWarning[] = []
  const placed = rows.filter((row) => {
    if (row.siteId === site.id || onlyPlant) return true
    unplaced.push({
      code: 'NO_SITE',
      message: `${row.order.number} line ${row.seq} is not planned: its making site is not chosen yet and the company has several plants.`,
      orderId: row.orderId,
      orderLineId: row.id,
    })
    return false
  })
  const styleIds = [...new Set(placed.map((row) => row.styleId))]
  const released = styleIds.length === 0 ? [] : await db.styleRevision.findMany({ where: { styleId: { in: styleIds }, status: 'RELEASED' }, select: { id: true, styleId: true }, orderBy: { revision: 'desc' } })
  const releasedOf = new Map<string, string>()
  for (const revision of released) if (!releasedOf.has(revision.styleId)) releasedOf.set(revision.styleId, revision.id)
  const styles = styleIds.length === 0 ? [] : await db.style.findMany({ where: { id: { in: styleIds } }, select: { id: true, baseSize: true } })
  const baseSizeOf = new Map(styles.map((style) => [style.id, style.baseSize]))

  const orderLines: PlanOrderLine[] = placed.map((row) => {
    const due = row.promiseDate ?? row.requestedDate ?? row.order.promiseDate ?? row.order.requestedDate
    const mtmSize = row.baseSize ?? baseSizeOf.get(row.styleId) ?? null
    return {
      orderId: row.orderId,
      orderNumber: row.order.number,
      orderLineId: row.id,
      lineSeq: row.seq,
      styleId: row.styleId,
      colourwayId: row.colourwayId,
      revisionId: row.styleRevisionId ?? releasedOf.get(row.styleId) ?? null,
      sizes: row.kind === 'MADE_TO_MEASURE' ? (mtmSize ? [{ size: mtmSize, pieces: 1 }] : []) : row.sizes.map((size) => ({ size: size.size, pieces: size.quantity })),
      dueDate: due ? dayOf(due) : null,
    }
  })
  const revisions: PlanRevision[] = []
  for (const revisionId of [...new Set(orderLines.flatMap((line) => (line.revisionId ? [line.revisionId] : [])))].sort()) {
    revisions.push({ id: revisionId, lines: await readLines(db, revisionId) })
  }
  return { orderLines, revisions, unplaced }
}

// ---- work orders ------------------------------------------------------------------------------------------------------

/** The site's work order cells that make these order lines (open and made ones), and what was issued to the open ones. */
export async function readWorkOrders(db: Reader, siteId: string, orderLineIds: readonly string[]): Promise<{ cells: PlanWorkOrderCell[]; issues: WorkOrderIssue[] }> {
  if (orderLineIds.length === 0) return { cells: [], issues: [] }
  const rows = await db.workOrderSize.findMany({
    // B-W2a-12: a REPAIR work order's cell repairs a sold garment; it is not production of the line.
    where: { siteId, salesOrderLineId: { in: [...orderLineIds] }, workOrder: { status: { in: [...OPEN_WORK_ORDER_STATUSES, ...MADE_WORK_ORDER_STATUSES] }, kind: { not: 'REPAIR' } } },
    select: { workOrderId: true, salesOrderLineId: true, size: true, quantity: true, workOrder: { select: { number: true, status: true } } },
    orderBy: [{ workOrderId: 'asc' }, { size: 'asc' }],
  })
  const cells: PlanWorkOrderCell[] = rows.map((row) => ({ workOrderId: row.workOrderId, workOrderNumber: row.workOrder.number, status: row.workOrder.status, orderLineId: row.salesOrderLineId, size: row.size, pieces: row.quantity }))
  const open = [...new Set(cells.filter((cell) => OPEN_WORK_ORDER_STATUSES.includes(cell.status)).map((cell) => cell.workOrderId))]
  if (open.length === 0) return { cells, issues: [] }
  // Net issued per work order, material and colour: moves that leave a location for the work order, less moves that
  // come back from it (returns, and reversals of issues).
  const by = ['workOrderId', 'itemId', 'itemColourId'] as const
  const out = await db.stockMove.groupBy({ by: [...by], where: { siteId, workOrderId: { in: open }, fromLocationId: { not: null }, toLocationId: null }, _sum: { baseQuantity: true } })
  const back = await db.stockMove.groupBy({ by: [...by], where: { siteId, workOrderId: { in: open }, fromLocationId: null, toLocationId: { not: null } }, _sum: { baseQuantity: true } })
  const net = new Map<string, { workOrderId: string; itemId: string; itemColourId: string | null; quantity: Decimal }>()
  const add = (row: (typeof out)[number], sign: 1 | -1) => {
    const key = `${row.workOrderId}|${row.itemId}|${row.itemColourId ?? '-'}`
    const quantity = new Dec(row._sum.baseQuantity?.toString() ?? '0')
    const entry = net.get(key) ?? { workOrderId: row.workOrderId!, itemId: row.itemId, itemColourId: row.itemColourId, quantity: ZERO }
    net.set(key, { ...entry, quantity: entry.quantity.plus(sign === 1 ? quantity : quantity.negated()) })
  }
  for (const row of out) add(row, 1)
  for (const row of back) add(row, -1)
  const issues = [...net.values()].filter((entry) => entry.quantity.gt(0)).map((entry) => ({ ...entry, quantity: q4(entry.quantity) }))
  return { cells, issues }
}

// ---- stock and lots ---------------------------------------------------------------------------------------------------

export type PlanStockRow = PlanStock

/** The site's stock of these items, per colour and lot (on hand above 0), with the hides that hold it. */
export async function readStock(db: Reader, siteId: string, itemIds: readonly string[] | null): Promise<PlanStock[]> {
  if (itemIds !== null && itemIds.length === 0) return []
  const where: Prisma.StockMoveWhereInput = { siteId, ...(itemIds === null ? {} : { itemId: { in: [...itemIds] } }) }
  const by = ['itemId', 'itemColourId', 'lotId', 'hideId'] as const
  const into = await db.stockMove.groupBy({ by: [...by], where: { AND: [where, { toLocationId: { not: null } }] }, _sum: { baseQuantity: true } })
  const outOf = await db.stockMove.groupBy({ by: [...by], where: { AND: [where, { fromLocationId: { not: null } }] }, _sum: { baseQuantity: true } })
  const perHide = new Map<string, { itemId: string; itemColourId: string | null; lotId: string | null; hideId: string | null; quantity: Decimal }>()
  const add = (row: (typeof into)[number], sign: 1 | -1) => {
    const key = [row.itemId, row.itemColourId ?? '-', row.lotId ?? '-', row.hideId ?? '-'].join('|')
    const quantity = new Dec(row._sum.baseQuantity?.toString() ?? '0')
    const entry = perHide.get(key) ?? { itemId: row.itemId, itemColourId: row.itemColourId, lotId: row.lotId, hideId: row.hideId, quantity: ZERO }
    perHide.set(key, { ...entry, quantity: entry.quantity.plus(sign === 1 ? quantity : quantity.negated()) })
  }
  for (const row of into) add(row, 1)
  for (const row of outOf) add(row, -1)
  const perLot = new Map<string, { itemId: string; itemColourId: string | null; lotId: string | null; quantity: Decimal; hides: number }>()
  for (const entry of perHide.values()) {
    if (!entry.quantity.gt(0)) continue
    const key = [entry.itemId, entry.itemColourId ?? '-', entry.lotId ?? '-'].join('|')
    const lot = perLot.get(key) ?? { itemId: entry.itemId, itemColourId: entry.itemColourId, lotId: entry.lotId, quantity: ZERO, hides: 0 }
    perLot.set(key, { ...lot, quantity: lot.quantity.plus(entry.quantity), hides: lot.hides + (entry.hideId ? 1 : 0) })
  }
  return [...perLot.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, lot]) => ({ itemId: lot.itemId, itemColourId: lot.itemColourId, lotId: lot.lotId, quantity: q4(lot.quantity), hides: lot.hides }))
}

export const LOT_COLUMNS = { id: true, code: true, qualityStatus: true, requiresCrViTest: true, crViStatus: true, qualityNote: true, receivedAt: true, qualityDecidedAt: true } as const satisfies Prisma.LotSelect
export type LotRow = Prisma.LotGetPayload<{ select: typeof LOT_COLUMNS }>

export async function readLots(db: Reader, lotIds: readonly string[]): Promise<LotRow[]> {
  const ids = [...new Set(lotIds)]
  return ids.length === 0 ? [] : db.lot.findMany({ where: { id: { in: ids } }, select: LOT_COLUMNS })
}

export const lotFactsOf = (lot: LotRow): LotFacts => ({ id: lot.id, qualityStatus: lot.qualityStatus, requiresCrViTest: lot.requiresCrViTest, crViStatus: lot.crViStatus })

// ---- open purchase orders ---------------------------------------------------------------------------------------------

export interface PurchaseRead extends PlanPurchase {
  readonly purchaseOrderId: string
  readonly purchaseOrderStatus: string
  readonly seq: number
  readonly confirmed: boolean
}

/** The site's open purchase order lines of these items, with what they still bring (confirmed or ordered, less posted receipts). */
export async function readPurchases(db: Reader, siteId: string, itemIds: readonly string[]): Promise<PurchaseRead[]> {
  if (itemIds.length === 0) return []
  const lines = await db.purchaseOrderLine.findMany({
    where: { siteId, itemId: { in: [...itemIds] }, purchaseOrder: { status: { in: [...OPEN_PURCHASE_STATUSES] } } },
    select: {
      id: true,
      seq: true,
      itemId: true,
      itemColourId: true,
      quantity: true,
      baseQuantity: true,
      confirmedQuantity: true,
      needDate: true,
      confirmedDate: true,
      purchaseOrderId: true,
      purchaseOrder: { select: { number: true, status: true } },
    },
    orderBy: [{ purchaseOrderId: 'asc' }, { seq: 'asc' }],
  })
  const received =
    lines.length === 0
      ? []
      : await db.goodsReceiptLine.groupBy({ by: ['purchaseOrderLineId'], where: { purchaseOrderLineId: { in: lines.map((line) => line.id) }, receipt: { status: 'POSTED' } }, _sum: { baseQuantity: true } })
  const receivedOf = new Map(received.map((row) => [row.purchaseOrderLineId, row._sum.baseQuantity?.toString() ?? '0']))
  return lines.map((line) => ({
    purchaseOrderId: line.purchaseOrderId,
    purchaseOrderNumber: line.purchaseOrder.number,
    purchaseOrderStatus: line.purchaseOrder.status,
    purchaseOrderLineId: line.id,
    seq: line.seq,
    itemId: line.itemId,
    itemColourId: line.itemColourId,
    confirmed: line.confirmedDate !== null || line.confirmedQuantity !== null,
    openQuantity: openQuantityOf({
      quantity: line.quantity.toString(),
      baseQuantity: line.baseQuantity.toString(),
      confirmedQuantity: line.confirmedQuantity === null ? null : line.confirmedQuantity.toString(),
      received: receivedOf.get(line.id) ?? '0',
    }),
    dueDate: dayOf(line.confirmedDate ?? line.needDate),
  }))
}
