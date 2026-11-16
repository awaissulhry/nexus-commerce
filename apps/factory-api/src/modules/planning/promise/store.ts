import { ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time' // B-W2b-GB29: businessDate
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
// B-W2b-GB29 (G224): planned work orders in the promise's queue, planned finishes, quality-held finished garments.
import { demandOf } from '@nexus/factory-domain/planning/planned-orders/rules'
import type { OpenWorkOrder } from '../capacity/service'
import { garmentsOf, STEP_VARIANT_COLUMNS, type LoadCell } from '../capacity/steps'
import { lineOptionsOf } from '../planned-orders/steps'

/**
 * What promise dates read (B-W2b-301), in one client, one query after another. Office only: a site is seen with
 * planning.promise.view over its company and the site (else not found); a quote or an order line also with its own view
 * permission (the routes check it).
 *
 *   style      the style, its size range in order, its ACTIVE colourways, the revision a promise makes (the one asked or
 *              named, else the newest RELEASED one) and its routing
 *   stock      per SKU (colourway × size) at the site: finished garments on hand at its finished-goods places (the
 *              ledger, B-W2a-12; B-W2b-GB29: less what a quality hold keeps from shipping, `heldFinishedOf`), what open
 *              work orders still bring (their cells less what went into finished goods and what shipped straight from
 *              the release; B-W2b-GB29: on the board's planned finish, else the due date, `plannedFinishesOf`), the
 *              plan's planned work orders (B-W2b-293), what open customer
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
export function withPromiseLines(db: Reader, lines: readonly Omit<PlanOrderLine, 'dueDate'>[], options: ReadonlyMap<string, readonly string[]> = new Map()): (demand: DemandRead) => Promise<DemandRead> {
  return async (demand) => {
    const dates = demand.orderLines.flatMap((line) => (line.dueDate ? [line.dueDate] : []))
    const last = dates.length === 0 ? null : dates.reduce((a, b) => (a > b ? a : b))
    const after = last === null ? '2000-01-02' : new Date(Date.parse(`${last}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
    const added: PlanOrderLine[] = lines.map((line) => ({ ...line, dueDate: after }))
    // B-W2b-GB29 (G223): each added line's chosen options configure its explosion (an option's BOM lines and effects).
    const chosenOptions = new Map([...(demand.chosenOptions ?? new Map<string, readonly string[]>())])
    for (const line of added) {
      const values = options.get(line.orderLineId)
      if (values && values.length > 0) chosenOptions.set(line.orderLineId, [...values])
    }
    const known = new Set(demand.revisions.map((revision) => revision.id))
    const revisions = [...demand.revisions]
    for (const revisionId of [...new Set(added.flatMap((line) => (line.revisionId && !known.has(line.revisionId) ? [line.revisionId] : [])))].sort()) {
      revisions.push({ id: revisionId, lines: await withoutCustomerSupplied(db, revisionId, await readLines(db, revisionId)) })
    }
    return { ...demand, orderLines: [...demand.orderLines, ...added], revisions, unplaced: demand.unplaced, ...(chosenOptions.size > 0 ? { chosenOptions } : {}) } // B-W2b-GB29: ...demand keeps what else the demand carries
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
    // B-W2b-GB29 (G224): garments a quality hold keeps from shipping are not on hand to promise (capped at what is there).
    const itemOfCell = (colourwayId: string, size: string): string | null => {
      const variant = variantOf.get(skuKey(colourwayId, size))
      return variant ? (itemOfVariant.get(variant.id)?.id ?? null) : null
    }
    for (const [itemId, pieces] of await heldFinishedOf(db, site, itemIds, itemOfCell)) onHand.set(itemId, (onHand.get(itemId) ?? 0) - Math.min(pieces, Math.max(0, onHand.get(itemId) ?? 0)))
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
    // B-W2b-GB29 (G224): a work order on the planning board brings its garments at the board's planned finish, else on its due date.
    const finishes = await plannedFinishesOf(db, site, workOrderIds)
    for (const cell of cells) {
      const sku = entry(cell.colourwayId, cell.size)
      const left = max0(cell.quantity - (sku.itemId ? max0(receivedOf.get(`${cell.workOrderId}|${sku.itemId}`) ?? 0) : 0) - (directOf.get(cell.id) ?? 0))
      if (left === 0) continue
      const date = finishes.get(cell.workOrderId) ?? (cell.workOrder.dueDate ? dayOf(cell.workOrder.dueDate) : null)
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

// ---- B-W2b-GB29 (G224, begin): the promise's queue, planned finishes and quality-held garments -------------------------

/**
 * The plan's planned work orders as load of a promise's queue (B-W2b-GB29, G224; B-W2b-301's gap "the queue does not count
 * planned work orders"): each PLANNED MAKE order of the site — work the plan already holds for confirmed demand — books
 * its routing's minutes ahead of a new promise, as an unplaced released work order does: on its due date, at the site's
 * first ACTIVE work centre (by code) of each step's kind, and on its planned line when it has one. Its revision is its own,
 * else the style's newest RELEASED one (none: no routing, no load). A step only for some sizes, colourways or options is
 * done on the garments of the cells it is for (capacity/steps `garmentsOf`; a pegged order line's chosen options, none for
 * stock); a step done outside books no lane of ours. SUBCONTRACT orders book their workshop (subcontract-capacity), never
 * our lanes.
 */
export async function plannedLoadOf(db: Reader, site: SiteRow): Promise<OpenWorkOrder[]> {
  const rows = await db.plannedWorkOrder.findMany({
    where: { siteId: site.id, status: 'PLANNED', kind: 'MAKE' },
    select: { id: true, styleId: true, colourwayId: true, styleRevisionId: true, sizes: true, dueDate: true, lineId: true, demand: true, style: { select: { id: true, code: true, name: true } } },
    orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
  })
  if (rows.length === 0) return []
  const released = new Map<string, string | null>()
  for (const styleId of [...new Set(rows.filter((row) => row.styleRevisionId === null).map((row) => row.styleId))].sort()) {
    released.set(styleId, (await db.styleRevision.findFirst({ where: { styleId, status: 'RELEASED' }, select: { id: true }, orderBy: { revision: 'desc' } }))?.id ?? null)
  }
  const revisionIds = [...new Set(rows.flatMap((row) => { const id = row.styleRevisionId ?? released.get(row.styleId) ?? null; return id ? [id] : [] }))]
  const steps = revisionIds.length === 0 ? [] : await db.routingOperation.findMany({
    where: { revisionId: { in: revisionIds } },
    select: { revisionId: true, seq: true, code: true, name: true, workCentreKind: true, standardMinutes: true, supplierId: true, ...STEP_VARIANT_COLUMNS },
    orderBy: [{ revisionId: 'asc' }, { seq: 'asc' }],
  })
  const centres = await db.workCentre.findMany({ where: { siteId: site.id, status: 'ACTIVE' }, select: { id: true, kind: true }, orderBy: [{ code: 'asc' }, { id: 'asc' }] })
  const centreOf = (kind: string): string | null => centres.find((centre) => centre.kind === kind)?.id ?? null
  const options = await lineOptionsOf(db, rows.flatMap((row) => demandOf(row.demand).map((entry) => entry.orderLineId)))
  return rows.flatMap((row) => {
    const revisionId = row.styleRevisionId ?? released.get(row.styleId) ?? null
    const own = steps.filter((step) => step.revisionId === revisionId && step.supplierId === null)
    if (own.length === 0) return []
    // The garments as cells: each size's pegged order lines (with their options), the rest of the size for stock.
    const demand = demandOf(row.demand)
    const cells: LoadCell[] = sizesOf(row.sizes).flatMap(({ size, quantity }) => {
      const pegged = demand.filter((entry) => entry.size === size)
      const peggedPieces = pegged.reduce((sum, entry) => sum + entry.pieces, 0)
      return [
        ...pegged.map((entry) => ({ colourwayId: row.colourwayId, size, quantity: Math.min(entry.pieces, quantity), optionValueIds: options.get(entry.orderLineId) ?? [] })),
        ...(quantity > peggedPieces ? [{ colourwayId: row.colourwayId, size, quantity: quantity - peggedPieces, optionValueIds: [] as string[] }] : []),
      ]
    })
    const operations = own.flatMap((step) => {
      const workCentreId = centreOf(step.workCentreKind)
      if (!workCentreId) return []
      return [{ id: `${row.id}:${step.seq}`, seq: step.seq, code: step.code, name: step.name, standardMinutes: step.standardMinutes.toString(), workCentreId, done: 0, pieces: garmentsOf(step, cells) }]
    })
    if (operations.length === 0) return []
    return [{
      id: row.id,
      number: `Planned ${row.id.slice(0, 8)}`,
      status: 'PLANNED',
      dueDate: dayOf(row.dueDate),
      lineId: row.lineId,
      pieces: sizesOf(row.sizes).reduce((sum, entry) => sum + entry.quantity, 0),
      style: row.style,
      operations,
      operationsById: new Map(operations.map((operation) => [operation.id, operation])),
    }]
  })
}

/**
 * When each open work order of the site finishes on the WORKING plan (B-W2b-GB29, G224; B-W2b-301's gap "ATP uses the due
 * date, not the board's planned finish"): the day (site zone) its latest bar or part ends — the board's planned finish
 * (schedule's backward `plannedFinish`, the order-line promise's `finish`). A work order not on the board has none here: its
 * garments stay expected on its due date. Two reads; no permission.
 */
export async function plannedFinishesOf(db: Reader, site: Pick<SiteRow, 'id' | 'timezone'>, workOrderIds: readonly string[]): Promise<Map<string, BusinessDate>> {
  if (workOrderIds.length === 0) return new Map()
  const plan = await db.planVersion.findFirst({ where: { siteId: site.id, kind: 'WORKING' }, select: { id: true } })
  if (!plan) return new Map()
  const rows = await db.scheduleSlot.groupBy({ by: ['workOrderId'], where: { planVersionId: plan.id, workOrderId: { in: [...workOrderIds] } }, _max: { endAt: true } })
  const out = new Map<string, BusinessDate>()
  for (const row of rows) if (row._max.endAt) out.set(row.workOrderId, businessDate(new Date(row._max.endAt.getTime() - 1), site.timezone))
  return out
}

/**
 * Finished garments on hand that may not ship (B-W2b-GB29, G224; B-W2b-301's gap "finished goods under a quality hold count
 * as on hand"), per FINISHED item: what shipping's packing check refuses (quality/holds checks `holdOnPacking`) — the
 * garments a work order under an ACTIVE hold of the site put into finished goods (its production receipts, less their
 * reversals, less what shipped from stock of its cells), and the RELEASED serials under an ACTIVE serial hold whose work order
 * is not held itself. The caller caps it at what is on hand.
 */
export async function heldFinishedOf(db: Reader, site: Pick<SiteRow, 'id'>, itemIds: readonly string[], itemOfCell: (colourwayId: string, size: string) => string | null): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (itemIds.length === 0) return out
  const holds = await db.qualityHold.findMany({ where: { siteId: site.id, status: 'ACTIVE', subjectType: { in: ['WorkOrder', 'GarmentSerial'] } }, select: { subjectType: true, subjectIds: true } })
  const heldOrders = [...new Set(holds.filter((hold) => hold.subjectType === 'WorkOrder').flatMap((hold) => hold.subjectIds))]
  const heldSerials = [...new Set(holds.filter((hold) => hold.subjectType === 'GarmentSerial').flatMap((hold) => hold.subjectIds))]
  const add = (itemId: string, pieces: number) => out.set(itemId, (out.get(itemId) ?? 0) + pieces)
  if (heldOrders.length > 0) {
    const received = await db.stockMove.groupBy({ by: ['workOrderId', 'itemId', 'reversalOfId'], where: { siteId: site.id, reason: PRODUCTION_RECEIPT, workOrderId: { in: heldOrders }, itemId: { in: [...itemIds] } }, _sum: { baseQuantity: true } })
    const net = new Map<string, number>()
    for (const row of received) {
      const key = `${row.workOrderId}|${row.itemId}`
      const quantity = Number(row._sum.baseQuantity?.toString() ?? '0')
      net.set(key, (net.get(key) ?? 0) + (row.reversalOfId ? -quantity : quantity))
    }
    // What shipped from stock of the held work orders' cells (a shipment line names its cell; the stock move its line).
    const cells = await db.workOrderSize.findMany({ where: { workOrderId: { in: heldOrders } }, select: { id: true, workOrderId: true, colourwayId: true, size: true } })
    const lines = cells.length === 0 ? [] : await db.shipmentLine.findMany({ where: { workOrderSizeId: { in: cells.map((cell) => cell.id) } }, select: { id: true, workOrderSizeId: true } })
    const shipped = lines.length === 0 ? [] : await db.stockMove.groupBy({ by: ['shipmentLineId'], where: { shipmentLineId: { in: lines.map((line) => line.id) }, reason: 'SHIPMENT' }, _sum: { baseQuantity: true } })
    const cellOf = new Map(cells.map((cell) => [cell.id, cell]))
    const lineCell = new Map(lines.map((line) => [line.id, cellOf.get(line.workOrderSizeId)]))
    for (const row of shipped) {
      const cell = row.shipmentLineId ? lineCell.get(row.shipmentLineId) : undefined
      const itemId = cell ? itemOfCell(cell.colourwayId, cell.size) : null
      if (!cell || !itemId) continue
      const key = `${cell.workOrderId}|${itemId}`
      net.set(key, (net.get(key) ?? 0) - Number(row._sum.baseQuantity?.toString() ?? '0'))
    }
    for (const [key, pieces] of net) if (pieces > 0) add(key.split('|')[1]!, pieces)
  }
  if (heldSerials.length > 0) {
    const serials = await db.garmentSerial.findMany({ where: { id: { in: heldSerials }, siteId: site.id, status: 'RELEASED', workOrderId: { notIn: heldOrders } }, select: { workOrderSize: { select: { colourwayId: true, size: true } } } })
    for (const serial of serials) {
      const itemId = itemOfCell(serial.workOrderSize.colourwayId, serial.workOrderSize.size)
      if (itemId && itemIds.includes(itemId)) add(itemId, 1)
    }
  }
  return out
}
// ---- B-W2b-GB29 (G224, end) --------------------------------------------------------------------------------------------
