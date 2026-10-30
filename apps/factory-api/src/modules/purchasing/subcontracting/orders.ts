import type { Prisma, Uom } from '@nexus/factory-db'
import { ConflictError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { isCurrencyCode } from '@nexus/factory-domain/core/money'
import { baseQuantityOf } from '@nexus/factory-domain/inventory/ledger/units'
import { markMoney } from '@nexus/factory-domain/money/marked'
import { PURCHASING_VIEW } from '@nexus/factory-domain/purchasing/permissions'
import { PURCHASING_SUBCONTRACT_MANAGE } from '@nexus/factory-domain/purchasing/subcontracting/permissions'
import {
  cancelProblems,
  closeProblems,
  defaultSizes,
  DUE_STATUSES,
  isFee,
  issueProblems,
  MAX_KIT_LINES,
  MAX_OPERATIONS,
  OPEN_STATUSES,
  operationAmount,
  orderAmount,
  piecesOf,
  piecesProblems,
  reopenProblems,
  SEQ_STEP,
  WORK_ORDER_STATES,
  type SizePieces,
  type SubcontractOrderStatus,
} from '@nexus/factory-domain/purchasing/subcontracting/rules'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { supplierArrivalFor } from '../../../platform/calendars/service'
import { allocateNumber } from '../../../platform/numbering/allocate'
import { actorIdOf, assertMay, dayOf, dayValue, officeContextOf, quantityText, unitsOf, ITEM_COLUMNS, type Reader } from '../store'
import {
  assertWorkshop,
  KIT_COLUMNS,
  nameOf,
  officeOrder,
  OPERATION_COLUMNS,
  ORDER_COLUMNS,
  outsideStepsOf,
  readKitLines,
  readLocationRow,
  readOperations,
  readOrder,
  readWorkOrderFacts,
  readWorkshop,
  sizesOf,
  workshopLocations,
  type KitRow,
  type OperationRow,
  type OrderRow,
  type OutsideStep,
  type WorkOrderFacts,
} from './store'
import { orderDetailOf, orderSummaries, type OrderDetailView, type OrderSummaryView } from './views'

/**
 * Subcontract orders (B-W2a-25; SCM-138; design purchasing.subcontracting "New subcontract order", record tab
 * "Operations & quantities"): work of one work order sent to an outside workshop. Office only; each write is ONE command
 * on the order (its version bump holds the row; the …_supply_w2a_guards triggers hold the same rules).
 *
 *   create     from a RELEASED or IN_PROGRESS work order and some of its operations: the workshop (default the first
 *              operation's routing step's), its stock location on the work order's site (its only active one by
 *              default: none → create it first, kind SUBCONTRACTOR), pieces per size (default every garment), the fee
 *              per piece (default the routing step's when the step names this workshop; a cost), the return date
 *              (default: the step's transit days from the order date, the workshop's closed days skipped); the
 *              number from the company's SUBCONTRACT series; optionally the kit planned from the work order's
 *              materials. Pieces of one operation across live orders never exceed the work order's garments.
 *   change     the header and the operations only while DRAFT (afterwards only the return date and the notes); the
 *              order's amount is always the sum of its operations'.
 *   kit plan   PLANNED lines (typed, or from the work order's planned materials for the cells sent; leather tracked by
 *              the hide goes cut, as bundles, not as a kit line), changed and removed while PLANNED.
 *   issue      DRAFT → ISSUED (the checks of factory-domain subcontracting `issueProblems`, in words); back to DRAFT
 *              while nothing is out; cancel a draft or an issued order while nothing is out (its planned kit lines
 *              too); close once every piece is back.
 *
 * Kit out and goods back are kit.ts and receive.ts.
 */

const today = (): BusinessDate => businessDate(serverClock.now())
const blankToNull = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
const atBody = (issues: readonly Issue[], prefix = 'body'): Issue[] => issues.map((issue) => ({ path: `${prefix}/${issue.path}`, message: issue.message }))
const refuse = (problems: readonly Issue[]) => new ValidationError(problems.length === 1 ? problems[0]!.message : 'The subcontract order is not valid as it stands.', problems)

/** The order as the answers show it, read again in the command. */
export async function detailInCommand(tools: Pick<CommandTools, 'tx'>, orderId: string): Promise<OrderDetailView> {
  const order = await readOrder(tools.tx, orderId)
  if (!order) throw new NotFoundError('Subcontract order not found.')
  return orderDetailOf(tools.tx, order, today())
}

/** Only while the order is DRAFT (409 in words otherwise). */
function assertDraft(order: Pick<OrderRow, 'status' | 'number'>, what: string): void {
  if (order.status !== 'DRAFT') throw new InvalidStateError(`Subcontract order ${order.number} is ${order.status.toLowerCase().replace('_', ' ')}; ${what} only while it is a draft (take an issued one back to draft first).`)
}

/** The order's amount kept as the sum of its operations' (in the command, after any change to them). */
async function refreshAmount(tx: CommandTx, orderId: string): Promise<number> {
  const operations = await tx.subcontractOperation.findMany({ where: { subcontractOrderId: orderId }, select: { netAmount: true } })
  const netAmount = orderAmount(operations)
  await tx.subcontractOrder.update({ where: { id: orderId }, data: { netAmount }, select: { id: true } })
  return netAmount
}

const auditOperation = (row: Pick<OperationRow, 'seq' | 'workOrderOperationId' | 'pieces' | 'sizes' | 'pricePerPiece' | 'netAmount' | 'expectedBackDate' | 'note'>) => ({
  seq: row.seq,
  workOrderOperationId: row.workOrderOperationId,
  pieces: row.pieces,
  sizes: sizesOf(row.sizes),
  pricePerPiece: markMoney('cost', row.pricePerPiece.toString()),
  netAmount: markMoney('cost', row.netAmount),
  expectedBackDate: dayOf(row.expectedBackDate),
  note: row.note,
})

// ---- reads -------------------------------------------------------------------------------------------------------------

export interface ListQuery {
  readonly status?: SubcontractOrderStatus | undefined
  readonly open?: boolean | undefined
  readonly partyId?: string | undefined
  readonly workOrderId?: string | undefined
  readonly siteId?: string | undefined
  readonly late?: boolean | undefined
  readonly kitToSend?: boolean | undefined
  readonly atWorkshop?: boolean | undefined
  readonly dueThisWeek?: boolean | undefined
  readonly q?: string | undefined
  readonly cursor?: string | undefined
  readonly limit: number
}

const scopeOf = (context: OfficeContext) => scopeWhere(actorOf(context), PURCHASING_VIEW, { company: 'companyId', site: 'siteId', party: 'partyId' }) as Prisma.SubcontractOrderWhereInput

/** The last day of the week of `day` (Sunday): "due back this week". */
function sundayOf(day: BusinessDate): Date {
  const start = new Date(`${day}T00:00:00.000Z`)
  return new Date(start.getTime() + ((7 - start.getUTCDay()) % 7) * 86_400_000)
}

/** The tiles' rules (B-W2a-56: each tile is also the list's filter, so a tile and its list always agree). */
const TILE_WHERE = {
  kitToSend: (): Prisma.SubcontractOrderWhereInput => ({ status: { in: ['ISSUED', 'AT_WORKSHOP', 'PARTLY_RECEIVED'] }, kitLines: { some: { status: 'PLANNED' } } }),
  atWorkshop: (): Prisma.SubcontractOrderWhereInput => ({ status: { in: ['AT_WORKSHOP', 'PARTLY_RECEIVED'] } }),
  dueThisWeek: (now: BusinessDate): Prisma.SubcontractOrderWhereInput => ({ status: { in: [...DUE_STATUSES] }, expectedBackDate: { gte: dayValue(now), lte: sundayOf(now) } }),
  late: (now: BusinessDate): Prisma.SubcontractOrderWhereInput => ({ status: { in: [...DUE_STATUSES] }, expectedBackDate: { lt: dayValue(now) } }),
}

/** purchasing.view: the orders the caller reaches, newest first (a cursor of ids). */
export async function listOrders(caller: CommandCaller, query: ListQuery): Promise<{ items: OrderSummaryView[]; nextCursor: string | null }> {
  const context = officeContextOf(caller)
  const now = today()
  const where: Prisma.SubcontractOrderWhereInput = {
    AND: [
      scopeOf(context),
      query.status ? { status: query.status } : query.open === false ? {} : { status: { in: [...OPEN_STATUSES] } },
      query.partyId ? { partyId: query.partyId } : {},
      query.workOrderId ? { workOrderId: query.workOrderId } : {},
      query.siteId ? { siteId: query.siteId } : {},
      query.late ? TILE_WHERE.late(now) : {},
      query.kitToSend ? TILE_WHERE.kitToSend() : {},
      query.atWorkshop ? TILE_WHERE.atWorkshop() : {},
      query.dueThisWeek ? TILE_WHERE.dueThisWeek(now) : {},
      query.q
        ? {
            OR: [
              { number: { contains: query.q, mode: 'insensitive' } },
              { party: { code: { contains: query.q, mode: 'insensitive' } } },
              { party: { legalName: { contains: query.q, mode: 'insensitive' } } },
              { party: { tradeName: { contains: query.q, mode: 'insensitive' } } },
              { workOrder: { number: { contains: query.q, mode: 'insensitive' } } },
            ],
          }
        : {},
      query.cursor ? { id: { lt: query.cursor } } : {},
    ],
  }
  return caller.withClient(async (client) => {
    const rows = await client.subcontractOrder.findMany({ where, orderBy: { id: 'desc' }, take: query.limit + 1, select: ORDER_COLUMNS })
    const page = rows.slice(0, query.limit)
    return { items: await orderSummaries(client, page, now), nextCursor: rows.length > query.limit ? page[page.length - 1]!.id : null }
  })
}

/** purchasing.view: the tiles (kit to send, at workshops, due back this week, late). */
export async function orderCounts(caller: CommandCaller, query: { readonly siteId?: string | undefined; readonly partyId?: string | undefined }) {
  const context = officeContextOf(caller)
  const now = today()
  const base: Prisma.SubcontractOrderWhereInput[] = [scopeOf(context), query.siteId ? { siteId: query.siteId } : {}, query.partyId ? { partyId: query.partyId } : {}]
  return caller.withClient(async (client) => {
    const kitToSend = await client.subcontractOrder.count({ where: { AND: [...base, TILE_WHERE.kitToSend()] } })
    const atWorkshops = await client.subcontractOrder.count({ where: { AND: [...base, TILE_WHERE.atWorkshop()] } })
    const dueBackThisWeek = await client.subcontractOrder.count({ where: { AND: [...base, TILE_WHERE.dueThisWeek(now)] } })
    const late = await client.subcontractOrder.count({ where: { AND: [...base, TILE_WHERE.late(now)] } })
    return { kitToSend, atWorkshops, dueBackThisWeek, late }
  })
}

/**
 * purchasing.view (B-W2a-56, the "New subcontract order" dialog): the RELEASED and IN_PROGRESS work orders the caller
 * reaches (purchasing.view over their company and site), newest first, by number or style code/name; each with its
 * garments, how many of its operations the routing sends out (a step naming a workshop) and its live orders.
 */
export async function workOrderChoices(caller: CommandCaller, query: { readonly q?: string | undefined; readonly siteId?: string | undefined; readonly limit: number }) {
  const context = officeContextOf(caller)
  const where: Prisma.WorkOrderWhereInput = {
    AND: [
      scopeWhere(actorOf(context), PURCHASING_VIEW, { company: 'companyId', site: 'siteId' }) as Prisma.WorkOrderWhereInput,
      { status: { in: [...WORK_ORDER_STATES] } },
      query.siteId ? { siteId: query.siteId } : {},
      query.q
        ? { OR: [{ number: { contains: query.q, mode: 'insensitive' } }, { style: { code: { contains: query.q, mode: 'insensitive' } } }, { style: { name: { contains: query.q, mode: 'insensitive' } } }] }
        : {},
    ],
  }
  return caller.withClient(async (client) => {
    const rows = await client.workOrder.findMany({ where, orderBy: { id: 'desc' }, take: query.limit, select: { id: true, number: true, status: true, companyId: true, siteId: true, styleId: true } })
    const ids = rows.map((row) => row.id)
    const styles = new Map((await client.style.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.styleId))] } }, select: { id: true, code: true, name: true } })).map((style) => [style.id, style]))
    const sites = new Map((await client.site.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.siteId))] } }, select: { id: true, code: true } })).map((site) => [site.id, site]))
    const garments = new Map((await client.workOrderSize.groupBy({ by: ['workOrderId'], where: { workOrderId: { in: ids } }, _sum: { quantity: true } })).map((row) => [row.workOrderId, row._sum.quantity ?? 0]))
    const operations = await client.workOrderOperation.findMany({ where: { workOrderId: { in: ids } }, select: { id: true, workOrderId: true, seq: true, routingSeq: true, code: true, name: true, styleRevisionId: true } })
    const steps = await outsideStepsOf(client, operations)
    const outside = new Map<string, number>()
    for (const operation of operations) if (steps.has(operation.id)) outside.set(operation.workOrderId, (outside.get(operation.workOrderId) ?? 0) + 1)
    const live = new Map((await client.subcontractOrder.groupBy({ by: ['workOrderId'], where: { workOrderId: { in: ids }, status: { notIn: ['CANCELLED', 'CLOSED'] } }, _count: { _all: true } })).map((row) => [row.workOrderId, row._count._all]))
    return {
      items: rows.map((row) => ({
        id: row.id,
        number: row.number,
        status: row.status,
        style: styles.get(row.styleId) ?? { id: row.styleId, code: '', name: '' },
        companyId: row.companyId,
        site: sites.get(row.siteId) ?? { id: row.siteId, code: '' },
        garments: garments.get(row.id) ?? 0,
        outsideSteps: outside.get(row.id) ?? 0,
        liveOrders: live.get(row.id) ?? 0,
      })),
    }
  })
}

/** purchasing.view: one order with its operations, kit, receipts, DDTs and what may be done now. */
export async function getOrder(caller: CommandCaller, orderId: string): Promise<{ order: OrderDetailView }> {
  const { order } = await officeOrder(caller, orderId)
  return { order: await caller.withClient((client) => orderDetailOf(client, order, today())) }
}

/**
 * purchasing.view: what a new order may send out of a work order: its cells, its operations with their routing step's
 * outside work (workshop, fee, transit days) and the pieces already on live orders, and the workshops' locations.
 */
export async function outsideOperations(caller: CommandCaller, workOrderId: string) {
  const context = officeContextOf(caller)
  return caller.withClient(async (client) => {
    const workOrder = await readWorkOrderFacts(client, workOrderId)
    if (!workOrder || !actorReaches(context, workOrder)) throw new NotFoundError('Work order not found.')
    const steps = await outsideStepsOf(client, workOrder.operations)
    const partyIds = [...new Set([...steps.values()].map((step) => step.supplierId))]
    const parties = await client.party.findMany({ where: { id: { in: partyIds } }, select: { id: true, code: true, legalName: true, tradeName: true } })
    const locations = await workshopLocations(client, workOrder.siteId, partyIds)
    const ordered = await orderedPieces(client, workOrder.id, null)
    const orders = await client.subcontractOrder.findMany({ where: { workOrderId, status: { notIn: ['CANCELLED', 'CLOSED'] } }, select: { id: true, number: true, status: true }, orderBy: { id: 'asc' } })
    const partyOf = new Map(parties.map((party) => [party.id, { id: party.id, code: party.code, name: nameOf(party) }]))
    return {
      workOrder: { id: workOrder.id, number: workOrder.number, status: workOrder.status, style: workOrder.style, companyId: workOrder.companyId, siteId: workOrder.siteId },
      cells: workOrder.cells.map((cell) => ({ workOrderSizeId: cell.id, colourway: cell.colourway, size: cell.size, quantity: cell.quantity })),
      operations: workOrder.operations.map((operation) => {
        const step = steps.get(operation.id)
        return {
          id: operation.id,
          seq: operation.seq,
          code: operation.code,
          name: operation.name,
          outside: step ? { workshop: partyOf.get(step.supplierId) ?? null, pricePerPiece: step.pricePerPiece as never, transitDays: step.transitDays } : null,
          ordered: ordered.get(operation.id) ?? 0,
        }
      }),
      workshops: [...partyOf.values()].map((party) => ({ ...party, locations: locations.filter((location) => location.partyId === party.id).map((location) => ({ id: location.id, code: location.code, name: location.name })) })),
      orders,
    }
  })
}

/** The caller sees work going out of this work order's site (purchasing.view over its company and site, any workshop). */
const actorReaches = (context: OfficeContext, workOrder: Pick<WorkOrderFacts, 'companyId' | 'siteId'>): boolean => can(actorOf(context), PURCHASING_VIEW, { companyId: workOrder.companyId, siteId: workOrder.siteId })

/** Pieces on live (not cancelled) orders per work order operation, leaving one order out. */
async function orderedPieces(db: Reader, workOrderId: string, except: string | null): Promise<Map<string, number>> {
  const rows = await db.subcontractOperation.groupBy({
    by: ['workOrderOperationId'],
    where: { workOrderId, subcontractOrder: { status: { not: 'CANCELLED' } }, ...(except ? { subcontractOrderId: { not: except } } : {}) },
    _sum: { pieces: true },
  })
  return new Map(rows.map((row) => [row.workOrderOperationId, row._sum.pieces ?? 0]))
}

// ---- create ------------------------------------------------------------------------------------------------------------

export interface OperationInput {
  readonly workOrderOperationId: string
  readonly pieces?: number | undefined
  readonly sizes?: readonly SizePieces[] | undefined
  readonly pricePerPiece?: string | undefined
  readonly expectedBackDate?: string | null | undefined
  readonly note?: string | null | undefined
}

export interface CreateInput {
  readonly workOrderId: string
  readonly partyId?: string | undefined
  readonly locationId?: string | undefined
  readonly orderDate?: string | undefined
  readonly expectedBackDate?: string | null | undefined
  readonly currency?: string | undefined
  readonly note?: string | null | undefined
  readonly internalNote?: string | null | undefined
  readonly operations: readonly OperationInput[]
  readonly planKit?: boolean | undefined
}

/** An operation as it is written: its pieces, sizes, fee and amount checked (paths under `prefix`). */
interface OperationDraft {
  readonly workOrderOperationId: string
  readonly pieces: number
  readonly sizes: SizePieces[]
  readonly pricePerPiece: string
  readonly netAmount: number
  readonly expectedBackDate: string | null
  readonly note: string | null
}

/** The pieces and sizes an operation takes: as given, else every garment of the work order. */
function piecesAndSizes(input: Pick<OperationInput, 'pieces' | 'sizes'>, workOrder: WorkOrderFacts, before: { pieces: number; sizes: SizePieces[] } | null, prefix: string): { pieces: number; sizes: SizePieces[] } {
  const garments = workOrder.cells.reduce((sum, cell) => sum + cell.quantity, 0)
  let sizes: SizePieces[]
  let pieces: number
  if (input.sizes !== undefined) {
    sizes = input.sizes.map((size) => ({ workOrderSizeId: size.workOrderSizeId, pieces: size.pieces }))
    pieces = input.pieces ?? (sizes.length > 0 ? piecesOf(sizes) : (before?.pieces ?? garments))
  } else if (input.pieces !== undefined) {
    pieces = input.pieces
    sizes = pieces === garments ? defaultSizes(workOrder.cells) : []
    if (pieces !== garments && before && before.sizes.length > 0) {
      throw refuse([{ path: `${prefix}/sizes`, message: `Say the pieces per size too: they add up to ${piecesOf(before.sizes)}, not ${pieces}.` }])
    }
  } else if (before) {
    return before
  } else {
    pieces = garments
    sizes = defaultSizes(workOrder.cells)
  }
  const problems = piecesProblems(pieces, sizes, workOrder.cells)
  if (problems.length > 0) throw refuse(atBody(problems, prefix))
  return { pieces, sizes }
}

/** The return date of an operation: its routing step's transit days from the order date, the workshop's closed days skipped. */
async function stepReturnDate(db: Reader, partyId: string, orderDate: BusinessDate, step: OutsideStep | undefined): Promise<BusinessDate | null> {
  if (!step || step.transitDays === null || step.supplierId !== partyId) return null
  const { walk } = await supplierArrivalFor(db as never, partyId, orderDate, step.transitDays)
  return walk.date
}

async function operationDrafts(
  db: Reader,
  inputs: readonly OperationInput[],
  workOrder: WorkOrderFacts,
  steps: Map<string, OutsideStep>,
  order: { partyId: string; orderDate: BusinessDate; currency: string; except: string | null },
  prefix: (index: number) => string,
  ordered: Map<string, number> | null,
): Promise<OperationDraft[]> {
  const seen = new Set<string>()
  const drafts: OperationDraft[] = []
  for (const [index, input] of inputs.entries()) {
    const at = prefix(index)
    const operation = workOrder.operations.find((row) => row.id === input.workOrderOperationId)
    if (!operation) throw refuse([{ path: `${at}/workOrderOperationId`, message: 'Not an operation of the work order.' }])
    if (seen.has(operation.id)) throw refuse([{ path: `${at}/workOrderOperationId`, message: `Operation ${operation.seq} ${operation.code} is listed twice.` }])
    seen.add(operation.id)
    const { pieces, sizes } = piecesAndSizes(input, workOrder, null, at)
    if (ordered) checkOrdered(ordered, operation, pieces, workOrder, at)
    const step = steps.get(operation.id)
    const fee = input.pricePerPiece ?? (step && step.supplierId === order.partyId ? step.pricePerPiece : null) ?? '0'
    if (!isFee(fee)) throw refuse([{ path: `${at}/pricePerPiece`, message: 'Expected a fee of 0 or more with at most six decimals.' }])
    const expectedBackDate = input.expectedBackDate !== undefined ? input.expectedBackDate : await stepReturnDate(db, order.partyId, order.orderDate, step)
    if (expectedBackDate !== null && expectedBackDate < order.orderDate) throw refuse([{ path: `${at}/expectedBackDate`, message: 'Due back on or after the order date.' }])
    drafts.push({ workOrderOperationId: operation.id, pieces, sizes, pricePerPiece: fee, netAmount: operationAmount(pieces, fee, order.currency), expectedBackDate, note: blankToNull(input.note) })
  }
  return drafts
}

/**
 * The pieces of a work order's operations on live orders are counted under one lock per work order (two buyers making
 * orders for the same operation at once wait for each other), inside the command that adds them.
 */
async function lockPieces(tools: CommandTools, workOrderId: string): Promise<void> {
  const tenantId = 'tenantId' in tools.context ? tools.context.tenantId : ''
  await tools.tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.subcontract-pieces', ${tenantId}::text, ${workOrderId}::text), 0))`
}

function checkOrdered(ordered: Map<string, number>, operation: WorkOrderFacts['operations'][number], pieces: number, workOrder: WorkOrderFacts, at: string): void {
  const garments = workOrder.cells.reduce((sum, cell) => sum + cell.quantity, 0)
  const already = ordered.get(operation.id) ?? 0
  if (already + pieces > garments) {
    throw refuse([{ path: `${at}/pieces`, message: `${already} piece(s) of operation ${operation.seq} ${operation.code} are on other subcontract orders already; at most ${Math.max(0, garments - already)} more of the work order's ${garments}.` }])
  }
}

/** The workshop's stock location on the site: the one named (checked), else its only active one. */
async function locationFor(db: Reader, siteId: string, partyId: string, locationId: string | undefined, path: string) {
  if (locationId !== undefined) {
    const location = await readLocationRow(db, locationId)
    if (!location || location.siteId !== siteId || location.kind !== 'SUBCONTRACTOR' || location.partyId !== partyId) {
      throw refuse([{ path, message: "Not a stock location of this workshop on the work order's site (a SUBCONTRACTOR location it owns)." }])
    }
    if (location.status !== 'ACTIVE') throw refuse([{ path, message: `Location ${location.code} is archived.` }])
    return location
  }
  const found = await workshopLocations(db, siteId, [partyId])
  if (found.length === 0) throw new InvalidStateError("The workshop has no stock location on the work order's site yet: create one first (a location of kind SUBCONTRACTOR, owned by the workshop).")
  if (found.length > 1) throw refuse([{ path, message: `The workshop has ${found.length} locations on the site: name the one to use.` }])
  return found[0]!
}

/** The work order's planned materials for the cells sent, per material and colour (a HIDE-tracked leather goes cut, as bundles). */
async function kitPlanOf(db: Reader, workOrderId: string, operations: readonly { readonly pieces: number; readonly sizes: readonly SizePieces[] }[], cells: WorkOrderFacts['cells']) {
  // Per cell, the most pieces any operation sends out (a garment travels once for all the order's operations).
  const share = new Map<string, number>()
  for (const operation of operations) {
    const sizes = operation.sizes.length > 0 ? operation.sizes : defaultSizes(cells)
    for (const size of sizes) share.set(size.workOrderSizeId, Math.max(share.get(size.workOrderSizeId) ?? 0, size.pieces))
  }
  const materials = await db.workOrderMaterial.findMany({ where: { workOrderId, workOrderSizeId: { in: [...share.keys()] } }, select: { itemId: true, itemColourId: true, workOrderSizeId: true, baseQuantity: true }, orderBy: [{ itemId: 'asc' }] })
  const items = new Map((await db.item.findMany({ where: { id: { in: [...new Set(materials.map((row) => row.itemId))] } }, select: { id: true, baseUom: true, tracking: true } })).map((item) => [item.id, item]))
  const cellQuantity = new Map(cells.map((cell) => [cell.id, cell.quantity]))
  const totals = new Map<string, { itemId: string; itemColourId: string | null; baseUom: Uom; base: number }>()
  for (const row of materials) {
    const item = items.get(row.itemId)
    if (!item || item.tracking === 'HIDE') continue
    const ratio = (share.get(row.workOrderSizeId) ?? 0) / (cellQuantity.get(row.workOrderSizeId) ?? 1)
    const key = `${row.itemId}|${row.itemColourId ?? '-'}`
    const entry = totals.get(key) ?? { itemId: row.itemId, itemColourId: row.itemColourId, baseUom: item.baseUom, base: 0 }
    entry.base += Number(row.baseQuantity.toString()) * ratio
    totals.set(key, entry)
  }
  return [...totals.values()].filter((entry) => entry.base > 0).map((entry) => ({ ...entry, quantity: entry.base.toFixed(4) }))
}

async function insertKitPlan(tools: CommandTools, order: Pick<OrderRow, 'id' | 'siteId' | 'partyId' | 'workOrderId'>, workOrder: WorkOrderFacts, operations: readonly { pieces: number; sizes: readonly SizePieces[] }[]): Promise<number> {
  const existing = await readKitLines(tools.tx, order.id)
  const planned = await kitPlanOf(tools.tx, order.workOrderId, operations, workOrder.cells)
  const already = new Set(existing.filter((line) => line.status !== 'CANCELLED').map((line) => `${line.itemId}|${line.itemColourId ?? '-'}`))
  let seq = existing.reduce((max, line) => Math.max(max, line.seq), 0)
  let added = 0
  for (const line of planned) {
    if (already.has(`${line.itemId}|${line.itemColourId ?? '-'}`)) continue
    if (existing.length + added >= MAX_KIT_LINES) break
    seq += SEQ_STEP
    const id = newId()
    await tools.tx.subcontractKitLine.create({
      data: { id, siteId: order.siteId, partyId: order.partyId, subcontractOrderId: order.id, seq, itemId: line.itemId, itemColourId: line.itemColourId, quantity: line.quantity, uom: line.baseUom, baseQuantity: line.quantity, note: 'From the work order’s planned materials.', createdAt: tools.now, updatedAt: tools.now, createdById: actorIdOf(tools) },
      select: { id: true },
    })
    tools.audit({ action: 'purchasing.subcontract.planKitLine', recordType: 'SubcontractKitLine', recordId: id, after: { seq, itemId: line.itemId, itemColourId: line.itemColourId, quantity: line.quantity, uom: line.baseUom } })
    added += 1
  }
  return added
}

/** purchasing.subcontract.manage: a draft order for outside operations of a work order. */
export async function createOrder(caller: CommandCaller, input: CreateInput, idempotencyKey?: string): Promise<{ order: OrderDetailView }> {
  const context = officeContextOf(caller)
  const facts = await caller.withClient(async (client) => {
    const workOrder = await readWorkOrderFacts(client, input.workOrderId)
    if (!workOrder) throw new NotFoundError('Work order not found.')
    const steps = await outsideStepsOf(client, workOrder.operations)
    const firstStep = input.operations.map((operation) => steps.get(operation.workOrderOperationId)).find((step) => step !== undefined)
    const partyId = input.partyId ?? firstStep?.supplierId
    if (!partyId) throw refuse([{ path: 'body/partyId', message: 'Name the workshop: no operation sent names one in its routing step.' }])
    const party = await readWorkshop(client, partyId)
    assertWorkshop(party, workOrder.companyId)
    assertMay(context, PURCHASING_SUBCONTRACT_MANAGE, { companyId: workOrder.companyId, siteId: workOrder.siteId, partyId }, 'Work order')
    if (!(WORK_ORDER_STATES as readonly string[]).includes(workOrder.status)) {
      throw new InvalidStateError(`Work order ${workOrder.number} is ${workOrder.status}; work is sent out only for a released or running one.`)
    }
    const location = await locationFor(client, workOrder.siteId, partyId, input.locationId, 'body/locationId')
    const company = await client.company.findUnique({ where: { id: workOrder.companyId }, select: { currency: true } })
    const currency = input.currency ?? company?.currency ?? 'EUR'
    if (!isCurrencyCode(currency)) throw refuse([{ path: 'body/currency', message: 'Expected an ISO 4217 currency code.' }])
    const orderDate = input.orderDate ?? today()
    const operations = await operationDrafts(client, input.operations, workOrder, steps, { partyId, orderDate, currency, except: null }, (index) => `body/operations/${index}`, null)
    const latest = operations.map((operation) => operation.expectedBackDate).filter((date): date is string => date !== null).sort().pop() ?? null
    const expectedBackDate = input.expectedBackDate !== undefined ? input.expectedBackDate : latest
    if (expectedBackDate !== null && expectedBackDate < orderDate) throw refuse([{ path: 'body/expectedBackDate', message: 'Due back on or after the order date.' }])
    return { workOrder, party: party!, location, currency, orderDate, operations, expectedBackDate }
  })
  const { workOrder, party, location, currency, orderDate, operations, expectedBackDate } = facts
  const { result } = await command(caller, { name: 'purchasing.subcontract.create', idempotencyKey, input }, async (tools) => {
    await lockPieces(tools, workOrder.id)
    const ordered = await orderedPieces(tools.tx, workOrder.id, null)
    for (const [index, operation] of operations.entries()) checkOrdered(ordered, workOrder.operations.find((row) => row.id === operation.workOrderOperationId)!, operation.pieces, workOrder, `body/operations/${index}`)
    const id = newId()
    const number = await allocateNumber(tools, { companyId: workOrder.companyId, kind: 'SUBCONTRACT' }, { type: 'SubcontractOrder', id, date: orderDate })
    const netAmount = orderAmount(operations)
    await tools.tx.subcontractOrder.create({
      data: {
        id,
        companyId: workOrder.companyId,
        siteId: workOrder.siteId,
        number: number.formatted,
        partyId: party.id,
        locationId: location.id,
        workOrderId: workOrder.id,
        orderDate: dayValue(orderDate),
        expectedBackDate: expectedBackDate ? dayValue(expectedBackDate) : null,
        currency,
        netAmount,
        note: blankToNull(input.note),
        internalNote: blankToNull(input.internalNote),
        createdAt: tools.now,
        updatedAt: tools.now,
        createdById: actorIdOf(tools),
      },
      select: { id: true },
    })
    for (const [index, operation] of operations.entries()) {
      await tools.tx.subcontractOperation.create({
        data: {
          id: newId(),
          siteId: workOrder.siteId,
          workOrderId: workOrder.id,
          subcontractOrderId: id,
          seq: (index + 1) * SEQ_STEP,
          workOrderOperationId: operation.workOrderOperationId,
          pieces: operation.pieces,
          sizes: json(operation.sizes),
          pricePerPiece: operation.pricePerPiece,
          netAmount: operation.netAmount,
          expectedBackDate: operation.expectedBackDate ? dayValue(operation.expectedBackDate) : null,
          note: operation.note,
          createdAt: tools.now,
          updatedAt: tools.now,
          createdById: actorIdOf(tools),
        },
        select: { id: true },
      })
    }
    const kitLines = input.planKit ? await insertKitPlan(tools, { id, siteId: workOrder.siteId, partyId: party.id, workOrderId: workOrder.id }, workOrder, operations) : 0
    tools.audit({
      recordType: 'SubcontractOrder',
      recordId: id,
      companyId: workOrder.companyId,
      siteId: workOrder.siteId,
      after: {
        number: number.formatted,
        workOrderId: workOrder.id,
        partyId: party.id,
        locationId: location.id,
        orderDate,
        expectedBackDate,
        currency,
        netAmount: markMoney('cost', netAmount),
        operations: operations.map((operation, index) => ({ seq: (index + 1) * SEQ_STEP, workOrderOperationId: operation.workOrderOperationId, pieces: operation.pieces, sizes: operation.sizes, pricePerPiece: markMoney('cost', operation.pricePerPiece), expectedBackDate: operation.expectedBackDate })),
        kitLines,
      },
    })
    tools.emit({
      type: 'subcontract_order.created',
      subject: id,
      companyId: workOrder.companyId,
      siteId: workOrder.siteId,
      payload: { subcontractOrderId: id, number: number.formatted, status: 'DRAFT', workOrderId: workOrder.id, partyId: party.id, siteId: workOrder.siteId, operations: operations.length, kitLines },
    })
    return { order: await detailInCommand(tools, id) }
  })
  return result
}

// ---- change --------------------------------------------------------------------------------------------------------------

/** The order the caller may change, read again under the command's lock (its version bump). */
async function lockedOrder(tools: CommandTools, orderId: string): Promise<OrderRow> {
  const order = await readOrder(tools.tx, orderId)
  if (!order) throw new NotFoundError('Subcontract order not found.')
  return order
}

const changed = (tools: CommandTools, order: Pick<OrderRow, 'id' | 'number' | 'companyId' | 'siteId'>, status: string, fields: string[]) =>
  tools.emit({ type: 'subcontract_order.updated', subject: order.id, companyId: order.companyId, siteId: order.siteId, payload: { subcontractOrderId: order.id, number: order.number, status, fields } })

export interface UpdateInput {
  readonly version: number
  readonly partyId?: string | undefined
  readonly locationId?: string | undefined
  readonly orderDate?: string | undefined
  readonly expectedBackDate?: string | null | undefined
  readonly currency?: string | undefined
  readonly note?: string | null | undefined
  readonly internalNote?: string | null | undefined
}

/** purchasing.subcontract.manage: the header; all of it while DRAFT, afterwards the return date and the notes. */
export async function updateOrder(caller: CommandCaller, orderId: string, input: UpdateInput, idempotencyKey?: string): Promise<{ order: OrderDetailView }> {
  const { context, order: seen } = await officeOrder(caller, orderId, PURCHASING_SUBCONTRACT_MANAGE)
  const terms = (['partyId', 'locationId', 'orderDate', 'currency'] as const).filter((field) => input[field] !== undefined)
  if (terms.length > 0) assertDraft(seen, 'its workshop, location, date and currency change')
  if (seen.status === 'CLOSED' || seen.status === 'CANCELLED') {
    if (input.expectedBackDate !== undefined || input.note !== undefined) throw new InvalidStateError(`Subcontract order ${seen.number} is ${seen.status.toLowerCase()}; only its internal note changes.`)
  }
  // A new workshop: checked, and its location (named, else its only one) on the order's site.
  let partyId = seen.partyId
  let locationId = seen.locationId
  if (input.partyId !== undefined || input.locationId !== undefined) {
    partyId = input.partyId ?? seen.partyId
    const party = await caller.withClient((client) => readWorkshop(client, partyId))
    assertWorkshop(party, seen.companyId)
    assertMay(context, PURCHASING_SUBCONTRACT_MANAGE, { companyId: seen.companyId, siteId: seen.siteId, partyId }, 'Subcontract order')
    locationId = (await caller.withClient((client) => locationFor(client, seen.siteId, partyId, input.locationId ?? (partyId === seen.partyId ? seen.locationId : undefined), 'body/locationId'))).id
  }
  const currency = input.currency ?? seen.currency
  if (!isCurrencyCode(currency)) throw refuse([{ path: 'body/currency', message: 'Expected an ISO 4217 currency code.' }])
  const { result } = await command(
    caller,
    { name: 'purchasing.subcontract.update', idempotencyKey, input: { orderId, ...input }, record: { type: 'SubcontractOrder', id: orderId, expectedVersion: input.version } },
    async (tools) => {
      const before = await lockedOrder(tools, orderId)
      if (terms.length > 0) assertDraft(before, 'its workshop, location, date and currency change')
      const orderDate = input.orderDate ?? dayOf(before.orderDate)!
      const expectedBackDate = input.expectedBackDate !== undefined ? input.expectedBackDate : dayOf(before.expectedBackDate)
      if (expectedBackDate !== null && expectedBackDate < orderDate) throw refuse([{ path: 'body/expectedBackDate', message: 'Due back on or after the order date.' }])
      const data: Prisma.SubcontractOrderUncheckedUpdateInput = {
        ...(input.partyId !== undefined || input.locationId !== undefined ? { partyId, locationId } : {}),
        ...(input.orderDate !== undefined ? { orderDate: dayValue(input.orderDate) } : {}),
        ...(input.expectedBackDate !== undefined ? { expectedBackDate: input.expectedBackDate ? dayValue(input.expectedBackDate) : null } : {}),
        ...(input.currency !== undefined ? { currency } : {}),
        ...(input.note !== undefined ? { note: blankToNull(input.note) } : {}),
        ...(input.internalNote !== undefined ? { internalNote: blankToNull(input.internalNote) } : {}),
      }
      if (partyId !== before.partyId) {
        // The kit lines name the order's workshop (their reference): only PLANNED ones exist while DRAFT; they follow it.
        // The reference (siteId, partyId, orderId) is checked per row, so the order moves first and its lines after.
        await moveKitToWorkshop(tools, before, partyId, data)
      } else {
        await tools.tx.subcontractOrder.update({ where: { id: orderId }, data, select: { id: true } })
      }
      if (input.currency !== undefined && currency !== before.currency) {
        for (const operation of await readOperations(tools.tx, orderId)) {
          await tools.tx.subcontractOperation.update({ where: { id: operation.id }, data: { netAmount: operationAmount(operation.pieces, operation.pricePerPiece.toString(), currency) }, select: { id: true } })
        }
        await refreshAmount(tools.tx, orderId)
      }
      const fields = Object.keys(data)
      tools.audit({
        recordType: 'SubcontractOrder',
        recordId: orderId,
        companyId: before.companyId,
        siteId: before.siteId,
        before: { partyId: before.partyId, locationId: before.locationId, orderDate: dayOf(before.orderDate), expectedBackDate: dayOf(before.expectedBackDate), currency: before.currency, note: before.note, internalNote: before.internalNote },
        after: { partyId, locationId, orderDate, expectedBackDate, currency, note: input.note !== undefined ? blankToNull(input.note) : before.note, internalNote: input.internalNote !== undefined ? blankToNull(input.internalNote) : before.internalNote },
      })
      changed(tools, before, before.status, fields)
      return { order: await detailInCommand(tools, orderId) }
    },
  )
  return result
}

/**
 * A draft's workshop changes: its PLANNED kit lines reference (site, workshop, order), so they are taken off and put back
 * under the new workshop around the order's own change (same ids, seq and goods; audited).
 */
async function moveKitToWorkshop(tools: CommandTools, before: OrderRow, partyId: string, data: Prisma.SubcontractOrderUncheckedUpdateInput): Promise<void> {
  const lines = await readKitLines(tools.tx, before.id)
  for (const line of lines) await tools.tx.subcontractKitLine.delete({ where: { id: line.id }, select: { id: true } })
  await tools.tx.subcontractOrder.update({ where: { id: before.id }, data, select: { id: true } })
  for (const line of lines.filter((row) => row.status === 'PLANNED')) {
    await tools.tx.subcontractKitLine.create({
      data: {
        id: line.id,
        siteId: before.siteId,
        partyId,
        subcontractOrderId: before.id,
        seq: line.seq,
        itemId: line.itemId,
        itemColourId: line.itemColourId,
        lotId: line.lotId,
        hideId: line.hideId,
        quantity: line.quantity,
        uom: line.uom,
        baseQuantity: line.baseQuantity,
        note: line.note,
        createdAt: tools.now,
        updatedAt: tools.now,
        createdById: actorIdOf(tools),
      },
      select: { id: true },
    })
  }
  if (lines.length > 0) tools.audit({ action: 'purchasing.subcontract.kitToWorkshop', recordType: 'SubcontractOrder', recordId: before.id, companyId: before.companyId, siteId: before.siteId, before: { partyId: before.partyId }, after: { partyId, kitLineIds: lines.map((line) => line.id) } })
}

// ---- operations ------------------------------------------------------------------------------------------------------------

async function operationContext(tools: CommandTools, orderId: string) {
  const order = await lockedOrder(tools, orderId)
  assertDraft(order, 'its operations change')
  const workOrder = await readWorkOrderFacts(tools.tx, order.workOrderId)
  if (!workOrder) throw new NotFoundError('Work order not found.')
  return { order, workOrder, steps: await outsideStepsOf(tools.tx, workOrder.operations) }
}

/** purchasing.subcontract.manage: one more operation of the work order on a draft. */
export async function addOperation(caller: CommandCaller, orderId: string, input: OperationInput & { readonly version: number }, idempotencyKey?: string): Promise<{ order: OrderDetailView }> {
  await officeOrder(caller, orderId, PURCHASING_SUBCONTRACT_MANAGE)
  const { result } = await command(
    caller,
    { name: 'purchasing.subcontract.addOperation', idempotencyKey, input: { orderId, ...input }, record: { type: 'SubcontractOrder', id: orderId, expectedVersion: input.version } },
    async (tools) => {
      const { order, workOrder, steps } = await operationContext(tools, orderId)
      const existing = await readOperations(tools.tx, orderId)
      if (existing.length >= MAX_OPERATIONS) throw refuse([{ path: 'body', message: `An order has at most ${MAX_OPERATIONS} operations.` }])
      if (existing.some((row) => row.workOrderOperationId === input.workOrderOperationId)) throw new ConflictError('This operation is on the order already: change its pieces instead.')
      await lockPieces(tools, order.workOrderId)
      const [draft] = await operationDrafts(tools.tx, [input], workOrder, steps, { partyId: order.partyId, orderDate: dayOf(order.orderDate)!, currency: order.currency, except: order.id }, () => 'body', await orderedPieces(tools.tx, order.workOrderId, order.id))
      const seq = existing.reduce((max, row) => Math.max(max, row.seq), 0) + SEQ_STEP
      const id = newId()
      const row = await tools.tx.subcontractOperation.create({
        data: { id, siteId: order.siteId, workOrderId: order.workOrderId, subcontractOrderId: orderId, seq, workOrderOperationId: draft!.workOrderOperationId, pieces: draft!.pieces, sizes: json(draft!.sizes), pricePerPiece: draft!.pricePerPiece, netAmount: draft!.netAmount, expectedBackDate: draft!.expectedBackDate ? dayValue(draft!.expectedBackDate) : null, note: draft!.note, createdAt: tools.now, updatedAt: tools.now, createdById: actorIdOf(tools) },
        select: OPERATION_COLUMNS,
      })
      const netAmount = await refreshAmount(tools.tx, orderId)
      tools.audit({ action: 'purchasing.subcontract.addOperation', recordType: 'SubcontractOperation', recordId: id, companyId: order.companyId, siteId: order.siteId, after: { ...auditOperation(row), orderNetAmount: markMoney('cost', netAmount) } })
      changed(tools, order, order.status, ['operations'])
      return { order: await detailInCommand(tools, orderId) }
    },
  )
  return result
}

/** purchasing.subcontract.manage: an operation's pieces, sizes, fee, return date or note, on a draft. */
export async function editOperation(caller: CommandCaller, orderId: string, operationId: string, input: Omit<OperationInput, 'workOrderOperationId'> & { readonly version: number }, idempotencyKey?: string): Promise<{ order: OrderDetailView }> {
  await officeOrder(caller, orderId, PURCHASING_SUBCONTRACT_MANAGE)
  const { result } = await command(
    caller,
    { name: 'purchasing.subcontract.editOperation', idempotencyKey, input: { orderId, operationId, ...input }, record: { type: 'SubcontractOrder', id: orderId, expectedVersion: input.version } },
    async (tools) => {
      const { order, workOrder } = await operationContext(tools, orderId)
      const before = isUuid(operationId) ? await tools.tx.subcontractOperation.findUnique({ where: { id: operationId }, select: OPERATION_COLUMNS }) : null
      if (!before || before.subcontractOrderId !== orderId) throw new NotFoundError('Operation not found on this order.')
      const { pieces, sizes } = piecesAndSizes(input, workOrder, { pieces: before.pieces, sizes: sizesOf(before.sizes) }, 'body')
      const operation = workOrder.operations.find((row) => row.id === before.workOrderOperationId)!
      await lockPieces(tools, order.workOrderId)
      checkOrdered(await orderedPieces(tools.tx, workOrder.id, order.id), operation, pieces, workOrder, 'body')
      const fee = input.pricePerPiece ?? before.pricePerPiece.toString()
      if (!isFee(fee)) throw refuse([{ path: 'body/pricePerPiece', message: 'Expected a fee of 0 or more with at most six decimals.' }])
      const expectedBackDate = input.expectedBackDate !== undefined ? input.expectedBackDate : dayOf(before.expectedBackDate)
      if (expectedBackDate !== null && expectedBackDate < dayOf(order.orderDate)!) throw refuse([{ path: 'body/expectedBackDate', message: 'Due back on or after the order date.' }])
      const row = await tools.tx.subcontractOperation.update({
        where: { id: operationId },
        data: { pieces, sizes: json(sizes), pricePerPiece: fee, netAmount: operationAmount(pieces, fee, order.currency), expectedBackDate: expectedBackDate ? dayValue(expectedBackDate) : null, ...(input.note !== undefined ? { note: blankToNull(input.note) } : {}), version: { increment: 1 } },
        select: OPERATION_COLUMNS,
      })
      const netAmount = await refreshAmount(tools.tx, orderId)
      tools.audit({ action: 'purchasing.subcontract.editOperation', recordType: 'SubcontractOperation', recordId: operationId, companyId: order.companyId, siteId: order.siteId, before: auditOperation(before), after: { ...auditOperation(row), orderNetAmount: markMoney('cost', netAmount) } })
      changed(tools, order, order.status, ['operations'])
      return { order: await detailInCommand(tools, orderId) }
    },
  )
  return result
}

/** purchasing.subcontract.manage: an operation off a draft. */
export async function removeOperation(caller: CommandCaller, orderId: string, operationId: string, input: { readonly version: number }, idempotencyKey?: string): Promise<{ order: OrderDetailView }> {
  await officeOrder(caller, orderId, PURCHASING_SUBCONTRACT_MANAGE)
  const { result } = await command(
    caller,
    { name: 'purchasing.subcontract.removeOperation', idempotencyKey, input: { orderId, operationId, ...input }, record: { type: 'SubcontractOrder', id: orderId, expectedVersion: input.version } },
    async (tools) => {
      const order = await lockedOrder(tools, orderId)
      assertDraft(order, 'its operations change')
      const before = isUuid(operationId) ? await tools.tx.subcontractOperation.findUnique({ where: { id: operationId }, select: OPERATION_COLUMNS }) : null
      if (!before || before.subcontractOrderId !== orderId) throw new NotFoundError('Operation not found on this order.')
      await tools.tx.subcontractOperation.delete({ where: { id: operationId }, select: { id: true } })
      const netAmount = await refreshAmount(tools.tx, orderId)
      tools.audit({ action: 'purchasing.subcontract.removeOperation', recordType: 'SubcontractOperation', recordId: operationId, companyId: order.companyId, siteId: order.siteId, before: auditOperation(before), after: { removed: true, orderNetAmount: markMoney('cost', netAmount) } })
      changed(tools, order, order.status, ['operations'])
      return { order: await detailInCommand(tools, orderId) }
    },
  )
  return result
}

// ---- the kit plan ----------------------------------------------------------------------------------------------------------

export interface KitLineInput {
  readonly itemId: string
  readonly itemColourId?: string | null | undefined
  readonly lotId?: string | null | undefined
  readonly hideId?: string | null | undefined
  readonly quantity: string
  readonly uom?: Uom | undefined
  readonly note?: string | null | undefined
}

const KIT_OPEN = new Set<string>(['DRAFT', 'ISSUED', 'AT_WORKSHOP', 'PARTLY_RECEIVED'])

/** The goods of a kit line, checked: the item (the company's or every company's), its colour, a lot and hide of the site. */
export async function kitGoods(tx: CommandTx, order: Pick<OrderRow, 'companyId' | 'siteId'>, line: { itemId: string; itemColourId?: string | null | undefined; lotId?: string | null | undefined; hideId?: string | null | undefined; quantity: string; uom?: Uom | undefined; baseQuantity?: string | undefined }, at: string) {
  const item = isUuid(line.itemId) ? await tx.item.findUnique({ where: { id: line.itemId }, select: { ...ITEM_COLUMNS, tracking: true } }) : null
  if (!item || (item.companyId !== null && item.companyId !== order.companyId)) throw refuse([{ path: `${at}/itemId`, message: 'Not a material of the order’s company.' }])
  let itemColourId = line.itemColourId ?? null
  if (itemColourId) {
    const colour = isUuid(itemColourId) ? await tx.itemColour.findUnique({ where: { id: itemColourId }, select: { itemId: true } }) : null
    if (!colour || colour.itemId !== item.id) throw refuse([{ path: `${at}/itemColourId`, message: 'Not a colour of this material.' }])
  }
  const lotId = line.lotId ?? null
  if (lotId) {
    const lot = isUuid(lotId) ? await tx.lot.findUnique({ where: { id: lotId }, select: { itemId: true, itemColourId: true, siteId: true } }) : null
    if (!lot || lot.itemId !== item.id || lot.siteId !== order.siteId) throw refuse([{ path: `${at}/lotId`, message: 'Not a lot of this material on the order’s site.' }])
    if (itemColourId && lot.itemColourId !== itemColourId) throw refuse([{ path: `${at}/lotId`, message: 'The lot is of another colour.' }])
    itemColourId = lot.itemColourId
  }
  const hideId = line.hideId ?? null
  if (hideId) {
    const hide = isUuid(hideId) ? await tx.hide.findUnique({ where: { id: hideId }, select: { lotId: true } }) : null
    if (!hide || !lotId || hide.lotId !== lotId) throw refuse([{ path: `${at}/hideId`, message: 'Not a hide of the line’s lot (name the lot too).' }])
  }
  const uom = line.uom ?? item.baseUom
  const base = baseQuantityOf({ quantity: line.quantity, uom, baseQuantity: line.baseQuantity ?? null }, unitsOf(item))
  if (base.problem || base.baseQuantity === undefined) throw refuse([{ path: `${at}/${base.problem?.path ?? 'quantity'}`, message: base.problem?.message ?? 'Expected a quantity above 0.' }])
  if (!(Number(line.quantity) > 0) || !(Number(base.baseQuantity) > 0)) throw refuse([{ path: `${at}/quantity`, message: 'Expected a quantity above 0.' }])
  return { item, itemColourId, lotId, hideId, quantity: line.quantity, uom, baseQuantity: Number(base.baseQuantity).toFixed(4) }
}

/** purchasing.subcontract.manage: kit lines to send (PLANNED), typed. */
export async function addKitLines(caller: CommandCaller, orderId: string, input: { readonly version: number; readonly lines: readonly KitLineInput[] }, idempotencyKey?: string): Promise<{ order: OrderDetailView }> {
  await officeOrder(caller, orderId, PURCHASING_SUBCONTRACT_MANAGE)
  const { result } = await command(
    caller,
    { name: 'purchasing.subcontract.addKitLines', idempotencyKey, input: { orderId, ...input }, record: { type: 'SubcontractOrder', id: orderId, expectedVersion: input.version } },
    async (tools) => {
      const order = await lockedOrder(tools, orderId)
      if (!KIT_OPEN.has(order.status)) throw new InvalidStateError(`Subcontract order ${order.number} is ${order.status.toLowerCase().replace('_', ' ')}; no kit line is added to it.`)
      const existing = await readKitLines(tools.tx, orderId)
      if (existing.length + input.lines.length > MAX_KIT_LINES) throw refuse([{ path: 'body/lines', message: `A kit has at most ${MAX_KIT_LINES} lines.` }])
      let seq = existing.reduce((max, line) => Math.max(max, line.seq), 0)
      for (const [index, line] of input.lines.entries()) {
        const goods = await kitGoods(tools.tx, order, line, `body/lines/${index}`)
        seq += SEQ_STEP
        const id = newId()
        await tools.tx.subcontractKitLine.create({
          data: { id, siteId: order.siteId, partyId: order.partyId, subcontractOrderId: orderId, seq, itemId: goods.item.id, itemColourId: goods.itemColourId, lotId: goods.lotId, hideId: goods.hideId, quantity: goods.quantity, uom: goods.uom, baseQuantity: goods.baseQuantity, note: blankToNull(line.note), createdAt: tools.now, updatedAt: tools.now, createdById: actorIdOf(tools) },
          select: { id: true },
        })
        tools.audit({ action: 'purchasing.subcontract.addKitLine', recordType: 'SubcontractKitLine', recordId: id, companyId: order.companyId, siteId: order.siteId, after: { seq, itemId: goods.item.id, itemColourId: goods.itemColourId, lotId: goods.lotId, hideId: goods.hideId, quantity: goods.quantity, uom: goods.uom, baseQuantity: goods.baseQuantity } })
      }
      changed(tools, order, order.status, ['kit'])
      return { order: await detailInCommand(tools, orderId) }
    },
  )
  return result
}

/** purchasing.subcontract.manage: the kit planned from the work order's materials for the cells sent (lines it lacks). */
export async function planKit(caller: CommandCaller, orderId: string, input: { readonly version: number }, idempotencyKey?: string): Promise<{ order: OrderDetailView }> {
  await officeOrder(caller, orderId, PURCHASING_SUBCONTRACT_MANAGE)
  const { result } = await command(
    caller,
    { name: 'purchasing.subcontract.planKit', idempotencyKey, input: { orderId, ...input }, record: { type: 'SubcontractOrder', id: orderId, expectedVersion: input.version } },
    async (tools) => {
      const order = await lockedOrder(tools, orderId)
      if (!KIT_OPEN.has(order.status)) throw new InvalidStateError(`Subcontract order ${order.number} is ${order.status.toLowerCase().replace('_', ' ')}; no kit line is added to it.`)
      const workOrder = await readWorkOrderFacts(tools.tx, order.workOrderId)
      if (!workOrder) throw new NotFoundError('Work order not found.')
      const operations = (await readOperations(tools.tx, orderId)).map((row) => ({ pieces: row.pieces, sizes: sizesOf(row.sizes) }))
      const added = await insertKitPlan(tools, order, workOrder, operations)
      tools.audit({ action: 'purchasing.subcontract.planKit', recordType: 'SubcontractOrder', recordId: orderId, companyId: order.companyId, siteId: order.siteId, after: { added } })
      if (added > 0) changed(tools, order, order.status, ['kit'])
      return { order: await detailInCommand(tools, orderId) }
    },
  )
  return result
}

async function plannedLine(tools: CommandTools, orderId: string, lineId: string): Promise<KitRow> {
  const line = isUuid(lineId) ? await tools.tx.subcontractKitLine.findUnique({ where: { id: lineId }, select: KIT_COLUMNS }) : null
  if (!line || line.subcontractOrderId !== orderId) throw new NotFoundError('Kit line not found on this order.')
  if (line.status !== 'PLANNED') throw new InvalidStateError(`Kit line ${line.seq} is ${line.status.toLowerCase()}; only a planned line changes.`)
  return line
}

/** purchasing.subcontract.manage: a PLANNED kit line's quantity, lot, hide or note. */
export async function editKitLine(caller: CommandCaller, orderId: string, lineId: string, input: { readonly version: number; readonly quantity?: string | undefined; readonly uom?: Uom | undefined; readonly lotId?: string | null | undefined; readonly hideId?: string | null | undefined; readonly note?: string | null | undefined }, idempotencyKey?: string): Promise<{ order: OrderDetailView }> {
  await officeOrder(caller, orderId, PURCHASING_SUBCONTRACT_MANAGE)
  const { result } = await command(
    caller,
    { name: 'purchasing.subcontract.editKitLine', idempotencyKey, input: { orderId, lineId, ...input }, record: { type: 'SubcontractOrder', id: orderId, expectedVersion: input.version } },
    async (tools) => {
      const order = await lockedOrder(tools, orderId)
      const before = await plannedLine(tools, orderId, lineId)
      const goods = await kitGoods(
        tools.tx,
        order,
        {
          itemId: before.itemId,
          itemColourId: before.itemColourId,
          lotId: input.lotId !== undefined ? input.lotId : before.lotId,
          hideId: input.hideId !== undefined ? input.hideId : input.lotId !== undefined && input.lotId !== before.lotId ? null : before.hideId,
          quantity: input.quantity ?? quantityText(before.quantity),
          uom: input.uom ?? before.uom,
        },
        'body',
      )
      await tools.tx.subcontractKitLine.update({
        where: { id: lineId },
        data: { lotId: goods.lotId, hideId: goods.hideId, itemColourId: goods.itemColourId, quantity: goods.quantity, uom: goods.uom, baseQuantity: goods.baseQuantity, ...(input.note !== undefined ? { note: blankToNull(input.note) } : {}), version: { increment: 1 } },
        select: { id: true },
      })
      tools.audit({
        action: 'purchasing.subcontract.editKitLine',
        recordType: 'SubcontractKitLine',
        recordId: lineId,
        companyId: order.companyId,
        siteId: order.siteId,
        before: { lotId: before.lotId, hideId: before.hideId, quantity: quantityText(before.quantity), uom: before.uom, note: before.note },
        after: { lotId: goods.lotId, hideId: goods.hideId, quantity: goods.quantity, uom: goods.uom, baseQuantity: goods.baseQuantity, note: input.note !== undefined ? blankToNull(input.note) : before.note },
      })
      changed(tools, order, order.status, ['kit'])
      return { order: await detailInCommand(tools, orderId) }
    },
  )
  return result
}

/** purchasing.subcontract.manage: a PLANNED kit line off the order. */
export async function removeKitLine(caller: CommandCaller, orderId: string, lineId: string, input: { readonly version: number }, idempotencyKey?: string): Promise<{ order: OrderDetailView }> {
  await officeOrder(caller, orderId, PURCHASING_SUBCONTRACT_MANAGE)
  const { result } = await command(
    caller,
    { name: 'purchasing.subcontract.removeKitLine', idempotencyKey, input: { orderId, lineId, ...input }, record: { type: 'SubcontractOrder', id: orderId, expectedVersion: input.version } },
    async (tools) => {
      const order = await lockedOrder(tools, orderId)
      const before = await plannedLine(tools, orderId, lineId)
      await tools.tx.subcontractKitLine.delete({ where: { id: lineId }, select: { id: true } })
      tools.audit({ action: 'purchasing.subcontract.removeKitLine', recordType: 'SubcontractKitLine', recordId: lineId, companyId: order.companyId, siteId: order.siteId, before: { seq: before.seq, itemId: before.itemId, quantity: quantityText(before.quantity), uom: before.uom } })
      changed(tools, order, order.status, ['kit'])
      return { order: await detailInCommand(tools, orderId) }
    },
  )
  return result
}

// ---- issue, back to draft, cancel, close ---------------------------------------------------------------------------------

/** The facts of the order's acts, read under the command's lock. */
export async function actFacts(tx: CommandTx, order: OrderRow) {
  const operations = await readOperations(tx, order.id)
  const kit = await readKitLines(tx, order.id)
  const party = await tx.party.findUnique({ where: { id: order.partyId }, select: { status: true } })
  const location = await tx.location.findUnique({ where: { id: order.locationId }, select: { status: true } })
  const workOrder = await tx.workOrder.findUnique({ where: { id: order.workOrderId }, select: { status: true } })
  const codes = new Map((await tx.workOrderOperation.findMany({ where: { id: { in: operations.map((row) => row.workOrderOperationId) } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
  return {
    operations,
    kit,
    facts: {
      status: order.status as SubcontractOrderStatus,
      expectedBackDate: dayOf(order.expectedBackDate),
      orderDate: dayOf(order.orderDate)!,
      currency: order.currency,
      workshopActive: party?.status === 'ACTIVE',
      locationActive: location?.status === 'ACTIVE',
      workOrderStatus: workOrder?.status ?? '',
      operations: operations.map((row) => ({ seq: row.seq, code: codes.get(row.workOrderOperationId), pieces: row.pieces, pricePerPiece: row.pricePerPiece.toString(), piecesSent: row.piecesSent })),
      kitLines: kit.map((line) => ({ status: line.status })),
    },
  }
}

const inWords = (problems: readonly string[]) => new InvalidStateError(problems.join(' '))

/** purchasing.subcontract.manage: DRAFT → ISSUED (the job goes to the workshop; its operations and amount are fixed). */
export async function issueOrder(caller: CommandCaller, orderId: string, input: { readonly version: number }, idempotencyKey?: string): Promise<{ order: OrderDetailView }> {
  await officeOrder(caller, orderId, PURCHASING_SUBCONTRACT_MANAGE)
  const { result } = await command(
    caller,
    { name: 'purchasing.subcontract.issue', idempotencyKey, input: { orderId, ...input }, record: { type: 'SubcontractOrder', id: orderId, expectedVersion: input.version } },
    async (tools) => {
      const order = await lockedOrder(tools, orderId)
      const { operations, facts } = await actFacts(tools.tx, order)
      const problems = issueProblems(facts)
      if (problems.length > 0) throw inWords(problems)
      const netAmount = await refreshAmount(tools.tx, orderId)
      await tools.tx.subcontractOrder.update({ where: { id: orderId }, data: { status: 'ISSUED', issuedAt: tools.now, issuedById: actorIdOf(tools) }, select: { id: true } })
      const pieces = operations.reduce((sum, row) => sum + row.pieces, 0)
      tools.audit({ recordType: 'SubcontractOrder', recordId: orderId, companyId: order.companyId, siteId: order.siteId, before: { status: 'DRAFT' }, after: { status: 'ISSUED', netAmount: markMoney('cost', netAmount), operations: operations.length, pieces } })
      tools.emit({ type: 'subcontract_order.issued', subject: orderId, companyId: order.companyId, siteId: order.siteId, payload: { subcontractOrderId: orderId, number: order.number, status: 'ISSUED', partyId: order.partyId, operations: operations.length, pieces } })
      return { order: await detailInCommand(tools, orderId) }
    },
  )
  return result
}

/** purchasing.subcontract.manage: ISSUED → DRAFT while nothing is out (to be changed). */
export async function reopenOrder(caller: CommandCaller, orderId: string, input: { readonly version: number }, idempotencyKey?: string): Promise<{ order: OrderDetailView }> {
  await officeOrder(caller, orderId, PURCHASING_SUBCONTRACT_MANAGE)
  const { result } = await command(
    caller,
    { name: 'purchasing.subcontract.reopen', idempotencyKey, input: { orderId, ...input }, record: { type: 'SubcontractOrder', id: orderId, expectedVersion: input.version } },
    async (tools) => {
      const order = await lockedOrder(tools, orderId)
      const { facts } = await actFacts(tools.tx, order)
      const problems = reopenProblems(facts)
      if (problems.length > 0) throw inWords(problems)
      await tools.tx.subcontractOrder.update({ where: { id: orderId }, data: { status: 'DRAFT', issuedAt: null, issuedById: null }, select: { id: true } })
      tools.audit({ recordType: 'SubcontractOrder', recordId: orderId, companyId: order.companyId, siteId: order.siteId, before: { status: 'ISSUED', issuedAt: order.issuedAt?.toISOString() ?? null }, after: { status: 'DRAFT' } })
      tools.emit({ type: 'subcontract_order.reopened', subject: orderId, companyId: order.companyId, siteId: order.siteId, payload: { subcontractOrderId: orderId, number: order.number, status: 'DRAFT' } })
      return { order: await detailInCommand(tools, orderId) }
    },
  )
  return result
}

/** purchasing.subcontract.manage: DRAFT or ISSUED → CANCELLED with the reason, while nothing is out (its planned kit lines too). */
export async function cancelOrder(caller: CommandCaller, orderId: string, input: { readonly version: number; readonly reason: string }, idempotencyKey?: string): Promise<{ order: OrderDetailView }> {
  await officeOrder(caller, orderId, PURCHASING_SUBCONTRACT_MANAGE)
  const { result } = await command(
    caller,
    { name: 'purchasing.subcontract.cancel', idempotencyKey, input: { orderId, ...input }, record: { type: 'SubcontractOrder', id: orderId, expectedVersion: input.version } },
    async (tools) => {
      const order = await lockedOrder(tools, orderId)
      const { kit, facts } = await actFacts(tools.tx, order)
      const problems = cancelProblems(facts)
      if (problems.length > 0) throw inWords(problems)
      const planned = kit.filter((line) => line.status === 'PLANNED')
      for (const line of planned) await tools.tx.subcontractKitLine.update({ where: { id: line.id }, data: { status: 'CANCELLED', version: { increment: 1 } }, select: { id: true } })
      await tools.tx.subcontractOrder.update({ where: { id: orderId }, data: { status: 'CANCELLED', cancelledAt: tools.now, cancelReason: input.reason.trim() }, select: { id: true } })
      tools.audit({ recordType: 'SubcontractOrder', recordId: orderId, companyId: order.companyId, siteId: order.siteId, reason: input.reason.trim(), before: { status: order.status }, after: { status: 'CANCELLED', kitLinesCancelled: planned.map((line) => line.id) } })
      tools.emit({ type: 'subcontract_order.cancelled', subject: orderId, companyId: order.companyId, siteId: order.siteId, payload: { subcontractOrderId: orderId, number: order.number, status: 'CANCELLED', from: order.status } })
      return { order: await detailInCommand(tools, orderId) }
    },
  )
  return result
}

/** purchasing.subcontract.manage: RECEIVED → CLOSED. */
export async function closeOrder(caller: CommandCaller, orderId: string, input: { readonly version: number; readonly note?: string | null | undefined }, idempotencyKey?: string): Promise<{ order: OrderDetailView }> {
  await officeOrder(caller, orderId, PURCHASING_SUBCONTRACT_MANAGE)
  const { result } = await command(
    caller,
    { name: 'purchasing.subcontract.close', idempotencyKey, input: { orderId, ...input }, record: { type: 'SubcontractOrder', id: orderId, expectedVersion: input.version } },
    async (tools) => {
      const order = await lockedOrder(tools, orderId)
      const problems = closeProblems({ status: order.status as SubcontractOrderStatus })
      if (problems.length > 0) throw inWords(problems)
      await tools.tx.subcontractOrder.update({ where: { id: orderId }, data: { status: 'CLOSED', closedAt: tools.now }, select: { id: true } })
      tools.audit({ recordType: 'SubcontractOrder', recordId: orderId, companyId: order.companyId, siteId: order.siteId, ...(blankToNull(input.note) ? { reason: blankToNull(input.note)! } : {}), before: { status: 'RECEIVED' }, after: { status: 'CLOSED' } })
      tools.emit({ type: 'subcontract_order.closed', subject: orderId, companyId: order.companyId, siteId: order.siteId, payload: { subcontractOrderId: orderId, number: order.number, status: 'CLOSED' } })
      return { order: await detailInCommand(tools, orderId) }
    },
  )
  return result
}
