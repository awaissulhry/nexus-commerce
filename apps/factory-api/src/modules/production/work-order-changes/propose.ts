import type { Prisma } from '@nexus/factory-db'
import { ConflictError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { CHANGE_WORDS, type ChangeCell, type ChangeRefusal, type ExtraOutcome, type ExtraPieces, type PlannedChange, type Words } from '@nexus/factory-domain/order-apply/rules'
import { WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import { ORDERS_MANAGE } from '@nexus/factory-domain/sales/orders/permissions'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { officeOrder } from '../../sales/orders/moves'
import { officeContextOf } from '../work-orders/access'
import { reachesWorkOrder } from '../work-orders/scope'
import { changeViews, CHANGE_COLUMNS, WORK_ORDER_COLUMNS } from './read'

/**
 * B-SA-041 (sales page plan, lead picks P6', R1; 13-backend B4b): proposing a WorkOrderChange — the gap an accepted change of a
 * sales order leaves on one of its work orders, held for a person who manages the work order (Home › Approvals, B-SA-044; the
 * work order's band notice). A proposal is not an approval (rule 42; review C-11): it moves no money and promises nothing.
 *
 *   POST /production/work-order-changes {salesOrderId, workOrderId?, requestId?, amendmentId?, kind, cells, extra?,
 *        extraOutcome?, reason}   orders.manage over the order; the work order reached with workorders.view (a mixed one made
 *                                 before the one-customer rule: only by a person of every customer) — an office's own change
 *   proposeInCommand(tools, …)    the same rows inside a command that is already open: B-SA-042's Accept of a customer's
 *                                 change (factory-domain order-apply planChanges: one change per work order)
 *
 * Each row PROPOSED, of the order's customer, named its proposer; audited; `work_order_change.proposed` (ids, kind; the order's
 * customer as partyId). The database's …_order_apply_guards hold the shape and the wall for every login (a work order of another
 * customer, a line of another order, extra pieces of a cell it does not lower are refused).
 */

/** A refusal of the work-order changes: 409 with `refusal/<CODE>` and the words (both languages in factory-domain CHANGE_WORDS). */
export class ChangeRefusedError extends ConflictError {
  override name = 'ChangeRefusedError'
  override readonly issues: readonly Issue[]
  constructor(
    readonly code: ChangeRefusal,
    readonly words: Words,
  ) {
    super(words.en)
    this.issues = [{ path: `refusal/${code}`, message: words.en }]
  }
}

export const refuseChange = (code: ChangeRefusal, words: Words): never => {
  throw new ChangeRefusedError(code, words)
}

/** The order a change is of (its customer and company: the reference's keys). */
export interface ChangeOrder {
  readonly id: string
  readonly number: string
  readonly companyId: string
  readonly partyId: string
}

export interface ProposeInput {
  readonly order: ChangeOrder
  readonly requestId: string | null
  readonly amendmentId: string | null
  readonly reason: string
  /** What happens to the extra pieces of the changes that leave some (chosen before Accept, R1 / Round 4). */
  readonly extraOutcome: ExtraOutcome | null
  readonly changes: readonly PlannedChange[]
}

export interface Proposed {
  readonly id: string
  readonly kind: PlannedChange['kind']
  readonly workOrderId: string | null
  readonly number: string | null
  readonly cells: readonly ChangeCell[]
  readonly extra: readonly ExtraPieces[]
}

/** The changes written PROPOSED inside an open command (see the file's head); [] when there is none. */
export async function proposeInCommand(tools: CommandTools, context: OfficeContext, input: ProposeInput): Promise<Proposed[]> {
  const { tx, now } = tools
  const made: Proposed[] = []
  const workOrderIds = [...new Set(input.changes.flatMap((change) => (change.workOrderId ? [change.workOrderId] : [])))]
  const sites = new Map((workOrderIds.length > 0 ? await tx.workOrder.findMany({ where: { id: { in: workOrderIds } }, select: { id: true, siteId: true } }) : []).map((row) => [row.id, row.siteId]))
  for (const change of input.changes) {
    if (change.extra.length > 0 && input.extraOutcome === null) throw new ValidationError('Choose what happens to the extra pieces.', [{ path: 'body/extraOutcome', message: 'Choose what happens to the extra pieces already cut.' }])
    const siteId = change.workOrderId ? sites.get(change.workOrderId) : null
    if (change.workOrderId && !siteId) throw new NotFoundError('Work order not found.')
    const id = newId()
    const extra = change.kind === 'LOWER_TO_ORDER' && change.extra.length > 0 ? change.extra : null
    await tx.workOrderChange.create({
      data: {
        id,
        companyId: input.order.companyId,
        partyId: input.order.partyId,
        salesOrderId: input.order.id,
        siteId: siteId ?? null,
        workOrderId: change.workOrderId,
        requestId: input.requestId,
        amendmentId: input.amendmentId,
        kind: change.kind,
        cells: change.cells as unknown as Prisma.InputJsonValue,
        ...(extra ? { extra: extra as unknown as Prisma.InputJsonValue, extraOutcome: input.extraOutcome! } : {}),
        reason: input.reason.slice(0, 500),
        proposedById: context.actorId,
        createdAt: now,
        updatedAt: now,
        createdById: context.actorId,
      },
      select: { id: true },
    })
    tools.audit({
      action: 'workorders.proposeChange',
      recordType: 'WorkOrderChange',
      recordId: id,
      companyId: input.order.companyId,
      siteId: siteId ?? null,
      after: { status: 'PROPOSED', kind: change.kind, salesOrderId: input.order.id, workOrderId: change.workOrderId, requestId: input.requestId, amendmentId: input.amendmentId, cells: change.cells, extra, extraOutcome: extra ? input.extraOutcome : null },
      reason: input.reason,
    })
    tools.emit({
      type: 'work_order_change.proposed',
      subject: id,
      companyId: input.order.companyId,
      siteId: siteId ?? null,
      payload: { changeId: id, salesOrderId: input.order.id, workOrderId: change.workOrderId, partyId: input.order.partyId, kind: change.kind, requestId: input.requestId, amendmentId: input.amendmentId, hasExtra: extra !== null },
    })
    made.push({ id, kind: change.kind, workOrderId: change.workOrderId, number: change.number, cells: change.cells, extra: extra ?? [] })
  }
  return made
}

export interface ProposeBody {
  readonly salesOrderId: string
  readonly workOrderId?: string | null | undefined
  readonly requestId?: string | null | undefined
  readonly amendmentId?: string | null | undefined
  readonly kind: PlannedChange['kind']
  readonly cells: readonly ChangeCell[]
  readonly extra?: readonly ExtraPieces[] | null | undefined
  readonly extraOutcome?: ExtraOutcome | null | undefined
  readonly reason: string
}

/** The body's problems against the order and the work order as they are (400 / 409 in words; the database holds the rest). */
async function checkedChange(caller: CommandCaller, context: OfficeContext, body: ProposeBody, order: ChangeOrder): Promise<PlannedChange> {
  const actor = actorOf(context)
  return caller.withClient(async (db) => {
    const workOrder = body.workOrderId ? await db.workOrder.findUnique({ where: { id: body.workOrderId }, select: { ...WORK_ORDER_COLUMNS, styleId: true } }) : null
    if (body.workOrderId && (!workOrder || !reachesWorkOrder(actor, WORKORDERS_VIEW, workOrder))) throw new NotFoundError('Work order not found.')
    if (body.kind === 'LOWER_TO_ORDER' && !workOrder) throw new ValidationError('Name the work order it lowers.', [{ path: 'body/workOrderId', message: 'A change that lowers names its work order.' }])
    if (body.requestId) {
      const request = await db.orderChangeRequest.findUnique({ where: { id: body.requestId }, select: { orderId: true, status: true } })
      if (!request || request.orderId !== order.id) throw new NotFoundError('Change request not found.')
      // Accept is the commercial decision (P6', R1): a change of a work order carries out an accepted request only, so a request
      // withdrawn by the customer or refused by us never leaves one behind (and the customer's session, which has no grant on
      // these office records, never needs to touch one).
      if (request.status !== 'ACCEPTED') refuseChange('REQUEST_NOT_ACCEPTED', CHANGE_WORDS.requestNotAccepted())
    }
    if (body.amendmentId) {
      const amendment = await db.salesOrderAmendment.findUnique({ where: { id: body.amendmentId }, select: { orderId: true } })
      if (!amendment || amendment.orderId !== order.id) throw new NotFoundError('Amendment not found.')
    }
    const lines = await db.salesOrderLine.findMany({ where: { id: { in: [...new Set(body.cells.map((cell) => cell.salesOrderLineId))] } }, select: { id: true, orderId: true, styleId: true, siteId: true } })
    const lineOf = new Map(lines.map((line) => [line.id, line]))
    if (body.cells.some((cell) => lineOf.get(cell.salesOrderLineId)?.orderId !== order.id)) refuseChange('NOT_THIS_ORDER', CHANGE_WORDS.notThisOrder())
    const named = body.cells.flatMap((cell) => (cell.workOrderSizeId ? [cell.workOrderSizeId] : []))
    const held = new Map((named.length > 0 ? await db.workOrderSize.findMany({ where: { id: { in: named } }, select: { id: true, workOrderId: true, salesOrderLineId: true, size: true, quantity: true } }) : []).map((row) => [row.id, row]))
    const problems: Issue[] = []
    body.cells.forEach((cell, index) => {
      const at = `body/cells/${index}`
      if (body.kind === 'LOWER_TO_ORDER' ? cell.to >= cell.from || cell.workOrderSizeId === null : cell.to <= cell.from) problems.push({ path: at, message: body.kind === 'LOWER_TO_ORDER' ? 'A change that lowers names its cell and goes below what it makes.' : 'A change that makes more goes above what it makes.' })
      if (cell.workOrderSizeId !== null) {
        const row = held.get(cell.workOrderSizeId)
        if (!row || row.workOrderId !== workOrder?.id || row.salesOrderLineId !== cell.salesOrderLineId || row.size !== cell.size) problems.push({ path: `${at}/workOrderSizeId`, message: "Not a cell of this work order, of that line and size." })
        else if (row.quantity !== cell.from) refuseChange('CHANGED_SINCE', CHANGE_WORDS.changedSince(workOrder!.number))
      } else if (cell.from !== 0) problems.push({ path: `${at}/from`, message: 'A new cell starts from 0.' })
    })
    const extra = body.extra ?? []
    if (extra.length > 0 && body.kind !== 'LOWER_TO_ORDER') problems.push({ path: 'body/extra', message: 'Only a change that lowers leaves extra pieces.' })
    if ((extra.length > 0) !== (body.extraOutcome !== undefined && body.extraOutcome !== null)) problems.push({ path: 'body/extraOutcome', message: 'Extra pieces come with what happens to them, and only then.' })
    for (const [index, entry] of extra.entries()) {
      if (!body.cells.some((cell) => cell.workOrderSizeId === entry.workOrderSizeId && cell.salesOrderLineId === entry.salesOrderLineId && cell.size === entry.size)) problems.push({ path: `body/extra/${index}`, message: 'Extra pieces of a cell this change lowers.' })
    }
    if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
    const first = lineOf.get(body.cells[0]!.salesOrderLineId)!
    return { kind: body.kind, workOrderId: workOrder?.id ?? null, number: workOrder?.number ?? null, styleId: workOrder?.styleId ?? first.styleId, siteId: workOrder?.siteId ?? first.siteId, cells: body.cells, extra }
  })
}

/** orders.manage: POST /production/work-order-changes (see the file's head). */
export async function proposeChange(caller: CommandCaller, body: ProposeBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const order = await officeOrder(caller, body.salesOrderId, ORDERS_MANAGE)
  const planned = await checkedChange(caller, context, body, order)
  const { result } = await command(caller, { name: 'workorders.proposeChange', idempotencyKey, input: body }, async (tools) => {
    const [made] = await proposeInCommand(tools, context, { order, requestId: body.requestId ?? null, amendmentId: body.amendmentId ?? null, reason: body.reason.trim(), extraOutcome: body.extraOutcome ?? null, changes: [planned] })
    return { changeId: made!.id }
  })
  return caller.withClient(async (db) => {
    const row = await db.workOrderChange.findUniqueOrThrow({ where: { id: result.changeId }, select: CHANGE_COLUMNS })
    return { change: (await changeViews(db, actorOf(context), [row]))[0]! }
  })
}

