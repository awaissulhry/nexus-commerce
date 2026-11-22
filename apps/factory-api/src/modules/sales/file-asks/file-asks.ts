import type { Prisma } from '@nexus/factory-db'
import { FILES_UPLOAD, THREADS_POST } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ConflictError, ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, type Actor } from '@nexus/factory-domain/core/permissions'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { askLocaleOf, askTextProblem, chaseNoteText, checkTaskTitle, FILE_ASK_LIMITS, isFloorAddressee, uploadTaskTitle, type FileAskStatus, type FileAskTarget } from '@nexus/factory-domain/files/asks'
import { seesPrices } from '@nexus/factory-domain/files/priced'
import { markMoney } from '@nexus/factory-domain/money/marked'
import { WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import { SALES_MEASUREMENTS_VIEW } from '@nexus/factory-domain/sales/measure-link/permissions'
import { TASKS_MANAGE } from '@nexus/factory-domain/tasks/permissions'
import { cleanBody } from '@nexus/factory-domain/threads/rules'
import { command, StaleVersionError, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { readOfficeReached } from '../../../platform/files/files'
import { fileRecordScope, reachesFileRecord } from '../../../platform/files/record-scope'
import { mayOnThread } from '../../../platform/threads/records'
import { ensureThread, mentionProblems, writeMessage } from '../../../platform/threads/threads'
import { reachesWorkOrder } from '../../production/work-orders/scope'
import { officeContextOf } from '../orders/access'
import { officeOrder } from '../orders/moves'
import { readOrder, type OrderRow, type Reader } from '../orders/store'
import type { AnswerAskBody, ChangeAskBody, MakeAskBody, ReasonBody, ReassignAskBody, VersionBody } from './contract'
import { badField, refused, resolveWho, type AskOrder } from './people'
import { followAskTasks, moveAskTasks, writeAskTask } from './tasks'

/**
 * B-OF-031 (order files tab; 13-backend §2; Owner D2, D3) — "Ask for a file" on one sales order, office only:
 *
 *   POST  /sales/orders/:orderId/file-asks                  make: what (words, kind), where it lands (the order, a line, a work order and
 *                                                           maybe its step), who (§2.1, ./people.ts), due day, priced / body data
 *   PATCH /sales/orders/:orderId/file-asks/:askId           change the words or the due day (OPEN): the open Tasks follow
 *   POST  …/:askId/reassign                                 another addressee (OPEN): the open Tasks cancelled, new ones written
 *   POST  …/:askId/cancel                                   with a reason (OPEN or ARRIVED): the open Tasks cancelled
 *   POST  …/:askId/answer                                   the files sent for this ask (OPEN → ARRIVED): files of the record it lands
 *                                                           on (files.upload there), the addressees' Tasks done, the asker's "Check: …"
 *   POST  …/:askId/accept                                   ARRIVED → ACCEPTED, refused while a file is held by the virus scan
 *                                                           (FILES_HELD) or found infected (FILE_INFECTED); the check Task done
 *   POST  …/:askId/ask-again                                ARRIVED → OPEN with a reason: rounds + 1, the addressees' Tasks open again,
 *                                                           the files stay on the record, the check Task done
 *   POST  …/:askId/chase                                    "Ask for an update" (OPEN): an office addressee gets an office note in the
 *                                                           order's thread that mentions the open Tasks' people (never a priced ask's
 *                                                           words); the floor only `lastChasedAt` (the tablet says "The office asked
 *                                                           for an update"; nobody named)
 *
 * THE WALLS: every route reaches the order first (`officeOrder`: orders.view over its company and customer, else "Sales order not
 * found.", the words of an unknown id), then the ask by (order, id) — another order's ask, an ask on a work order the reader does not
 * reach, or a body-data ask without the measurements right: "File ask not found.". Rights over the order: tasks.manage (+ threads.post
 * to make one and to chase); a priced ask only with the price grain (403 "Shown to people who see prices"), a body-data one only with
 * sales.measurements.view; a work order only one of THIS order the reader reaches. The ask stores no "who sees it". Every write sends
 * the version it read (409 on a stale one), and is ONE command: the ask (factory-db FileAsk, its guard the last word), its Tasks (./
 * tasks.ts, written before the ask's statement that names them), one audit row `files.fileAsk.<act>` on the FileAsk with before →
 * after (a priced ask's words money-marked: the history shows them only with the price grain), its event file_ask.* (ids only).
 */

export const ASK_NOT_FOUND = 'File ask not found.'
const CLOSED_ORDERS: ReadonlySet<string> = new Set(['CLOSED', 'CANCELLED'])
const PRICES_WORDS = 'Shown to people who see prices.'
const MEASUREMENTS_WORDS = 'Shown to people who may see measurements.'

export const ASK_COLUMNS = {
  id: true,
  companyId: true,
  partyId: true,
  siteId: true,
  salesOrderId: true,
  target: true,
  salesOrderLineId: true,
  workOrderId: true,
  workOrderOperationId: true,
  words: true,
  fileKind: true,
  priced: true,
  bodyData: true,
  addressee: true,
  addresseeUserId: true,
  addresseeRoleId: true,
  addresseeTeamId: true,
  dueOn: true,
  status: true,
  fileIds: true,
  answeredAt: true,
  answeredById: true,
  acceptedAt: true,
  rounds: true,
  lastReason: true,
  lastChasedAt: true,
  taskIds: true,
  checkTaskId: true,
  askedById: true,
  createdAt: true,
  version: true,
} as const
export type AskRow = Prisma.FileAskGetPayload<{ select: typeof ASK_COLUMNS }>

/** A stored day as the asks say it (YYYY-MM-DD). */
export const dayOf = (value: Date): BusinessDate => value.toISOString().slice(0, 10)
const asDay = (day: BusinessDate): Date => new Date(`${day}T00:00:00.000Z`)

/** The order as the asks' Tasks and checks read it. */
export const askOrderOf = (order: Pick<OrderRow, 'id' | 'number' | 'companyId' | 'partyId'>): AskOrder => ({ id: order.id, number: order.number, companyId: order.companyId, partyId: order.partyId })
const scopeOf = (order: Pick<OrderRow, 'companyId' | 'partyId'>) => ({ companyId: order.companyId, siteId: null, partyId: order.partyId })

/** The order, reached by the office person (the brand wall's not-found first), and who they are. */
export async function reachOrder(caller: CommandCaller, orderId: string): Promise<{ context: OfficeContext; actor: Actor; order: OrderRow }> {
  const context = officeContextOf(caller)
  const order = await officeOrder(caller, orderId)
  return { context, actor: actorOf(context), order }
}

/** May keep the order's asks (tasks.manage over it); `post`: may also write on its thread (make, chase). */
export function mayKeepAsks(actor: Actor, order: Pick<OrderRow, 'companyId' | 'partyId'>, post: boolean): boolean {
  const scope = scopeOf(order)
  return can(actor, TASKS_MANAGE, scope) && (!post || mayOnThread(actor, THREADS_POST, 'SalesOrder', scope))
}
export const NOT_YOURS = 'You may not ask for files on this order.'

/** A priced ask only with the price grain; a body-data ask only with the measurements right (403 in words). */
export function assertMarks(actor: Actor, order: Pick<OrderRow, 'companyId' | 'partyId'>, ask: { readonly priced: boolean; readonly bodyData: boolean }): void {
  if (ask.priced && !seesPrices(actor)) throw new ForbiddenError(PRICES_WORDS)
  if (ask.bodyData && !can(actor, SALES_MEASUREMENTS_VIEW, { companyId: order.companyId, partyId: order.partyId })) throw new ForbiddenError(MEASUREMENTS_WORDS)
}

/** The ask of this order, as this reader may reach it (else the not-found words). */
export async function readAsk(db: Reader, actor: Actor, order: Pick<OrderRow, 'id' | 'companyId' | 'partyId'>, askId: string): Promise<AskRow> {
  const row = isUuid(askId) ? await db.fileAsk.findFirst({ where: { id: askId, salesOrderId: order.id }, select: ASK_COLUMNS }) : null
  if (!row) throw new NotFoundError(ASK_NOT_FOUND)
  if (row.workOrderId) {
    const workOrder = await db.workOrder.findUnique({ where: { id: row.workOrderId }, select: { companyId: true, siteId: true, partyId: true } })
    if (!workOrder || !reachesWorkOrder(actor, WORKORDERS_VIEW, workOrder)) throw new NotFoundError(ASK_NOT_FOUND)
  }
  if (row.bodyData && !can(actor, SALES_MEASUREMENTS_VIEW, { companyId: order.companyId, partyId: order.partyId })) throw new NotFoundError(ASK_NOT_FOUND)
  return row
}

/** Inside a command: the ask locked and read again, at the version the person read (409 on a stale one). */
export async function lockAsk(tools: Pick<CommandTools, 'tx'>, askId: string, version: number): Promise<AskRow> {
  await tools.tx.$queryRaw`SELECT id FROM "FileAsk" WHERE id = ${askId}::uuid FOR UPDATE`
  const row = await tools.tx.fileAsk.findUnique({ where: { id: askId }, select: ASK_COLUMNS })
  if (!row) throw new NotFoundError(ASK_NOT_FOUND)
  if (row.version !== version) throw new StaleVersionError('FileAsk', askId, row.version, version)
  return row
}

/** The ask as its audit row keeps it (a priced ask's words money-marked: only a reader with the price grain sees them). */
export function auditViewOf(row: Pick<AskRow, 'status' | 'target' | 'salesOrderLineId' | 'workOrderId' | 'workOrderOperationId' | 'addressee' | 'addresseeUserId' | 'addresseeRoleId' | 'addresseeTeamId' | 'words' | 'priced' | 'dueOn' | 'fileIds' | 'rounds'>) {
  return {
    status: row.status,
    target: row.target,
    lineId: row.salesOrderLineId,
    workOrderId: row.workOrderId,
    operationId: row.workOrderOperationId,
    addressee: row.addressee,
    userId: row.addresseeUserId,
    roleId: row.addresseeRoleId,
    teamId: row.addresseeTeamId,
    words: row.priced ? markMoney('price', row.words) : row.words,
    dueOn: dayOf(row.dueOn),
    fileIds: [...row.fileIds],
    rounds: row.rounds,
  }
}

/** The ids every file_ask.* event carries (no words, no file name, no person). */
export const eventIdsOf = (row: Pick<AskRow, 'id' | 'salesOrderId' | 'workOrderId' | 'partyId'>, status: FileAskStatus) => ({ askId: row.id, salesOrderId: row.salesOrderId, workOrderId: row.workOrderId, status, partyId: row.partyId })
/** Where every file_ask.* event sits: the order, its company, the work order's site. */
export const eventPlaceOf = (row: Pick<AskRow, 'salesOrderId' | 'companyId' | 'siteId'>) => ({ subject: row.salesOrderId, companyId: row.companyId, siteId: row.siteId })

/** The answer of every command: the ask as it is now, and the Tasks it wrote. */
export const answerOf = (id: string, version: number, status: FileAskStatus, tasks = 0) => ({ ask: { id, version, status }, tasks })

/** A reason in one line of 3 to 500 characters (400 by place). */
export function reasonOf(text: string, path = 'reason'): string {
  const problem = askTextProblem(text, FILE_ASK_LIMITS.reasonMin, FILE_ASK_LIMITS.reasonMax)
  if (problem) throw badField(path, problem)
  return text.trim()
}

/** A due day: today (the company's day) or later. */
function dueOf(day: BusinessDate): BusinessDate {
  if (day < businessDate(serverClock.now())) throw badField('dueOn', 'A due day is today or later.')
  return day
}

/** What is needed: one line of 1 to 500 characters. */
function wordsOf(text: string): string {
  const problem = askTextProblem(text, 1)
  if (problem) throw badField('words', problem)
  return text.trim()
}

/** Where a new ask lands, checked on this order (a work order: one of its own, live, not a repair, that the reader reaches). */
async function landingOf(db: Reader, actor: Actor, order: OrderRow, target: MakeAskBody['target']) {
  const ids = { lineId: target.lineId, workOrderId: target.workOrderId, operationId: target.operationId }
  if (target.type === 'SALES_ORDER') {
    if (ids.lineId || ids.workOrderId || ids.operationId) throw badField('target', 'An ask on the order itself names no line, work order or step.')
    return { target: 'SALES_ORDER' as FileAskTarget, salesOrderLineId: null, workOrderId: null, siteId: null, operationId: null }
  }
  if (target.type === 'SALES_ORDER_LINE') {
    if (!ids.lineId) throw badField('target/lineId', 'Say which line the file lands on.')
    if (ids.workOrderId || ids.operationId) throw badField('target', 'An ask on a line names no work order or step.')
    const line = await db.salesOrderLine.findFirst({ where: { id: ids.lineId, orderId: order.id }, select: { id: true } })
    if (!line) throw badField('target/lineId', 'Not a line of this order.')
    return { target: 'SALES_ORDER_LINE' as FileAskTarget, salesOrderLineId: line.id, workOrderId: null, siteId: null, operationId: null }
  }
  if (!ids.workOrderId) throw badField('target/workOrderId', 'Say which work order the file lands on.')
  if (ids.lineId) throw badField('target/lineId', 'An ask on a work order names no line.')
  const lineIds = (await db.salesOrderLine.findMany({ where: { orderId: order.id }, select: { id: true } })).map((line) => line.id)
  const workOrder = lineIds.length === 0
    ? null
    : await db.workOrder.findFirst({
        where: { id: ids.workOrderId, companyId: order.companyId, partyId: order.partyId, status: { not: 'CANCELLED' }, kind: { not: 'REPAIR' }, sizes: { some: { salesOrderLineId: { in: lineIds } } } },
        select: { id: true, companyId: true, siteId: true, partyId: true },
      })
  // One not of this order and one the reader does not reach read the same (never a word that it exists).
  if (!workOrder || !reachesWorkOrder(actor, WORKORDERS_VIEW, workOrder)) throw badField('target/workOrderId', 'Not a work order of this order.')
  let operationId: string | null = null
  if (ids.operationId) {
    const step = await db.workOrderOperation.findFirst({ where: { id: ids.operationId, workOrderId: workOrder.id }, select: { id: true } })
    if (!step) throw badField('target/operationId', 'Not a step of this work order.')
    operationId = step.id
  }
  return { target: 'WORK_ORDER' as FileAskTarget, salesOrderLineId: null, workOrderId: workOrder.id, siteId: workOrder.siteId, operationId }
}

// ---- make ---------------------------------------------------------------------------------------------------------------------
/** POST /sales/orders/:orderId/file-asks */
export async function makeAsk(caller: CommandCaller, orderId: string, body: MakeAskBody, idempotencyKey?: string) {
  const { context, actor, order } = await reachOrder(caller, orderId)
  if (!mayKeepAsks(actor, order, true)) throw new ForbiddenError(NOT_YOURS)
  const marks = { priced: body.priced === true, bodyData: body.bodyData === true }
  assertMarks(actor, order, marks)
  if (CLOSED_ORDERS.has(order.status)) throw refused('ORDER_CLOSED')
  const words = wordsOf(body.words)
  const dueOn = dueOf(body.dueOn)
  const { result } = await command(caller, { name: 'files.fileAsk.make', idempotencyKey, input: { orderId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const fresh = await readOrder(tx, order.id)
    if (!fresh || CLOSED_ORDERS.has(fresh.status)) throw refused('ORDER_CLOSED')
    const land = await landingOf(tx, actor, fresh, body.target)
    const askOrder = askOrderOf(fresh)
    const who = await resolveWho(tx, context.tenantId, askOrder, body.who, { target: land.target, siteId: land.siteId, operationId: land.operationId }, marks, now)
    const id = newId()
    // The office addressees' Tasks first: the ask's statement names them (its guard reads Task).
    const taskIds: string[] = []
    for (const person of who.people) {
      taskIds.push(await writeAskTask(tools, { order: askOrder, title: uploadTaskTitle(words, marks.priced, person.locale), description: marks.priced ? null : words, assigneeId: person.id, by: context.actorId, dueOn, askId: id }))
    }
    const row = await tx.fileAsk.create({
      data: {
        id,
        companyId: fresh.companyId,
        partyId: fresh.partyId,
        siteId: land.siteId,
        salesOrderId: fresh.id,
        target: land.target,
        salesOrderLineId: land.salesOrderLineId,
        workOrderId: land.workOrderId,
        workOrderOperationId: land.operationId,
        words,
        fileKind: body.fileKind,
        priced: marks.priced,
        bodyData: marks.bodyData,
        addressee: who.addressee,
        addresseeUserId: who.addresseeUserId,
        addresseeRoleId: who.addresseeRoleId,
        addresseeTeamId: who.addresseeTeamId,
        dueOn: asDay(dueOn),
        taskIds,
        askedById: context.actorId,
        createdAt: now,
        updatedAt: now,
      },
      select: ASK_COLUMNS,
    })
    tools.audit({ action: 'files.fileAsk.make', recordType: 'FileAsk', recordId: id, companyId: row.companyId, siteId: row.siteId, after: { ...auditViewOf(row), fileKind: row.fileKind, marks: [...(row.priced ? ['PRICED'] : []), ...(row.bodyData ? ['BODY_DATA'] : [])], taskIds, salesOrderId: row.salesOrderId } })
    tools.emit({ type: 'file_ask.asked', ...eventPlaceOf(row), payload: eventIdsOf(row, 'OPEN') })
    return answerOf(id, row.version, 'OPEN', taskIds.length)
  })
  return result
}

// ---- change -------------------------------------------------------------------------------------------------------------------
/** The ask of this order for a command: reached (the walls), its marks held, the right over the order (else 403). */
export async function askForCommand(caller: CommandCaller, orderId: string, askId: string, post = false) {
  const reached = await reachOrder(caller, orderId)
  if (!mayKeepAsks(reached.actor, reached.order, post)) throw new ForbiddenError(NOT_YOURS)
  const ask = await caller.withClient((db) => readAsk(db, reached.actor, reached.order, askId))
  assertMarks(reached.actor, reached.order, ask)
  return { ...reached, ask }
}

/** PATCH /sales/orders/:orderId/file-asks/:askId */
export async function changeAsk(caller: CommandCaller, orderId: string, askId: string, body: ChangeAskBody, idempotencyKey?: string) {
  if (body.words === undefined && body.dueOn === undefined) throw badField('words', 'Send the new words or the new due day.')
  const words = body.words === undefined ? undefined : wordsOf(body.words)
  const due = body.dueOn === undefined ? undefined : dueOf(body.dueOn)
  const { ask } = await askForCommand(caller, orderId, askId)
  if (ask.status !== 'OPEN') throw refused('NOT_OPEN')
  const { result } = await command(caller, { name: 'files.fileAsk.change', idempotencyKey, input: { orderId, askId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const row = await lockAsk(tools, ask.id, body.version)
    if (row.status !== 'OPEN') throw refused('NOT_OPEN')
    const next = { words: words ?? row.words, dueOn: due ?? dayOf(row.dueOn) }
    const changed = { words: next.words !== row.words, due: next.dueOn !== dayOf(row.dueOn) }
    if (!changed.words && !changed.due) throw badField('words', 'Nothing changes: the words and the due day are as they are.')
    const after = await tx.fileAsk.update({ where: { id: row.id }, data: { words: next.words, dueOn: asDay(next.dueOn), version: row.version + 1, updatedAt: now }, select: ASK_COLUMNS })
    await followAskTasks(tools, row.taskIds, { titleOf: (locale) => uploadTaskTitle(next.words, row.priced, askLocaleOf(locale)), dueOn: next.dueOn })
    tools.audit({ action: 'files.fileAsk.change', recordType: 'FileAsk', recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: auditViewOf(row), after: auditViewOf(after) })
    if (changed.words) tools.emit({ type: 'file_ask.changed', ...eventPlaceOf(row), payload: { ...eventIdsOf(row, 'OPEN'), change: 'WORDS' } })
    if (changed.due) tools.emit({ type: 'file_ask.changed', ...eventPlaceOf(row), payload: { ...eventIdsOf(row, 'OPEN'), change: 'DUE' } })
    return answerOf(row.id, after.version, 'OPEN')
  })
  return result
}

// ---- reassign -----------------------------------------------------------------------------------------------------------------
/** POST /sales/orders/:orderId/file-asks/:askId/reassign */
export async function reassignAsk(caller: CommandCaller, orderId: string, askId: string, body: ReassignAskBody, idempotencyKey?: string) {
  const reason = body.reason === undefined || body.reason.trim() === '' ? null : reasonOf(body.reason)
  const { context, ask } = await askForCommand(caller, orderId, askId)
  if (ask.status !== 'OPEN') throw refused('NOT_OPEN')
  const { result } = await command(caller, { name: 'files.fileAsk.reassign', idempotencyKey, input: { orderId, askId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const row = await lockAsk(tools, ask.id, body.version)
    if (row.status !== 'OPEN') throw refused('NOT_OPEN')
    const order = (await readOrder(tx, row.salesOrderId))!
    const askOrder = askOrderOf(order)
    const who = await resolveWho(tx, context.tenantId, askOrder, body.who, { target: row.target, siteId: row.siteId, operationId: row.workOrderOperationId }, { priced: row.priced, bodyData: row.bodyData }, now)
    if (who.addressee === row.addressee && who.addresseeUserId === row.addresseeUserId && who.addresseeRoleId === row.addresseeRoleId && who.addresseeTeamId === row.addresseeTeamId) {
      throw badField('who', 'This ask is already to them.')
    }
    await moveAskTasks(tools, row.taskIds, 'CANCELLED', context.actorId)
    const dueOn = dayOf(row.dueOn)
    const taskIds: string[] = []
    for (const person of who.people) {
      taskIds.push(await writeAskTask(tools, { order: askOrder, title: uploadTaskTitle(row.words, row.priced, person.locale), description: row.priced ? null : row.words, assigneeId: person.id, by: context.actorId, dueOn, askId: row.id }))
    }
    const after = await tx.fileAsk.update({
      where: { id: row.id },
      data: { addressee: who.addressee, addresseeUserId: who.addresseeUserId, addresseeRoleId: who.addresseeRoleId, addresseeTeamId: who.addresseeTeamId, taskIds, version: row.version + 1, updatedAt: now },
      select: ASK_COLUMNS,
    })
    tools.audit({ action: 'files.fileAsk.reassign', recordType: 'FileAsk', recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: { ...auditViewOf(row), taskIds: [...row.taskIds] }, after: { ...auditViewOf(after), taskIds }, ...(reason ? { reason } : {}) })
    tools.emit({ type: 'file_ask.changed', ...eventPlaceOf(row), payload: { ...eventIdsOf(row, 'OPEN'), change: 'ADDRESSEE' } })
    return answerOf(row.id, after.version, 'OPEN', taskIds.length)
  })
  return result
}

// ---- cancel -------------------------------------------------------------------------------------------------------------------
/** POST /sales/orders/:orderId/file-asks/:askId/cancel — an ask is never deleted: it is cancelled with a reason. */
export async function cancelAsk(caller: CommandCaller, orderId: string, askId: string, body: ReasonBody, idempotencyKey?: string) {
  const reason = reasonOf(body.reason)
  const { context, ask } = await askForCommand(caller, orderId, askId)
  if (ask.status !== 'OPEN' && ask.status !== 'ARRIVED') throw refused('NOT_OPEN')
  const { result } = await command(caller, { name: 'files.fileAsk.cancel', idempotencyKey, input: { orderId, askId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const row = await lockAsk(tools, ask.id, body.version)
    if (row.status !== 'OPEN' && row.status !== 'ARRIVED') throw refused('NOT_OPEN')
    // The addressees' open Tasks and the asker's check Task are cancelled (a done one stays done).
    await moveAskTasks(tools, [...row.taskIds, ...(row.checkTaskId ? [row.checkTaskId] : [])], 'CANCELLED', context.actorId)
    const after = await tx.fileAsk.update({ where: { id: row.id }, data: { status: 'CANCELLED', cancelledAt: now, cancelledById: context.actorId, cancelReason: reason, version: row.version + 1, updatedAt: now }, select: ASK_COLUMNS })
    tools.audit({ action: 'files.fileAsk.cancel', recordType: 'FileAsk', recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: auditViewOf(row), after: auditViewOf(after), reason })
    tools.emit({ type: 'file_ask.changed', ...eventPlaceOf(row), payload: { ...eventIdsOf(row, 'CANCELLED'), change: 'CANCELLED' } })
    return answerOf(row.id, after.version, 'CANCELLED')
  })
  return result
}

// ---- S2.2: answer ----------------------------------------------------------------------------------------------------------------
/** The record an ask's files belong to: the order, its line, or its work order. */
export const targetRecordOf = (row: Pick<AskRow, 'target' | 'salesOrderId' | 'salesOrderLineId' | 'workOrderId'>): { readonly recordType: string; readonly recordId: string } =>
  row.target === 'SALES_ORDER' ? { recordType: 'SalesOrder', recordId: row.salesOrderId } : row.target === 'SALES_ORDER_LINE' ? { recordType: 'SalesOrderLine', recordId: row.salesOrderLineId! } : { recordType: 'WorkOrder', recordId: row.workOrderId! }

/** POST /sales/orders/:orderId/file-asks/:askId/answer — the files sent for this ask; the addressee, or anyone who adds files there. */
export async function answerAsk(caller: CommandCaller, orderId: string, askId: string, body: AnswerAskBody, idempotencyKey?: string) {
  const { context, actor, order } = await reachOrder(caller, orderId)
  const ask = await caller.withClient((db) => readAsk(db, actor, order, askId))
  assertMarks(actor, order, ask)
  if (ask.status !== 'OPEN') throw refused('NOT_OPEN')
  // files.upload over the record the file lands on (its own scope: a work order's company, site and customer).
  const target = targetRecordOf(ask)
  const found = await caller.withClient((db) => fileRecordScope(db, context.tenantId, target))
  if (!reachesFileRecord(actor, FILES_UPLOAD, found, order.companyId)) throw new ForbiddenError('You may not add files where this ask lands.')
  const fileIds = [...new Set(body.fileIds)]
  for (const fileId of fileIds) {
    // A file out of the person's reach (or priced, for someone who sees no prices) is as unknown as a wrong id.
    const file = await readOfficeReached(caller, fileId)
    if (file.recordType !== target.recordType || file.recordId !== target.recordId || file.status === 'DELETED') throw refused('FILE_NOT_OF_TARGET')
    if (file.scanStatus === 'INFECTED') throw refused('FILE_INFECTED')
  }
  const { result } = await command(caller, { name: 'files.fileAsk.answer', idempotencyKey, input: { orderId, askId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const row = await lockAsk(tools, ask.id, body.version)
    if (row.status !== 'OPEN') throw refused('NOT_OPEN')
    await moveAskTasks(tools, row.taskIds, 'DONE', context.actorId)
    const checkTaskId = await writeCheckTask(tools, row, context.actorId)
    const after = await tx.fileAsk.update({ where: { id: row.id }, data: { status: 'ARRIVED', fileIds, answeredAt: now, answeredById: context.actorId, checkTaskId, version: row.version + 1, updatedAt: now }, select: ASK_COLUMNS })
    tools.audit({ action: 'files.fileAsk.answer', recordType: 'FileAsk', recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: auditViewOf(row), after: { ...auditViewOf(after), by: 'OFFICE', checkTaskId } })
    tools.emit({ type: 'file_ask.arrived', ...eventPlaceOf(row), payload: eventIdsOf(row, 'ARRIVED') })
    return answerOf(row.id, after.version, 'ARRIVED', 1)
  })
  return result
}

/**
 * The asker's "Check: {words}" Task once files arrived (in their language; a priced ask never its words), due today (the company's
 * day); written before the ask's statement that names it. `by`: the office person who sent the files, null for the floor (the system).
 */
export async function writeCheckTask(tools: Pick<CommandTools, 'tx' | 'now' | 'audit' | 'emit'>, row: AskRow, by: string | null): Promise<string> {
  const order = await tools.tx.salesOrder.findUniqueOrThrow({ where: { id: row.salesOrderId }, select: { id: true, number: true, companyId: true, partyId: true } })
  const asker = await tools.tx.user.findUnique({ where: { id: row.askedById }, select: { locale: true } })
  return writeAskTask(tools, { order: askOrderOf(order), title: checkTaskTitle(row.words, row.priced, askLocaleOf(asker?.locale)), description: row.priced ? null : row.words, assigneeId: row.askedById, by, dueOn: businessDate(tools.now), askId: row.id })
}

// ---- S2.2: accept, ask again ----------------------------------------------------------------------------------------------------
/** POST /sales/orders/:orderId/file-asks/:askId/accept — never while a file sent is held by the virus scan, or found infected. */
export async function acceptAsk(caller: CommandCaller, orderId: string, askId: string, body: VersionBody, idempotencyKey?: string) {
  const { context, ask } = await askForCommand(caller, orderId, askId)
  if (ask.status !== 'ARRIVED') throw refused('NOT_ARRIVED')
  const { result } = await command(caller, { name: 'files.fileAsk.accept', idempotencyKey, input: { orderId, askId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const row = await lockAsk(tools, ask.id, body.version)
    if (row.status !== 'ARRIVED') throw refused('NOT_ARRIVED')
    const files = await tx.storedFile.findMany({ where: { id: { in: [...row.fileIds] } }, select: { id: true, status: true, scanStatus: true } })
    if (files.some((file) => file.scanStatus === 'INFECTED')) throw refused('FILE_INFECTED')
    const held = row.fileIds.filter((fileId) => files.find((file) => file.id === fileId)?.status !== 'AVAILABLE').length
    if (held > 0) throw refused('FILES_HELD', { n: held })
    if (row.checkTaskId) await moveAskTasks(tools, [row.checkTaskId], 'DONE', context.actorId)
    const after = await tx.fileAsk.update({ where: { id: row.id }, data: { status: 'ACCEPTED', acceptedAt: now, acceptedById: context.actorId, version: row.version + 1, updatedAt: now }, select: ASK_COLUMNS })
    tools.audit({ action: 'files.fileAsk.accept', recordType: 'FileAsk', recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: auditViewOf(row), after: auditViewOf(after) })
    tools.emit({ type: 'file_ask.decided', ...eventPlaceOf(row), payload: { ...eventIdsOf(row, 'ACCEPTED'), decision: 'ACCEPTED' } })
    return answerOf(row.id, after.version, 'ACCEPTED')
  })
  return result
}

/** POST /sales/orders/:orderId/file-asks/:askId/ask-again — with why; the files sent stay on the record. */
export async function askAgain(caller: CommandCaller, orderId: string, askId: string, body: ReasonBody, idempotencyKey?: string) {
  const reason = reasonOf(body.reason)
  const { context, ask } = await askForCommand(caller, orderId, askId)
  if (ask.status !== 'ARRIVED') throw refused('NOT_ARRIVED')
  const { result } = await command(caller, { name: 'files.fileAsk.askAgain', idempotencyKey, input: { orderId, askId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const row = await lockAsk(tools, ask.id, body.version)
    if (row.status !== 'ARRIVED') throw refused('NOT_ARRIVED')
    await moveAskTasks(tools, row.taskIds, 'OPEN', context.actorId)
    if (row.checkTaskId) await moveAskTasks(tools, [row.checkTaskId], 'DONE', context.actorId)
    const after = await tx.fileAsk.update({
      where: { id: row.id },
      data: { status: 'OPEN', fileIds: [], answeredAt: null, answeredById: null, rounds: row.rounds + 1, lastReason: reason, version: row.version + 1, updatedAt: now },
      select: ASK_COLUMNS,
    })
    tools.audit({ action: 'files.fileAsk.askAgain', recordType: 'FileAsk', recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: auditViewOf(row), after: auditViewOf(after), reason })
    tools.emit({ type: 'file_ask.decided', ...eventPlaceOf(row), payload: { ...eventIdsOf(row, 'OPEN'), decision: 'ASKED_AGAIN' } })
    return answerOf(row.id, after.version, 'OPEN')
  })
  return result
}

// ---- S2.2: chase --------------------------------------------------------------------------------------------------------------
/** POST /sales/orders/:orderId/file-asks/:askId/chase — "Ask for an update". */
export async function chaseAsk(caller: CommandCaller, orderId: string, askId: string, body: VersionBody, idempotencyKey?: string) {
  const { context, ask } = await askForCommand(caller, orderId, askId, true)
  if (ask.status !== 'OPEN') throw refused('NOT_OPEN')
  const { result } = await command(caller, { name: 'files.fileAsk.chase', idempotencyKey, input: { orderId, askId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const row = await lockAsk(tools, ask.id, body.version)
    if (row.status !== 'OPEN') throw refused('NOT_OPEN')
    let messageId: string | null = null
    if (!isFloorAddressee(row.addressee)) {
      // The open Tasks' people, mentioned in an office note on the order's thread (threads' own check of who may be mentioned).
      const open = await tx.task.findMany({ where: { id: { in: [...row.taskIds] }, status: 'OPEN', assigneeId: { not: null } }, select: { assigneeId: true } })
      const people = [...new Set(open.map((task) => task.assigneeId!))]
      const { thread } = await ensureThread(tools, { type: 'SalesOrder', id: row.salesOrderId }, context.actorId)
      if (thread.status !== 'OPEN') throw new ConflictError("This order's conversation is closed: the note asking for an update cannot be posted.")
      const problems = await mentionProblems(tx, tools.context, thread, people, now)
      const refusedIds = new Set(problems.map((problem) => people[Number(problem.path.split('/').pop())]).filter((userId): userId is string => userId !== undefined))
      const author = await tx.user.findUnique({ where: { id: context.actorId }, select: { displayName: true, locale: true } })
      const message = await writeMessage(tools, thread, {
        direction: 'INTERNAL_NOTE',
        channel: 'APP',
        author: { kind: 'USER', id: context.actorId, name: author?.displayName ?? null },
        bodyText: cleanBody(chaseNoteText(row.words, row.priced, dayOf(row.dueOn), askLocaleOf(author?.locale))),
        mentions: people.filter((userId) => !refusedIds.has(userId)),
      })
      messageId = message.id
    }
    const after = await tx.fileAsk.update({ where: { id: row.id }, data: { lastChasedAt: now, version: row.version + 1, updatedAt: now }, select: ASK_COLUMNS })
    tools.audit({ action: 'files.fileAsk.chase', recordType: 'FileAsk', recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: { lastChasedAt: row.lastChasedAt?.toISOString() ?? null }, after: { lastChasedAt: now.toISOString(), messageId } })
    tools.emit({ type: 'file_ask.changed', ...eventPlaceOf(row), payload: { ...eventIdsOf(row, 'OPEN'), change: 'CHASED' } })
    return answerOf(row.id, after.version, 'OPEN')
  })
  return result
}
