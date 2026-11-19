import { DomainError, ForbiddenError, InvalidStateError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { moveChange, workOrderMachine, type ManualMove } from '@nexus/factory-domain/production/work-orders/machine'
import { WORKORDERS_MANAGE } from '@nexus/factory-domain/production/work-orders/permissions'
import { assertTransition, nextStates } from '@nexus/factory-domain/state/machine'
import { command, StaleVersionError, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { lockWorkOrderIssues } from '../../inventory/issue/store'
import { officeContextOf } from './access'
import { lockedStatus, readWorkOrder, type Reader } from './store'
// B-OP-024 (order page plan N1; review R-16): what a cancel would meet, and a cancel with cut pieces refused in words.
import type { Words } from '@nexus/factory-domain/order-apply/rules'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import { readIssued } from './facts'
import { workOrderView, type WorkOrderView } from './views'
import { officeWorkOrder, onWorkOrder, todayOfCommand } from './work-orders'

/**
 * The office's moves after the release (B-W1-38; MES-007): start (RELEASED → IN_PROGRESS; the floor's first issue, cut
 * or scan will start it by itself in B-W1-39/40/42), complete (IN_PROGRESS → COMPLETED), close (COMPLETED → CLOSED; since
 * B-W2b-411 the route closes through ./close.ts: planned vs actual, a tolerance reason, the cost close) and cancel (from DRAFT, RELEASED or IN_PROGRESS,
 * with a reason). One command each on the work order (its version bump locks the row): the machine's check, then the
 * status with its time in one row update (the trigger refuses a status without its time). A cancelled work order gives
 * its pieces back to its order lines; what was issued to it stays on it in the ledger until it is returned (the record
 * lists it per material: `spec.materials[].issued`).
 *
 * Complete, close and cancel end the issuing (B-W1-39: stock is issued only to a RELEASED or IN_PROGRESS work order), so
 * they take the work order's issue lock (modules/inventory/issue store `lockWorkOrderIssues`, the lock every issue,
 * return, undo and reversal takes first) BEFORE the work order's row: an issue in flight finishes first and the move
 * follows it, or the move commits first and the issue, reading the status under the same lock, refuses. Never an issue
 * on a cancelled work order. (The floor cannot lock the row itself: its role only reads work orders.)
 */

/** The moves after which nothing more is issued to the work order. */
const ENDS_ISSUING: readonly ManualMove[] = Object.freeze(['COMPLETED', 'CLOSED', 'CANCELLED'])

/** command()'s record guard, by hand (after the issue lock): the version the caller read, then compare-and-set. B-W2b-411: the close (./close.ts) takes it too. */
export async function bumpVersion(tx: CommandTx, workOrderId: string, expected: number | undefined): Promise<void> {
  const row = await tx.workOrder.findUnique({ where: { id: workOrderId }, select: { version: true } })
  if (!row) throw new NotFoundError('WorkOrder not found.')
  if (expected !== undefined && expected !== row.version) throw new StaleVersionError('WorkOrder', workOrderId, row.version, expected)
  const { count } = await tx.workOrder.updateMany({ where: { id: workOrderId, version: row.version }, data: { version: row.version + 1 } })
  if (count !== 1) {
    const current = await tx.workOrder.findUnique({ where: { id: workOrderId }, select: { version: true } })
    if (!current) throw new NotFoundError('WorkOrder not found.')
    throw new StaleVersionError('WorkOrder', workOrderId, current.version, row.version)
  }
}

const COMMAND: Readonly<Record<ManualMove, `workorders.${string}`>> = {
  IN_PROGRESS: 'workorders.start',
  COMPLETED: 'workorders.complete',
  CLOSED: 'workorders.close',
  CANCELLED: 'workorders.cancel',
}

export async function moveWorkOrder(
  caller: CommandCaller,
  workOrderId: string,
  to: ManualMove,
  body: { readonly version?: number | undefined; readonly reason?: string | undefined },
  idempotencyKey?: string,
): Promise<{ workOrder: WorkOrderView }> {
  const workOrder = await officeWorkOrder(caller, workOrderId, WORKORDERS_MANAGE)
  const spec = { name: COMMAND[to], idempotencyKey, input: { workOrderId, to, ...body }, version: body.version }
  const work = (tools: CommandTools): Promise<{ workOrder: WorkOrderView }> => moveInCommand(tools, workOrder.id, to, body.reason) // B-SA-041
  if (!ENDS_ISSUING.includes(to)) return onWorkOrder(caller, workOrder, spec, work)
  const { tenantId } = officeContextOf(caller)
  const { result } = await command(caller, { name: spec.name, idempotencyKey, input: spec.input }, async (tools) => {
    await lockWorkOrderIssues(tools.tx, tenantId, workOrder.id)
    await bumpVersion(tools.tx, workOrder.id, body.version)
    // B-OP-024 (R-16): pieces already cut are never cancelled away — the way out is Lower to the order (never below what is cut).
    if (to === 'CANCELLED') refuseCutPieces((await cutCellsOf(tools.tx, tenantId, workOrder.id)).reduce((sum, cell) => sum + cell.cut, 0))
    return work(tools)
  })
  return result
}

// ── B-OP-024 (order page plan N1; review R-16): a work order's cancel check, and no cancel of cut pieces ──
/** The words of a cancel refused for pieces already cut (409 `refusal/CUT_PIECES`); the way out named. */
export const CUT_PIECES_WORDS = (count: number): Words => ({
  en: `${count} pieces are cut: lower the work order to the cut instead`,
  it: `${count} pezzi sono già tagliati: riduci l'ordine di lavoro al tagliato`,
})

const refuseCutPieces = (count: number): void => {
  if (count <= 0) return
  const words = CUT_PIECES_WORDS(count)
  throw new DomainError('conflict', words.en, [{ path: 'refusal/CUT_PIECES', message: words.en }])
}

/** Each cell of the work order with what is already cut of it (the database's floor, factory_work_order_cell_floor). */
export async function cutCellsOf(db: Reader, tenantId: string, workOrderId: string): Promise<{ cellId: string; size: string; colourwayId: string; quantity: number; cut: number }[]> {
  const cells = await db.workOrderSize.findMany({ where: { workOrderId }, select: { id: true, size: true, colourwayId: true, quantity: true }, orderBy: [{ colourwayId: 'asc' }, { size: 'asc' }] })
  if (cells.length === 0) return []
  const floors = await db.$queryRaw<{ id: string; floor: number }[]>`SELECT c.id::text AS id, "factory_work_order_cell_floor"(${tenantId}::uuid, c.id) AS floor FROM unnest(${cells.map((cell) => cell.id)}::uuid[]) AS c(id)`
  const cutOf = new Map(floors.map((row) => [row.id, Number(row.floor)]))
  return cells.map((cell) => ({ cellId: cell.id, size: cell.size, colourwayId: cell.colourwayId, quantity: cell.quantity, cut: cutOf.get(cell.id) ?? 0 }))
}

/** A subcontract order at its workshop (the work order's pieces are out there). */
const AT_WORKSHOP = ['ISSUED', 'AT_WORKSHOP', 'PARTLY_RECEIVED'] as const

/**
 * workorders.view: GET /production/work-orders/:workOrderId/cancel-check — what cancelling the work order would meet, read only:
 * the pieces already cut per cell (a cancel with any is refused: lower it to the cut instead — R-16, no outcome to pick on the
 * row), the stock issued to it (it stays on it in the ledger until returned), and the subcontract orders at a workshop. Another
 * customer's work order (or a mixed one, for a person limited to some customers) is "Work order not found.", as an unknown id.
 */
export async function workOrderCancelCheck(caller: CommandCaller, workOrderId: string) {
  const context = officeContextOf(caller)
  const workOrder = await officeWorkOrder(caller, workOrderId)
  return caller.withClient(async (client) => {
    const cells = await cutCellsOf(client, context.tenantId, workOrder.id)
    const pieces = cells.reduce((sum, cell) => sum + cell.cut, 0)
    const issued = [...(await readIssued(client, workOrder.siteId, [workOrder.id])).entries()].flatMap(([key, quantity]) => {
      if (!quantity.gt(0)) return []
      const [, itemId, colour] = key.split('|') as [string, string, string]
      return [{ itemId, itemColourId: colour === '-' ? null : colour, quantity: decimalText(quantity) }]
    })
    const items = new Map((issued.length > 0 ? await client.item.findMany({ where: { id: { in: [...new Set(issued.map((row) => row.itemId))] } }, select: { id: true, code: true, baseUom: true } }) : []).map((row) => [row.id, row]))
    const colourIds = [...new Set(issued.flatMap((row) => (row.itemColourId ? [row.itemColourId] : [])))]
    const colours = new Map((colourIds.length > 0 ? await client.itemColour.findMany({ where: { id: { in: colourIds } }, select: { id: true, code: true } }) : []).map((row) => [row.id, row.code]))
    const workshops = await client.subcontractOrder.findMany({ where: { workOrderId: workOrder.id, status: { in: [...AT_WORKSHOP] } }, select: { id: true, number: true }, orderBy: { number: 'asc' } })
    const stateAllows = nextStates(workOrderMachine, workOrder.status).includes('CANCELLED')
    return {
      workOrderId: workOrder.id,
      number: workOrder.number,
      status: workOrder.status,
      version: workOrder.version,
      /** The machine takes a cancel now and nothing is cut. */
      cancellable: stateAllows && pieces === 0,
      /** Why a cancel is refused for what is cut (null: nothing cut). */
      refusal: pieces > 0 ? CUT_PIECES_WORDS(pieces) : null,
      cut: { pieces, cells: cells.filter((cell) => cell.cut > 0) },
      issued: issued.map((row) => {
        const item = items.get(row.itemId)
        const colour = row.itemColourId ? colours.get(row.itemColourId) : undefined
        return { ...row, label: `${item?.code ?? row.itemId}${colour ? ` ${colour}` : ''}`, baseUom: item?.baseUom ?? '' }
      }),
      atWorkshop: workshops.map((row) => ({ subcontractOrderId: row.id, number: row.number })),
    }
  })
}
// ── end B-OP-024 ──

// ── B-SA-041 (sales page plan): a move's own work inside a command that already holds the work order (its row locked; for
// COMPLETED, CLOSED and CANCELLED its issue lock taken first: lockWorkOrderIssues, then bumpVersion) — moveWorkOrder's own
// command, and a WorkOrderChange applied on a made-to-measure unit (modules/production/work-order-changes: its unit cancelled).
/** The machine's check, the status with its time, the audit row and workorder.status_changed. */
export async function moveInCommand(tools: CommandTools, workOrderId: string, to: ManualMove, reason: string | undefined): Promise<{ workOrder: WorkOrderView }> {
  const { tx, now } = tools
  const current = await readWorkOrder(tx, workOrderId)
  if (!current) throw new NotFoundError('Work order not found.')
  assertTransition(workOrderMachine, current.status, to, { reason: reason ?? null })
  const change = moveChange(to, now, reason)
  await tx.workOrder.update({ where: { id: current.id }, data: change, select: { id: true } })
  const after = Object.fromEntries(Object.entries(change).map(([key, value]) => [key, value instanceof Date ? toUtcIso(value) : value]))
  tools.audit({
    recordType: 'WorkOrder',
    recordId: current.id,
    companyId: current.companyId,
    siteId: current.siteId,
    before: { status: current.status },
    after,
    ...(to === 'CANCELLED' ? { reason: (reason ?? '').trim() } : {}),
  })
  tools.emit({
    type: 'workorder.status_changed',
    subject: current.id,
    companyId: current.companyId,
    siteId: current.siteId,
    payload: { workOrderId: current.id, number: current.number, partyId: current.partyId /* B-PR-09 */, from: current.status, to },
  })
  return { workOrder: await workOrderView(tx, (await readWorkOrder(tx, current.id))!, todayOfCommand(tools)) }
}
// ── end B-SA-041 ──

/**
 * The first work on a released work order starts it (B-W1-39: the first issue; B-W1-40 and B-W1-42 can call it for the
 * first cut or scan): RELEASED → IN_PROGRESS with its start time, as the system (the worker's handler; the floor role
 * cannot update a work order) or the office, in one command on the work order (its version bump locks the row). Answers
 * `started: false` and writes nothing when the work order is not RELEASED any more (started already, or cancelled
 * meanwhile). The same work order is started once: its key is `workorders-start:<id>` and its input names only the
 * work order (never the cause), so a repeat, or a second first work handled at the same time (two issues of one work
 * order in one worker batch), answers from the receipt instead of being refused as a reused key; the audit row keeps
 * the cause of the start that won.
 */
export async function startOnFirstWork(caller: CommandCaller, workOrderId: string, cause: { readonly what: string; readonly causationId?: string }): Promise<{ started: boolean }> {
  const context = caller.factoryContext
  if (!context || (context.audience !== 'system' && context.audience !== 'office')) throw new ForbiddenError()
  const current = await caller.withClient((client) => readWorkOrder(client, workOrderId))
  if (!current || current.status !== 'RELEASED') return { started: false }
  try {
    const { result } = await command(
      caller,
      {
        name: 'workorders.start',
        idempotencyKey: `workorders-start:${workOrderId}`,
        input: { workOrderId, to: 'IN_PROGRESS' },
        record: { type: 'WorkOrder', id: workOrderId },
        ...(cause.causationId ? { causationId: cause.causationId } : {}),
      },
      async (tools) => {
        const row = await lockedStatus(tools.tx, workOrderId, ['RELEASED'], 'its first work starts it')
        const change = moveChange('IN_PROGRESS', tools.now)
        await tools.tx.workOrder.update({ where: { id: row.id }, data: change, select: { id: true } })
        tools.audit({
          recordType: 'WorkOrder',
          recordId: row.id,
          companyId: row.companyId,
          siteId: row.siteId,
          before: { status: row.status },
          after: { status: 'IN_PROGRESS', startedAt: toUtcIso(tools.now) },
          reason: `Started by its first work: ${cause.what}.`,
        })
        tools.emit({
          type: 'workorder.status_changed',
          subject: row.id,
          companyId: row.companyId,
          siteId: row.siteId,
          payload: { workOrderId: row.id, number: row.number, partyId: row.partyId /* B-PR-09 */, from: row.status, to: 'IN_PROGRESS' },
        })
        return { started: true }
      },
    )
    return result
  } catch (error) {
    if (error instanceof InvalidStateError) return { started: false }
    throw error
  }
}
