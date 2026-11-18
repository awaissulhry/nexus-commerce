import type { Prisma } from '@nexus/factory-db'
import { ConflictError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { WORKORDERS_MANAGE } from '@nexus/factory-domain/production/work-orders/permissions'
import { Dec, ZERO, type Decimal } from '@nexus/factory-domain/tax/decimal'
import {
  cutLinePlan,
  cutLineRefusal,
  cutOrderStand,
  followedQuantity,
  loweredTo,
  LOWER_WORDS,
  type CutLineFacts,
  type LowerRefusal,
  type Words,
} from '@nexus/factory-domain/production/work-orders/lower'
import type { CommandCaller, CommandTools } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { emitOrder } from '../cutorders/emit'
import { lockCells } from '../cutorders/store'
import { lockReservations } from '../../inventory/reservations/store'
import { officeContextOf } from './access'
import { lockOrderLines, readWorkOrder, type Header } from './store'
import { workOrderView } from './views'
import { actorIdOf, changedEvent, officeWorkOrder, onWorkOrder, todayOfCommand } from './work-orders'

/**
 * B-SA-040 (sales page plan, lead pick R1; review 17-review P6-1, C-16): production's command "Lower to the order" —
 *
 *   POST /production/work-orders/:workOrderId/lower-to-order {version, cells: [{workOrderSizeId, quantity}], reason?}
 *
 * workorders.manage over the work order (the planner or the supervisor; 404 for a work order of a customer the caller does not
 * reach, a mixed one made before the one-customer rule only for people of every customer: ./access assertMay). A RELEASED or
 * IN_PROGRESS work order's cells go down to what the order needs now (`quantity`, the figure asked), never below what is already
 * cut: ONE command at the work order's version (Idempotency-Key), in this order —
 *
 *   1. the cells' order-line locks (as a draft's cells take them), the live cut orders of the cells FOR UPDATE, then the cells'
 *      cut-order locks (a plan of a cut order takes the same, in the same order);
 *   2. per cell: its cut order lines (factory-domain production/work-orders/lower cutLinePlan) — a LEATHER cut order still
 *      PLANNED follows the cell down (its line lowered, or removed at 0; the cut order's version moves and cut_order.changed
 *      PLAN_CHANGED says so); one already fixed for the cell is refused in words ("Re-plan the lay of CO-0007 first"), one being
 *      cut waits until it is cut;
 *   3. what is already cut, read from the database with SELECT factory_work_order_cell_floor(tenant, cell) — the very floor its
 *      cell guard holds, so the command and the guard always agree — and the cell lowered to max(cut, asked); 0 with nothing cut:
 *      the cell goes (a cancelled size) unless labels, serials or floor records name it (refused in words);
 *   4. its planned materials follow the new figure (scaled, rounded up once to 4 places; a cell that goes takes them with it);
 *   5. the work order's ACTIVE reservations of those materials (the customer's own lots too: a reservation holds a lot whoever
 *      owns it) follow the planned need down — the latest first, never below what was issued; one left with nothing open is
 *      RELEASED (nothing issued) or ISSUED (all of the rest issued), with the words of the change;
 *   6. audit rows per cell, cut order line, material and reservation; workorder.changed (cells); the traveller marked for a
 *      reprint in the answer and the audit row (travellers are made on request and stored nowhere: every paper printed before
 *      this change is out of date).
 *
 * A DRAFT keeps its own command (PUT …/cells, setCells); a raise is MAKE_MORE (a DRAFT's cells, or a new DRAFT: B-SA-041). B-SA-041's
 * apply of a WorkOrderChange runs steps 1–6 in its own command (`lowerToOrderInCommand`, the work order's row locked first).
 */

export interface LowerCellInput {
  readonly workOrderSizeId: string
  /** The figure the order needs now (0: none). */
  readonly quantity: number
}

export interface LowerBody {
  readonly version?: number | undefined
  readonly reason?: string | null | undefined
  readonly cells: readonly LowerCellInput[]
}

/** What one cell did. */
export interface LoweredCell {
  readonly workOrderSizeId: string
  readonly salesOrderLineId: string
  readonly size: string
  readonly asked: number
  readonly from: number
  readonly to: number
  /** What is already cut (the database's floor). */
  readonly alreadyCut: number
  /** The cell went (0, nothing cut). */
  readonly removed: boolean
  readonly words: Words
}

export interface LowerDone {
  readonly cells: LoweredCell[]
  readonly cutOrders: { cutOrderId: string; number: string; lineId: string; from: number; to: number }[]
  readonly materials: { lowered: number; removed: number }
  readonly reservations: { lowered: number; released: number; issued: number }
  /** A traveller printed before the change is out of date (made on request, stored nowhere). */
  readonly reprint: { traveller: boolean; words: Words | null }
}

/** A refusal of "Lower to the order": 409 with `refusal/<CODE>` and the words (both languages in factory-domain LOWER_WORDS). */
export class LowerRefusedError extends ConflictError {
  override name = 'LowerRefusedError'
  override readonly issues: readonly Issue[]
  constructor(
    // S7 end check: the refusal's code is `refusal` (as the other …RefusedError), never `code` — that one is DomainError's
    // 'conflict', which mapError turns into the 409.
    readonly refusal: LowerRefusal,
    readonly words: Words,
  ) {
    super(words.en)
    this.issues = [{ path: `refusal/${refusal}`, message: words.en }]
  }
}

const refuse = (code: LowerRefusal, words: Words): never => {
  throw new LowerRefusedError(code, words)
}

const DEFAULT_REASON = 'Lowered to the order'

/** Why this work order is not lowered at all (its state or kind); null when it may be. */
export function lowerStateRefusal(workOrder: Pick<Header, 'number' | 'status' | 'kind'>): { code: LowerRefusal; words: Words } | null {
  if (workOrder.kind === 'REPAIR') return { code: 'REPAIR', words: LOWER_WORDS.repair(workOrder.number) }
  if (workOrder.kind === 'MADE_TO_MEASURE') return { code: 'UNIT', words: LOWER_WORDS.unit(workOrder.number) }
  if (workOrder.status === 'DRAFT') return { code: 'DRAFT', words: LOWER_WORDS.draft(workOrder.number) }
  if (workOrder.status === 'ON_HOLD') return { code: 'ON_HOLD', words: LOWER_WORDS.onHold(workOrder.number) }
  if (workOrder.status !== 'RELEASED' && workOrder.status !== 'IN_PROGRESS') return { code: 'NOT_RELEASED', words: LOWER_WORDS.notReleased(workOrder.number, workOrder.status) }
  return null
}

/** The body's own problems: 1 to 400 cells, each once, whole pieces (400 with every one). */
function bodyProblems(cells: readonly LowerCellInput[]): Issue[] {
  const problems: Issue[] = []
  if (cells.length === 0) problems.push({ path: 'body/cells', message: 'Name at least one cell to lower.' })
  const seen = new Set<string>()
  cells.forEach((cell, index) => {
    if (seen.has(cell.workOrderSizeId)) problems.push({ path: `body/cells/${index}/workOrderSizeId`, message: 'This cell is named twice.' })
    seen.add(cell.workOrderSizeId)
    if (!Number.isSafeInteger(cell.quantity) || cell.quantity < 0) problems.push({ path: `body/cells/${index}/quantity`, message: 'Whole pieces from 0.' })
  })
  return problems
}

/** workorders.manage: POST /production/work-orders/:workOrderId/lower-to-order (see the file's head). */
export async function lowerToOrder(caller: CommandCaller, workOrderId: string, body: LowerBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const workOrder = await officeWorkOrder(caller, workOrderId, WORKORDERS_MANAGE)
  const state = lowerStateRefusal(workOrder)
  if (state) refuse(state.code, state.words)
  const problems = bodyProblems(body.cells)
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
  const reason = body.reason?.trim() ? body.reason.trim() : DEFAULT_REASON
  return onWorkOrder(caller, workOrder, { name: 'workorders.lowerToOrder', idempotencyKey, input: { workOrderId, ...body }, version: body.version }, async (tools) => {
    const lowered = await lowerToOrderInCommand(tools, context, workOrder.id, body.cells, reason)
    return { workOrder: await workOrderView(tools.tx, (await readWorkOrder(tools.tx, workOrder.id))!, todayOfCommand(tools)), lowered }
  })
}

interface CellRow {
  readonly id: string
  readonly size: string
  readonly quantity: number
  readonly salesOrderLineId: string | null
}

/** The cells `permission` work names, of this work order (else 404 in the words of an unknown cell). */
async function cellsOf(tools: CommandTools, workOrderId: string, asks: readonly LowerCellInput[]): Promise<Map<string, CellRow>> {
  const ids = asks.map((ask) => ask.workOrderSizeId)
  const rows = await tools.tx.workOrderSize.findMany({ where: { id: { in: ids.filter(isUuid) }, workOrderId }, select: { id: true, size: true, quantity: true, salesOrderLineId: true } })
  const byId = new Map(rows.map((row) => [row.id, row]))
  for (const [index, id] of ids.entries()) if (!byId.has(id)) throw new NotFoundError(`Work order cell not found (body/cells/${index}).`)
  return byId
}

/** The garments a live cut order line holds of its cell: what its reconciliation says was cut, else its own (the floor's rule). */
const garmentsOf = (line: { quantity: number; reconciliations: readonly { cutQuantity: number | null }[] }): number => {
  const cut = line.reconciliations.find((entry) => entry.cutQuantity !== null)?.cutQuantity
  return cut ?? line.quantity
}

/** What is already cut of a cell: the database's own floor (factory-db factory_work_order_cell_floor), read in this transaction. */
async function cellFloor(tools: CommandTools, tenantId: string, cellId: string): Promise<number> {
  const [row] = await tools.tx.$queryRaw<{ floor: number }[]>`SELECT "factory_work_order_cell_floor"(${tenantId}::uuid, ${cellId}::uuid) AS floor`
  return Number(row?.floor ?? 0)
}

/** Is anything but its planned materials and cut order lines naming the cell (labels, serials, floor and quality records)? */
async function cellInUse(tools: CommandTools, cellId: string): Promise<boolean> {
  const row = await tools.tx.workOrderSize.findUnique({
    where: { id: cellId },
    select: {
      _count: {
        select: {
          cutPieces: true,
          bundles: true,
          inspectionDefects: true,
          qualityReleases: true,
          qualityReleaseReversals: true,
          garmentSerials: true,
          shipmentLines: true,
          garmentLabelPrints: true,
          reworkOrders: true,
          replacementRequests: true,
          recutTickets: true,
          garmentDowngrades: true,
          subcontractProgressReports: true,
        },
      },
    },
  })
  return row ? Object.values(row._count).some((count) => count > 0) : false
}

/**
 * Steps 1–6 of the file's head inside a command whose caller checked workorders.manage over the work order and locked its row
 * (onWorkOrder's version bump, or B-SA-041's apply). Refuses in words, nothing written, when one cell cannot go as asked.
 */
export async function lowerToOrderInCommand(tools: CommandTools, context: OfficeContext, workOrderId: string, asks: readonly LowerCellInput[], reason: string): Promise<LowerDone> {
  const { tx, now } = tools
  const current = await readWorkOrder(tx, workOrderId)
  if (!current) throw new NotFoundError('Work order not found.')
  const state = lowerStateRefusal(current)
  if (state) refuse(state.code, state.words)
  const problems = bodyProblems(asks)
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
  const cells = await cellsOf(tools, current.id, asks)
  for (const ask of asks) {
    const cell = cells.get(ask.workOrderSizeId)!
    if (cell.salesOrderLineId === null) refuse('NO_ORDER_LINE', LOWER_WORDS.noOrderLine(cell.size))
    if (ask.quantity > cell.quantity) refuse('ONLY_LOWERS', LOWER_WORDS.onlyLowers(cell.size, cell.quantity, ask.quantity))
  }
  const wanted = asks.filter((ask) => ask.quantity < cells.get(ask.workOrderSizeId)!.quantity)
  const cellIds = wanted.map((ask) => ask.workOrderSizeId)

  // 1. The locks: order lines, the live cut orders of the cells (FOR UPDATE, in id order), the cells' cut-order locks.
  await lockOrderLines(tx, context.tenantId, wanted.map((ask) => cells.get(ask.workOrderSizeId)!.salesOrderLineId!))
  const liveOrders = cellIds.length === 0 ? [] : await tx.cutOrderLine.findMany({ where: { workOrderSizeId: { in: cellIds }, cutOrder: { is: { status: { not: 'CANCELLED' } } } }, select: { cutOrderId: true } })
  const cutOrderIds = [...new Set(liveOrders.map((line) => line.cutOrderId))].sort()
  if (cutOrderIds.length > 0) await tx.$queryRaw`SELECT id FROM "CutOrder" WHERE id = ANY(${cutOrderIds}::uuid[]) ORDER BY id FOR UPDATE`
  await lockCells(tx, context.tenantId, cellIds)

  const done: LoweredCell[] = []
  const followedLines: LowerDone['cutOrders'] = []
  const touchedOrders = new Map<string, { id: string; companyId: string; siteId: string; number: string; kind: string; status: string; version: number }>()
  const materials = { lowered: 0, removed: 0 }
  const removedCells = new Set<string>()
  const materialKeys = new Map<string, { itemId: string; itemColourId: string | null }>()

  for (const ask of asks) {
    const cell = cells.get(ask.workOrderSizeId)!
    if (ask.quantity >= cell.quantity) {
      done.push({ workOrderSizeId: cell.id, salesOrderLineId: cell.salesOrderLineId!, size: cell.size, asked: ask.quantity, from: cell.quantity, to: cell.quantity, alreadyCut: 0, removed: false, words: LOWER_WORDS.lowered(cell.size, cell.quantity, cell.quantity) })
      continue
    }
    // 2. Its cut order lines: the following ones lowered first, a fixed one refused in words.
    const lines = await tx.cutOrderLine.findMany({
      where: { workOrderSizeId: cell.id, cutOrder: { is: { status: { not: 'CANCELLED' } } } },
      select: { id: true, seq: true, quantity: true, cutOrderId: true, reconciliations: { select: { cutQuantity: true } }, cutOrder: { select: { id: true, companyId: true, siteId: true, number: true, kind: true, status: true, version: true } } },
    })
    const facts: CutLineFacts[] = lines.map((line) => ({ lineId: line.id, cutOrderId: line.cutOrderId, number: line.cutOrder.number, seq: line.seq, stand: cutOrderStand(line.cutOrder), garments: garmentsOf(line) }))
    const plan = cutLinePlan(facts, ask.quantity)
    if (!plan.ok) {
      const refusal = cutLineRefusal(plan)
      refuse(refusal.code, refusal.words)
    } else {
      for (const step of plan.lowered) {
        const line = lines.find((entry) => entry.id === step.lineId)!
        if (step.to === 0) await tx.cutOrderLine.delete({ where: { id: step.lineId }, select: { id: true } })
        else await tx.cutOrderLine.update({ where: { id: step.lineId }, data: { quantity: step.to, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
        touchedOrders.set(line.cutOrder.id, line.cutOrder)
        followedLines.push({ cutOrderId: line.cutOrder.id, number: line.cutOrder.number, lineId: step.lineId, from: step.from, to: step.to })
        tools.audit({ action: 'cutorders.lineFollowedWorkOrder', recordType: 'CutOrderLine', recordId: step.lineId, companyId: line.cutOrder.companyId, siteId: line.cutOrder.siteId, before: { quantity: step.from }, after: step.to === 0 ? { removed: true, workOrderId: current.id } : { quantity: step.to, workOrderId: current.id }, reason })
      }
    }
    // 3. What is already cut, as the database's guard reads it; the cell to max(cut, asked).
    const alreadyCut = await cellFloor(tools, context.tenantId, cell.id)
    const to = loweredTo(cell.quantity, ask.quantity, alreadyCut)
    const planned = await tx.workOrderMaterial.findMany({ where: { workOrderSizeId: cell.id }, select: { id: true, itemId: true, itemColourId: true, quantity: true, baseQuantity: true } })
    if (to < cell.quantity) for (const material of planned) materialKeys.set(`${material.itemId}|${material.itemColourId ?? '-'}`, { itemId: material.itemId, itemColourId: material.itemColourId })
    if (to === 0) {
      if (await cellInUse(tools, cell.id)) refuse('CELL_IN_USE', LOWER_WORDS.cellInUse(cell.size))
      // 4. A cell that goes takes its planned materials with it (the material guard: nothing of it cut).
      materials.removed += (await tx.workOrderMaterial.deleteMany({ where: { workOrderSizeId: cell.id } })).count
      removedCells.add(cell.id)
    } else if (to < cell.quantity) {
      await tx.workOrderSize.update({ where: { id: cell.id }, data: { quantity: to, version: { increment: 1 } }, select: { id: true } })
      for (const material of planned) {
        const quantity = followedQuantity(material.quantity.toString(), cell.quantity, to)
        const baseQuantity = followedQuantity(material.baseQuantity.toString(), cell.quantity, to)
        if (quantity === null || baseQuantity === null) continue
        await tx.workOrderMaterial.update({ where: { id: material.id }, data: { quantity, baseQuantity, version: { increment: 1 } }, select: { id: true } })
        materials.lowered += 1
      }
    }
    done.push({ workOrderSizeId: cell.id, salesOrderLineId: cell.salesOrderLineId!, size: cell.size, asked: ask.quantity, from: cell.quantity, to, alreadyCut, removed: to === 0, words: to > ask.quantity ? LOWER_WORDS.alreadyCut(alreadyCut) : LOWER_WORDS.lowered(cell.size, cell.quantity, to) })
  }

  // A work order keeps one cell at least: every size gone is a cancel (its own move, with its reason).
  if (removedCells.size > 0 && (await tx.workOrderSize.count({ where: { workOrderId: current.id, id: { notIn: [...removedCells] } } })) === 0) refuse('LAST_CELL', LOWER_WORDS.lastCell(current.number))

  // 5. The reservations of the lowered materials follow (before a removed cell goes: a reservation may name it).
  const reservations = await followReservations(tools, context, current, [...materialKeys.values()], removedCells, reason)
  for (const cellId of removedCells) await tx.workOrderSize.delete({ where: { id: cellId }, select: { id: true } })

  // The cut orders whose lines followed: their version moves, they are announced (the Cutting page, the tablets).
  for (const order of touchedOrders.values()) {
    await tx.cutOrder.update({ where: { id: order.id }, data: { version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    await emitOrder(tools, order, 'PLAN_CHANGED', [current.id])
  }

  const changed = done.filter((cell) => cell.to < cell.from)
  for (const cell of changed) {
    tools.audit({
      action: 'workorders.lowerCell',
      recordType: 'WorkOrderSize',
      recordId: cell.workOrderSizeId,
      companyId: current.companyId,
      siteId: current.siteId,
      before: { quantity: cell.from, size: cell.size, salesOrderLineId: cell.salesOrderLineId },
      after: cell.removed ? undefined : { quantity: cell.to, size: cell.size, salesOrderLineId: cell.salesOrderLineId, asked: cell.asked, alreadyCut: cell.alreadyCut },
      reason,
    })
  }
  const reprint = changed.length > 0
  tools.audit({
    action: 'workorders.lowerToOrder',
    recordType: 'WorkOrder',
    recordId: current.id,
    companyId: current.companyId,
    siteId: current.siteId,
    after: { cells: done.map((cell) => ({ cellId: cell.workOrderSizeId, size: cell.size, asked: cell.asked, from: cell.from, to: cell.to, alreadyCut: cell.alreadyCut })), cutOrderLines: followedLines, materials, reservations, travellerReprint: reprint, by: actorIdOf(tools) },
    reason,
  })
  if (reprint) changedEvent(tools, current, ['cells'], await tx.workOrderSize.findMany({ where: { workOrderId: current.id }, select: { quantity: true } }))
  return { cells: done, cutOrders: followedLines, materials, reservations, reprint: { traveller: reprint, words: reprint ? LOWER_WORDS.reprint() : null } }
}

type ReservationRow = { id: string; companyId: string; siteId: string; itemId: string; itemColourId: string | null; quantity: Prisma.Decimal; issuedQuantity: Prisma.Decimal; workOrderSizeId: string | null; version: number }

const dec = (value: { toString(): string }): Decimal => new Dec(value.toString())

/**
 * Step 5: the work order's ACTIVE reservations of these materials (QUANTITY and AREA: a named hide is held whole) follow the
 * planned need down. Per material and colour: a reservation of a removed cell keeps only what was issued; the ones of a cell (a
 * leather split by garment) at most that cell's planned need; all of them together at most the work order's. The latest first,
 * never below what was issued: nothing open left → RELEASED (nothing issued) or ISSUED (the rest issued).
 */
async function followReservations(tools: CommandTools, context: OfficeContext, workOrder: Header, keys: readonly { itemId: string; itemColourId: string | null }[], removedCells: ReadonlySet<string>, reason: string): Promise<LowerDone['reservations']> {
  const counts = { lowered: 0, released: 0, issued: 0 }
  if (keys.length === 0) return counts
  const { tx, now } = tools
  await lockReservations(tx, context.tenantId, keys.map((key) => ({ siteId: workOrder.siteId, itemId: key.itemId, itemColourId: key.itemColourId })))
  const freed: { id: string; itemId: string }[] = []
  for (const key of keys) {
    const rows: ReservationRow[] = await tx.reservation.findMany({
      where: { workOrderId: workOrder.id, itemId: key.itemId, itemColourId: key.itemColourId, status: 'ACTIVE', kind: { in: ['QUANTITY', 'AREA'] } },
      select: { id: true, companyId: true, siteId: true, itemId: true, itemColourId: true, quantity: true, issuedQuantity: true, workOrderSizeId: true, version: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    })
    if (rows.length === 0) continue
    const planned = await tx.workOrderMaterial.findMany({ where: { workOrderId: workOrder.id, itemId: key.itemId, itemColourId: key.itemColourId }, select: { workOrderSizeId: true, baseQuantity: true } })
    const needOf = (cellId: string | null): Decimal => (cellId !== null && removedCells.has(cellId) ? ZERO : planned.filter((row) => cellId === null || row.workOrderSizeId === cellId).reduce((sum, row) => sum.plus(dec(row.baseQuantity)), ZERO))
    const held = new Map(rows.map((row) => [row.id, dec(row.quantity)]))
    const trim = (group: readonly ReservationRow[], need: Decimal) => {
      let excess = group.reduce((sum, row) => sum.plus(held.get(row.id)!), ZERO).minus(need)
      for (const row of group) {
        if (excess.lte(0)) break
        const quantity = held.get(row.id)!
        const open = quantity.minus(dec(row.issuedQuantity))
        const give = open.lt(excess) ? open : excess
        if (give.lte(0)) continue
        held.set(row.id, quantity.minus(give))
        excess = excess.minus(give)
      }
    }
    for (const cellId of new Set(rows.flatMap((row) => (row.workOrderSizeId ? [row.workOrderSizeId] : [])))) trim(rows.filter((row) => row.workOrderSizeId === cellId), needOf(cellId))
    trim(rows, needOf(null))
    for (const row of rows) {
      const quantity = held.get(row.id)!
      const issued = dec(row.issuedQuantity)
      if (quantity.equals(dec(row.quantity))) continue
      const nothingOpen = quantity.lte(issued)
      const data: Prisma.ReservationUncheckedUpdateInput = nothingOpen
        ? issued.gt(0)
          ? { quantity: issued.toFixed(4), status: 'ISSUED', issuedAt: now, version: { increment: 1 }, updatedAt: now }
          : { status: 'RELEASED', releasedAt: now, releasedById: context.actorId, releaseReason: `${reason} (${workOrder.number})`.slice(0, 500), version: { increment: 1 }, updatedAt: now }
        : { quantity: quantity.toFixed(4), version: { increment: 1 }, updatedAt: now }
      const changed = await tx.reservation.updateMany({ where: { id: row.id, status: 'ACTIVE', version: row.version }, data })
      if (changed.count !== 1) throw new ConflictError('A reservation of this work order changed meanwhile: read it again.')
      if (nothingOpen && issued.gt(0)) counts.issued += 1
      else if (nothingOpen) counts.released += 1
      else counts.lowered += 1
      freed.push({ id: row.id, itemId: row.itemId })
      tools.audit({
        action: 'inventory.reservationFollowedWorkOrder',
        recordType: 'Reservation',
        recordId: row.id,
        companyId: row.companyId,
        siteId: row.siteId,
        before: { quantity: dec(row.quantity).toFixed(4), issuedQuantity: issued.toFixed(4), status: 'ACTIVE' },
        after: { quantity: (nothingOpen ? issued : quantity).toFixed(4), status: nothingOpen ? (issued.gt(0) ? 'ISSUED' : 'RELEASED') : 'ACTIVE', workOrderId: workOrder.id },
        reason,
      })
    }
  }
  if (freed.length > 0) {
    tools.emit({
      type: 'inventory.reservations_released',
      subject: freed[0]!.id,
      companyId: workOrder.companyId,
      siteId: workOrder.siteId,
      payload: { reservationIds: freed.map((row) => row.id), workOrderIds: [workOrder.id], salesOrderLineIds: [], itemIds: [...new Set(freed.map((row) => row.itemId))], hideIds: [] },
    })
  }
  return counts
}
