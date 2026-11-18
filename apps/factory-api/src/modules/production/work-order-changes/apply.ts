import { DomainError, ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { applyRouteOf, CHANGE_WORDS, changedSince, declineProblem, takesEveryCell, type ChangeCell, type WorkOrderChangeStatus, type Words } from '@nexus/factory-domain/order-apply/rules'
import { command, IdempotencyKeyReusedError, StaleVersionError, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { lockWorkOrderIssues } from '../../inventory/issue/store'
import { officeContextOf } from '../work-orders/access'
import { lowerToOrderInCommand } from '../work-orders/lower'
import { bumpVersion, moveInCommand } from '../work-orders/moves'
import { readWorkOrder } from '../work-orders/store'
import { createWorkOrder, setCellsInCommand } from '../work-orders/work-orders'
import { ChangeRefusedError, refuseChange } from './propose'
import { CHANGE_COLUMNS, cellsOf, changeViews, mayDecide, readableChange, type ChangeRow } from './read'
import { decideInCommand } from './decide'

/**
 * B-SA-041 (sales page plan, lead picks P6', R1; 13-backend B4b "Apply"): carrying out a PROPOSED WorkOrderChange, leaving it as
 * is, or making it stale. workorders.manage over its work order (a new DRAFT's: over the order's company and customer); the
 * proposer is always named, and the accepter who holds workorders.manage may apply it himself (a proposal is not an approval,
 * rule 42; review C-11).
 *
 *   POST …/:changeId/apply {version}   ONE command on the change (its version guards it): it is still PROPOSED; its work order's
 *                                      row is locked and its cells read again — a cell whose `from` is not what the work order
 *                                      makes now is refused in words ("WO-0042 changed since — propose again"); then, by the work
 *                                      order as it is now (factory-domain order-apply applyRouteOf):
 *                                        a DRAFT            its cells set (work-orders setCellsInCommand, extracted from setCells)
 *                                        RELEASED / IN_PROGRESS   production's Lower to the order (B-SA-040: never below what is cut)
 *                                        a made-to-measure unit    its unit work order cancelled (a cut unit: refused, scrap it)
 *                                        MAKE_MORE, none named     a new DRAFT made (createWorkOrder on the change: madeWorkOrderId)
 *                                      the change APPLIED in the same command (decidedAt, decidedById), audited,
 *                                      work_order_change.applied. A refusal leaves it PROPOSED with its words in `lastError` (a
 *                                      command of its own after the refused one rolled back): never a silent half-update.
 *   POST …/:changeId/decline {version, words}   "Left as is" (words 1 to 300): DECLINED, audited, work_order_change.declined.
 * The decision's writes and STALE are ./decide.ts.
 */

/** The answer of an apply: the change as it is now, the work order it changed or made, and a reprint mark. */
export interface ApplyAnswer {
  readonly workOrderId: string
  readonly reprint: { traveller: boolean; words: Words | null }
}

/** The change PROPOSED at the version read, inside the command (its row locked by the version bump). */
async function waitingIn(tools: CommandTools, changeId: string): Promise<ChangeRow> {
  const row = await tools.tx.workOrderChange.findUnique({ where: { id: changeId }, select: CHANGE_COLUMNS })
  if (!row) throw new NotFoundError('Work order change not found.')
  if (row.status !== 'PROPOSED') refuseChange('DECIDED', CHANGE_WORDS.decided(row.status as WorkOrderChangeStatus))
  return row
}

/** The work order's cells now: by cell, and by line and size. */
async function cellsNow(tools: CommandTools, workOrderId: string): Promise<{ byCell: Map<string, number>; byLineSize: Map<string, number> }> {
  const rows = await tools.tx.workOrderSize.findMany({ where: { workOrderId }, select: { id: true, salesOrderLineId: true, size: true, quantity: true } })
  return { byCell: new Map(rows.map((row) => [row.id, row.quantity])), byLineSize: new Map(rows.flatMap((row) => (row.salesOrderLineId ? [[`${row.salesOrderLineId}|${row.size}`, row.quantity] as const] : []))) }
}

/** What is cut of the change's cells (the database's floor, summed); 0 lets the work order be cancelled. */
async function cutOf(tools: CommandTools, tenantId: string, cells: readonly ChangeCell[]): Promise<number> {
  let cut = 0
  for (const cell of cells) {
    if (!cell.workOrderSizeId) continue
    const [row] = await tools.tx.$queryRaw<{ floor: number }[]>`SELECT "factory_work_order_cell_floor"(${tenantId}::uuid, ${cell.workOrderSizeId}::uuid) AS floor`
    cut += Number(row?.floor ?? 0)
  }
  return cut
}

/** Should a refusal be kept on the change as `lastError`? A rule's refusal yes; a stale version, an unknown record or a decided one no. */
function failureWords(error: unknown): string | null {
  if (error instanceof StaleVersionError || error instanceof IdempotencyKeyReusedError || error instanceof NotFoundError || error instanceof ForbiddenError) return null
  if (error instanceof ChangeRefusedError && error.code === 'DECIDED') return null
  if (error instanceof DomainError) return error.message
  // The database's own refusal (check_violation): its words name no other customer (…_order_apply_guards and the rest).
  const cause = (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: unknown; originalMessage?: unknown } } } } | null)?.meta?.driverAdapterError?.cause
  return cause?.originalCode === '23514' && typeof cause.originalMessage === 'string' ? cause.originalMessage : null
}

/** A refused apply: its words kept on the change (still PROPOSED), in a command of its own. */
async function keepFailure(caller: CommandCaller, changeId: string, words: string): Promise<void> {
  await command(caller, { name: 'workorders.changeApplyRefused', input: { changeId, words } }, async (tools) => {
    const row = await tools.tx.workOrderChange.findUnique({ where: { id: changeId }, select: CHANGE_COLUMNS })
    if (!row || row.status !== 'PROPOSED') return null
    const lastError = words.trim().slice(0, 500) || 'Refused.'
    await tools.tx.workOrderChange.update({ where: { id: changeId }, data: { lastError, version: { increment: 1 } }, select: { id: true } })
    tools.audit({ action: 'workorders.changeApplyRefused', recordType: 'WorkOrderChange', recordId: changeId, companyId: row.companyId, siteId: row.siteId, before: { lastError: row.lastError }, after: { lastError } })
    return null
  })
}

/** workorders.manage: POST /production/work-order-changes/:changeId/apply (see the file's head). */
export async function applyChange(caller: CommandCaller, changeId: string, body: { readonly version: number }, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const { row, workOrder } = await caller.withClient((db) => readableChange(db, actor, changeId))
  if (!mayDecide(actor, row, workOrder)) throw new ForbiddenError()
  if (row.status !== 'PROPOSED') refuseChange('DECIDED', CHANGE_WORDS.decided(row.status as WorkOrderChangeStatus))
  let answer: ApplyAnswer
  try {
    answer = await applyNow(caller, context, row, body.version, idempotencyKey)
  } catch (error) {
    const words = failureWords(error)
    if (words !== null) await keepFailure(caller, row.id, words)
    throw error
  }
  return caller.withClient(async (db) => {
    const fresh = await db.workOrderChange.findUniqueOrThrow({ where: { id: row.id }, select: CHANGE_COLUMNS })
    const made = (await readWorkOrder(db, answer.workOrderId))!
    return { change: (await changeViews(db, actor, [fresh]))[0]!, workOrder: { id: made.id, number: made.number, status: made.status, version: made.version }, reprint: answer.reprint }
  })
}

/** Why the work order as it is now takes no change (its words name our work order only). */
const refuseRoute = (refusal: 'WORK_ORDER_DONE' | 'ON_HOLD' | 'NOT_A_DRAFT', number: string): never =>
  refuseChange(refusal, refusal === 'ON_HOLD' ? CHANGE_WORDS.onHold(number) : refusal === 'NOT_A_DRAFT' ? CHANGE_WORDS.notADraft(number) : CHANGE_WORDS.workOrderDone(number))

async function applyNow(caller: CommandCaller, context: OfficeContext, row: ChangeRow, version: number, idempotencyKey: string | undefined): Promise<ApplyAnswer> {
  const cells = cellsOf(row)
  const { current, cellIds } = await caller.withClient(async (db) => ({
    current: row.workOrderId ? await readWorkOrder(db, row.workOrderId) : null,
    cellIds: row.workOrderId ? (await db.workOrderSize.findMany({ where: { workOrderId: row.workOrderId }, select: { id: true } })).map((cell) => cell.id) : [],
  }))
  const route = applyRouteOf({ kind: row.kind, workOrderId: row.workOrderId }, current, row.kind === 'LOWER_TO_ORDER' && takesEveryCell(cells, cellIds))
  if ('refusal' in route) refuseRoute(route.refusal, current?.number ?? '')
  const plan = route as { route: 'SET_DRAFT_CELLS' | 'LOWER_RELEASED' | 'CANCEL_WORK_ORDER' | 'NEW_DRAFT' }

  // MAKE_MORE naming no work order: a new DRAFT through the one create, on the change (its APPLIED write in that command).
  if (plan.route === 'NEW_DRAFT') {
    const lines = new Map<string, { size: string; quantity: number }[]>()
    for (const cell of cells) lines.set(cell.salesOrderLineId, [...(lines.get(cell.salesOrderLineId) ?? []), { size: cell.size, quantity: cell.to }])
    const made = await createWorkOrder(caller, { lines: [...lines].map(([salesOrderLineId, sizes]) => ({ salesOrderLineId, sizes })) }, idempotencyKey, undefined, undefined, {
      changeId: row.id,
      version,
      inCommand: async (tools, workOrder) => {
        const waiting = await waitingIn(tools, row.id)
        await decideInCommand(tools, context, waiting, 'APPLIED', { madeWorkOrderId: workOrder.id })
      },
    })
    return { workOrderId: made.workOrder.id, reprint: { traveller: false, words: null } }
  }

  const workOrderId = row.workOrderId!
  const { result } = await command(caller, { name: 'workorders.applyChange', idempotencyKey, input: { changeId: row.id, version }, record: { type: 'WorkOrderChange', id: row.id, expectedVersion: version } }, async (tools) => {
    const waiting = await waitingIn(tools, row.id)
    const asked = cellsOf(waiting)
    // A cancel ends the issuing: the work order's issue lock first, then its row (as the office's cancel takes them).
    if (plan.route === 'CANCEL_WORK_ORDER') await lockWorkOrderIssues(tools.tx, context.tenantId, workOrderId)
    await bumpVersion(tools.tx, workOrderId, undefined)
    const target = (await readWorkOrder(tools.tx, workOrderId))!
    // Its cells as they are now: a change proposed on another figure is proposed again; the route read again (it may have been
    // released meanwhile).
    const now = await cellsNow(tools, workOrderId)
    if (changedSince(asked, now.byCell, now.byLineSize).length > 0) refuseChange('CHANGED_SINCE', CHANGE_WORDS.changedSince(target.number))
    const again = applyRouteOf({ kind: waiting.kind, workOrderId }, target, waiting.kind === 'LOWER_TO_ORDER' && takesEveryCell(asked, [...now.byCell.keys()]))
    if ('refusal' in again) refuseRoute(again.refusal, target.number)
    const to = (again as { route: string }).route
    if (to === 'CANCEL_WORK_ORDER' && plan.route !== 'CANCEL_WORK_ORDER') refuseChange('CHANGED_SINCE', CHANGE_WORDS.changedSince(target.number))
    let reprint: ApplyAnswer['reprint'] = { traveller: false, words: null }
    const lower = async () => (await lowerToOrderInCommand(tools, context, workOrderId, asked.map((cell) => ({ workOrderSizeId: cell.workOrderSizeId!, quantity: cell.to })), waiting.reason)).reprint
    if (to === 'CANCEL_WORK_ORDER') {
      const cut = await cutOf(tools, context.tenantId, asked)
      if (cut > 0 && target.kind === 'MADE_TO_MEASURE') refuseChange('UNIT_CUT', CHANGE_WORDS.unitCut(target.number))
      // Every size to 0: nothing cut, the work order is cancelled; something cut stays (Lower to the order keeps it).
      if (cut === 0) await moveInCommand(tools, workOrderId, 'CANCELLED', waiting.reason)
      else reprint = await lower()
    } else if (to === 'SET_DRAFT_CELLS') {
      await setCellsInCommand(tools, context, workOrderId, asked.map((cell) => ({ salesOrderLineId: cell.salesOrderLineId, size: cell.size, quantity: cell.to })))
    } else {
      reprint = await lower()
    }
    await decideInCommand(tools, context, waiting, 'APPLIED')
    return { reprint }
  })
  return { workOrderId, reprint: result.reprint }
}

/** workorders.manage: POST /production/work-order-changes/:changeId/decline (see the file's head). */
export async function declineChange(caller: CommandCaller, changeId: string, body: { readonly version: number; readonly words: string }, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const { row, workOrder } = await caller.withClient((db) => readableChange(db, actor, changeId))
  if (!mayDecide(actor, row, workOrder)) throw new ForbiddenError()
  const problem = declineProblem(body.words)
  if (problem) throw new DomainError('validation_failed', problem, [{ path: 'body/words', message: problem }])
  await command(caller, { name: 'workorders.declineChange', idempotencyKey, input: { changeId, ...body }, record: { type: 'WorkOrderChange', id: row.id, expectedVersion: body.version } }, async (tools) => {
    const waiting = await waitingIn(tools, row.id)
    await decideInCommand(tools, context, waiting, 'DECLINED', { note: body.words.trim() })
    return null
  })
  return caller.withClient(async (db) => {
    const fresh = await db.workOrderChange.findUniqueOrThrow({ where: { id: row.id }, select: CHANGE_COLUMNS })
    return { change: (await changeViews(db, actor, [fresh]))[0]! }
  })
}
