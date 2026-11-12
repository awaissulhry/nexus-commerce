import type { Prisma } from '@nexus/factory-db'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere, type Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate, businessDayStart, toUtcIso } from '@nexus/factory-domain/core/time'
import type {
  AddLineBody,
  ApproversBody,
  CancelBody,
  CreateOrderBody,
  DecideBody,
  DraftRevisionBody,
  OrderListQuery,
  OrderRequestsBody,
  OrderView,
  ReleaseOrderBody,
  UpdateLineBody,
  UpdateOrderBody,
  VersionBody,
  WorkInProgressBody,
} from '@nexus/factory-domain/product/changes/contracts'
import { PRODUCT_CHANGES_APPROVE, PRODUCT_CHANGES_MANAGE, PRODUCT_CHANGES_VIEW } from '@nexus/factory-domain/product/changes/permissions'
import {
  approvalOutcome,
  approverRefusal,
  approversRefusal,
  cancelRefusal,
  changeLineRefusal,
  decideRefusal,
  effectRefusal,
  isLiveOrder,
  linkRefusal,
  monthStart,
  ORDER_TILES,
  orderEditRefusal,
  releaseRefusal,
  selfNamedRefusal,
  submitRefusal,
  workInProgressRefusal,
  type ApprovalFacts,
  type ChangeDecision,
  type ChangeEffect,
  type ChangeRefusal,
  type OrderTile,
  type OwnWorkFacts,
} from '@nexus/factory-domain/product/changes/rules'
import { WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import { command, StaleVersionError, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { allocateNumber } from '../../../platform/numbering/allocate'
import { followInCommand } from '../../../platform/threads/followers'
import { copyRevision, releaseRevision } from '../bom/revisions'
import { numberIfNeeded } from './requests'
import {
  assertMay,
  ChangeRefusedError,
  databaseRefusal,
  dayOf,
  madeOf,
  may,
  NOTHING_MADE,
  officeOf,
  ORDER_COLUMNS,
  orderRowsOf,
  personMay,
  readOrderFor,
  refuse,
  REQUEST_COLUMNS,
  requestRowsOf,
  type OrderData,
} from './store'

/**
 * Change orders (B-W2b-226; PRD-170, PRD-175, MES-006; design products.changes record tabs Change, Impact, Approvals,
 * Affected records; "Approve change" A / R). The rules are factory-domain product/changes/rules; the database repeats them.
 *
 *   GET   /product/change-orders                              product.changes.view: the list with its tiles (mine to approve,
 *                                                             approved to release, released this month, open, all)
 *   GET   /product/change-orders/:id                          the record: requests, lines, work in progress, approvals, the
 *                                                             open work orders without a line, the redline's compare, actions
 *   POST  /product/change-orders                              product.changes.manage: a DRAFT from the style's RELEASED
 *                                                             revision, numbered ECO-…, with the requests it carries
 *   PATCH /product/change-orders/:id                          what, why, description, effect, the proposed DRAFT revision
 *                                                             (while DRAFT); the priority until it is decided
 *   PUT   /product/change-orders/:id/requests                 the requests it carries (an open one goes into review)
 *   POST  /product/change-orders/:id/lines                    a CHANGE line (a record before → after); PATCH / DELETE one
 *   PUT   /product/change-orders/:id/work-in-progress         every open work order's line and disposition (MES-006)
 *   PUT   /product/change-orders/:id/approvers                who decides (never its author; nobody names themselves),
 *                                                             required or not
 *   POST  /product/change-orders/:id/draft-revision           W1's copy of the released revision into the next DRAFT, named
 *                                                             its proposed revision (the edit rule lets it through for it)
 *   POST  /product/change-orders/:id/submit                   SUBMITTED: what it says is fixed; its approvers are told
 *   POST  /product/change-orders/:id/decide                   product.changes.approve: the caller's own decision (four eyes:
 *                                                             not on an approval they named themselves to, nor on a change
 *                                                             order carrying a request they raised);
 *                                                             every required approval → APPROVED (its requests ACCEPTED);
 *                                                             one rejection → REJECTED
 *   POST  /product/change-orders/:id/cancel                   CANCELLED with why (its draft revision stays a draft)
 *   POST  /product/change-orders/:id/release                  W1's release of the proposed revision: the old one OBSOLETE,
 *                                                             the order RELEASED, its requests DONE, in one command
 *
 * Each write is ONE command on the change order at the version the caller read (its version moves with every write).
 */

const LIST_LIMIT = 100
const OPEN_WORK = ['DRAFT', 'RELEASED', 'IN_PROGRESS', 'ON_HOLD'] as const

const actorIdOf = (tools: CommandTools): string => {
  if (tools.context.audience !== 'office') throw new ValidationError('A change order is written by a person.')
  return tools.context.actorId
}

const orderEvent = (tools: CommandTools, order: Pick<OrderData, 'id' | 'number' | 'styleId' | 'companyId'>, status: OrderData['status'], change: string, approverIds: readonly string[] = []) =>
  tools.emit({ type: 'change_order.changed', subject: order.id, companyId: order.companyId, payload: { changeOrderId: order.id, number: order.number, styleId: order.styleId, status, change, approverIds: [...approverIds] } })

function badBody(path: string, message: string): never {
  throw new ValidationError(message, [{ path: `body/${path}`, message }])
}

/** A database unique key broken by a race: the proposed revision is another live order's. */
function takenRevision(error: unknown): never {
  if (typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002') {
    throw new ChangeRefusedError({ code: 'DRAFT_EXISTS', message: 'This draft revision is already proposed by another change order still going: one change order per draft.' })
  }
  throw error
}

// ---- requests carried ----------------------------------------------------------------------------------------------------

/** Puts requests into the change order (an open one goes into review, numbered if it came from the floor), in a command. */
async function linkRequests(tools: CommandTools, order: Pick<OrderData, 'id' | 'number' | 'styleId' | 'companyId'>, requestIds: readonly string[]): Promise<void> {
  const { tx } = tools
  for (const requestId of requestIds) {
    const row = await tx.changeRequest.findUnique({ where: { id: requestId }, select: REQUEST_COLUMNS })
    if (!row || row.companyId !== order.companyId) badBody('requestIds', 'No such change request in this company.')
    const carrier = row!.changeOrderId && row!.changeOrderId !== order.id ? await tx.changeOrder.findUnique({ where: { id: row!.changeOrderId }, select: { number: true, status: true } }) : null
    refuse(linkRefusal({ number: row!.number, status: row!.status, sameStyle: row!.styleId === order.styleId, carriedBy: carrier && isLiveOrder(carrier.status) ? carrier.number : null }, order.number))
    if (row!.changeOrderId === order.id) continue
    const number = await numberIfNeeded(tools, row!)
    const status = row!.status === 'OPEN' ? 'IN_REVIEW' : row!.status
    await tx.changeRequest.update({ where: { id: row!.id }, data: { number, status, changeOrderId: order.id, version: { increment: 1 }, updatedAt: tools.now }, select: { id: true } })
    tools.audit({ action: 'product.changes.linkRequest', recordType: 'ChangeRequest', recordId: row!.id, companyId: row!.companyId, siteId: row!.siteId, before: { status: row!.status, changeOrderId: row!.changeOrderId, number: row!.number }, after: { status, changeOrderId: order.id, number } })
    tools.emit({ type: 'change_request.changed', subject: row!.id, companyId: row!.companyId, siteId: row!.siteId, payload: { changeRequestId: row!.id, number, styleId: row!.styleId, status, changeOrderId: order.id, change: 'LINKED' } })
  }
}

// ---- create and change -----------------------------------------------------------------------------------------------------

/** POST /product/change-orders */
export async function createOrder(caller: CommandCaller, body: CreateOrderBody, idempotencyKey?: string): Promise<OrderView> {
  const context = officeOf(caller)
  const style = await caller.withClient((db) => db.style.findUnique({ where: { id: body.styleId }, select: { id: true, code: true, companyId: true } }))
  if (!style || (style.companyId !== null && !may(context, PRODUCT_CHANGES_VIEW, style.companyId))) throw new NotFoundError('Style not found.')
  const companyId = style.companyId ?? body.companyId ?? context.companyId ?? null
  if (companyId === null) badBody('companyId', `Style ${style.code} is every company's: say which company the change order is for.`)
  if (style.companyId !== null && body.companyId !== undefined && body.companyId !== style.companyId) badBody('companyId', 'The change order is for the style’s company.')
  assertMay(context, PRODUCT_CHANGES_MANAGE, companyId!)
  refuse(effectRefusal(body.effect ?? 'NEXT_ORDER', body.effectiveDate ?? null))
  const id = newId()
  await command(caller, { name: 'product.changes.createOrder', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const authorId = actorIdOf(tools)
    const released = await tx.styleRevision.findFirst({ where: { styleId: style.id, status: 'RELEASED' }, select: { id: true, revision: true } })
    if (!released) refuse({ code: 'NO_RELEASED_REVISION', message: `Style ${style.code} has no released revision: a change order changes a released one. Release the first revision directly.` })
    const { formatted: number } = await allocateNumber(tools, { companyId: companyId!, kind: 'CHANGE_ORDER' }, { type: 'ChangeOrder', id })
    const data = {
      id,
      number,
      companyId: companyId!,
      styleId: style.id,
      fromRevisionId: released!.id,
      title: body.title,
      reason: body.reason,
      description: body.description ?? null,
      priority: body.priority ?? 'NORMAL',
      effect: body.effect ?? 'NEXT_ORDER',
      effectiveDate: body.effectiveDate ? businessDayStart(body.effectiveDate, 'UTC') : null,
      authorId,
      createdAt: now,
      updatedAt: now,
      createdById: authorId,
    }
    await tx.changeOrder.create({ data, select: { id: true } })
    tools.audit({ action: 'product.changes.createOrder', recordType: 'ChangeOrder', recordId: id, companyId: companyId!, after: { ...data, fromRevision: released!.revision, effectiveDate: body.effectiveDate ?? null, createdAt: toUtcIso(now), updatedAt: undefined } })
    await followInCommand(tools, { type: 'ChangeOrder', id, companyId: companyId!, siteId: null }, authorId, 'CREATOR', authorId)
    const order = { id, number, styleId: style.id, companyId: companyId! }
    await linkRequests(tools, order, [...new Set(body.requestIds ?? [])])
    orderEvent(tools, order, 'DRAFT', 'CREATED')
    return { id }
  }).catch(databaseRefusal)
  return readOrder(caller, id)
}

/** PATCH /product/change-orders/:id */
export async function updateOrder(caller: CommandCaller, changeOrderId: string, body: UpdateOrderBody, idempotencyKey?: string): Promise<OrderView> {
  const { row: seen } = await readOrderFor(caller, changeOrderId, PRODUCT_CHANGES_MANAGE)
  const { version, ...changes } = body
  const fields = Object.keys(changes).filter((key) => changes[key as keyof typeof changes] !== undefined)
  if (fields.length === 0) badBody('version', 'Say what changes.')
  if (fields.some((field) => field !== 'priority')) refuse(orderEditRefusal(seen))
  else if (!isLiveOrder(seen.status)) refuse(orderEditRefusal(seen))
  await command(caller, { name: 'product.changes.updateOrder', idempotencyKey, input: { changeOrderId, ...body }, record: { type: 'ChangeOrder', id: changeOrderId, expectedVersion: version } }, async (tools) => {
    const { tx } = tools
    const order = await tx.changeOrder.findUniqueOrThrow({ where: { id: changeOrderId }, select: ORDER_COLUMNS })
    if (fields.some((field) => field !== 'priority')) refuse(orderEditRefusal(order))
    // The effect and its day as they will be: a day named, else the one kept while the effect stays DATE.
    const effect = (changes.effect ?? order.effect) as ChangeEffect
    const effectiveDate = changes.effectiveDate !== undefined ? changes.effectiveDate : effect === 'DATE' ? dayOf(order.effectiveDate) : null
    if (changes.effect !== undefined || changes.effectiveDate !== undefined) refuse(effectRefusal(effect, effectiveDate))
    if (changes.toRevisionId) {
      const revision = await tx.styleRevision.findUnique({ where: { id: changes.toRevisionId }, select: { styleId: true, revision: true, status: true } })
      const from = await tx.styleRevision.findUniqueOrThrow({ where: { id: order.fromRevisionId }, select: { revision: true } })
      if (!revision || revision.styleId !== order.styleId) badBody('toRevisionId', 'No such revision of this style.')
      if (revision!.status !== 'DRAFT' || revision!.revision <= from.revision) refuse({ code: 'REVISION_NOT_DRAFT', message: `Revision ${revision!.revision} is not a draft after revision ${from.revision}: ${order.number} proposes the style's next draft revision.` })
    }
    const data = {
      ...(changes.title !== undefined ? { title: changes.title } : {}),
      ...(changes.reason !== undefined ? { reason: changes.reason } : {}),
      ...(changes.description !== undefined ? { description: changes.description } : {}),
      ...(changes.priority !== undefined ? { priority: changes.priority } : {}),
      ...(changes.effect !== undefined || changes.effectiveDate !== undefined ? { effect, effectiveDate: effectiveDate ? businessDayStart(effectiveDate, 'UTC') : null } : {}),
      ...(changes.toRevisionId !== undefined ? { toRevisionId: changes.toRevisionId } : {}),
    }
    await tx.changeOrder.update({ where: { id: changeOrderId }, data, select: { id: true } }).catch(takenRevision)
    const before = Object.fromEntries(Object.keys(data).map((key) => [key, key === 'effectiveDate' ? dayOf(order.effectiveDate) : order[key as keyof OrderData]]))
    tools.audit({ action: 'product.changes.updateOrder', recordType: 'ChangeOrder', recordId: changeOrderId, companyId: order.companyId, before, after: { ...data, ...('effectiveDate' in data ? { effectiveDate } : {}) } })
    orderEvent(tools, order, order.status, changes.toRevisionId !== undefined ? 'REVISION_LINKED' : 'UPDATED')
    return null
  }).catch(databaseRefusal)
  return readOrder(caller, changeOrderId)
}

/** PUT /product/change-orders/:id/requests: the requests it carries (those left out are taken out). */
export async function setOrderRequests(caller: CommandCaller, changeOrderId: string, body: OrderRequestsBody, idempotencyKey?: string): Promise<OrderView> {
  const { row: seen } = await readOrderFor(caller, changeOrderId, PRODUCT_CHANGES_MANAGE)
  refuse(orderEditRefusal(seen))
  await command(caller, { name: 'product.changes.setOrderRequests', idempotencyKey, input: { changeOrderId, ...body }, record: { type: 'ChangeOrder', id: changeOrderId, expectedVersion: body.version } }, async (tools) => {
    const { tx } = tools
    const order = await tx.changeOrder.findUniqueOrThrow({ where: { id: changeOrderId }, select: ORDER_COLUMNS })
    refuse(orderEditRefusal(order))
    const wanted = new Set(body.requestIds)
    const carried = await tx.changeRequest.findMany({ where: { changeOrderId }, select: REQUEST_COLUMNS })
    for (const row of carried.filter((request) => !wanted.has(request.id))) {
      await tx.changeRequest.update({ where: { id: row.id }, data: { changeOrderId: null, version: { increment: 1 }, updatedAt: tools.now }, select: { id: true } })
      tools.audit({ action: 'product.changes.unlinkRequest', recordType: 'ChangeRequest', recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: { changeOrderId }, after: { changeOrderId: null } })
      tools.emit({ type: 'change_request.changed', subject: row.id, companyId: row.companyId, siteId: row.siteId, payload: { changeRequestId: row.id, number: row.number!, styleId: row.styleId, status: row.status, changeOrderId: null, change: 'UNLINKED' } })
    }
    await linkRequests(tools, order, [...wanted])
    tools.audit({ action: 'product.changes.setOrderRequests', recordType: 'ChangeOrder', recordId: changeOrderId, companyId: order.companyId, before: { requestIds: carried.map((row) => row.id) }, after: { requestIds: [...wanted] } })
    orderEvent(tools, order, order.status, 'REQUESTS_CHANGED')
    return null
  }).catch(databaseRefusal)
  return readOrder(caller, changeOrderId)
}

// ---- lines ---------------------------------------------------------------------------------------------------------------

const nextSeq = async (tx: CommandTx, changeOrderId: string): Promise<number> => ((await tx.changeOrderItem.aggregate({ where: { changeOrderId }, _max: { seq: true } }))._max.seq ?? 0) + 1

/** A JSON value as stored (a JSON column is left out to stay NULL: factory-db exports no runtime DbNull). */
const jsonOf = (value: unknown): Prisma.InputJsonValue | undefined => (value === null || value === undefined ? undefined : (value as Prisma.InputJsonValue))

/** Runs a write to the change order's lines: DRAFT only, at its version. */
async function onDraft(caller: CommandCaller, changeOrderId: string, version: number, name: Permission, input: unknown, idempotencyKey: string | undefined, work: (tools: CommandTools, order: OrderData) => Promise<void>): Promise<OrderView> {
  const { row: seen } = await readOrderFor(caller, changeOrderId, PRODUCT_CHANGES_MANAGE)
  refuse(orderEditRefusal(seen))
  await command(caller, { name, idempotencyKey, input, record: { type: 'ChangeOrder', id: changeOrderId, expectedVersion: version } }, async (tools) => {
    const order = await tools.tx.changeOrder.findUniqueOrThrow({ where: { id: changeOrderId }, select: ORDER_COLUMNS })
    refuse(orderEditRefusal(order))
    await work(tools, order)
    orderEvent(tools, order, order.status, 'LINES_CHANGED')
    return null
  }).catch(databaseRefusal)
  return readOrder(caller, changeOrderId)
}

/** POST /product/change-orders/:id/lines: a CHANGE line. */
export function addLine(caller: CommandCaller, changeOrderId: string, body: AddLineBody, idempotencyKey?: string): Promise<OrderView> {
  refuse(changeLineRefusal({ recordType: body.recordType, field: body.field ?? null, before: body.before, after: body.after }))
  return onDraft(caller, changeOrderId, body.version, 'product.changes.addLine', { changeOrderId, ...body }, idempotencyKey, async (tools, order) => {
    const id = newId()
    const seq = await nextSeq(tools.tx, changeOrderId)
    const before = jsonOf(body.before)
    const after = jsonOf(body.after)
    await tools.tx.changeOrderItem.create({
      data: { id, changeOrderId, seq, kind: 'CHANGE', recordType: body.recordType, recordId: body.recordId, field: body.field ?? null, ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}), note: body.note ?? null, createdAt: tools.now, updatedAt: tools.now, createdById: actorIdOf(tools) },
      select: { id: true },
    })
    tools.audit({ action: 'product.changes.addLine', recordType: 'ChangeOrderItem', recordId: id, companyId: order.companyId, after: { changeOrderId, seq, kind: 'CHANGE', recordType: body.recordType, recordId: body.recordId, field: body.field ?? null, before: body.before ?? null, after: body.after ?? null, note: body.note ?? null } })
  })
}

/** PATCH /product/change-orders/:id/lines/:lineId */
export function updateLine(caller: CommandCaller, changeOrderId: string, lineId: string, body: UpdateLineBody, idempotencyKey?: string): Promise<OrderView> {
  return onDraft(caller, changeOrderId, body.version, 'product.changes.updateLine', { changeOrderId, lineId, ...body }, idempotencyKey, async (tools, order) => {
    const { tx } = tools
    const line = isUuid(lineId) ? await tx.changeOrderItem.findFirst({ where: { id: lineId, changeOrderId, kind: 'CHANGE' }, select: { id: true, recordType: true, field: true, before: true, after: true, note: true } }) : null
    if (!line) throw new NotFoundError('Line not found.')
    const next = {
      field: body.field === undefined ? line.field : body.field,
      before: body.before === undefined ? line.before : body.before,
      after: body.after === undefined ? line.after : body.after,
      note: body.note === undefined ? line.note : body.note,
    }
    refuse(changeLineRefusal({ recordType: line.recordType!, field: next.field, before: next.before, after: next.after }))
    const before = jsonOf(next.before)
    const after = jsonOf(next.after)
    await tx.changeOrderItem.update({ where: { id: line.id }, data: { field: next.field, note: next.note, ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}), version: { increment: 1 } }, select: { id: true } })
    // A value cleared: SQL NULL (no runtime DbNull in factory-db).
    if (before === undefined) await tx.$executeRaw`UPDATE "ChangeOrderItem" SET "before" = NULL WHERE "id" = ${line.id}::uuid AND "before" IS NOT NULL`
    if (after === undefined) await tx.$executeRaw`UPDATE "ChangeOrderItem" SET "after" = NULL WHERE "id" = ${line.id}::uuid AND "after" IS NOT NULL`
    tools.audit({ action: 'product.changes.updateLine', recordType: 'ChangeOrderItem', recordId: line.id, companyId: order.companyId, before: { field: line.field, before: line.before, after: line.after, note: line.note }, after: next })
  })
}

/** DELETE /product/change-orders/:id/lines/:lineId?version= */
export function removeLine(caller: CommandCaller, changeOrderId: string, lineId: string, version: number, idempotencyKey?: string): Promise<OrderView> {
  return onDraft(caller, changeOrderId, version, 'product.changes.removeLine', { changeOrderId, lineId, version }, idempotencyKey, async (tools, order) => {
    const line = isUuid(lineId) ? await tools.tx.changeOrderItem.findFirst({ where: { id: lineId, changeOrderId, kind: 'CHANGE' }, select: { id: true, seq: true, recordType: true, recordId: true, field: true } }) : null
    if (!line) throw new NotFoundError('Line not found.')
    await tools.tx.changeOrderItem.delete({ where: { id: line.id }, select: { id: true } })
    tools.audit({ action: 'product.changes.removeLine', recordType: 'ChangeOrderItem', recordId: line.id, companyId: order.companyId, before: line })
  })
}

/** PUT /product/change-orders/:id/work-in-progress: every open work order's line, replaced at once (MES-006). */
export function setWorkInProgress(caller: CommandCaller, changeOrderId: string, body: WorkInProgressBody, idempotencyKey?: string): Promise<OrderView> {
  const ids = body.lines.map((line) => line.workOrderId)
  if (new Set(ids).size !== ids.length) badBody('lines', 'A work order is named once.')
  return onDraft(caller, changeOrderId, body.version, 'product.changes.setWorkInProgress', { changeOrderId, ...body }, idempotencyKey, async (tools, order) => {
    const { tx, now } = tools
    const workOrders = await tx.workOrder.findMany({ where: { id: { in: ids } }, select: { id: true, number: true, status: true, styleId: true, siteId: true, companyId: true } })
    const byId = new Map(workOrders.map((row) => [row.id, row]))
    for (const line of body.lines) {
      const workOrder = byId.get(line.workOrderId)
      if (!workOrder) badBody('lines', 'No such work order.')
      refuse(workInProgressRefusal({ number: workOrder!.number, status: workOrder!.status, sameStyle: workOrder!.styleId === order.styleId }))
    }
    const old = await tx.changeOrderItem.findMany({ where: { changeOrderId, kind: 'WORK_IN_PROGRESS' }, select: { id: true, workOrderId: true, disposition: true, note: true } })
    if (old.length > 0) await tx.changeOrderItem.deleteMany({ where: { changeOrderId, kind: 'WORK_IN_PROGRESS' } })
    let seq = await nextSeq(tx, changeOrderId)
    const createdById = actorIdOf(tools)
    if (body.lines.length > 0) {
      await tx.changeOrderItem.createMany({
        data: body.lines.map((line) => ({ id: newId(), changeOrderId, seq: seq++, kind: 'WORK_IN_PROGRESS' as const, siteId: byId.get(line.workOrderId)!.siteId, workOrderId: line.workOrderId, disposition: line.disposition, note: line.note ?? null, createdAt: now, updatedAt: now, createdById })),
      })
    }
    tools.audit({ action: 'product.changes.setWorkInProgress', recordType: 'ChangeOrder', recordId: changeOrderId, companyId: order.companyId, before: { lines: old }, after: { lines: body.lines } })
  })
}

// ---- approvers and the move to approval -------------------------------------------------------------------------------------

const approvalFactsOf = (rows: readonly { approverId: string; required: boolean; decision: string | null }[]): ApprovalFacts[] =>
  rows.map((row) => ({ approverId: row.approverId, required: row.required, decision: row.decision as ChangeDecision | null }))

/** What makes a decision the decider's own work: who named them its approver, who raised each request it carries. */
const ownWorkOf = (mine: { readonly createdById: string | null } | null, carried: readonly { readonly number: string | null; readonly createdById: string | null }[]): OwnWorkFacts => ({
  namedById: mine?.createdById ?? null,
  carried: carried.map((request) => ({ number: request.number, raisedById: request.createdById })),
})
const carriedOf = (db: Pick<CommandTx, 'changeRequest'>, changeOrderId: string) => db.changeRequest.findMany({ where: { changeOrderId }, select: { number: true, createdById: true } })

/** After a decision or a change of approvers of a SUBMITTED order: APPROVED (its requests accepted) or REJECTED when settled. */
async function settle(tools: CommandTools, order: OrderData, deciderId: string): Promise<'APPROVED' | 'REJECTED' | null> {
  const { tx, now } = tools
  const approvals = await tx.changeApproval.findMany({ where: { changeOrderId: order.id }, select: { approverId: true, required: true, decision: true } })
  const outcome = approvalOutcome(approvalFactsOf(approvals))
  if (outcome === 'WAITING') return null
  await tx.changeOrder.update({ where: { id: order.id }, data: { status: outcome, decidedAt: now }, select: { id: true } })
  tools.audit({ action: outcome === 'APPROVED' ? 'product.changes.approved' : 'product.changes.rejected', recordType: 'ChangeOrder', recordId: order.id, companyId: order.companyId, before: { status: 'SUBMITTED' }, after: { status: outcome, decidedAt: toUtcIso(now) } })
  if (outcome === 'APPROVED') {
    // Approving the change order decides the requests it carries: accepted by the approver who completed the approval.
    const waiting = await tx.changeRequest.findMany({ where: { changeOrderId: order.id, status: { in: ['OPEN', 'IN_REVIEW'] } }, select: REQUEST_COLUMNS })
    for (const row of waiting) {
      const number = await numberIfNeeded(tools, row)
      await tx.changeRequest.update({ where: { id: row.id }, data: { number, status: 'ACCEPTED', decidedAt: now, decidedById: deciderId, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
      tools.audit({ action: 'product.changes.acceptRequest', recordType: 'ChangeRequest', recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: { status: row.status }, after: { status: 'ACCEPTED', decidedAt: toUtcIso(now), decidedById: deciderId, changeOrder: order.number } })
      tools.emit({ type: 'change_request.changed', subject: row.id, companyId: row.companyId, siteId: row.siteId, payload: { changeRequestId: row.id, number, styleId: row.styleId, status: 'ACCEPTED', changeOrderId: order.id, change: 'ACCEPTED' } })
    }
  }
  return outcome
}

/** PUT /product/change-orders/:id/approvers */
export async function setApprovers(caller: CommandCaller, changeOrderId: string, body: ApproversBody, idempotencyKey?: string): Promise<OrderView> {
  const { context, row: seen } = await readOrderFor(caller, changeOrderId, PRODUCT_CHANGES_MANAGE)
  refuse(approversRefusal(seen))
  const ids = body.approvers.map((approver) => approver.userId)
  if (new Set(ids).size !== ids.length) badBody('approvers', 'Each approver is named once.')
  for (const approver of body.approvers) refuse(approverRefusal(seen, approver.userId))
  await command(caller, { name: 'product.changes.setApprovers', idempotencyKey, input: { changeOrderId, ...body }, record: { type: 'ChangeOrder', id: changeOrderId, expectedVersion: body.version } }, async (tools) => {
    const { tx, now } = tools
    const order = await tx.changeOrder.findUniqueOrThrow({ where: { id: changeOrderId }, select: ORDER_COLUMNS })
    refuse(approversRefusal(order))
    const current = await tx.changeApproval.findMany({ where: { changeOrderId }, select: { id: true, approverId: true, required: true, decision: true } })
    const wanted = new Map(body.approvers.map((approver) => [approver.userId, approver.required ?? true]))
    for (const userId of wanted.keys()) {
      if (current.some((approval) => approval.approverId === userId)) continue
      refuse(selfNamedRefusal(order, actorIdOf(tools), userId))
      const user = await tx.user.findFirst({ where: { id: userId, status: 'ACTIVE' }, select: { id: true, displayName: true } })
      if (!user || !(await personMay(tx, context.tenantId, userId, PRODUCT_CHANGES_APPROVE, order.companyId, now))) {
        refuse({ code: 'APPROVER_CANNOT', message: `${user?.displayName ?? 'This person'} cannot approve change orders of this company: name someone who holds the approval of changes (product.changes.approve).` })
      }
    }
    const removed = current.filter((approval) => approval.decision === null && !wanted.has(approval.approverId))
    if (removed.length > 0) await tx.changeApproval.deleteMany({ where: { id: { in: removed.map((approval) => approval.id) } } })
    for (const approval of current.filter((each) => each.decision === null && wanted.has(each.approverId) && wanted.get(each.approverId) !== each.required)) {
      await tx.changeApproval.update({ where: { id: approval.id }, data: { required: wanted.get(approval.approverId)!, version: { increment: 1 } }, select: { id: true } })
    }
    const added = [...wanted.entries()].filter(([userId]) => !current.some((approval) => approval.approverId === userId))
    for (const [userId, required] of added) {
      await tx.changeApproval.create({ data: { id: newId(), changeOrderId, approverId: userId, required, createdAt: now, updatedAt: now, createdById: actorIdOf(tools) }, select: { id: true } })
      await followInCommand(tools, { type: 'ChangeOrder', id: changeOrderId, companyId: order.companyId, siteId: null }, userId, 'ASSIGNEE', actorIdOf(tools))
    }
    const after = await tx.changeApproval.findMany({ where: { changeOrderId }, select: { approverId: true, required: true, decision: true } })
    if (order.status === 'SUBMITTED' && !after.some((approval) => approval.required)) {
      refuse({ code: 'NO_APPROVER', message: `Change order ${order.number} waits for approval: keep at least one required approver.` })
    }
    tools.audit({ action: 'product.changes.setApprovers', recordType: 'ChangeOrder', recordId: changeOrderId, companyId: order.companyId, before: { approvers: current.map(({ approverId, required, decision }) => ({ approverId, required, decision })) }, after: { approvers: after } })
    orderEvent(tools, order, order.status, 'APPROVERS_CHANGED', order.status === 'SUBMITTED' ? added.map(([userId]) => userId) : [])
    if (order.status === 'SUBMITTED') {
      const outcome = await settle(tools, order, actorIdOf(tools))
      if (outcome) orderEvent(tools, order, outcome, outcome)
    }
    return null
  }).catch(databaseRefusal)
  return readOrder(caller, changeOrderId)
}

/** POST /product/change-orders/:id/draft-revision: W1's copy of the released revision, proposed by this change order. */
export async function startDraftRevision(caller: CommandCaller, changeOrderId: string, body: DraftRevisionBody, idempotencyKey?: string): Promise<OrderView> {
  const { row } = await readOrderFor(caller, changeOrderId, PRODUCT_CHANGES_MANAGE)
  refuse(startDraftRefusal(row, await caller.withClient((db) => db.styleRevision.findFirst({ where: { styleId: row.styleId, status: 'DRAFT' }, select: { revision: true } }))))
  if (row.version !== body.version) throw new StaleVersionError('ChangeOrder', row.id, row.version, body.version)
  await copyRevision(caller, row.styleId, row.fromRevisionId, { changeNote: body.changeNote ?? `${row.number}: ${row.title}`.slice(0, 2000) }, idempotencyKey, { id: row.id, number: row.number, version: row.version }).catch(databaseRefusal)
  return readOrder(caller, changeOrderId)
}

function startDraftRefusal(order: OrderData, draft: { revision: number } | null): ChangeRefusal | null {
  const notDraft = orderEditRefusal(order)
  if (notDraft) return notDraft
  if (order.toRevisionId !== null) return { code: 'DRAFT_EXISTS', message: `Change order ${order.number} already proposes its draft revision: make the change there.` }
  if (draft) return { code: 'DRAFT_EXISTS', message: `Revision ${draft.revision} is already a draft of this style: name it as the proposed revision of ${order.number}, or abandon it first.` }
  return null
}

/** POST /product/change-orders/:id/submit */
export async function submitOrder(caller: CommandCaller, changeOrderId: string, body: VersionBody, idempotencyKey?: string): Promise<OrderView> {
  await readOrderFor(caller, changeOrderId, PRODUCT_CHANGES_MANAGE)
  await command(caller, { name: 'product.changes.submit', idempotencyKey, input: { changeOrderId, ...body }, record: { type: 'ChangeOrder', id: changeOrderId, expectedVersion: body.version } }, async (tools) => {
    const { tx, now } = tools
    const order = await tx.changeOrder.findUniqueOrThrow({ where: { id: changeOrderId }, select: ORDER_COLUMNS })
    const toRevision = order.toRevisionId ? await tx.styleRevision.findUnique({ where: { id: order.toRevisionId }, select: { revision: true, status: true } }) : null
    const approvals = await tx.changeApproval.findMany({ where: { changeOrderId }, select: { approverId: true, required: true, decision: true } })
    refuse(submitRefusal(order, toRevision, approvalFactsOf(approvals)))
    await tx.changeOrder.update({ where: { id: changeOrderId }, data: { status: 'SUBMITTED', submittedAt: now }, select: { id: true } })
    tools.audit({ action: 'product.changes.submit', recordType: 'ChangeOrder', recordId: changeOrderId, companyId: order.companyId, before: { status: 'DRAFT' }, after: { status: 'SUBMITTED', submittedAt: toUtcIso(now), toRevision: toRevision!.revision } })
    orderEvent(tools, order, 'SUBMITTED', 'SUBMITTED', approvals.filter((approval) => approval.decision === null).map((approval) => approval.approverId))
    return null
  }).catch(databaseRefusal)
  return readOrder(caller, changeOrderId)
}

/** POST /product/change-orders/:id/decide: the caller's own decision (four eyes). */
export async function decideOrder(caller: CommandCaller, changeOrderId: string, body: DecideBody, idempotencyKey?: string): Promise<OrderView> {
  const { context, row: seen } = await readOrderFor(caller, changeOrderId, PRODUCT_CHANGES_APPROVE)
  const { mine, carried } = await caller.withClient(async (db) => ({
    mine: await db.changeApproval.findFirst({ where: { changeOrderId, approverId: context.actorId }, select: { approverId: true, required: true, decision: true, createdById: true } }),
    carried: await carriedOf(db, changeOrderId),
  }))
  refuse(decideRefusal(seen, mine ? approvalFactsOf([mine])[0]! : null, context.actorId, body.decision, body.reason ?? null, ownWorkOf(mine, carried)))
  await command(caller, { name: 'product.changes.decide', idempotencyKey, input: { changeOrderId, ...body }, record: { type: 'ChangeOrder', id: changeOrderId, expectedVersion: body.version } }, async (tools) => {
    const { tx, now } = tools
    const order = await tx.changeOrder.findUniqueOrThrow({ where: { id: changeOrderId }, select: ORDER_COLUMNS })
    const approval = await tx.changeApproval.findFirst({ where: { changeOrderId, approverId: context.actorId }, select: { id: true, approverId: true, required: true, decision: true, createdById: true } })
    refuse(decideRefusal(order, approval ? approvalFactsOf([approval])[0]! : null, context.actorId, body.decision, body.reason ?? null, ownWorkOf(approval, await carriedOf(tx, changeOrderId))))
    await tx.changeApproval.update({ where: { id: approval!.id }, data: { decision: body.decision, decidedAt: now, reason: body.reason ?? null, version: { increment: 1 } }, select: { id: true } })
    tools.audit({ action: 'product.changes.decideApproval', recordType: 'ChangeApproval', recordId: approval!.id, companyId: order.companyId, before: { decision: null }, after: { decision: body.decision, decidedAt: toUtcIso(now), changeOrderId }, ...(body.reason ? { reason: body.reason } : {}) })
    const outcome = await settle(tools, order, context.actorId)
    orderEvent(tools, order, outcome ?? 'SUBMITTED', outcome ?? 'APPROVAL_DECIDED')
    return null
  }).catch(databaseRefusal)
  return readOrder(caller, changeOrderId)
}

/** POST /product/change-orders/:id/cancel */
export async function cancelOrder(caller: CommandCaller, changeOrderId: string, body: CancelBody, idempotencyKey?: string): Promise<OrderView> {
  const { row: seen } = await readOrderFor(caller, changeOrderId, PRODUCT_CHANGES_MANAGE)
  refuse(cancelRefusal(seen, body.reason))
  await command(caller, { name: 'product.changes.cancel', idempotencyKey, input: { changeOrderId, ...body }, record: { type: 'ChangeOrder', id: changeOrderId, expectedVersion: body.version } }, async (tools) => {
    const { tx, now } = tools
    const order = await tx.changeOrder.findUniqueOrThrow({ where: { id: changeOrderId }, select: ORDER_COLUMNS })
    refuse(cancelRefusal(order, body.reason))
    await tx.changeOrder.update({ where: { id: changeOrderId }, data: { status: 'CANCELLED', cancelledAt: now, cancelReason: body.reason }, select: { id: true } })
    tools.audit({ action: 'product.changes.cancel', recordType: 'ChangeOrder', recordId: changeOrderId, companyId: order.companyId, before: { status: order.status }, after: { status: 'CANCELLED', cancelledAt: toUtcIso(now) }, reason: body.reason })
    orderEvent(tools, order, 'CANCELLED', 'CANCELLED')
    return null
  }).catch(databaseRefusal)
  return readOrder(caller, changeOrderId)
}

/** POST /product/change-orders/:id/release: W1's release of the proposed revision, the change order released with it. */
export async function releaseOrder(caller: CommandCaller, changeOrderId: string, body: ReleaseOrderBody, idempotencyKey?: string): Promise<OrderView> {
  const { row } = await readOrderFor(caller, changeOrderId, PRODUCT_CHANGES_MANAGE)
  refuse(releaseRefusal({ number: row.number, status: row.status, effect: row.effect as ChangeEffect, effectiveDate: dayOf(row.effectiveDate) }, businessDate(new Date())))
  if (row.version !== body.version) throw new StaleVersionError('ChangeOrder', row.id, row.version, body.version)
  const revision = await caller.withClient((db) => db.styleRevision.findUniqueOrThrow({ where: { id: row.toRevisionId! }, select: { version: true } }))
  await releaseRevision(caller, row.styleId, row.toRevisionId!, { version: revision.version, changeNote: body.changeNote ?? `${row.number}: ${row.title}`.slice(0, 2000) }, idempotencyKey).catch(databaseRefusal)
  return readOrder(caller, changeOrderId)
}

// ---- reads ---------------------------------------------------------------------------------------------------------------

function orderWhere(context: OfficeContext, query: OrderListQuery, tile: OrderTile, today: string): Prisma.ChangeOrderWhereInput {
  const scope = scopeWhere(actorOf(context), PRODUCT_CHANGES_VIEW, { company: 'companyId' }) as Prisma.ChangeOrderWhereInput
  const byTile: Prisma.ChangeOrderWhereInput =
    tile === 'MINE_TO_APPROVE'
      ? { status: 'SUBMITTED', approvals: { some: { approverId: context.actorId, decision: null } } }
      : tile === 'TO_RELEASE'
        ? { status: 'APPROVED' }
        : tile === 'RELEASED_THIS_MONTH'
          ? { status: 'RELEASED', releasedAt: { gte: businessDayStart(monthStart(today)) } }
          : tile === 'OPEN'
            ? { status: { in: ['DRAFT', 'SUBMITTED', 'APPROVED'] } }
            : {}
  return {
    AND: [
      scope,
      byTile,
      query.status ? { status: query.status } : {},
      query.styleId ? { styleId: query.styleId } : {},
      query.companyId ? { companyId: query.companyId } : {},
      query.q ? { OR: [{ number: { contains: query.q, mode: 'insensitive' } }, { title: { contains: query.q, mode: 'insensitive' } }, { style: { code: { contains: query.q, mode: 'insensitive' } } }] } : {},
    ],
  }
}

/** GET /product/change-orders: newest first. */
export async function listOrders(caller: CommandCaller, query: OrderListQuery) {
  const context = officeOf(caller)
  const tile = query.tile ?? 'ALL'
  const limit = query.limit ?? LIST_LIMIT
  const today = businessDate(new Date())
  return caller.withClient(async (db) => {
    const found = await db.changeOrder.findMany({ where: orderWhere(context, query, tile, today), select: ORDER_COLUMNS, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1 })
    const rows = await orderRowsOf(db, found.slice(0, limit))
    const counts = Object.fromEntries(await Promise.all(ORDER_TILES.map(async (each) => [each, await db.changeOrder.count({ where: orderWhere(context, { ...query, status: undefined }, each, today) })] as const)))
    return { rows, counts: counts as Record<OrderTile, number>, complete: found.length <= limit }
  })
}

const allowed = (refusal: ChangeRefusal | null) => ({ allowed: refusal === null, refusal })
const notYours = (what: string): ChangeRefusal => ({ code: 'ORDER_MOVE', message: `Your role does not ${what}.` })

/** GET /product/change-orders/:id */
export async function readOrder(caller: CommandCaller, changeOrderId: string): Promise<OrderView> {
  const { context, row } = await readOrderFor(caller, changeOrderId)
  return caller.withClient(async (db) => {
    const [base] = await orderRowsOf(db, [row])
    const requests = await db.changeRequest.findMany({ where: { changeOrderId }, select: REQUEST_COLUMNS, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
    const items = await db.changeOrderItem.findMany({ where: { changeOrderId }, orderBy: { seq: 'asc' }, select: { id: true, seq: true, kind: true, recordType: true, recordId: true, field: true, before: true, after: true, workOrderId: true, disposition: true, note: true } })
    const approvals = await db.changeApproval.findMany({ where: { changeOrderId }, orderBy: [{ stage: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }], select: { id: true, stage: true, approverId: true, required: true, decision: true, decidedAt: true, reason: true, createdById: true } })
    const names = new Map((await db.user.findMany({ where: { id: { in: approvals.map((approval) => approval.approverId) } }, select: { id: true, displayName: true } })).map((user) => [user.id, user.displayName]))
    const wipIds = items.filter((item) => item.kind === 'WORK_IN_PROGRESS' && item.workOrderId !== null).map((item) => item.workOrderId!)
    const seesWork = can(actorOf(context), WORKORDERS_VIEW, { companyId: row.companyId })
    const workScope = scopeWhere(actorOf(context), WORKORDERS_VIEW, { company: 'companyId', site: 'siteId' }) as Prisma.WorkOrderWhereInput
    const open = seesWork
      ? await db.workOrder.findMany({ where: { AND: [workScope, { styleId: row.styleId, status: { in: [...OPEN_WORK] }, id: { notIn: wipIds } }] }, select: { id: true, number: true, status: true, siteId: true, styleRevisionId: true }, orderBy: [{ number: 'asc' }], take: 200 })
      : null
    const wipOrders = await db.workOrder.findMany({ where: { id: { in: wipIds } }, select: { id: true, number: true, status: true, siteId: true, styleRevisionId: true } })
    const revisionNumbers = new Map(
      (await db.styleRevision.findMany({ where: { id: { in: [...wipOrders, ...(open ?? [])].map((order) => order.styleRevisionId).filter((value): value is string => value !== null) } }, select: { id: true, revision: true } })).map((revision) => [revision.id, revision.revision]),
    )
    const made = await madeOf(db, wipIds)
    const workOf = (order: { id: string; number: string; status: string; siteId: string; styleRevisionId: string | null }) => ({ id: order.id, number: order.number, status: order.status, siteId: order.siteId, revision: order.styleRevisionId ? (revisionNumbers.get(order.styleRevisionId) ?? null) : null })
    const draft = await db.styleRevision.findFirst({ where: { styleId: row.styleId, status: 'DRAFT' }, select: { revision: true } })
    const toRevision = row.toRevisionId ? await db.styleRevision.findUnique({ where: { id: row.toRevisionId }, select: { revision: true, status: true } }) : null
    const facts = approvalFactsOf(approvals)
    const mine = approvals.find((approval) => approval.approverId === context.actorId) ?? null
    const manage = may(context, PRODUCT_CHANGES_MANAGE, row.companyId)
    const approve = may(context, PRODUCT_CHANGES_APPROVE, row.companyId)
    return {
      ...base!,
      reason: row.reason,
      description: row.description,
      releasedById: row.releasedById,
      cancelledAt: row.cancelledAt ? toUtcIso(row.cancelledAt) : null,
      cancelReason: row.cancelReason,
      requestsList: await requestRowsOf(db, requests),
      lines: items.filter((item) => item.kind === 'CHANGE').map((item) => ({ id: item.id, seq: item.seq, recordType: item.recordType!, recordId: item.recordId!, field: item.field, before: item.before, after: item.after, note: item.note })),
      workInProgress: items
        .filter((item) => item.kind === 'WORK_IN_PROGRESS')
        .flatMap((item) => {
          const order = wipOrders.find((each) => each.id === item.workOrderId)
          return order ? [{ id: item.id, seq: item.seq, workOrder: workOf(order), disposition: item.disposition!, note: item.note, made: made.get(order.id) ?? NOTHING_MADE }] : []
        }),
      approvalsList: approvals.map(({ createdById: _namedBy, ...approval }) => ({ ...approval, approverName: names.get(approval.approverId) ?? null, decision: approval.decision as ChangeDecision | null, decidedAt: approval.decidedAt ? toUtcIso(approval.decidedAt) : null })),
      openWorkOrders: open ? open.map(workOf) : null,
      compare: row.toRevisionId ? { styleId: row.styleId, from: row.fromRevisionId, to: row.toRevisionId } : null,
      actions: {
        edit: allowed(manage ? orderEditRefusal(row) : notYours('write change orders')),
        startDraft: allowed(manage ? startDraftRefusal(row, draft) : notYours('write change orders')),
        submit: allowed(manage ? submitRefusal(row, toRevision, facts) : notYours('write change orders')),
        decide: allowed(approve ? decideRefusal(row, mine ? approvalFactsOf([mine])[0]! : null, context.actorId, 'APPROVED', 'given', ownWorkOf(mine, requests)) : notYours('approve change orders')),
        cancel: allowed(manage ? cancelRefusal(row, 'given') : notYours('write change orders')),
        release: allowed(manage ? releaseRefusal({ number: row.number, status: row.status, effect: row.effect as ChangeEffect, effectiveDate: dayOf(row.effectiveDate) }, businessDate(new Date())) : notYours('release change orders')),
      },
    }
  })
}
