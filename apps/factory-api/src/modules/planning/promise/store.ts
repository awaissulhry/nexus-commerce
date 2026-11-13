import { ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { OPEN_WORK_ORDER_STATUSES } from '@nexus/factory-domain/planning/explode'
import type { AtpFlow } from '@nexus/factory-domain/planning/promise/atp'
import { PLANNING_PROMISE_VIEW } from '@nexus/factory-domain/planning/promise/permissions'
import { currentPromiseOf, type StoredPromise } from '@nexus/factory-domain/planning/promise/rules'
import { sizesOf } from '@nexus/factory-domain/planning/planned-orders/rules'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { finishedPlaces, PRODUCTION_RECEIPT } from '../../inventory/finished/post'
import { readLines } from '../../product/bom/store'
// B-W2b-228 (PRD-084): a material the customer sends is not bought.
import { withoutCustomerSupplied } from '../../product/bom-lines/store'
import { officeContextOf } from '../access'
import { dayOf, SITE_COLUMNS, type DemandRead, type Reader, type SiteRow } from '../store'
import type { PlanOrderLine } from '@nexus/factory-domain/planning/explode'

/**
 * What promise dates read (B-W2b-301), in one client, one query after another. Office only: a site is seen with
 * planning.promise.view over its company and the site (else not found); a quote or an order line also with its own view
 * permission (the routes check it).
 *
 *   style      the style, its size range in order, its ACTIVE colourways, the revision a promise makes (the one asked or
 *              named, else the newest RELEASED one) and its routing
 *   stock      per SKU (colourway × size) at the site: finished garments on hand at its finished-goods places (the
 *              ledger, B-W2a-12), what open work orders still bring (their cells less what went into finished goods and
 *              what shipped straight from the release), the plan's planned work orders (B-W2b-293), what open customer
 *              order lines still wait for (ordered less shipped; a size's newest promise, else the line's delivery
 *              schedule, else its date), and the SKU's production strategy at the site (ItemPlanning.strategy)
 *   promises   an order line's PromiseRecord rows (B-W2b-286)
 */

export const ORDER_DEMAND_STATUSES = ['CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED'] as const
/** The order states a promise may still be recorded in (the PromiseRecord guard refuses SHIPPED, CLOSED, CANCELLED). */
export const PROMISABLE_ORDER_STATUSES = ['PENDING_APPROVAL', 'CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED'] as const
const SHIPPED_STATUSES = ['SHIPPED', 'DELIVERED'] as const

// ---- access -------------------------------------------------------------------------------------------------------------

export const mayPromiseAt = (context: OfficeContext, permission: Permission, site: Pick<SiteRow, 'companyId' | 'id'>): boolean => can(actorOf(context), permission, { companyId: site.companyId, siteId: site.id })

/** The site the caller asks about: seen with planning.promise.view (else not found), `permission` held there (else forbidden). */
export async function promiseSite(caller: CommandCaller, siteId: string, permission: Permission = PLANNING_PROMISE_VIEW, db?: Reader): Promise<SiteRow> {
  const context = officeContextOf(caller)
  const read = (client: Reader) => (isUuid(siteId) ? client.site.findUnique({ where: { id: siteId }, select: SITE_COLUMNS }) : Promise.resolve(null))
  const site = db ? await read(db) : await caller.withClient(read)
  if (!site || !mayPromiseAt(context, PLANNING_PROMISE_VIEW, site)) throw new NotFoundError('Site not found.')
  if (!mayPromiseAt(context, permission, site)) throw new ForbiddenError()
  return site
}

/** The site a company's work is planned at when none is named: its only ACTIVE plant (as MRP places order lines). */
export async function plantOf(db: Reader, companyId: string, siteId: string | null | undefined, path: string): Promise<SiteRow> {
  if (siteId) {
    const site = isUuid(siteId) ? await db.site.findUnique({ where: { id: siteId }, select: SITE_COLUMNS }) : null
    if (!site || site.companyId !== companyId) throw new ValidationError('The site is not a site of the company.', [{ path, message: 'Name a site of the company.' }])
    return site
  }
  const plants = await db.site.findMany({ where: { companyId, kind: 'PLANT', status: 'ACTIVE' }, select: SITE_COLUMNS, orderBy: [{ code: 'asc' }, { id: 'asc' }], take: 2 })
  if (plants.length !== 1) throw new ValidationError(plants.length === 0 ? 'The company has no active plant to make it.' : 'The company has several plants: name the site that makes it.', [{ path, message: 'Name the site.' }])
  return plants[0]!
}

// ---- the style ------------------------------------------------------------------------------------------------------------

export const STYLE_COLUMNS = { id: true, code: true, name: true, companyId: true, status: true, sizes: true, baseSize: true } as const

export interface StyleFacts {
  readonly style: { id: string; code: string; name: string; companyId: string | null; status: string; sizes: string[]; baseSize: string | null }
  readonly colourways: readonly { id: string; code: string; name: string }[]
}

export async function readStyleFacts(db: Reader, styleId: string): Promise<StyleFacts | null> {
  if (!isUuid(styleId)) return null
  const style = await db.style.findUnique({ where: { id: styleId }, select: STYLE_COLUMNS })
  if (!style) return null
  const colourways = await db.colourway.findMany({ where: { styleId, status: 'ACTIVE' }, select: { id: true, code: true, name: true }, orderBy: [{ code: 'asc' }, { id: 'asc' }] })
  return { style: { ...style, sizes: [...style.sizes] }, colourways }
}

export interface RevisionFacts {
  readonly id: string
  readonly revision: number
  readonly status: string
}

/** The revision a promise makes: the one asked (of the style), else the newest RELEASED one; null: none. */
export async function revisionFor(db: Reader, styleId: string, asked: string | null | undefined): Promise<RevisionFacts | null> {
  if (asked) {
    const row = isUuid(asked) ? await db.styleRevision.findUnique({ where: { id: asked }, select: { id: true, styleId: true, revision: true, status: true } }) : null
    if (!row || row.styleId !== styleId) throw new ValidationError('The revision is not a revision of the style.', [{ path: 'body/revisionId', message: 'Name a revision of the style.' }])
    return { id: row.id, revision: row.revision, status: row.status }
  }
  const released = await db.styleRevision.findFirst({ where: { styleId, status: 'RELEASED' }, select: { id: true, revision: true, status: true }, orderBy: { revision: 'desc' } })
  return released
}

export interface RoutingStepRow {
  readonly seq: number
  readonly name: string
  readonly workCentreKind: string
  readonly standardMinutes: string
  readonly supplierId: string | null
  readonly transitDays: number | null
  readonly appliesToSizes: readonly string[]
  readonly appliesToColourwayIds: readonly string[]
  /** B-W2b-365: a step only for some options (./steps `stepsForOptions`). */
  readonly appliesToOptionValueIds: readonly string[]
}

export async function readRouting(db: Reader, revisionId: string | null): Promise<RoutingStepRow[]> {
  if (!revisionId) return []
  const rows = await db.routingOperation.findMany({
    where: { revisionId },
    select: { seq: true, name: true, workCentreKind: true, standardMinutes: true, supplierId: true, transitDays: true, appliesToSizes: true, appliesToColourwayIds: true, /* B-W2b-365 */ appliesToOptionValueIds: true },
    orderBy: { seq: 'asc' },
  })
  return rows.map((row) => ({ ...row, standardMinutes: row.standardMinutes.toString() }))
}

/**
 * A promise's lines added to the plan's demand (planning/inputs `readPlanInputs`'s B-W2b-301 hook): after every real order
 * line (their day is after the last dated one), with the revisions they explode that the demand did not read yet.
 */
export function withPromiseLines(db: Reader, lines: readonly Omit<PlanOrderLine, 'dueDate'>[]): (demand: DemandRead) => Promise<DemandRead> {
  return async (demand) => {
    const dates = demand.orderLines.flatMap((line) => (line.dueDate ? [line.dueDate] : []))
    const last = dates.length === 0 ? null : dates.reduce((a, b) => (a > b ? a : b))
    const after = last === null ? '2000-01-02' : new Date(Date.parse(`${last}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
    const added: PlanOrderLine[] = lines.map((line) => ({ ...line, dueDate: after }))
    const known = new Set(demand.revisions.map((revision) => revision.id))
    const revisions = [...demand.revisions]
    for (const revisionId of [...new Set(added.flatMap((line) => (line.revisionId && !known.has(line.revisionId) ? [line.revisionId] : [])))].sort()) {
      revisions.push({ id: revisionId, lines: await withoutCustomerSupplied(db, revisionId, await readLines(db, revisionId)) })
    }
    return { orderLines: [...demand.orderLines, ...added], revisions, unplaced: demand.unplaced }
  }
}

// ---- stock, receipts and commitments of a style at a site -------------------------------------------------------------

export const skuKey = (colourwayId: string, size: string): string => `${colourwayId}|${size}`

export interface SkuFlows {
  readonly colourwayId: string
  readonly size: string
  readonly itemId: string | null
  readonly sku: string | null
  readonly strategy: string | null
  readonly onHand: number
  readonly receipts: AtpFlow[]
  readonly commitments: AtpFlow[]
  /** Where the receipts and commitments come from (the cell's popover). */
  readonly sources: { kind: 'WORK_ORDER' | 'PLANNED_ORDER' | 'ORDER_LINE'; id: string; number: string; date: BusinessDate | null; pieces: number }[]
}

const max0 = (value: number): number => (value > 0 ? value : 0)

/** An order line's open pieces per size and day: shipped taken from the earliest; a size's own newest promise wins. */
export function openFlowsOf(input: {
  readonly sizes: readonly { size: string; quantity: number }[]
  readonly deliveries: readonly { date: BusinessDate; sizeQuantities: Readonly<Record<string, number>> | null }[]
  readonly shipped: (size: string) => number
  readonly lineDate: BusinessDate | null
  readonly promiseOf: (size: string) => BusinessDate | null
}): { size: string; date: BusinessDate | null; pieces: number }[] {
  const out: { size: string; date: BusinessDate | null; pieces: number }[] = []
  for (const { size, quantity } of input.sizes) {
    const promised = input.promiseOf(size)
    let shipped = max0(input.shipped(size))
    if (promised !== null) {
      const open = max0(quantity - shipped)
      if (open > 0) out.push({ size, date: promised, pieces: open })
      continue
    }
    const parts: { date: BusinessDate | null; pieces: number }[] = []
    let left = quantity
    for (const delivery of [...input.deliveries].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))) {
      const pieces = Math.min(left, max0(Number(delivery.sizeQuantities?.[size] ?? 0)))
      if (pieces > 0) parts.push({ date: delivery.date, pieces })
      left -= pieces
    }
    if (left > 0) parts.push({ date: input.lineDate, pieces: left })
    for (const part of parts) {
      const taken = Math.min(shipped, part.pieces)
      shipped -= taken
      if (part.pieces - taken > 0) out.push({ size, date: part.date, pieces: part.pieces - taken })
    }
  }
  return out
}

const sizeQuantitiesOf = (value: unknown): Record<string, number> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value as Record<string, unknown>).flatMap(([size, pieces]) => (typeof pieces === 'number' ? [[size, pieces]] : []))) : null

/** The PromiseRecord rows of order lines, oldest first. */
export async function readPromiseRows(db: Reader, lineIds: readonly string[]): Promise<Map<string, StoredPromise[]>> {
  const out = new Map<string, StoredPromise[]>()
  if (lineIds.length === 0) return out
  const rows = await db.promiseRecord.findMany({
    where: { salesOrderLineId: { in: [...lineIds] } },
    select: { id: true, salesOrderLineId: true, size: true, promisedDate: true, kind: true, promisedAt: true, reasonCode: true, reason: true, siteId: true, planVersionId: true, customerToldAt: true },
    orderBy: [{ promisedAt: 'asc' }, { id: 'asc' }],
  })
  for (const row of rows) out.set(row.salesOrderLineId, [...(out.get(row.salesOrderLineId) ?? []), { id: row.id, size: row.size, promisedDate: dayOf(row.promisedDate), kind: row.kind, promisedAt: row.promisedAt }])
  return out
}

/** Every SKU of the style at the site with its flows (one entry per ACTIVE colourway × size of the range). */
export async function readSkuFlows(db: Reader, site: SiteRow, facts: StyleFacts): Promise<SkuFlows[]> {
  const styleId = facts.style.id
  const variants = await db.variant.findMany({ where: { styleId }, select: { id: true, colourwayId: true, size: true, sku: true } })
  const variantOf = new Map(variants.map((variant) => [skuKey(variant.colourwayId, variant.size), variant]))
  const items = variants.length === 0 ? [] : await db.item.findMany({ where: { kind: 'FINISHED', variantId: { in: variants.map((variant) => variant.id) } }, select: { id: true, code: true, variantId: true } })
  const itemOfVariant = new Map(items.map((item) => [item.variantId!, item]))
  const itemIds = items.map((item) => item.id)
  const planning = itemIds.length === 0 ? [] : await db.itemPlanning.findMany({ where: { siteId: site.id, itemId: { in: itemIds } }, select: { itemId: true, itemColourId: true, strategy: true }, orderBy: { id: 'asc' } })
  const strategyOf = (itemId: string): string | null => (planning.find((row) => row.itemId === itemId && row.itemColourId === null) ?? planning.find((row) => row.itemId === itemId))?.strategy ?? null

  // On hand at the site's finished-goods places.
  const places = (await finishedPlaces(db, site.id)).map((place) => place.id)
  const onHand = new Map<string, number>()
  if (itemIds.length > 0 && places.length > 0) {
    const into = await db.stockMove.groupBy({ by: ['itemId'], where: { siteId: site.id, itemId: { in: itemIds }, toLocationId: { in: places } }, _sum: { baseQuantity: true } })
    const outOf = await db.stockMove.groupBy({ by: ['itemId'], where: { siteId: site.id, itemId: { in: itemIds }, fromLocationId: { in: places } }, _sum: { baseQuantity: true } })
    for (const row of into) onHand.set(row.itemId, (onHand.get(row.itemId) ?? 0) + Number(row._sum.baseQuantity?.toString() ?? '0'))
    for (const row of outOf) onHand.set(row.itemId, (onHand.get(row.itemId) ?? 0) - Number(row._sum.baseQuantity?.toString() ?? '0'))
  }

  const flows = new Map<string, SkuFlows>()
  const entry = (colourwayId: string, size: string): SkuFlows => {
    const key = skuKey(colourwayId, size)
    let found = flows.get(key)
    if (!found) {
      const variant = variantOf.get(key)
      const item = variant ? itemOfVariant.get(variant.id) : undefined
      found = { colourwayId, size, itemId: item?.id ?? null, sku: variant?.sku ?? null, strategy: item ? strategyOf(item.id) : null, onHand: item ? Math.max(0, Math.floor(onHand.get(item.id) ?? 0)) : 0, receipts: [], commitments: [], sources: [] }
      flows.set(key, found)
    }
    return found
  }
  for (const colourway of facts.colourways) for (const size of facts.style.sizes) entry(colourway.id, size)

  // Open work orders: their cells less what went into finished goods and what shipped straight from the release.
  const cells = await db.workOrderSize.findMany({
    where: { siteId: site.id, styleId, workOrder: { status: { in: [...OPEN_WORK_ORDER_STATUSES] }, kind: { notIn: ['REPAIR', 'SAMPLE'] } } },
    select: { id: true, workOrderId: true, colourwayId: true, size: true, quantity: true, workOrder: { select: { number: true, dueDate: true } } },
    orderBy: [{ workOrderId: 'asc' }, { size: 'asc' }],
  })
  if (cells.length > 0) {
    const workOrderIds = [...new Set(cells.map((cell) => cell.workOrderId))]
    const received = itemIds.length === 0 ? [] : await db.stockMove.groupBy({ by: ['workOrderId', 'itemId', 'reversalOfId'], where: { siteId: site.id, reason: PRODUCTION_RECEIPT, workOrderId: { in: workOrderIds }, itemId: { in: itemIds } }, _sum: { baseQuantity: true } })
    const receivedOf = new Map<string, number>()
    for (const row of received) {
      const key = `${row.workOrderId}|${row.itemId}`
      const quantity = Number(row._sum.baseQuantity?.toString() ?? '0')
      receivedOf.set(key, (receivedOf.get(key) ?? 0) + (row.reversalOfId ? -quantity : quantity))
    }
    const lines = await db.shipmentLine.findMany({ where: { workOrderSizeId: { in: cells.map((cell) => cell.id) }, shipment: { status: { in: [...SHIPPED_STATUSES] } } }, select: { id: true, workOrderSizeId: true, quantity: true } })
    const fromStock = lines.length === 0 ? [] : await db.stockMove.groupBy({ by: ['shipmentLineId'], where: { shipmentLineId: { in: lines.map((line) => line.id) }, reason: 'SHIPMENT' }, _sum: { baseQuantity: true } })
    const fromStockOf = new Map(fromStock.map((row) => [row.shipmentLineId!, Number(row._sum.baseQuantity?.toString() ?? '0')]))
    const directOf = new Map<string, number>()
    for (const line of lines) directOf.set(line.workOrderSizeId, (directOf.get(line.workOrderSizeId) ?? 0) + max0(line.quantity - (fromStockOf.get(line.id) ?? 0)))
    for (const cell of cells) {
      const sku = entry(cell.colourwayId, cell.size)
      const left = max0(cell.quantity - (sku.itemId ? max0(receivedOf.get(`${cell.workOrderId}|${sku.itemId}`) ?? 0) : 0) - (directOf.get(cell.id) ?? 0))
      if (left === 0) continue
      const date = cell.workOrder.dueDate ? dayOf(cell.workOrder.dueDate) : null
      sku.receipts.push({ date, pieces: left })
      sku.sources.push({ kind: 'WORK_ORDER', id: cell.workOrderId, number: cell.workOrder.number, date, pieces: left })
    }
  }

  // The plan's planned work orders (not made real yet).
  const planned = await db.plannedWorkOrder.findMany({ where: { siteId: site.id, styleId, status: 'PLANNED' }, select: { id: true, colourwayId: true, sizes: true, dueDate: true }, orderBy: [{ dueDate: 'asc' }, { id: 'asc' }] })
  for (const row of planned) {
    const date = dayOf(row.dueDate)
    for (const { size, quantity } of sizesOf(row.sizes)) {
      const sku = entry(row.colourwayId, size)
      sku.receipts.push({ date, pieces: quantity })
      sku.sources.push({ kind: 'PLANNED_ORDER', id: row.id, number: `Planned ${row.id.slice(0, 8)}`, date, pieces: quantity })
    }
  }

  // Open customer order lines of the style at the site (or with no site when the site is the company's only plant).
  const plants = await db.site.count({ where: { companyId: site.companyId, kind: 'PLANT', status: 'ACTIVE' } })
  const onlyPlant = plants === 1 && site.kind === 'PLANT' && site.status === 'ACTIVE'
  const orderLines = await db.salesOrderLine.findMany({
    where: { styleId, kind: 'SIZE_GRID', companyId: site.companyId, closedShortAt: null, order: { status: { in: [...ORDER_DEMAND_STATUSES] } }, ...(onlyPlant ? { OR: [{ siteId: site.id }, { siteId: null }] } : { siteId: site.id }) },
    select: {
      id: true,
      seq: true,
      colourwayId: true,
      requestedDate: true,
      promiseDate: true,
      order: { select: { id: true, number: true, requestedDate: true, promiseDate: true } },
      sizes: { select: { size: true, quantity: true } },
      deliveries: { select: { deliveryDate: true, sizeQuantities: true } },
    },
    orderBy: [{ orderId: 'asc' }, { seq: 'asc' }],
  })
  if (orderLines.length > 0) {
    const lineIds = orderLines.map((line) => line.id)
    const shippedRows = await db.shipmentLine.groupBy({ by: ['salesOrderLineId', 'size'], where: { salesOrderLineId: { in: lineIds }, shipment: { status: { in: [...SHIPPED_STATUSES] } } }, _sum: { quantity: true } })
    const shippedOf = new Map(shippedRows.map((row) => [`${row.salesOrderLineId}|${row.size}`, row._sum.quantity ?? 0]))
    const promises = await readPromiseRows(db, lineIds)
    for (const line of orderLines) {
      const day = line.promiseDate ?? line.requestedDate ?? line.order.promiseDate ?? line.order.requestedDate
      const rows = promises.get(line.id) ?? []
      const parts = openFlowsOf({
        sizes: line.sizes,
        deliveries: line.deliveries.map((delivery) => ({ date: dayOf(delivery.deliveryDate), sizeQuantities: sizeQuantitiesOf(delivery.sizeQuantities) })),
        shipped: (size) => shippedOf.get(`${line.id}|${size}`) ?? 0,
        lineDate: day ? dayOf(day) : null,
        // A size's newest promise row (its own or the line's every-size row) is the day it is waited for.
        promiseOf: (size) => (rows.length === 0 ? null : (currentPromiseOf(size, rows, null)?.date ?? null)),
      })
      for (const part of parts) {
        const sku = entry(line.colourwayId, part.size)
        sku.commitments.push({ date: part.date, pieces: part.pieces })
        sku.sources.push({ kind: 'ORDER_LINE', id: line.id, number: `${line.order.number} line ${line.seq}`, date: part.date, pieces: part.pieces })
      }
    }
  }
  return [...flows.values()]
}

/** The styles a site can promise from stock: a SKU set to make to stock there, or finished garments on hand. */
export async function readStockStyles(db: Reader, site: SiteRow, q: string | undefined, limit: number) {
  const planned = await db.itemPlanning.findMany({ where: { siteId: site.id, strategy: 'MAKE_TO_STOCK', item: { kind: 'FINISHED' } }, select: { item: { select: { variant: { select: { styleId: true } } } } } })
  const places = (await finishedPlaces(db, site.id)).map((place) => place.id)
  const stocked = new Set<string>()
  if (places.length > 0) {
    const into = await db.stockMove.groupBy({ by: ['itemId'], where: { siteId: site.id, toLocationId: { in: places } }, _sum: { baseQuantity: true } })
    const outOf = await db.stockMove.groupBy({ by: ['itemId'], where: { siteId: site.id, fromLocationId: { in: places } }, _sum: { baseQuantity: true } })
    const net = new Map<string, number>()
    for (const row of into) net.set(row.itemId, (net.get(row.itemId) ?? 0) + Number(row._sum.baseQuantity?.toString() ?? '0'))
    for (const row of outOf) net.set(row.itemId, (net.get(row.itemId) ?? 0) - Number(row._sum.baseQuantity?.toString() ?? '0'))
    const held = [...net.entries()].filter(([, quantity]) => quantity > 0).map(([itemId]) => itemId)
    if (held.length > 0) {
      const rows = await db.item.findMany({ where: { id: { in: held }, kind: 'FINISHED' }, select: { variant: { select: { styleId: true } } } })
      for (const row of rows) if (row.variant) stocked.add(row.variant.styleId)
    }
  }
  const toStock = new Set(planned.flatMap((row) => (row.item.variant ? [row.item.variant.styleId] : [])))
  const ids = [...new Set([...toStock, ...stocked])]
  if (ids.length === 0) return []
  const text = q?.trim()
  const styles = await db.style.findMany({
    where: { id: { in: ids }, ...(text ? { OR: [{ code: { contains: text, mode: 'insensitive' } }, { name: { contains: text, mode: 'insensitive' } }] } : {}) },
    select: { id: true, code: true, name: true },
    orderBy: [{ code: 'asc' }, { id: 'asc' }],
    take: limit,
  })
  return styles.map((style) => ({ ...style, makeToStock: toStock.has(style.id), onHand: stocked.has(style.id) }))
}
