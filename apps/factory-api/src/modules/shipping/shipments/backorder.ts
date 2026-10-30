import { ConflictError, InvalidStateError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { grantsFor, type Actor, type Permission } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { SHIPPING_VIEW } from '@nexus/factory-domain/shipping/permissions'
import { backorderTotals, backorderWords, orderCapProblems, sizeBackorder, type SizeBackorder } from '@nexus/factory-domain/shipping/shipments/backorder'
import type { CommandCaller, CommandTx } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { mayOn, officeContextOf } from '../access'
import { cellCounts } from '../cells'

/**
 * Partial shipments and the backorder (B-W2a-48; LOG-004; SCOPE W2a rule 1; design warehouse.shipments sh-lines
 * "SizeGridProgress with ordered / released / shipped before / this shipment per size"): what of an order's lines and
 * sizes left, is on its way, stays behind, and is ready for the next shipment (factory-domain shipping/shipments/
 * backorder). Office reads (shipping.view over the order's company and party):
 *
 *   GET /shipping/orders/:salesOrderId/backorder[?shipmentId=]   one order, line by line and size by size; with a
 *                                                                  shipment of it named, its garments apart
 *   GET /shipping/backorders                                       the open orders with something left to ship, a
 *                                                                  page at a time in SQL (several orders at once)
 *
 * And the rule the shipment commands hold (`assertOrderCaps`): a size never ships more than its order line ordered, and
 * a line closed short (B-W2a-30) takes no more garments.
 */

/** Shipments whose garments left (as the sales order counts them). */
const LEFT = ['SHIPPED', 'DELIVERED'] as const
/** Shipments that have not left yet. */
const OPEN = ['DRAFT', 'PACKED'] as const

type Reader = CommandTx

const ORDER_SELECT = { id: true, number: true, status: true, companyId: true, partyId: true, customerRef: true, promiseDate: true, party: { select: { code: true, legalName: true } } } as const

/** The sizes of an order line as rows: a size grid's, or a made-to-measure unit's one (its base size). */
function orderedSizes(line: { kind: string; quantity: number; baseSize: string | null; sizes: readonly { size: string; quantity: number }[] }): { size: string; quantity: number }[] {
  if (line.sizes.length > 0) return [...line.sizes].sort((a, b) => a.size.localeCompare(b.size, undefined, { numeric: true }))
  return [{ size: line.baseSize ?? '', quantity: line.quantity }]
}

/** Every line and size of these orders with its backorder figures (`shipmentId` apart, when named). */
async function readBackorders(db: Reader, orderIds: readonly string[], shipmentId: string | null) {
  if (orderIds.length === 0) return new Map<string, ReturnType<typeof lineView>[]>()
  // One query after another: a transaction's client has one connection.
  const lines = await db.salesOrderLine.findMany({
    where: { orderId: { in: [...orderIds] } },
    select: {
      id: true,
      orderId: true,
      seq: true,
      kind: true,
      quantity: true,
      baseSize: true,
      closedShortQuantity: true,
      closeShortReason: true,
      style: { select: { code: true, name: true } },
      colourway: { select: { code: true, name: true } },
      sizes: { select: { size: true, quantity: true } },
    },
    orderBy: [{ orderId: 'asc' }, { seq: 'asc' }],
  })
  const lineIds = lines.map((line) => line.id)
  const shipped = lineIds.length > 0
    ? await db.shipmentLine.groupBy({ by: ['salesOrderLineId', 'size', 'shipmentId'], where: { salesOrderLineId: { in: lineIds }, shipment: { status: { notIn: ['CANCELLED'] } } }, _sum: { quantity: true } })
    : []
  const shipmentIds = [...new Set(shipped.map((row) => row.shipmentId))]
  const statuses = new Map((shipmentIds.length > 0 ? await db.shipment.findMany({ where: { id: { in: shipmentIds } }, select: { id: true, status: true } }) : []).map((row) => [row.id, row.status]))
  const cells = lineIds.length > 0 ? await db.workOrderSize.findMany({ where: { salesOrderLineId: { in: lineIds }, workOrder: { kind: { not: 'REPAIR' } } }, select: { id: true, salesOrderLineId: true, size: true } }) : []
  const counts = await cellCounts(db, cells.map((cell) => cell.id))

  const key = (lineId: string, size: string) => `${lineId}|${size}`
  const add = (map: Map<string, number>, at: string, value: number) => map.set(at, (map.get(at) ?? 0) + value)
  const left = new Map<string, number>()
  const open = new Map<string, number>()
  const mine = new Map<string, number>()
  const holding = new Map<string, number>()
  for (const row of shipped) {
    const at = key(row.salesOrderLineId, row.size)
    const quantity = row._sum.quantity ?? 0
    const status = statuses.get(row.shipmentId)
    add(holding, at, quantity)
    if (row.shipmentId === shipmentId) add(mine, at, quantity)
    else if ((LEFT as readonly string[]).includes(status ?? '')) add(left, at, quantity)
    else if ((OPEN as readonly string[]).includes(status ?? '')) add(open, at, quantity)
  }
  const released = new Map<string, number>()
  for (const cell of cells) {
    const count = counts.get(cell.id)
    if (count) add(released, key(cell.salesOrderLineId, cell.size), count.released - count.reversed)
  }
  const byOrder = new Map<string, ReturnType<typeof lineView>[]>()
  for (const line of lines) {
    const sizes = orderedSizes(line).map((entry) =>
      sizeBackorder({
        size: entry.size,
        ordered: entry.quantity,
        closedShort: line.closedShortQuantity !== null,
        shipped: left.get(key(line.id, entry.size)) ?? 0,
        open: open.get(key(line.id, entry.size)) ?? 0,
        thisShipment: mine.get(key(line.id, entry.size)) ?? 0,
        netReleased: released.get(key(line.id, entry.size)) ?? 0,
        onShipments: holding.get(key(line.id, entry.size)) ?? 0,
      }),
    )
    byOrder.set(line.orderId, [...(byOrder.get(line.orderId) ?? []), lineView(line, sizes)])
  }
  return byOrder
}

function lineView(
  line: { id: string; seq: number; kind: string; closedShortQuantity: number | null; closeShortReason: string | null; style: { code: string; name: string }; colourway: { code: string; name: string } },
  sizes: SizeBackorder[],
) {
  return {
    lineId: line.id,
    seq: line.seq,
    kind: line.kind,
    styleCode: line.style.code,
    styleName: line.style.name,
    colourwayCode: line.colourway.code,
    colourwayName: line.colourway.name,
    closedShort: line.closedShortQuantity !== null,
    closeShortReason: line.closeShortReason,
    sizes,
    totals: backorderTotals(sizes),
  }
}

/** The order the office may see (its company and party), else 404. */
async function officeOrder(caller: CommandCaller, salesOrderId: string) {
  const context = officeContextOf(caller)
  const order = isUuid(salesOrderId) ? await caller.withClient((client) => client.salesOrder.findUnique({ where: { id: salesOrderId }, select: ORDER_SELECT })) : null
  if (!order || !mayOn(context, SHIPPING_VIEW, { companyId: order.companyId, partyId: order.partyId })) throw new NotFoundError('Sales order not found.')
  return order
}

const orderHeader = (order: { id: string; number: string; status: string; companyId: string; partyId: string; customerRef: string | null; promiseDate: Date | null; party: { code: string; legalName: string } }) => ({
  salesOrderId: order.id,
  number: order.number,
  status: order.status,
  companyId: order.companyId,
  partyId: order.partyId,
  party: order.party,
  customerRef: order.customerRef,
  promiseDate: order.promiseDate ? order.promiseDate.toISOString().slice(0, 10) : null,
})

/** GET /shipping/orders/:salesOrderId/backorder */
export async function orderBackorder(caller: CommandCaller, salesOrderId: string, query: { shipmentId?: string | undefined }) {
  const order = await officeOrder(caller, salesOrderId)
  return caller.withClient(async (client) => {
    let shipmentId: string | null = null
    if (query.shipmentId) {
      const shipment = isUuid(query.shipmentId) ? await client.shipment.findUnique({ where: { id: query.shipmentId }, select: { id: true, salesOrderId: true } }) : null
      if (!shipment || shipment.salesOrderId !== order.id) throw new NotFoundError('Shipment not found on this order.')
      shipmentId = shipment.id
    }
    const lines = (await readBackorders(client, [order.id], shipmentId)).get(order.id) ?? []
    const shipments = await client.shipment.findMany({ where: { salesOrderId: order.id }, select: { id: true, number: true, status: true, shippedAt: true }, orderBy: { number: 'asc' } })
    const totals = backorderTotals(lines.flatMap((line) => line.sizes))
    return {
      order: orderHeader(order),
      shipmentId,
      lines,
      totals,
      words: backorderWords(totals),
      shipments: shipments.map((shipment) => ({ id: shipment.id, number: shipment.number, status: shipment.status, shippedAt: shipment.shippedAt ? toUtcIso(shipment.shippedAt) : null })),
    }
  })
}

// ---- several orders at once: the list, a page at a time in SQL ------------------------------------------------------

/**
 * The union of the caller's grants for `permission` as SQL filters (null: every row): looser than can() when grants
 * differ (each grant's companies with its own parties), so every row is checked again with can() after the page is
 * read. Null result: the caller reaches nothing.
 */
export function looseScope(actor: Actor, permission: Permission): { companies: string[] | null; sites: string[] | null; parties: string[] | null } | null {
  const grants = grantsFor(actor, permission)
  if (grants.length === 0) return null
  const union = (pick: (grant: (typeof grants)[number]) => 'all' | readonly string[]) => (grants.some((grant) => pick(grant) === 'all') ? null : [...new Set(grants.flatMap((grant) => [...(pick(grant) as readonly string[])]))])
  return { companies: union((grant) => grant.companies), sites: union((grant) => grant.sites), parties: union((grant) => grant.parties) }
}

export interface BackordersQuery {
  readonly siteId?: string | undefined
  readonly partyId?: string | undefined
  readonly q?: string | undefined
  readonly cursor?: string | undefined
  readonly limit: number
}

const OPEN_ORDER_STATUSES = ['CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED']

/** GET /shipping/backorders: the open orders with garments still to ship (never a closed-short line's), oldest number first. */
export async function listBackorders(caller: CommandCaller, query: BackordersQuery) {
  const context = officeContextOf(caller)
  const scope = looseScope(actorOf(context), SHIPPING_VIEW)
  if (!scope) return { orders: [], nextCursor: null }
  return caller.withClient(async (client) => {
    const cursor = query.cursor && isUuid(query.cursor) ? await client.salesOrder.findUnique({ where: { id: query.cursor }, select: { id: true, number: true } }) : null
    const q = query.q?.trim() ? `%${query.q.trim().replace(/[\\%_]/g, (match) => `\\${match}`)}%` : null
    // Ordered less closed (a closed line leaves nothing) less on shipments that are not CANCELLED or RETURNED, per line
    // and size (a made-to-measure unit: its one size), added up per order.
    const rows = await client.$queryRaw<{ id: string; number: string; backorder: number }[]>`
      WITH sized AS (
        SELECT l.id AS line_id, l."orderId" AS order_id, COALESCE(s.size, l."baseSize", '') AS size, COALESCE(s.quantity, l.quantity) AS ordered
          FROM "SalesOrderLine" l LEFT JOIN "SalesOrderLineSize" s ON s."lineId" = l.id
         WHERE l."closedShortQuantity" IS NULL
      ), held AS (
        SELECT sl."salesOrderLineId" AS line_id, sl.size, SUM(sl.quantity)::int AS quantity
          FROM "ShipmentLine" sl JOIN "Shipment" sh ON sh.id = sl."shipmentId"
         WHERE sh.status::text IN ('DRAFT', 'PACKED', 'SHIPPED', 'DELIVERED')
         GROUP BY sl."salesOrderLineId", sl.size
      )
      SELECT o.id, o.number, SUM(GREATEST(0, sized.ordered - COALESCE(held.quantity, 0)))::int AS backorder
        FROM "SalesOrder" o
        JOIN sized ON sized.order_id = o.id
        LEFT JOIN held ON held.line_id = sized.line_id AND held.size = sized.size
        JOIN "Party" p ON p.id = o."partyId"
       WHERE o.status::text = ANY(${OPEN_ORDER_STATUSES}::text[])
         AND (${scope.companies === null}::boolean OR o."companyId" = ANY(${scope.companies ?? []}::uuid[]))
         AND (${scope.parties === null}::boolean OR o."partyId" = ANY(${scope.parties ?? []}::uuid[]))
         AND (${query.partyId ?? null}::uuid IS NULL OR o."partyId" = ${query.partyId ?? null}::uuid)
         AND (${query.siteId ?? null}::uuid IS NULL OR EXISTS (SELECT 1 FROM "SalesOrderLine" sl2 WHERE sl2."orderId" = o.id AND sl2."siteId" = ${query.siteId ?? null}::uuid))
         AND (${q}::text IS NULL OR o.number ILIKE ${q} OR o."customerRef" ILIKE ${q} OR p."legalName" ILIKE ${q})
         AND (${cursor?.number ?? null}::text IS NULL OR (o.number, o.id) > (${cursor?.number ?? ''}::text, ${cursor?.id ?? '00000000-0000-0000-0000-000000000000'}::uuid))
       GROUP BY o.id, o.number
      HAVING SUM(GREATEST(0, sized.ordered - COALESCE(held.quantity, 0))) > 0
       ORDER BY o.number, o.id
       LIMIT ${query.limit + 1}`
    const page = rows.slice(0, query.limit)
    const orders = page.length > 0 ? await client.salesOrder.findMany({ where: { id: { in: page.map((row) => row.id) } }, select: ORDER_SELECT }) : []
    const visible = orders.filter((order) => mayOn(context, SHIPPING_VIEW, { companyId: order.companyId, partyId: order.partyId }))
    const byId = new Map(visible.map((order) => [order.id, order]))
    const backorders = await readBackorders(client, visible.map((order) => order.id), null)
    return {
      orders: page.flatMap((row) => {
        const order = byId.get(row.id)
        if (!order) return []
        const lines = backorders.get(order.id) ?? []
        const totals = backorderTotals(lines.flatMap((line) => line.sizes))
        return [{ ...orderHeader(order), totals, words: backorderWords(totals) }]
      }),
      nextCursor: rows.length > query.limit ? page[page.length - 1]!.id : null,
    }
  })
}

// ---- the rule the shipment commands hold --------------------------------------------------------------------------

/** One order line and size a command adds garments of: the cell's line, its size and how many more. */
export interface CapRequest {
  readonly salesOrderLineId: string
  readonly size: string
  readonly more: number
}

/** Serialises shipments of the same order lines (B-W1-23's work-order line lock: closing a line short takes it too). */
export async function lockOrderLinesForShipping(tx: CommandTx, tenantId: string, lineIds: Iterable<string>): Promise<void> {
  for (const lineId of [...new Set(lineIds)].sort()) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.work-order-line', ${tenantId}::uuid, ${lineId}::uuid), 0))`
  }
}

/**
 * Inside a shipment command, after its cells' shipping locks: the order lines' locks (sorted), then each requested
 * line and size checked against its order line (409 in words): never more than ordered over the shipments that are not
 * CANCELLED or RETURNED, never anything of a line closed short.
 */
export async function assertOrderCaps(tx: CommandTx, tenantId: string, requests: readonly CapRequest[]): Promise<void> {
  const wanted = requests.filter((request) => request.more > 0)
  if (wanted.length === 0) return
  const lineIds = [...new Set(wanted.map((request) => request.salesOrderLineId))]
  await lockOrderLinesForShipping(tx, tenantId, lineIds)
  const lines = await tx.salesOrderLine.findMany({
    where: { id: { in: lineIds } },
    select: { id: true, seq: true, kind: true, quantity: true, baseSize: true, closedShortQuantity: true, closeShortReason: true, style: { select: { code: true } }, colourway: { select: { code: true } }, sizes: { select: { size: true, quantity: true } } },
  })
  const held = await tx.shipmentLine.groupBy({ by: ['salesOrderLineId', 'size'], where: { salesOrderLineId: { in: lineIds }, shipment: { status: { in: ['DRAFT', 'PACKED', 'SHIPPED', 'DELIVERED'] } } }, _sum: { quantity: true } })
  const heldOf = new Map(held.map((row) => [`${row.salesOrderLineId}|${row.size}`, row._sum.quantity ?? 0]))
  const byLine = new Map(lines.map((line) => [line.id, line]))
  const more = new Map<string, number>()
  for (const request of wanted) more.set(`${request.salesOrderLineId}|${request.size}`, (more.get(`${request.salesOrderLineId}|${request.size}`) ?? 0) + request.more)
  const problems: string[] = []
  for (const [at, garments] of more) {
    const [lineId, size] = at.split('|') as [string, string]
    const line = byLine.get(lineId)
    if (!line) throw new InvalidStateError('An order line of these garments is gone.')
    const ordered = orderedSizes(line).find((entry) => entry.size === size)?.quantity ?? 0
    problems.push(
      ...orderCapProblems(
        { label: `Order line ${line.seq} (${line.style.code} ${line.colourway.code}), size ${size}`, ordered, closedShort: line.closedShortQuantity !== null, closeShortReason: line.closeShortReason, onShipments: heldOf.get(at) ?? 0 },
        garments,
      ),
    )
  }
  if (problems.length > 0) throw new ConflictError(problems.join(' '))
}

/** For the leaving command: the shipment's lines whose order line was closed short (what `closedShortAtShipProblems` reads). */
export async function closedShortLinesOf(tx: CommandTx, shipmentId: string): Promise<{ label: string; closedShort: boolean; garments: number }[]> {
  const lines = await tx.shipmentLine.findMany({ where: { shipmentId }, select: { quantity: true, salesOrderLine: { select: { id: true, seq: true, closedShortQuantity: true } } } })
  const byLine = new Map<string, { label: string; closedShort: boolean; garments: number }>()
  for (const line of lines) {
    const order = line.salesOrderLine
    const entry = byLine.get(order.id) ?? { label: `Order line ${order.seq}`, closedShort: order.closedShortQuantity !== null, garments: 0 }
    byLine.set(order.id, { ...entry, garments: entry.garments + line.quantity })
  }
  return [...byLine.values()]
}

/** The order lines a set of cells makes, with their sizes (the caps' input). */
export async function capRequestsOf(tx: CommandTx, more: ReadonlyMap<string, number>): Promise<CapRequest[]> {
  if (more.size === 0) return []
  const cells = await tx.workOrderSize.findMany({ where: { id: { in: [...more.keys()] } }, select: { id: true, salesOrderLineId: true, size: true } })
  return cells.map((cell) => ({ salesOrderLineId: cell.salesOrderLineId, size: cell.size, more: more.get(cell.id) ?? 0 }))
}
