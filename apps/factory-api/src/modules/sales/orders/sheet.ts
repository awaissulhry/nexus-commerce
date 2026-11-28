import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { FILES_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ValidationError } from '@nexus/factory-domain/core/errors'
import { can, holds, scopeWhere, type Actor } from '@nexus/factory-domain/core/permissions'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import { SALES_MEASUREMENTS_VIEW } from '@nexus/factory-domain/sales/measure-link/permissions'
import { orderLifeOf, type OrderLife } from '@nexus/factory-domain/sales/order-life'
import { daysLate, type SalesOrderStatus } from '@nexus/factory-domain/sales/orders/orders'
import { ORDERS_MANAGE, ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import { asksOfLines, decodeSheetCursor, encodeSheetCursor, materialWords, SHEET_LIFE_KEEPS, sheetLineKindOf, sheetOrder, sizesWords, type OpenChange, type SheetLifeKeeps } from '@nexus/factory-domain/sales/orders-sheet/rules'
import { choicesOf } from '@nexus/factory-domain/sales/portal-ordering/choices'
import type { RequestStatus } from '@nexus/factory-domain/sales/portal-ordering/rules'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { hasSmallPreview } from '../../../platform/files/thumbs/small'
import { unreadCounts } from '../../../platform/threads/reads'
import { holdsInForce } from '../../parties/holds/holds'
import { mainPictureThumbnails } from '../../product/images/main-picture'
import { piecesByOrderOf } from '../../shipping/shipments/orders-of'
import { draftStillOpen, piecesOfLine, sheetLinesOf, shipToInUseOf } from '../portal-ordering/people'
import { readDraftFiles, readLines, readPeople, type LineRow, type PersonRow } from '../portal-ordering/store'
import { mayOn, officeContextOf, seenOrdersWhere, seenRequestsWhere } from './access'
import { ownOrdersOf } from './on-the-order'
import { lateWhere } from './orders'
import { orderProductionColumns, type ProductionColumns } from './production-columns'
import type { OrderSheetQuery, SheetLineView, SheetRowView } from './sheet-contract'
import { dayOrNull, LEFT } from './store'

/**
 * owb-of1 step 1 (order workflow, plan.md § 5b "the orders sheet", § 5c "no loophole"; research R-office O1): GET /sales/orders/sheet —
 * the office's ONE list over the two records of one design order: the Draft and Sent orders (PortalOrderRequest) beside the
 * confirmed ones (SalesOrder), newest change first, cursor pages of at most 100. Each row says its life word (the base's
 * `orderLifeOf`), its subject (a request's own; an order's = the request it came from), its picture (the record in charge: the
 * request's while Draft or Sent, the order's after Confirm; else the first line's design picture), the "Waits · news" facts, and its
 * lines as the sheet's child rows (material, sizes in words, pieces, the customer's own columns, the customer's open asks).
 *
 * The walls:
 *   - who: orders.view over the record's company and customer, OR orders.view.own and the person is on it (on-the-order.ts) — the ids
 *     IN SQL before paging (access.ts seenOrdersWhere / seenRequestsWhere). A party-limited role sees only its parties' rows, the
 *     REQUEST rows too.
 *   - money: no price, cost or amount field at all, for anybody (the design: prices are Finance's page).
 *   - numbers: a REQUEST row carries its own number (RQ-…), never an office number (an ACCEPTED request is listed as its order).
 *   - body data: a line's size sheet (a MEASUREMENTS file) is named only to a reader of measurements over the customer.
 * The filters (`life`, factory-domain orders-sheet SHEET_LIFE_KEEPS): all (no drafts, no withdrawn) · drafts · incoming (Sent) ·
 * confirmed · production · ready · shipped · delivered · withdrawn (only on ask). `q`: number, subject, customer reference, the
 * customer (name or code), a line's style code. The tiles count the reader's whole scope under `partyId` and `q` (not `life`).
 */

type Reader = FactoryClient

const DELIVERED_WHERE: Prisma.SalesOrderWhereInput = { shipments: { some: { status: 'DELIVERED' }, none: { status: 'SHIPPED' } } }
const AT_WAREHOUSE_WHERE: Prisma.SalesOrderWhereInput = { shipments: { some: { warehouseLeg: { is: { arrivedAt: { not: null }, forwardedAt: null } } } } }

function splitWhere(split: SheetLifeKeeps['split']): Prisma.SalesOrderWhereInput {
  if (split === 'NOT_DELIVERED') return { OR: [{ status: 'PARTLY_SHIPPED' }, { NOT: DELIVERED_WHERE }, AT_WAREHOUSE_WHERE] }
  if (split === 'DELIVERED') return { OR: [{ status: 'DELIVERED' }, { AND: [DELIVERED_WHERE, { NOT: AT_WAREHOUSE_WHERE }] }] }
  return {}
}

const words = (q: string) => ({ contains: q, mode: 'insensitive' as const })
const partyNamed = (q: string): Prisma.PartyWhereInput => ({ OR: [{ legalName: words(q) }, { tradeName: words(q) }, { code: words(q) }] })

function orderTerms(context: OfficeContext, own: Awaited<ReturnType<typeof ownOrdersOf>>, query: Pick<OrderSheetQuery, 'q' | 'partyId'>): Prisma.SalesOrderWhereInput {
  return {
    AND: [
      seenOrdersWhere(context, own),
      query.partyId ? { partyId: query.partyId } : {},
      query.q
        ? { OR: [{ number: words(query.q) }, { customerRef: words(query.q) }, { party: partyNamed(query.q) }, { lines: { some: { style: { code: words(query.q) } } } }, { portalOrderRequests: { some: { subject: words(query.q) } } }] }
        : {},
    ],
  }
}

function requestTerms(context: OfficeContext, own: Awaited<ReturnType<typeof ownOrdersOf>>, query: Pick<OrderSheetQuery, 'q' | 'partyId'>): Prisma.PortalOrderRequestWhereInput {
  return {
    AND: [
      seenRequestsWhere(context, own),
      query.partyId ? { partyId: query.partyId } : {},
      query.q ? { OR: [{ number: words(query.q) }, { subject: words(query.q) }, { customerRef: words(query.q) }, { party: partyNamed(query.q) }, { lines: { some: { style: { code: words(query.q) } } } }] } : {},
    ],
  }
}

const beforeCursor = (cursor: { readonly at: number; readonly id: string } | null) =>
  cursor ? { OR: [{ updatedAt: { lt: new Date(cursor.at) } }, { updatedAt: new Date(cursor.at), id: { lt: cursor.id } }] } : {}

const ORDER_ROW = {
  id: true,
  number: true,
  version: true,
  companyId: true,
  partyId: true,
  status: true,
  requestedDate: true,
  promiseDate: true,
  updatedAt: true,
  pictureFileId: true,
  floorRestricted: true,
  party: { select: { code: true, legalName: true } },
  portalOrderRequests: { select: { id: true, subject: true }, orderBy: { createdAt: 'asc' as const }, take: 1 },
} as const satisfies Prisma.SalesOrderSelect

const REQUEST_ROW = {
  id: true,
  number: true,
  version: true,
  companyId: true,
  partyId: true,
  status: true,
  requestedDate: true,
  updatedAt: true,
  subject: true,
  pictureFileId: true,
  shipToAddressId: true,
  party: { select: { code: true, legalName: true } },
} as const satisfies Prisma.PortalOrderRequestSelect

type OrderRowRead = Prisma.SalesOrderGetPayload<{ select: typeof ORDER_ROW }>
type RequestRowRead = Prisma.PortalOrderRequestGetPayload<{ select: typeof REQUEST_ROW }>
type Picked = { readonly kind: 'ORDER'; readonly row: OrderRowRead } | { readonly kind: 'REQUEST'; readonly row: RequestRowRead }

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)]
const dayText = (value: Date | null): BusinessDate | null => (value === null ? null : value.toISOString().slice(0, 10))

/** GET /sales/orders/sheet (see the file's head). */
export async function orderSheet(caller: CommandCaller, query: OrderSheetQuery) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const today = businessDate(serverClock.now())
  const cursor = query.cursor !== undefined ? decodeSheetCursor(query.cursor) : null
  if (query.cursor !== undefined && cursor === null) throw new ValidationError('This page belongs to another list: read the sheet from its start again.', [{ path: 'querystring/cursor', message: 'A cursor of this sheet.' }])
  const keeps = SHEET_LIFE_KEEPS[query.life]
  const read = await caller.withClient(async (client) => {
    const own = await ownOrdersOf(client, context)
    const orders = orderTerms(context, own, query)
    const requests = requestTerms(context, own, query)
    const take = query.limit + 1
    const orderRows = keeps.orders.length > 0
      ? await client.salesOrder.findMany({ where: { AND: [orders, { status: { in: [...keeps.orders] } }, splitWhere(keeps.split), beforeCursor(cursor)] }, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], take, select: ORDER_ROW })
      : []
    const requestRows = keeps.requests.length > 0
      ? await client.portalOrderRequest.findMany({ where: { AND: [requests, { status: { in: [...keeps.requests] } }, beforeCursor(cursor)] }, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], take, select: REQUEST_ROW })
      : []
    // ONE list, newest change first across both records; a next page while either record has more.
    const merged: Picked[] = [...orderRows.map((row) => ({ kind: 'ORDER' as const, row })), ...requestRows.map((row) => ({ kind: 'REQUEST' as const, row }))].sort((a, b) =>
      sheetOrder({ at: a.row.updatedAt.getTime(), id: a.row.id }, { at: b.row.updatedAt.getTime(), id: b.row.id }),
    )
    const page = merged.slice(0, query.limit)
    const last = page.at(-1)
    const nextCursor = merged.length > query.limit && last ? encodeSheetCursor({ at: last.row.updatedAt.getTime(), id: last.row.id }) : null
    const tiles = await tilesOf(client, actor, orders, requests, today)
    const built = await rowsOf(client, context, actor, own, page, today)
    return { built, tiles, nextCursor }
  })
  // The new messages per row (each thread checked as the thread page checks it), read after the page.
  const unread = read.built.length > 0 ? (await unreadCounts(caller, read.built.map((row) => ({ type: row.kind === 'ORDER' ? 'SalesOrder' : 'PortalOrderRequest', id: row.id })))).counts : []
  const unreadOf = new Map(unread.map((count) => [`${count.recordType}:${count.recordId}`, count.newCount]))
  const rows: SheetRowView[] = read.built.map((row) => ({ ...row, news: { ...row.news, unread: unreadOf.get(`${row.kind === 'ORDER' ? 'SalesOrder' : 'PortalOrderRequest'}:${row.id}`) ?? 0 } }))
  return { rows, tiles: read.tiles, nextCursor: read.nextCursor }
}

// ---- the tiles (the design's officeKpis): the reader's scope under partyId and q ------------------------------------------------

async function tilesOf(client: Reader, actor: Actor, orders: Prisma.SalesOrderWhereInput, requests: Prisma.PortalOrderRequestWhereInput, today: BusinessDate) {
  const count = (where: Prisma.SalesOrderWhereInput) => client.salesOrder.count({ where: { AND: [orders, where] } })
  const sent = await client.portalOrderRequest.count({ where: { AND: [requests, { status: 'SENT' }] } })
  const waitingApproval = await count({ status: 'PENDING_APPROVAL' })
  // "Problems": the orders with an open production issue — only over the orders the reader's workorders.view reaches.
  let problems = 0
  if (holds(actor, WORKORDERS_VIEW)) {
    const open = await client.productionIssue.findMany({ where: { status: 'OPEN', salesOrderId: { not: null } }, select: { salesOrderId: true }, distinct: ['salesOrderId'] })
    const ids = unique(open.flatMap((row) => (row.salesOrderId ? [row.salesOrderId] : [])))
    problems = ids.length === 0 ? 0 : await count({ AND: [{ id: { in: ids } }, scopeWhere(actor, WORKORDERS_VIEW, { company: 'companyId', party: 'partyId' }) as Prisma.SalesOrderWhereInput] })
  }
  return {
    incoming: sent + waitingApproval,
    waitingForPrint: await count({ status: 'CONFIRMED', prints: { none: { kind: 'FIRST' } } }),
    inProduction: await count({ status: 'IN_PRODUCTION' }),
    problems,
    late: await count(lateWhere(today)),
    readyToShip: await count({ status: 'READY' }),
  }
}

// ---- the rows ---------------------------------------------------------------------------------------------------------------

type BuiltRow = Omit<SheetRowView, 'news'> & { news: SheetRowView['news'] }

async function rowsOf(client: Reader, context: OfficeContext, actor: Actor, own: Awaited<ReturnType<typeof ownOrdersOf>>, page: readonly Picked[], today: BusinessDate): Promise<BuiltRow[]> {
  if (page.length === 0) return []
  const orderRows = page.flatMap((entry) => (entry.kind === 'ORDER' ? [entry.row] : []))
  const requestRows = page.flatMap((entry) => (entry.kind === 'REQUEST' ? [entry.row] : []))
  const orderFacts = await orderFactsOf(client, context, actor, own, orderRows, today)
  const requestFacts = await requestFactsOf(client, actor, requestRows, today)
  const scopes = unique(page.map((entry) => `${entry.row.partyId}|${entry.row.companyId}`))
  const onHold = new Set<string>()
  for (const key of scopes) {
    const [partyId, companyId] = key.split('|') as [string, string]
    if ((await holdsInForce(client, partyId, companyId)).length > 0) onHold.add(key)
  }
  const designers = await withDesignerOf(client, page)
  const pictures = await picturesOf(client, actor, page, orderFacts.firstStyle, requestFacts.firstStyle)
  return page.map((entry): BuiltRow => {
    const scope = { companyId: entry.row.companyId, partyId: entry.row.partyId }
    const party = { id: entry.row.partyId, code: entry.row.party.code, name: entry.row.party.legalName }
    const customerOnHold = onHold.has(`${entry.row.partyId}|${entry.row.companyId}`)
    const picture = pictures.get(entry.row.id) ?? null
    const mayManage = mayOn(context, ORDERS_MANAGE, scope)
    if (entry.kind === 'ORDER') {
      const row = entry.row
      const facts = orderFacts.of.get(row.id)!
      const promised = dayOrNull(row.promiseDate)
      const late = daysLate(row.status as SalesOrderStatus, promised, today)
      const design = orderFacts.design.get(row.id) ?? null
      return {
        kind: 'ORDER',
        id: row.id,
        version: row.version,
        number: row.number,
        subject: row.portalOrderRequests[0]?.subject ?? null,
        party,
        life: facts.life,
        wantedFor: dayText(row.requestedDate),
        promised,
        daysLate: late,
        where: { stage: facts.production?.stage ?? null, health: facts.production?.health ?? null, held: facts.production?.held ?? false },
        picture,
        news: {
          unread: 0,
          openAsks: facts.openAsks,
          openDetails: 0,
          sentAsText: false,
          remakeOf: orderFacts.remakeOf.get(row.id) ?? null,
          withDesigner: designers.has(row.id) && design !== 'APPROVED',
          design,
          problems: facts.production?.openIssues ?? 0,
          late: (late ?? 0) > 0,
          label: facts.label,
          next: facts.life === 'CONFIRMED' && !facts.printed ? 'PRINT' : orderFacts.printAgain.has(row.id) ? 'PRINT_AGAIN' : facts.life === 'READY_TO_SHIP' ? 'SHIP' : null,
          paymentNotices: orderFacts.notices.get(row.id) ?? 0,
        },
        restricted: row.floorRestricted,
        customerOnHold,
        pieces: facts.pieces,
        may: { confirm: false, deleteDraft: false, editLines: row.status === 'CONFIRMED' && mayManage ? 'AMEND' : null },
        lines: orderFacts.lines.get(row.id) ?? [],
      }
    }
    const row = entry.row
    const facts = requestFacts.of.get(row.id)!
    const life = orderLifeOf({ request: { status: row.status as RequestStatus } }).life
    const open = row.status === 'DRAFT' || row.status === 'SENT'
    return {
      kind: 'REQUEST',
      id: row.id,
      version: row.version,
      number: row.number,
      subject: row.subject,
      party,
      life,
      wantedFor: dayText(row.requestedDate),
      promised: null,
      daysLate: null,
      where: null,
      picture,
      news: {
        unread: 0,
        openAsks: 0,
        openDetails: facts.openDetails,
        sentAsText: facts.sentAsText,
        remakeOf: null,
        withDesigner: designers.has(row.id),
        design: null,
        problems: 0,
        late: false,
        label: null,
        next: row.status === 'SENT' && mayManage ? 'CONFIRM' : null,
        paymentNotices: 0,
      },
      restricted: false,
      customerOnHold,
      pieces: facts.pieces,
      may: { confirm: open && mayManage, deleteDraft: row.status === 'DRAFT' && row.number === null && mayManage, editLines: row.status === 'DRAFT' && mayManage ? 'DRAFT' : null },
      lines: facts.lines,
    }
  })
}

// ---- the own columns (R62) of a page's lines: the columns the record uses, in its order, each line's value -----------------------

type OwnUse = { readonly columnId: string; readonly name: string; readonly kind: SheetLineView['own'][number]['kind'] }
type OwnValueRow = { readonly columnId: string; readonly lineId: string; readonly valueText: string | null; readonly valueNumber: Prisma.Decimal | null; readonly valueDate: Date | null; readonly valueBool: boolean | null }

function ownOf(uses: readonly OwnUse[], values: readonly OwnValueRow[], lineId: string): SheetLineView['own'] {
  return uses.map((use) => {
    const found = values.find((value) => value.lineId === lineId && value.columnId === use.columnId)
    const value = !found
      ? null
      : use.kind === 'NUMBER'
        ? found.valueNumber === null
          ? null
          : Number(found.valueNumber.toString())
        : use.kind === 'DATE'
          ? dayText(found.valueDate)
          : use.kind === 'YES_NO'
            ? found.valueBool
            : found.valueText
    return { columnId: use.columnId, name: use.name, kind: use.kind, value }
  })
}

async function ownUsesOf(client: Reader, where: { salesOrderId: { in: string[] } } | { portalOrderRequestId: { in: string[] } }): Promise<Map<string, OwnUse[]>> {
  const rows = await client.orderLineColumnUse.findMany({ where, select: { salesOrderId: true, portalOrderRequestId: true, seq: true, column: { select: { id: true, name: true, kind: true } } }, orderBy: [{ seq: 'asc' }, { id: 'asc' }] })
  const out = new Map<string, OwnUse[]>()
  for (const row of rows) {
    const recordId = row.salesOrderId ?? row.portalOrderRequestId
    if (!recordId) continue
    out.set(recordId, [...(out.get(recordId) ?? []), { columnId: row.column.id, name: row.column.name, kind: row.column.kind }])
  }
  return out
}

// ---- ORDER rows -------------------------------------------------------------------------------------------------------------

interface OrderFacts {
  readonly life: OrderLife
  readonly printed: boolean
  readonly pieces: number
  readonly openAsks: number
  readonly label: 'RECEIVED' | 'WAITS' | null
  readonly production: ProductionColumns | null
}

async function orderFactsOf(client: Reader, context: OfficeContext, actor: Actor, own: Awaited<ReturnType<typeof ownOrdersOf>>, rows: readonly OrderRowRead[], today: BusinessDate) {
  const of = new Map<string, OrderFacts>()
  const lines = new Map<string, SheetLineView[]>()
  const firstStyle = new Map<string, string>()
  const design = new Map<string, 'WAITS' | 'APPROVED' | 'CHANGE'>()
  const remakeOf = new Map<string, { id: string; number: string }>()
  const notices = new Map<string, number>()
  const printAgain = new Set<string>()
  if (rows.length === 0) return { of, lines, firstStyle, design, remakeOf, notices, printAgain }
  const ids = rows.map((row) => row.id)
  const lineRows = await client.salesOrderLine.findMany({
    where: { orderId: { in: ids }, kind: { not: 'FEE' } },
    select: { id: true, orderId: true, seq: true, kind: true, styleId: true, colourwayId: true, description: true, quantity: true, style: { select: { code: true, name: true } }, colourway: { select: { name: true } }, sizes: { select: { size: true, quantity: true }, orderBy: { size: 'asc' } } },
    orderBy: [{ orderId: 'asc' }, { seq: 'asc' }],
  })
  for (const line of lineRows) if (!firstStyle.has(line.orderId)) firstStyle.set(line.orderId, line.styleId)
  // "Printed" = an OrderPrint FIRST row exists (S3 writes it at "Print and start the work").
  const printed = new Set((await client.orderPrint.findMany({ where: { salesOrderId: { in: ids }, kind: 'FIRST' }, select: { salesOrderId: true } })).map((row) => row.salesOrderId))
  // The shipments that left (the life word: delivered once every one that left was delivered) and the shipped pieces.
  const shipments = await client.shipment.findMany({ where: { salesOrderId: { in: ids }, status: { in: [...LEFT] } }, select: { id: true, salesOrderId: true, status: true } })
  const shippedPieces = await piecesByOrderOf(client, shipments.map((row) => row.id), ids)
  // Our warehouse way: a leg that arrived and was not sent on (life AT_OUR_WAREHOUSE; the label received or awaited).
  const legs = await client.shipmentWarehouseLeg.findMany({ where: { shipment: { salesOrderId: { in: ids } }, arrivedAt: { not: null }, forwardedAt: null }, select: { customerLabelFileId: true, shipment: { select: { salesOrderId: true } } } })
  const production = await orderProductionColumns(client, actor, context.actorId, rows.map((row) => ({ id: row.id, companyId: row.companyId, partyId: row.partyId, status: row.status as SalesOrderStatus })), today)
  // The customer's open asks (CHANGE and CANCEL: the sheet's amber values), oldest first, with the names of what they ask.
  const changes = await client.orderChangeRequest.findMany({
    where: { orderId: { in: ids }, status: 'OPEN', kind: { in: ['CHANGE', 'CANCEL'] } },
    select: { id: true, orderId: true, kind: true, lines: { select: { orderLineId: true, size: true, quantityBefore: true, quantity: true, styleId: true, colourwayId: true } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  const askedStyles = unique(changes.flatMap((change) => change.lines.flatMap((line) => (line.styleId ? [line.styleId] : []))))
  const askedColours = unique(changes.flatMap((change) => change.lines.flatMap((line) => (line.colourwayId ? [line.colourwayId] : []))))
  const styleCode = new Map(askedStyles.length > 0 ? (await client.style.findMany({ where: { id: { in: askedStyles } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]) : [])
  const colourName = new Map(askedColours.length > 0 ? (await client.colourway.findMany({ where: { id: { in: askedColours } }, select: { id: true, name: true } })).map((row) => [row.id, row.name]) : [])
  const uses = await ownUsesOf(client, { salesOrderId: { in: ids } })
  const lineIds = lineRows.map((line) => line.id)
  const values: OwnValueRow[] = lineIds.length > 0
    ? (await client.orderLineOwnValue.findMany({ where: { salesOrderLineId: { in: lineIds } }, select: { columnId: true, salesOrderLineId: true, valueText: true, valueNumber: true, valueDate: true, valueBool: true } })).map((row) => ({ ...row, lineId: row.salesOrderLineId! }))
    : []
  for (const row of rows) {
    const mine = lineRows.filter((line) => line.orderId === row.id)
    const left = shipments.filter((shipment) => shipment.salesOrderId === row.id)
    const atWarehouse = legs.filter((leg) => leg.shipment.salesOrderId === row.id)
    const pieces = mine.reduce((sum, line) => sum + line.quantity, 0)
    const life = orderLifeOf({
      order: {
        status: row.status as SalesOrderStatus,
        printed: printed.has(row.id),
        pieces: { shipped: shippedPieces.get(row.id) ?? 0, total: pieces },
        shipments: { left: left.length, delivered: left.filter((shipment) => shipment.status === 'DELIVERED').length },
        atOurWarehouse: atWarehouse.length > 0,
      },
    }).life
    const ownChanges: OpenChange[] = changes
      .filter((change) => change.orderId === row.id)
      .map((change) => ({
        id: change.id,
        kind: change.kind as 'CHANGE' | 'CANCEL',
        lines: change.lines.map((line) => ({ ...line, styleCode: line.styleId ? (styleCode.get(line.styleId) ?? null) : null, colourName: line.colourwayId ? (colourName.get(line.colourwayId) ?? null) : null })),
      }))
    const asks = asksOfLines(
      mine.map((line) => ({ id: line.id, styleId: line.styleId, styleCode: line.style.code, colourwayId: line.colourwayId, colourName: line.colourway.name, pieces: line.quantity })),
      ownChanges,
    )
    of.set(row.id, {
      life,
      printed: printed.has(row.id),
      pieces,
      openAsks: ownChanges.length,
      label: atWarehouse.length === 0 ? null : atWarehouse.every((leg) => leg.customerLabelFileId !== null) ? 'RECEIVED' : 'WAITS',
      production: production.get(row.id) ?? null,
    })
    const columns = uses.get(row.id) ?? []
    lines.set(
      row.id,
      mine.flatMap((line) => {
        const kind = sheetLineKindOf(line.kind)
        if (!kind) return []
        return [{
          id: line.id,
          seq: line.seq,
          kind,
          product: { styleId: line.styleId, code: line.style.code, name: line.style.name },
          text: line.description,
          material: materialWords(line.colourway.name, null),
          sizes: sizesWords(line.sizes),
          sizeFileId: null,
          pieces: line.quantity,
          own: ownOf(columns, values, line.id),
          asks: asks.get(line.id) ?? [],
        }]
      }),
    )
  }
  // The design's state: the newest PROOF or ARTWORK approval asked on the order or one of its lines (withdrawn ones aside).
  const approvals = await client.approvalRequest.findMany({
    where: { kind: { in: ['PROOF', 'ARTWORK'] }, status: { not: 'WITHDRAWN' }, OR: [{ recordType: 'SalesOrder', recordId: { in: ids } }, ...(lineIds.length > 0 ? [{ recordType: 'SalesOrderLine', recordId: { in: lineIds } }] : [])] },
    select: { recordType: true, recordId: true, status: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  })
  const orderOfLine = new Map(lineRows.map((line) => [line.id, line.orderId]))
  for (const approval of approvals) {
    const orderId = approval.recordType === 'SalesOrder' ? approval.recordId : orderOfLine.get(approval.recordId)
    if (!orderId || design.has(orderId)) continue
    const state = approval.status === 'OPEN' ? 'WAITS' : approval.status === 'APPROVED' || approval.status === 'APPROVED_WITH_CHANGES' ? 'APPROVED' : approval.status === 'REFUSED' ? 'CHANGE' : null
    if (state) design.set(orderId, state)
  }
  // Remake of: the order is the replacement an RMA made for another order of the customer — named only when the reader sees it.
  const remakes = await client.returnAuthorisation.findMany({ where: { replacementOrderId: { in: ids }, salesOrderId: { not: null } }, select: { replacementOrderId: true, salesOrderId: true } })
  const originals = unique(remakes.flatMap((row) => (row.salesOrderId ? [row.salesOrderId] : [])))
  const originalRows = originals.length > 0 ? await client.salesOrder.findMany({ where: { id: { in: originals } }, select: { id: true, number: true, companyId: true, partyId: true } }) : []
  for (const remake of remakes) {
    const original = originalRows.find((row) => row.id === remake.salesOrderId)
    if (!original || !remake.replacementOrderId) continue
    const seen = mayOn(context, ORDERS_VIEW, original) || (own?.salesOrderIds.includes(original.id) ?? false)
    if (seen) remakeOf.set(remake.replacementOrderId, { id: original.id, number: original.number })
  }
  // The customer's "I paid" notices still open (R37: a notice, it changes nothing owed).
  for (const row of await client.paymentNotice.groupBy({ by: ['salesOrderId'], where: { salesOrderId: { in: ids }, state: 'OPEN' }, _count: { _all: true } })) notices.set(row.salesOrderId, row._count._all)
  // Print again: the floor lost a page — an open PAPER help call on a work order that makes the order.
  const paper = await client.helpCall.findMany({
    where: { status: { in: ['SENT', 'SEEN', 'ON_THE_WAY'] }, type: { code: 'PAPER' }, workOrder: { sizes: { some: { salesOrderLine: { orderId: { in: ids } } } } } },
    select: { workOrder: { select: { sizes: { select: { salesOrderLine: { select: { orderId: true } } } } } } },
  })
  for (const call of paper) for (const size of call.workOrder?.sizes ?? []) if (size.salesOrderLine && ids.includes(size.salesOrderLine.orderId)) printAgain.add(size.salesOrderLine.orderId)
  return { of, lines, firstStyle, design, remakeOf, notices, printAgain }
}

// ---- REQUEST rows -----------------------------------------------------------------------------------------------------------

interface RequestFacts {
  readonly pieces: number
  readonly openDetails: number
  readonly sentAsText: boolean
}

async function requestFactsOf(client: Reader, actor: Actor, rows: readonly RequestRowRead[], today: BusinessDate) {
  const of = new Map<string, RequestFacts & { readonly lines: SheetLineView[] }>()
  const firstStyle = new Map<string, string>()
  if (rows.length === 0) return { of, firstStyle }
  const ids = rows.map((row) => row.id)
  // The lines in the draft (a line taken out — owb-b1 removedAt — is not counted, shown or sent), their people and files.
  const removed = new Set((await client.portalOrderRequestLine.findMany({ where: { requestId: { in: ids }, removedAt: { not: null } }, select: { id: true } })).map((line) => line.id))
  const lineRows: LineRow[] = (await readLines(client, ids)).filter((line) => !removed.has(line.id))
  const people: PersonRow[] = await readPeople(client, ids)
  const files = await readDraftFiles(client, ids, lineRows.map((line) => line.id))
  const sheetLines = sheetLinesOf(files)
  const parties = unique(rows.map((row) => row.partyId))
  const addresses = await client.partyAddress.findMany({ where: { partyId: { in: parties } }, select: { id: true, partyId: true, status: true, isDefaultShipTo: true } })
  const styleIds = unique(lineRows.flatMap((line) => (line.styleId ? [line.styleId] : [])))
  const colourIds = unique(lineRows.flatMap((line) => (line.colourwayId ? [line.colourwayId] : [])))
  const styles = new Map(styleIds.length > 0 ? (await client.style.findMany({ where: { id: { in: styleIds } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]) : [])
  const colours = new Map(colourIds.length > 0 ? (await client.colourway.findMany({ where: { id: { in: colourIds } }, select: { id: true, name: true } })).map((row) => [row.id, row.name]) : [])
  const uses = await ownUsesOf(client, { portalOrderRequestId: { in: ids } })
  const lineIds = lineRows.map((line) => line.id)
  const values: OwnValueRow[] = lineIds.length > 0
    ? (await client.orderLineOwnValue.findMany({ where: { portalOrderRequestLineId: { in: lineIds } }, select: { columnId: true, portalOrderRequestLineId: true, valueText: true, valueNumber: true, valueDate: true, valueBool: true } })).map((row) => ({ ...row, lineId: row.portalOrderRequestLineId! }))
    : []
  for (const row of rows) {
    const mine = lineRows.filter((line) => line.requestId === row.id).sort((a, b) => a.seq - b.seq)
    const roster = people.filter((person) => person.requestId === row.id)
    const head = mine.find((line) => line.styleId !== null)
    if (head?.styleId) firstStyle.set(row.id, head.styleId)
    const open = draftStillOpen(mine, roster, row, shipToInUseOf(row, addresses.filter((address) => address.partyId === row.partyId)), today, undefined, sheetLines)
    // A size sheet is body data: named only to a reader of measurements over the customer.
    const seesSheets = can(actor, SALES_MEASUREMENTS_VIEW, { companyId: row.companyId, partyId: row.partyId })
    const columns = uses.get(row.id) ?? []
    const lines: SheetLineView[] = mine.flatMap((line) => {
      const kind = sheetLineKindOf(line.kind)
      if (!kind) return []
      const style = line.styleId ? styles.get(line.styleId) : undefined
      const sheet = seesSheets ? files.find((file) => file.recordType === 'PortalOrderRequestLine' && file.recordId === line.id && file.category === 'MEASUREMENTS') : undefined
      return [{
        id: line.id,
        seq: line.seq,
        kind,
        product: style ? { styleId: style.id, code: style.code, name: style.name } : null,
        text: line.description ?? line.garmentType,
        material: materialWords(line.colourwayId ? (colours.get(line.colourwayId) ?? null) : line.colourText, choicesOf(line.choices)),
        sizes: sizesWords(line.sizes),
        sizeFileId: sheet?.id ?? null,
        pieces: piecesOfLine(line, roster),
        own: ownOf(columns, values, line.id),
        asks: [],
      }]
    })
    of.set(row.id, { pieces: lines.reduce((sum, line) => sum + line.pieces, 0), openDetails: open.openCount, sentAsText: mine.some((line) => line.styleId === null), lines })
  }
  return { of, firstStyle }
}

// ---- With the designer: the customer's Factory designer (or backup) follows the order or the request it came from -------------

async function withDesignerOf(client: Reader, page: readonly Picked[]): Promise<Set<string>> {
  const parties = unique(page.map((entry) => entry.row.partyId))
  const slots = await client.portalSettings.findMany({ where: { partyId: { in: parties } }, select: { partyId: true, factoryDesignerId: true, factoryDesignerBackupId: true } })
  const designersOf = new Map(slots.map((slot) => [slot.partyId, [slot.factoryDesignerId, slot.factoryDesignerBackupId].filter((value): value is string => value !== null)]))
  const designers = unique([...designersOf.values()].flat())
  if (designers.length === 0) return new Set()
  // A confirmed order is followed through itself or the request it came from.
  const records = page.flatMap((entry) => (entry.kind === 'ORDER' ? [{ type: 'SalesOrder', id: entry.row.id, of: entry.row.id }, ...entry.row.portalOrderRequests.map((request) => ({ type: 'PortalOrderRequest', id: request.id, of: entry.row.id }))] : [{ type: 'PortalOrderRequest', id: entry.row.id, of: entry.row.id }]))
  const follows = await client.recordFollower.findMany({
    where: { userId: { in: designers }, OR: [{ recordType: 'SalesOrder', recordId: { in: records.filter((record) => record.type === 'SalesOrder').map((record) => record.id) } }, { recordType: 'PortalOrderRequest', recordId: { in: records.filter((record) => record.type === 'PortalOrderRequest').map((record) => record.id) } }] },
    select: { recordType: true, recordId: true, userId: true },
  })
  const partyOf = new Map(page.map((entry) => [entry.row.id, entry.row.partyId]))
  const out = new Set<string>()
  for (const follow of follows) {
    for (const record of records) {
      if (record.type !== follow.recordType || record.id !== follow.recordId) continue
      if ((designersOf.get(partyOf.get(record.of) ?? '') ?? []).includes(follow.userId)) out.add(record.of)
    }
  }
  return out
}

// ---- The picture: the record's own (one the reader may open), else the first line's design picture ------------------------------

async function picturesOf(client: Reader, actor: Actor, page: readonly Picked[], orderStyle: ReadonlyMap<string, string>, requestStyle: ReadonlyMap<string, string>): Promise<Map<string, SheetRowView['picture']>> {
  const out = new Map<string, SheetRowView['picture']>()
  if (!holds(actor, FILES_READ)) return out
  const chosenIds = unique(page.flatMap((entry) => (entry.row.pictureFileId ? [entry.row.pictureFileId] : [])))
  const chosen = chosenIds.length > 0
    ? await client.storedFile.findMany({ where: { AND: [scopeWhere(actor, FILES_READ, { company: { field: 'companyId', nullable: true } }) as Prisma.StoredFileWhereInput, { id: { in: chosenIds }, status: 'AVAILABLE' }] }, select: { id: true, contentType: true, thumbnailKey: true } })
    : []
  const chosenOf = new Map(chosen.map((file) => [file.id, file]))
  const styleOf = (entry: Picked) => (entry.kind === 'ORDER' ? orderStyle.get(entry.row.id) : requestStyle.get(entry.row.id))
  const thumbnails = await mainPictureThumbnails(client, actor, unique(page.flatMap((entry) => (styleOf(entry) ? [styleOf(entry)!] : []))))
  const thumbIds = unique([...thumbnails.values()].map((thumbnail) => thumbnail.fileId))
  const thumbFiles = new Map(thumbIds.length > 0 ? (await client.storedFile.findMany({ where: { id: { in: thumbIds } }, select: { id: true, contentType: true, thumbnailKey: true } })).map((file) => [file.id, file]) : [])
  for (const entry of page) {
    const own = entry.row.pictureFileId ? chosenOf.get(entry.row.pictureFileId) : undefined
    const style = styleOf(entry)
    const thumbnail = style ? thumbnails.get(style) : undefined
    const file = own ?? (thumbnail ? thumbFiles.get(thumbnail.fileId) : undefined)
    if (file) out.set(entry.row.id, { fileId: file.id, contentType: file.contentType, small: hasSmallPreview(file) })
  }
  return out
}

